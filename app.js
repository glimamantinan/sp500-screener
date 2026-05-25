// ─── SUPABASE CONFIG — fill these in ──────────────────────────────────────
const SUPABASE_URL  = "https://rclximpbjovqnongbbmn.supabase.co";
const SUPABASE_ANON = "sb_publishable_v_Uk_SjPV7YcJVSSndPuPg_z3sN8fpC";
// ──────────────────────────────────────────────────────────────────────────

const { useState, useEffect, useMemo } = React;

// ── helpers ───────────────────────────────────────────────────────────────
const fmt = (v, d=1) => v == null ? "—" : Number(v).toFixed(d);
const fmtPct = v => v == null ? "—" : `${(v*100).toFixed(1)}%`;
const fmtB = v => {
  if (v == null) return "—";
  if (v >= 1e12) return `$${(v/1e12).toFixed(1)}T`;
  if (v >= 1e9)  return `$${(v/1e9).toFixed(1)}B`;
  return `$${(v/1e6).toFixed(0)}M`;
};
const scoreColor = s => {
  if (s >= 70) return "#22c55e";
  if (s >= 50) return "#f59e0b";
  return "#ef4444";
};
const SECTOR_COLORS = {
  "Technology":"#3b82f6","Healthcare":"#10b981","Financials":"#f59e0b",
  "Consumer Disc.":"#ec4899","Industrials":"#8b5cf6","Energy":"#f97316",
  "Comm. Services":"#06b6d4","Consumer Staples":"#84cc16","Materials":"#a78bfa",
  "Real Estate":"#fb7185","Utilities":"#67e8f9",
};
const sectorColor = s => SECTOR_COLORS[s] || "#94a3b8";

// ── Supabase fetch ─────────────────────────────────────────────────────────
async function fetchStocks() {
  const url = `${SUPABASE_URL}/rest/v1/sp500_screener?select=*&order=composite_score.desc`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${SUPABASE_ANON}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}`);
  return res.json();
}

// ── Score bar component ────────────────────────────────────────────────────
function ScoreBar({ label, value, max=100, color="#3b82f6" }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:3 }}>
        <span style={{ color:"#94a3b8" }}>{label}</span>
        <span style={{ fontWeight:600 }}>{fmt(value, 0)}</span>
      </div>
      <div style={{ background:"#1e293b", borderRadius:4, height:6 }}>
        <div style={{ width:`${Math.min(100, (value/max)*100)}%`, height:6, borderRadius:4, background:color, transition:"width .4s" }} />
      </div>
    </div>
  );
}

// ── Metric card ────────────────────────────────────────────────────────────
function Metric({ label, value }) {
  return (
    <div style={{ background:"#1e293b", borderRadius:8, padding:"10px 14px" }}>
      <div style={{ fontSize:11, color:"#64748b", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:600 }}>{value}</div>
    </div>
  );
}

// ── Pure SVG bar chart (no Recharts dependency) ────────────────────────────
function ReturnChart({ data }) {
  const W = 400, H = 140, pad = { t:10, r:10, b:30, l:44 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const vals = data.map(d => d.val);
  const maxAbs = Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals)), 1);
  const barW = Math.floor(innerW / data.length * 0.6);
  const barGap = innerW / data.length;
  const zeroY = pad.t + innerH * (maxAbs / (2 * maxAbs));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:"auto" }}>
      {/* zero line */}
      <line x1={pad.l} y1={zeroY} x2={W-pad.r} y2={zeroY} stroke="#334155" strokeWidth={1} />
      {/* gridlines */}
      {[-1,0,1].map(t => {
        const y = pad.t + innerH * (1 - (t*maxAbs/2 + maxAbs)/(2*maxAbs));
        return <line key={t} x1={pad.l} y1={y} x2={W-pad.r} y2={y} stroke="#1e293b" strokeDasharray="3 3" strokeWidth={1} />;
      })}
      {/* bars */}
      {data.map((d, i) => {
        const cx = pad.l + barGap * i + barGap / 2;
        const barH = Math.abs(d.val) / (2 * maxAbs) * innerH;
        const y = d.val >= 0 ? zeroY - barH : zeroY;
        return (
          <g key={d.name}>
            <rect x={cx - barW/2} y={y} width={barW} height={barH}
                  fill={d.val >= 0 ? "#22c55e" : "#ef4444"} rx={2} />
            <text x={cx} y={H - pad.b + 14} textAnchor="middle" fontSize={11} fill="#64748b">{d.name}</text>
            <text x={cx} y={d.val >= 0 ? y - 4 : y + barH + 12}
                  textAnchor="middle" fontSize={10} fill={d.val >= 0 ? "#22c55e" : "#ef4444"}>
              {d.val > 0 ? "+" : ""}{d.val}%
            </text>
          </g>
        );
      })}
      {/* y-axis labels */}
      {[-1,0,1].map(t => {
        const pct = (t * maxAbs).toFixed(0);
        const y = pad.t + innerH * (1 - (t*maxAbs + maxAbs)/(2*maxAbs));
        return <text key={t} x={pad.l-6} y={y+4} textAnchor="end" fontSize={10} fill="#64748b">{pct}%</text>;
      })}
    </svg>
  );
}

// ── Stock detail panel ─────────────────────────────────────────────────────
function StockDetail({ stock, onClose }) {
  const returnData = [
    { name:"1M", val: stock.return_1m != null ? +(stock.return_1m*100).toFixed(2) : null },
    { name:"3M", val: stock.return_3m != null ? +(stock.return_3m*100).toFixed(2) : null },
    { name:"6M", val: stock.return_6m != null ? +(stock.return_6m*100).toFixed(2) : null },
    { name:"12M",val: stock.return_12m!= null ? +(stock.return_12m*100).toFixed(2): null },
  ].filter(d => d.val != null);

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:100, display:"flex", alignItems:"center", justifyContent:"center" }}
         onClick={onClose}>
      <div style={{ background:"#0f1117", border:"1px solid #1e293b", borderRadius:12, width:"min(92vw,760px)", maxHeight:"90vh", overflowY:"auto", padding:28 }}
           onClick={e => e.stopPropagation()}>
        {/* header */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <span style={{ fontSize:24, fontWeight:700 }}>{stock.ticker}</span>
              <span style={{ background: sectorColor(stock.sector)+"22", color: sectorColor(stock.sector),
                             fontSize:11, padding:"2px 8px", borderRadius:20, border:`1px solid ${sectorColor(stock.sector)}44` }}>
                {stock.sector}
              </span>
            </div>
            <div style={{ color:"#94a3b8", fontSize:13, marginTop:4 }}>{stock.company_name || stock.ticker}</div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:16 }}>
            <div style={{ textAlign:"center" }}>
              <div style={{ fontSize:28, fontWeight:700, color: scoreColor(stock.composite_score) }}>
                {fmt(stock.composite_score, 0)}
              </div>
              <div style={{ fontSize:10, color:"#64748b" }}>COMPOSITE</div>
            </div>
            <button onClick={onClose}
              style={{ background:"none", border:"1px solid #334155", color:"#94a3b8", borderRadius:6, padding:"6px 12px", cursor:"pointer" }}>
              ✕ Close
            </button>
          </div>
        </div>

        {/* score bars */}
        <div style={{ background:"#0b0f19", borderRadius:8, padding:16, marginBottom:20 }}>
          <div style={{ fontSize:12, color:"#64748b", marginBottom:12, textTransform:"uppercase", letterSpacing:"0.05em" }}>Score breakdown</div>
          <ScoreBar label="Growth (35%)"    value={stock.growth_score}    color="#3b82f6" />
          <ScoreBar label="Momentum (25%)"  value={stock.momentum_score}  color="#8b5cf6" />
          <ScoreBar label="Valuation (20%)" value={stock.valuation_score} color="#f59e0b" />
          <ScoreBar label="Quality (12%)"   value={stock.quality_score}   color="#10b981" />
          <ScoreBar label="Sentiment (8%)"  value={stock.sentiment_score} color="#ec4899" />
        </div>

        {/* key metrics */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))", gap:10, marginBottom:20 }}>
          <Metric label="Price"         value={stock.price != null ? `$${fmt(stock.price,2)}` : "—"} />
          <Metric label="Market Cap"    value={fmtB(stock.market_cap)} />
          <Metric label="P/E"           value={fmt(stock.pe_ratio)} />
          <Metric label="EPS Growth"    value={fmtPct(stock.eps_growth)} />
          <Metric label="Rev Growth"    value={fmtPct(stock.revenue_growth)} />
          <Metric label="Profit Margin" value={fmtPct(stock.profit_margin)} />
          <Metric label="Beta"          value={fmt(stock.beta)} />
          <Metric label="Dividend Yld"  value={fmtPct(stock.dividend_yield)} />
        </div>

        {/* return chart — pure SVG, no dependencies */}
        {returnData.length > 0 && (
          <div style={{ background:"#0b0f19", borderRadius:8, padding:16 }}>
            <div style={{ fontSize:12, color:"#64748b", marginBottom:12, textTransform:"uppercase", letterSpacing:"0.05em" }}>Period returns (%)</div>
            <ReturnChart data={returnData} />
          </div>
        )}

        <div style={{ fontSize:11, color:"#334155", marginTop:16, textAlign:"right" }}>
          Last updated: {stock.updated_at ? new Date(stock.updated_at).toLocaleDateString("en-GB") : "—"} · Not financial advice
        </div>
      </div>
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────────────────
function App() {
  const [stocks, setStocks]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [search, setSearch]   = useState("");
  const [sector, setSector]   = useState("All");
  const [sortKey, setSortKey] = useState("composite_score");
  const [sortDir, setSortDir] = useState("desc");
  const [selected, setSelected] = useState(null);
  const [tab, setTab]         = useState("screener"); // screener | picks

  useEffect(() => {
    fetchStocks()
      .then(data => { setStocks(data); setLoading(false); })
      .catch(e   => { setError(e.message); setLoading(false); });
  }, []);

  const sectors = useMemo(() => ["All", ...Array.from(new Set(stocks.map(s=>s.sector).filter(Boolean))).sort()], [stocks]);

  const filtered = useMemo(() => {
    let d = stocks;
    if (sector !== "All") d = d.filter(s => s.sector === sector);
    if (search)           d = d.filter(s => s.ticker?.toLowerCase().includes(search.toLowerCase()) ||
                                            (s.company_name||"").toLowerCase().includes(search.toLowerCase()));
    return [...d].sort((a,b) => {
      const av = a[sortKey] ?? -Infinity, bv = b[sortKey] ?? -Infinity;
      return sortDir === "desc" ? bv - av : av - bv;
    });
  }, [stocks, sector, search, sortKey, sortDir]);

  // best per sector for picks tab
  const picks = useMemo(() => {
    const map = {};
    stocks.forEach(s => {
      if (!s.sector) return;
      if (!map[s.sector] || s.composite_score > map[s.sector].composite_score) map[s.sector] = s;
    });
    return Object.values(map).sort((a,b) => b.composite_score - a.composite_score);
  }, [stocks]);

  const toggleSort = key => {
    if (sortKey === key) setSortDir(d => d==="desc"?"asc":"desc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  const colStyle = { padding:"10px 12px", textAlign:"left", fontSize:12, color:"#64748b",
                     cursor:"pointer", userSelect:"none", whiteSpace:"nowrap" };
  const cellStyle = { padding:"10px 12px", fontSize:13, borderBottom:"1px solid #1a2035" };

  const SortIcon = ({k}) => sortKey===k ? (sortDir==="desc"?"▼":"▲") : <span style={{opacity:.3}}>⇅</span>;

  if (loading) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12 }}>
      <div style={{ width:40, height:40, border:"3px solid #1e293b", borderTop:"3px solid #3b82f6",
                    borderRadius:"50%", animation:"spin 1s linear infinite" }} />
      <span style={{ color:"#64748b", fontSize:14 }}>Loading from Supabase…</span>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  if (error) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:8 }}>
      <span style={{ fontSize:32 }}>⚠️</span>
      <span style={{ color:"#ef4444", fontWeight:600 }}>Failed to load data</span>
      <span style={{ color:"#64748b", fontSize:13, maxWidth:400, textAlign:"center" }}>{error}</span>
      <span style={{ color:"#64748b", fontSize:12, marginTop:8 }}>Check your SUPABASE_URL and SUPABASE_ANON in app.js</span>
    </div>
  );

  return (
    <div style={{ maxWidth:1400, margin:"0 auto", padding:"24px 16px" }}>
      {/* header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24, flexWrap:"wrap", gap:12 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, letterSpacing:"-0.02em" }}>S&P 500 Screener</h1>
          <div style={{ fontSize:12, color:"#475569", marginTop:2 }}>
            {stocks.length} stocks · updated {stocks[0]?.updated_at ? new Date(stocks[0].updated_at).toLocaleDateString("en-GB") : "—"}
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          {["screener","picks"].map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ padding:"7px 16px", borderRadius:8, border:"1px solid",
                       borderColor: tab===t ? "#3b82f6" : "#1e293b",
                       background:  tab===t ? "#1d4ed8" : "transparent",
                       color: tab===t ? "#fff" : "#94a3b8",
                       fontSize:13, cursor:"pointer", textTransform:"capitalize" }}>
              {t === "picks" ? "🏆 Sector Picks" : "📊 Screener"}
            </button>
          ))}
        </div>
      </div>

      {/* filters */}
      <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search ticker or company…"
          style={{ padding:"8px 14px", borderRadius:8, border:"1px solid #1e293b", background:"#0b0f19",
                   color:"#e2e8f0", fontSize:13, outline:"none", minWidth:220 }} />
        <select value={sector} onChange={e=>setSector(e.target.value)}
          style={{ padding:"8px 14px", borderRadius:8, border:"1px solid #1e293b", background:"#0b0f19",
                   color:"#e2e8f0", fontSize:13, outline:"none" }}>
          {sectors.map(s => <option key={s}>{s}</option>)}
        </select>
        <div style={{ fontSize:12, color:"#475569", alignSelf:"center" }}>{filtered.length} results</div>
      </div>

      {/* ── SCREENER TAB ── */}
      {tab === "screener" && (
        <div style={{ overflowX:"auto", borderRadius:10, border:"1px solid #1e293b" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead style={{ background:"#0b0f19", position:"sticky", top:0, zIndex:10 }}>
              <tr>
                {[
                  ["#","#",40],["Ticker","ticker",70],["Company","company_name",180],
                  ["Sector","sector",130],["Score","composite_score",70],
                  ["Growth","growth_score",70],["Momo","momentum_score",70],
                  ["Value","valuation_score",70],["Quality","quality_score",70],
                  ["1M %","return_1m",70],["3M %","return_3m",70],
                  ["12M %","return_12m",70],["P/E","pe_ratio",65],
                  ["Mkt Cap","market_cap",90],
                ].map(([label, key, w]) => (
                  <th key={key} onClick={()=>toggleSort(key)}
                    style={{ ...colStyle, width:w, minWidth:w }}>
                    {label} <SortIcon k={key} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, idx) => (
                <tr key={s.ticker} onClick={()=>setSelected(s)}
                  style={{ cursor:"pointer", background: idx%2===0?"#0d1220":"transparent",
                           transition:"background .15s" }}
                  onMouseEnter={e=>e.currentTarget.style.background="#1a2540"}
                  onMouseLeave={e=>e.currentTarget.style.background=idx%2===0?"#0d1220":"transparent"}>
                  <td style={{ ...cellStyle, color:"#475569" }}>{idx+1}</td>
                  <td style={{ ...cellStyle, fontWeight:700, color:"#93c5fd" }}>{s.ticker}</td>
                  <td style={{ ...cellStyle, color:"#94a3b8", maxWidth:180, overflow:"hidden",
                               textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.company_name || "—"}</td>
                  <td style={{ ...cellStyle }}>
                    <span style={{ background:sectorColor(s.sector)+"22", color:sectorColor(s.sector),
                                   fontSize:11, padding:"2px 7px", borderRadius:20 }}>
                      {s.sector || "—"}
                    </span>
                  </td>
                  <td style={{ ...cellStyle, fontWeight:700, color:scoreColor(s.composite_score) }}>
                    {fmt(s.composite_score,0)}
                  </td>
                  {["growth_score","momentum_score","valuation_score","quality_score"].map(k=>(
                    <td key={k} style={{ ...cellStyle, color:"#94a3b8" }}>{fmt(s[k],0)}</td>
                  ))}
                  {["return_1m","return_3m","return_12m"].map(k=>(
                    <td key={k} style={{ ...cellStyle, color: s[k]>0?"#22c55e":s[k]<0?"#ef4444":"#94a3b8" }}>
                      {s[k]!=null ? `${(s[k]*100).toFixed(1)}%` : "—"}
                    </td>
                  ))}
                  <td style={{ ...cellStyle, color:"#94a3b8" }}>{fmt(s.pe_ratio)}</td>
                  <td style={{ ...cellStyle, color:"#94a3b8" }}>{fmtB(s.market_cap)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── PICKS TAB ── */}
      {tab === "picks" && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:14 }}>
          {picks.map(s => (
            <div key={s.ticker} onClick={()=>setSelected(s)}
              style={{ background:"#0b0f19", border:`1px solid ${sectorColor(s.sector)}44`,
                       borderRadius:10, padding:18, cursor:"pointer", transition:"border-color .2s" }}
              onMouseEnter={e=>e.currentTarget.style.borderColor=sectorColor(s.sector)}
              onMouseLeave={e=>e.currentTarget.style.borderColor=sectorColor(s.sector)+"44"}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                <div>
                  <div style={{ fontSize:18, fontWeight:700 }}>{s.ticker}</div>
                  <div style={{ fontSize:11, color:"#64748b", marginTop:2 }}>{s.company_name}</div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:22, fontWeight:700, color:scoreColor(s.composite_score) }}>
                    {fmt(s.composite_score,0)}
                  </div>
                  <span style={{ background:sectorColor(s.sector)+"22", color:sectorColor(s.sector),
                                 fontSize:10, padding:"2px 7px", borderRadius:20 }}>{s.sector}</span>
                </div>
              </div>
              <ScoreBar label="Growth"    value={s.growth_score}    color="#3b82f6" />
              <ScoreBar label="Momentum"  value={s.momentum_score}  color="#8b5cf6" />
              <ScoreBar label="Valuation" value={s.valuation_score} color="#f59e0b" />
              <div style={{ display:"flex", gap:8, marginTop:12 }}>
                {["return_1m","return_3m","return_12m"].map((k,i)=>(
                  <div key={k} style={{ flex:1, background:"#1e293b", borderRadius:6, padding:"6px 8px", textAlign:"center" }}>
                    <div style={{ fontSize:10, color:"#64748b" }}>["1M","3M","12M"][i]}</div>
                    <div style={{ fontSize:13, fontWeight:600, color: s[k]>0?"#22c55e":s[k]<0?"#ef4444":"#94a3b8" }}>
                      {s[k]!=null?`${(s[k]*100).toFixed(1)}%`:"—"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* stock detail modal */}
      {selected && <StockDetail stock={selected} onClose={()=>setSelected(null)} />}

      <div style={{ fontSize:11, color:"#1e293b", textAlign:"center", marginTop:24 }}>
        Not financial advice · Data via Supabase · Weekly refresh every Sunday 06:00 UTC
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
