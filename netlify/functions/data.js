/*  Netlify Function  –  data.js  (Node 18 runtime)
    Collects Binance + other metrics and returns a JSON dashboard.
    Outbound requests go through the forward proxy specified by
    the HTTPS_PROXY environment variable (e.g. http://botuser:pass@IP:3128). */

import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";          // makes local testing identical

// ──────────────────────────────────
// Proxy support
// ──────────────────────────────────
const PROXY_URL = process.env.HTTPS_PROXY || "";
const fetchOpts = PROXY_URL ? { agent: new HttpsProxyAgent(PROXY_URL) } : {};

async function safeJson(url) {
  const r = await fetch(url, fetchOpts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ──────────────────────────────────
// Math helpers (unchanged)
// ──────────────────────────────────
const sma = (a,p)=>a.slice(-p).reduce((s,v)=>s+v,0)/p;
const ema = (a,p)=>{ if(a.length<p) return 0; const k=2/(p+1); let e=sma(a.slice(0,p),p); for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k); return e; };
const rsi = (a,p)=>{ if(a.length<p+1) return 0; let up=0,dn=0; for(let i=1;i<=p;i++){const d=a[i]-a[i-1]; d>=0?up+=d:dn-=d;} let au=up/p,ad=dn/p; for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1]; au=(au*(p-1)+Math.max(d,0))/p; ad=(ad*(p-1)+Math.max(-d,0))/p;} return ad?100-100/(1+au/ad):100; };
const atr = (h,l,c,p)=>{ if(h.length<p+1) return 0; const tr=[]; for(let i=1;i<h.length;i++) tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return sma(tr,p); };
const roc = (a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;

// ──────────────────────────────────
// Build dashboard
// ──────────────────────────────────
async function buildDashboardData() {
  const SYMBOL = "BTCUSDT";
  const LIMIT  = 250;
  const out = { dataA:{}, dataB:null, dataC:{}, dataD:{}, dataE:null,
                dataF:null, dataG:null, dataH:null, errors:[] };

  /* A – Indicators */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c=kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]), last=c.at(-1)||1;
      const macdArr = c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      out.dataA[tf] = {
        ema50   : +ema(c,50).toFixed(2),
        ema200  : +ema(c,200).toFixed(2),
        rsi14   : +rsi(c,14).toFixed(1),
        atrPct  : +((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist: +(macdArr.at(-1)-ema(macdArr,9)).toFixed(2)
      };
    } catch(e){ out.errors.push(`A[${tf}]: ${e.message}`); }
  }

  /* B – Funding & OI & Liquidations */
  try {
    const fr = await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates=fr.slice(-42).map(r=>+r.fundingRate);
    const mu=rates.reduce((a,b)=>a+b,0)/rates.length;
    const sd=Math.sqrt(rates.reduce((s,x)=>s+(x-mu)**2,0)/rates.length);
    const fundingZ = sd?((rates.at(-1)-mu)/sd).toFixed(2):"0.00";
    const oiNow = await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiHist= await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=24`);
    const oiDelta24h=((+oiNow.openInterest-+oiHist[0].sumOpenInterest)/+oiHist[0].sumOpenInterest*100).toFixed(1);
    const liqRaw=await safeJson("https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json");
    const btc=(liqRaw.data||[]).find(r=>r.symbol==="BTC")||{};
    out.dataB = { fundingZ, oiDelta24h, liquidations:{
      long1h:btc.long1h||0, short1h:btc.short1h||0,
      long4h:btc.long4h||0, short4h:btc.short4h||0,
      long24h:btc.long24h||0, short24h:btc.short24h||0
    }};
  } catch(e){ out.dataB={fundingZ:null, oiDelta24h:null, liquidations:null}; out.errors.push(`B: ${e.message}`); }

  /* C – ROC */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const c=kl.map(r=>+r[4]);
      out.dataC[tf]={ roc10:+roc(c,10).toFixed(2), roc20:+roc(c,20).toFixed(2) };
    } catch(e){ out.errors.push(`C[${tf}]: ${e.message}`); }
  }

  /* D – Volume & CVD */
  try {
    const win={'15m':0.25,'1h':1,'4h':4,'24h':24}; out.dataD.cvd={};
    for(const [lbl,hours] of Object.entries(win)) {
      const end=Date.now(), start=end-hours*3600_000;
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start}&endTime=${end}&limit=1500`);
      let bull=0,bear=0; kl.forEach(k=>+k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]);
      const agg=await safeJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; agg.forEach(t=>{ cvd+=t.m?-t.q:+t.q; });
      out.dataD[lbl]={ bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) };
      out.dataD.cvd[lbl]=+cvd.toFixed(2);
    }
    const tot24=out.dataD["24h"].totalVol;
    const base={'15m':tot24/96,'1h':tot24/24,'4h':tot24/6};
    out.dataD.relative={};
    for(const lbl of["15m","1h","4h"]){
      const r=out.dataD[lbl].totalVol/Math.max(base[lbl],1);
      out.dataD.relative[lbl]=r>2?"very high":r>1.2?"high":r<0.5?"low":"normal";
    }
  } catch(e){ out.errors.push(`D: ${e.message}`); }

  /* E – Stress index (synthetic) */
  try {
    const bScore=Math.min(3,Math.abs(+out.dataB.fundingZ||0));
    const lScore=Math.max(0,(+out.dataB.oiDelta24h||0)/5);
    const vFlag=out.dataD.relative["15m"];
    const vScore=vFlag==="very high"?2:vFlag==="high"?1:0;
    const liq=out.dataB.liquidations||{};
    const imb=Math.abs((liq.long24h||0)-(liq.short24h||0));
    const liqScore=Math.min(2,imb/1e6);
    const stress=bScore+lScore+vScore+liqScore;
    out.dataE={ stressIndex:+stress.toFixed(2), highRisk:stress>=5,
                components:{biasScore:bScore,levScore:lScore,volScore:vScore,liqScore},
                source:"synthetic" };
  } catch(e){ out.dataE=null; out.errors.push(`E: ${e.message}`); }

  /* F – VPVR */
  try {
    const h4=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=96`);
    const d1=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=30`);
    const w1=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=12`);
    const vp=bars=>{ const bkt={}; bars.forEach(b=>{ const px=(+b[2]+ +b[3]+ +b[4])/3, key=Math.round(px/100)*100; bkt[key]=(bkt[key]||0)+ +b[5]; });
                     const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0]; return {poc,buckets:bkt}; };
    out.dataF={ vpvr:{ "4h":vp(h4), "1d":vp(d1), "1w":vp(w1) } };
  } catch(e){ out.errors.push(`F: ${e.message}`); }

  /* G – Global macro */
  try {
    const gv=await safeJson("https://api.coingecko.com/api/v3/global"), g=gv.data;
    out.dataG={ totalMcapT:+(g.total_market_cap.usd/1e12).toFixed(2),
                mcap24hPct:+g.market_cap_change_percentage_24h_usd.toFixed(2),
                btcDominance:+g.market_cap_percentage.btc.toFixed(2),
                ethDominance:+g.market_cap_percentage.eth.toFixed(2) };
  } catch(e){ out.errors.push(`G: ${e.message}`); }

  /* H – Fear & Greed */
  try {
    const fg=await safeJson("https://api.alternative.me/fng/?limit=1"), d=fg.data?.[0];
    if(!d) throw new Error("FNG missing");
    out.dataH={ fearGreed:`${d.value} · ${d.value_classification}` };
  } catch(e){ out.errors.push(`H: ${e.message}`); }

  return out;
}

// ──────────────────────────────────
// Netlify Function handler
// ──────────────────────────────────
export default async (req, res) => {
  try {
    const payload = await buildDashboardData();
    payload.timestamp = Date.now();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    return res.status(200).json(payload);
  } catch (err) {
    console.error("Function error:", err);
    return res.status(500).json({ error: "Service unavailable", details: err.message });
  }
};
