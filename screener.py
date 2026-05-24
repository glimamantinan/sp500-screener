"""
S&P 500 Weekly Screener
=======================
Fetches data for top 250 S&P 500 stocks via yfinance,
scores them across 5 criteria, and upserts to Supabase.

Run locally:
    pip install -r requirements.txt
    export SUPABASE_URL=https://xxx.supabase.co
    export SUPABASE_KEY=<service_role_key>
    python screener.py

Runs automatically every Sunday via GitHub Actions.
"""

import os
import time
import requests
import yfinance as yf
import pandas as pd
import numpy as np
from datetime import datetime, timedelta

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_KEY"]
TOP_N          = 250          # increase to 500 later
BATCH_SIZE     = 25           # yfinance handles batches well
BATCH_DELAY    = 2.0          # seconds between batches
TABLE          = "sp500_screener"

# Scoring weights (must sum to 1.0)
WEIGHTS = dict(growth=0.35, momentum=0.25, valuation=0.20, quality=0.12, sentiment=0.08)

# ── Step 1: Fetch S&P 500 constituents from Wikipedia ────────────────────────
def fetch_constituents() -> pd.DataFrame:
    print("Fetching S&P 500 constituents...")
    url = (
        "https://raw.githubusercontent.com/datasets/s-and-p-500-companies"
        "/main/data/constituents.csv"
    )
    try:
        df = pd.read_csv(url)
        print(f"  CSV columns: {df.columns.tolist()}")  # debug line
        # Flexible column mapping
        col_map = {}
        for col in df.columns:
            cl = col.lower()
            if "symbol" in cl or "ticker" in cl:
                col_map[col] = "ticker"
            elif "name" in cl or "security" in cl or "company" in cl:
                col_map[col] = "name"
            elif "sector" in cl or "gics" in cl:
                col_map[col] = "sector"
        df = df.rename(columns=col_map)
        df["ticker"] = df["ticker"].str.replace(".", "-", regex=False)
        df = df[["ticker", "name", "sector"]]
        print(f"  Fetched {len(df)} constituents")
        return df
    except Exception as e:
        print(f"  CSV fetch failed ({e}), using fallback list")
        return get_fallback_universe()

# ── Step 2: Rank by market cap, take top N ───────────────────────────────────
def rank_by_market_cap(df: pd.DataFrame) -> pd.DataFrame:
    print(f"Fetching market caps to rank top {TOP_N}...")
    tickers = df["ticker"].tolist()
    caps = {}

    # yfinance bulk download is fastest for market cap
    for i in range(0, len(tickers), BATCH_SIZE):
        batch = tickers[i : i + BATCH_SIZE]
        try:
            data = yf.download(
                batch, period="1d", auto_adjust=True,
                progress=False, threads=True
            )
            info_batch = yf.Tickers(" ".join(batch))
            for t in batch:
                try:
                    caps[t] = info_batch.tickers[t].fast_info.market_cap or 0
                except Exception:
                    caps[t] = 0
        except Exception as e:
            print(f"  Market cap batch error: {e}")
        time.sleep(0.5)

    df["market_cap_rank"] = df["ticker"].map(caps).fillna(0)
    df = df.sort_values("market_cap_rank", ascending=False).head(TOP_N).reset_index(drop=True)
    print(f"  Top {TOP_N} selected. Smallest: {df.iloc[-1]['ticker']} (${df.iloc[-1]['market_cap_rank']/1e9:.0f}B)")
    return df

# ── Step 3: Fetch price history (13 months monthly) ──────────────────────────
def fetch_price_history(tickers: list) -> dict:
    """Returns dict of ticker -> list of {date, close}"""
    print(f"Fetching price history for {len(tickers)} tickers + SPY...")
    all_tickers = tickers + ["SPY"]
    end   = datetime.today()
    start = end - timedelta(days=400)

    try:
        raw    = yf.download(
            all_tickers, start=start, end=end,
            interval="1mo", auto_adjust=True,
            progress=False, threads=True
        )
        closes = raw["Close"] if "Close" in raw.columns else raw
        result = {}
        for t in all_tickers:
            if t in closes.columns:
                series = closes[t].dropna()
                result[t] = [
                    {
                        "date":  str(d)[:7],
                        "close": round(float(v), 4)  # force scalar float
                    }
                    for d, v in series.items()
                    if not (isinstance(v, float) and np.isnan(v))
                ]
            else:
                result[t] = []
        return result
    except Exception as e:
        print(f"  Price history error: {e}")
        return {t: [] for t in all_tickers}

# ── Step 4: Fetch fundamentals ────────────────────────────────────────────────
def fetch_fundamentals(ticker: str) -> dict:
    """Fetch fundamental data for a single ticker via yfinance."""
    try:
        t    = yf.Ticker(ticker)
        info = t.info
        return {
            "price":          info.get("currentPrice")      or info.get("regularMarketPrice") or 0,
            "analyst_target": info.get("targetMeanPrice")   or 0,
            "fwd_pe":         info.get("forwardPE")         or info.get("trailingPE")         or 30,
            "eps":            info.get("trailingEps")       or 0,
            "gross_margin":   info.get("grossMargins")      or 0,
            "roe":            info.get("returnOnEquity")    or 0,
            "debt_to_eq":     info.get("debtToEquity")      or 50,
            "revenue_growth": info.get("revenueGrowth")     or 0,
            "earnings_growth":info.get("earningsGrowth")    or 0,
            "market_cap":     info.get("marketCap")         or 0,
            "revenue_ttm":    info.get("totalRevenue")      or 0,
            "ebitda":         info.get("ebitda")            or 0,
            "beta":           info.get("beta")              or 1,
            "dividend_yield": info.get("dividendYield")     or 0,
            "week_52_high":   info.get("fiftyTwoWeekHigh")  or 0,
            "week_52_low":    info.get("fiftyTwoWeekLow")   or 0,
        }
    except Exception as e:
        print(f"  Fundamentals error for {ticker}: {e}")
        return {}

# ── Step 5: Score a stock ─────────────────────────────────────────────────────
def score_stock(fund: dict, price_hist: list, spy_hist: list) -> dict:
    def clamp(v): return min(1.0, max(0.0, v))
    def s100(v):  return round(clamp(v) * 100, 2)

    price          = fund.get("price", 0)
    analyst_target = fund.get("analyst_target", 0)
    analyst_upside = (analyst_target - price) / price if price > 0 and analyst_target > 0 else 0
    fwd_pe         = fund.get("fwd_pe", 30)
    gross_margin   = fund.get("gross_margin", 0)
    roe            = fund.get("roe", 0)
    debt_to_eq     = fund.get("debt_to_eq", 50)
    revenue_growth = fund.get("revenue_growth", 0)
    earnings_growth= fund.get("earnings_growth", 0)

    # Returns from price history
    def ret(hist, months_back):
        if len(hist) >= months_back + 1:
            p_now  = hist[-1]["close"]
            p_then = hist[-months_back - 1]["close"]
            return (p_now - p_then) / p_then if p_then > 0 else 0
        return 0

    mom1m  = ret(price_hist, 1)
    mom3m  = ret(price_hist, 3)
    mom6m  = ret(price_hist, 6)
    mom12m = ret(price_hist, 12)
    spy12m = ret(spy_hist,   12)
    alpha  = mom12m - spy12m

    # ── Sub-scores ──────────────────────────────────────────────────────────
    growth_score = s100(
        clamp(analyst_upside  / 0.40) * 0.30 +
        clamp((revenue_growth  + 0.05) / 0.45) * 0.25 +
        clamp((earnings_growth + 0.05) / 0.50) * 0.25 +
        clamp(roe / 0.35) * 0.20
    )
    momentum_score = s100(
        clamp((mom6m + 0.30) / 0.90) * 0.50 +
        clamp((alpha  + 0.30) / 0.90) * 0.50
    )
    valuation_score = s100(clamp((42 - fwd_pe) / 42))
    quality_score = s100(
        clamp(gross_margin) * 0.40 +
        clamp(roe / 0.35)   * 0.35 +
        clamp(100 / (debt_to_eq + 10)) * 0.25
    )
    sentiment_score = s100(clamp((analyst_upside + 0.10) / 0.60))

    composite = round(
        growth_score    * WEIGHTS["growth"]    +
        momentum_score  * WEIGHTS["momentum"]  +
        valuation_score * WEIGHTS["valuation"] +
        quality_score   * WEIGHTS["quality"]   +
        sentiment_score * WEIGHTS["sentiment"],
        2
    )

    return {
        "composite_score": composite,
        "growth_score":    growth_score,
        "momentum_score":  momentum_score,
        "valuation_score": valuation_score,
        "quality_score":   quality_score,
        "sentiment_score": sentiment_score,
        "price":           round(price, 2),
        "analyst_target":  round(analyst_target, 2),
        "analyst_upside":  round(analyst_upside, 4),
        "fwd_pe":          round(fwd_pe, 2),
        "eps":             round(fund.get("eps", 0), 2),
        "market_cap":      int(fund.get("market_cap", 0)),
        "revenue_ttm":     int(fund.get("revenue_ttm", 0)),
        "gross_margin":    round(gross_margin, 4),
        "ebitda":          int(fund.get("ebitda", 0)),
        "roic":            round(roe, 4),
        "beta":            round(fund.get("beta", 1), 2),
        "dividend_yield":  round(fund.get("dividend_yield", 0), 4),
        "week_52_high":    round(fund.get("week_52_high", 0), 2),
        "week_52_low":     round(fund.get("week_52_low", 0), 2),
        "mom_1m":          round(mom1m,  4),
        "mom_3m":          round(mom3m,  4),
        "mom_6m":          round(mom6m,  4),
        "mom_12m":         round(mom12m, 4),
        "alpha_vs_spy":    round(alpha,  4),
        "revenue_growth":  round(revenue_growth,  4),
        "earnings_growth": round(earnings_growth, 4),
    }

# ── Step 6: Upsert to Supabase ────────────────────────────────────────────────
import json

def sanitise(obj):
    """Recursively convert all pandas/numpy types to plain Python types."""
    if isinstance(obj, dict):
        return {k: sanitise(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [sanitise(i) for i in obj]
    elif isinstance(obj, float) and np.isnan(obj):
        return None
    elif hasattr(obj, 'item'):      # catches np.int64, np.float64, etc.
        return obj.item()
    elif hasattr(obj, 'tolist'):    # catches pd.Series, np.ndarray
        return obj.tolist()
    else:
        return obj

def upsert_batch(rows: list):
    """Push a batch of rows to Supabase via REST API."""
    clean_rows = [sanitise(row) for row in rows]
    # Verify serialisable before sending
    json.dumps(clean_rows)
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{TABLE}",
        headers=headers,
        json=clean_rows,
        timeout=30,
    )
    if r.status_code not in (200, 201):
        raise Exception(f"Supabase upsert failed: {r.status_code} {r.text[:200]}")

# ── Fallback universe ─────────────────────────────────────────────────────────
def get_fallback_universe() -> pd.DataFrame:
    data = [
        # Technology
        ("NVDA","NVIDIA","Information Technology"),("MSFT","Microsoft","Information Technology"),
        ("AAPL","Apple","Information Technology"),("AVGO","Broadcom","Information Technology"),
        ("AMD","AMD","Information Technology"),("CRM","Salesforce","Information Technology"),
        ("ADBE","Adobe","Information Technology"),("NOW","ServiceNow","Information Technology"),
        ("AMAT","Applied Materials","Information Technology"),("PANW","Palo Alto Networks","Information Technology"),
        ("PLTR","Palantir","Information Technology"),("SNOW","Snowflake","Information Technology"),
        ("ARM","Arm Holdings","Information Technology"),("CRWD","CrowdStrike","Information Technology"),
        ("ORCL","Oracle","Information Technology"),("IBM","IBM","Information Technology"),
        ("TXN","Texas Instruments","Information Technology"),("QCOM","Qualcomm","Information Technology"),
        ("MU","Micron Technology","Information Technology"),("INTC","Intel","Information Technology"),
        # Communication Services
        ("GOOGL","Alphabet","Communication Services"),("META","Meta Platforms","Communication Services"),
        ("NFLX","Netflix","Communication Services"),("TMUS","T-Mobile","Communication Services"),
        ("DIS","Disney","Communication Services"),("T","AT&T","Communication Services"),
        ("VZ","Verizon","Communication Services"),("CHTR","Charter Comms","Communication Services"),
        # Consumer Discretionary
        ("AMZN","Amazon","Consumer Discretionary"),("TSLA","Tesla","Consumer Discretionary"),
        ("BKNG","Booking Holdings","Consumer Discretionary"),("CMG","Chipotle","Consumer Discretionary"),
        ("RCL","Royal Caribbean","Consumer Discretionary"),("NKE","Nike","Consumer Discretionary"),
        ("SBUX","Starbucks","Consumer Discretionary"),("TJX","TJX Companies","Consumer Discretionary"),
        ("GM","General Motors","Consumer Discretionary"),("MCD","McDonald's","Consumer Discretionary"),
        ("HD","Home Depot","Consumer Discretionary"),("LOW","Lowe's","Consumer Discretionary"),
        # Consumer Staples
        ("COST","Costco","Consumer Staples"),("WMT","Walmart","Consumer Staples"),
        ("PG","Procter & Gamble","Consumer Staples"),("KO","Coca-Cola","Consumer Staples"),
        ("PEP","PepsiCo","Consumer Staples"),("MDLZ","Mondelez","Consumer Staples"),
        ("CL","Colgate-Palmolive","Consumer Staples"),("MO","Altria","Consumer Staples"),
        # Healthcare
        ("LLY","Eli Lilly","Health Care"),("UNH","UnitedHealth","Health Care"),
        ("ABBV","AbbVie","Health Care"),("TMO","Thermo Fisher","Health Care"),
        ("ISRG","Intuitive Surgical","Health Care"),("VRTX","Vertex Pharma","Health Care"),
        ("REGN","Regeneron","Health Care"),("BSX","Boston Scientific","Health Care"),
        ("DXCM","DexCom","Health Care"),("HCA","HCA Healthcare","Health Care"),
        ("JNJ","Johnson & Johnson","Health Care"),("PFE","Pfizer","Health Care"),
        ("MRK","Merck","Health Care"),("ABT","Abbott Labs","Health Care"),
        # Financials
        ("JPM","JPMorgan Chase","Financials"),("V","Visa","Financials"),
        ("MA","Mastercard","Financials"),("GS","Goldman Sachs","Financials"),
        ("MS","Morgan Stanley","Financials"),("BLK","BlackRock","Financials"),
        ("AXP","American Express","Financials"),("SPGI","S&P Global","Financials"),
        ("COF","Capital One","Financials"),("BAC","Bank of America","Financials"),
        ("WFC","Wells Fargo","Financials"),("C","Citigroup","Financials"),
        ("PGR","Progressive","Financials"),("CB","Chubb","Financials"),
        ("PYPL","PayPal","Financials"),("FI","Fiserv","Financials"),
        # Industrials
        ("CAT","Caterpillar","Industrials"),("GE","GE Aerospace","Industrials"),
        ("ETN","Eaton Corp","Industrials"),("RTX","RTX Corp","Industrials"),
        ("LMT","Lockheed Martin","Industrials"),("HON","Honeywell","Industrials"),
        ("UPS","UPS","Industrials"),("DE","Deere & Co","Industrials"),
        ("NOC","Northrop Grumman","Industrials"),("FDX","FedEx","Industrials"),
        ("UBER","Uber","Industrials"),("BA","Boeing","Industrials"),
        # Energy
        ("XOM","ExxonMobil","Energy"),("CVX","Chevron","Energy"),
        ("COP","ConocoPhillips","Energy"),("HAL","Halliburton","Energy"),
        ("SLB","SLB","Energy"),("MPC","Marathon Petroleum","Energy"),
        ("VLO","Valero Energy","Energy"),("OXY","Occidental Petroleum","Energy"),
        ("EOG","EOG Resources","Energy"),
        # Real Estate
        ("PLD","Prologis","Real Estate"),("EQIX","Equinix","Real Estate"),
        ("AMT","American Tower","Real Estate"),("SPG","Simon Property","Real Estate"),
        ("WELL","Welltower","Real Estate"),("DLR","Digital Realty","Real Estate"),
        # Materials
        ("LIN","Linde","Materials"),("FCX","Freeport-McMoRan","Materials"),
        ("APD","Air Products","Materials"),("NEM","Newmont","Materials"),
        ("SHW","Sherwin-Williams","Materials"),("ECL","Ecolab","Materials"),
        # Utilities
        ("NEE","NextEra Energy","Utilities"),("VST","Vistra Energy","Utilities"),
        ("SO","Southern Company","Utilities"),("DUK","Duke Energy","Utilities"),
        ("AEP","American Electric Power","Utilities"),
    ]
    return pd.DataFrame(data, columns=["ticker","name","sector"])

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    start = datetime.utcnow()
    print(f"\n{'═'*60}")
    print(f"S&P 500 Screener — {start.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"{'═'*60}\n")

    # 1. Constituents
    constituents = fetch_constituents()

    # 2. Rank by market cap
    universe = rank_by_market_cap(constituents)
    tickers  = universe["ticker"].tolist()

    # 3. Price history (bulk download — fast)
    price_histories = fetch_price_history(tickers)
    spy_hist = price_histories.get("SPY", [])

    # 4 & 5. Fundamentals + scoring
    print(f"\nScoring {len(tickers)} stocks...\n")
    processed, errors = 0, 0
    upsert_buffer = []

    for i, row in universe.iterrows():
        ticker = row["ticker"]
        try:
            fund      = fetch_fundamentals(ticker)
            hist      = price_histories.get(ticker, [])
            scores    = score_stock(fund, hist, spy_hist)

            db_row = {
                "ticker":       ticker,
                "name":         row["name"],
                "sector":       row["sector"],
                **scores,
                "price_history": hist,
                "spy_history":   spy_hist,
                "last_updated":  datetime.utcnow().isoformat(),
                "data_source":   "yfinance",
            }
            upsert_buffer.append(db_row)
            processed += 1

            rank = i + 1
            print(f"  ✓ {ticker:<6} #{rank:<4} score={scores['composite_score']:>5.1f}  "
                  f"growth={scores['growth_score']:>4.0f}  "
                  f"mom={scores['momentum_score']:>4.0f}  "
                  f"val={scores['valuation_score']:>4.0f}")

            # Upsert in batches of 25
            if len(upsert_buffer) >= BATCH_SIZE:
                upsert_batch(upsert_buffer)
                upsert_buffer = []
                time.sleep(BATCH_DELAY)

        except Exception as e:
            print(f"  ✗ {ticker:<6} {e}")
            errors += 1

    # Flush remaining
    if upsert_buffer:
        upsert_batch(upsert_buffer)

    elapsed = (datetime.utcnow() - start).seconds
    print(f"\n{'═'*60}")
    print(f"Done in {elapsed}s — {processed} scored, {errors} errors")
    print(f"{'═'*60}\n")

    if errors == processed:
        raise SystemExit("All stocks failed — check yfinance connectivity")

if __name__ == "__main__":
    main()
