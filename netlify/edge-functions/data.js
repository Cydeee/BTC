// netlify/edge-functions/data.js

export const config = { path: ["/data","/data.json"], cache: "manual" };

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  try {
    const payload = await buildDashboardData();
    payload.timestamp = Date.now();
    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=0, must-revalidate",
        "CDN-Cache-Control": "public, s-maxage=60, must-revalidate"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
}

/* ───────── Helpers ───────── */

// Your Cloudflare Worker URL
const PROXY_BASE = "https://binance-worker.charles-coursel.workers.dev/?path=";

/**
 * Fetch JSON via your Worker, routing to the correct Binance host:
 *  - /fapi/ → USD‑M futures
 *  - /dapi/ → COIN‑M delivery futures
 *  - everything else → Spot
 */
async function proxyJson(path) {
  // Worker will inspect the raw path, so just forward it
  const url = PROXY_BASE + encodeURIComponent(path);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---- Technical indicators ----
const sma = (arr, p) => arr.slice(-p).reduce((s,x)=>s+x,0)/p;
const ema = (arr, p) => {
  if (arr.length < p) return 0;
  const k = 2/(p+1);
  let e = sma(arr.slice(0,p), p);
  for (let i = p; i < arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
};
const rsi = (arr, p) => {
  if (arr.length < p+1) return 0;
  let up=0, down=0;
  for (let i=1;i<=p;i++) {
    const d = arr[i]-arr[i-1];
    if (d>0) up+=d; else down-=d;
  }
  let avgUp=up/p, avgDown=down/p;
  for (let i=p+1;i<arr.length;i++) {
    const d = arr[i]-arr[i-1];
    avgUp = (avgUp*(p-1) + Math.max(d,0))/p;
    avgDown = (avgDown*(p-1) + Math.max(-d,0))/p;
  }
  return avgDown===0 ? 100 : 100 - 100/(1 + avgUp/avgDown);
};
const atr = (h,l,c,p) => {
  if (h.length < p+1) return 0;
  const tr = [];
  for (let i=1;i<h.length;i++) {
    tr.push(Math.max(
      h[i]-l[i],
      Math.abs(h[i]-c[i-1]),
      Math.abs(l[i]-c[i-1])
    ));
  }
  return sma(tr, p);
};
const roc = (arr,n) =>
  arr.length >= n+1
    ? ((arr[arr.length-1] - arr[arr.length-1-n]) / arr[arr.length-1-n])*100
    : 0;

// ---- Assemble dashboard ----
async function buildDashboardData() {
  const S="BTCUSDT", L=250;
  const out = { dataA:{}, dataB:null, dataC:{}, dataD:{}, dataE:null, dataF:null, dataG:null, dataH:null, errors:[] };

  // A: Indicators
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await proxyJson(`/fapi/v1/klines?symbol=${S}&interval=${tf}&limit=${L}`);
      const c = kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]);
      const last = c.at(-1)||1;
      const e50=ema(c,50), e200=ema(c,200);
      const macdArr = c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      const macdHist = macdArr.at(-1) - ema(macdArr,9);
      out.dataA[tf] = {
        ema50:+e50.toFixed(2),
        ema200:+e200.toFixed(2),
        rsi14:+rsi(c,14).toFixed(1),
        atrPct:+((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist:+macdHist.toFixed(2)
      };
    } catch(e) {
      out.errors.push(`A[${tf}]: ${e.message}`);
    }
  }

  // B: Funding & Liquidations
  try {
    const fr = await proxyJson(`/fapi/v1/fundingRate?symbol=${S}&limit=1000`);
    const rates=fr.slice(-42).map(x=>+x.fundingRate);
    const mu=rates.reduce((a,b)=>a+b,0)/rates.length;
    const sd=Math.sqrt(rates.reduce((s,x)=>(s+(x-mu)**2),0)/rates.length);
    const fundingZ=sd?((rates.at(-1)-mu)/sd).toFixed(2):"0.00";
    const oiNow = await proxyJson(`/fapi/v1/openInterest?symbol=${S}`);
    const oiH   = await proxyJson(`/futures/data/openInterestHist?symbol=${S}&period=1h&limit=24`);
    const oiDelta = ((+oiNow.openInterest - +oiH[0].sumOpenInterest)/+oiH[0].sumOpenInterest*100).toFixed(1);
    const LQ = await proxyJson(`/raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json`);
    const btc = (LQ.data||[]).find(r=>r.symbol==="BTC")||{};
    out.dataB = {
      fundingZ,
      oiDelta24h: oiDelta,
      liquidations: {
        long1h:btc.long1h||0, short1h:btc.short1h||0,
        long4h:btc.long4h||0, short4h:btc.short4h||0,
        long24h:btc.long24h||0, short24h:btc.short24h||0
      }
    };
  } catch(e) {
    out.dataB={ fundingZ:null, oiDelta24h:null, liquidations:null };
    out.errors.push(`B: ${e.message}`);
  }

  // C: ROC
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await proxyJson(`/fapi/v1/klines?symbol=${S}&interval=${tf}&limit=21`);
      const c = kl.map(r=>+r[4]);
      out.dataC[tf] = { roc10:+roc(c,10).toFixed(2), roc20:+roc(c,20).toFixed(2) };
    } catch(e) {
      out.errors.push(`C[${tf}]: ${e.message}`);
    }
  }

  // D: Volume & CVD
  try {
    const windows = {"15m":0.25,"1h":1,"4h":4,"24h":24};
    out.dataD.cvd={};
    for (const [lbl,hrs] of Object.entries(windows)) {
      const end=Date.now(), start=end-hrs*3600*1000;
      const kl = await proxyJson(`/fapi/v1/klines?symbol=${S}&interval=1m&startTime=${start}&endTime=${end}&limit=1500`);
      let bull=0,bear=0; kl.forEach(k=>(+k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]));
      const agg = await proxyJson(`/fapi/v1/aggTrades?symbol=${S}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; agg.forEach(t=>{ cvd+= t.m? -t.q : +t.q; });
      out.dataD[lbl]={ bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) };
      out.dataD.cvd[lbl]=+cvd.toFixed(2);
    }
    const t24=out.dataD["24h"].totalVol, base={"15m":t24/96,"1h":t24/24,"4h":t24/6};
    out.dataD.relative={};
    for (const lbl of ["15m","1h","4h"]) {
      const r= out.dataD[lbl].totalVol/Math.max(base[lbl],1);
      out.dataD.relative[lbl] = r>2?"very high":r>1.2?"high":r<0.5?"low":"normal";
    }
  } catch(e) {
    out.errors.push(`D: ${e.message}`);
  }

  // E: Stress
  try {
    const b = Math.min(3,Math.abs(+out.dataB.fundingZ||0));
    const l = Math.max(0,(+out.dataB.oiDelta24h||0)/5);
    const vfl = out.dataD.relative["15m"];
    const v = vfl==="very high"?2:vfl==="high"?1:0;
    const imb = Math.abs((out.dataB.liquidations.long24h||0)-(out.dataB.liquidations.short24h||0));
    const ls = Math.min(2,imb/1e6), s=b+l+v+ls;
    out.dataE = { stressIndex:+s.toFixed(2), highRisk:s>=5, components:{biasScore:b,levScore:l,volScore:v,liqScore:ls}, source:"synthetic" };
  } catch(e) {
    out.dataE=null;
    out.errors.push(`E: ${e.message}`);
  }

  // F: VPVR
  try {
    const h4 = await proxyJson(`/fapi/v1/klines?symbol=${S}&interval=4h&limit=96`);
    const d1 = await proxyJson(`/fapi/v1/klines?symbol=${S}&interval=1d&limit=30`);
    const w1 = await proxyJson(`/fapi/v1/klines?symbol=${S}&interval=1w&limit=12`);
    const vp = bars=>{
      const bkt={};
      bars.forEach(b=>{
        const px=(+b[2]+ +b[3]+ +b[4])/3, v=+b[5], k=Math.round(px/100)*100;
        bkt[k]=(bkt[k]||0)+v;
      });
      const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0];
      return { poc, buckets:bkt };
    };
    out.dataF = { vpvr:{"4h":vp(h4),"1d":vp(d1),"1w":vp(w1)} };
  } catch(e) {
    out.errors.push(`F: ${e.message}`);
  }

  // G: Macro (CoinGecko)
  try {
    const g = (await proxyJson(`/api/v3/global`)).data;
    out.dataG = {
      totalMcapT:+(g.total_market_cap.usd/1e12).toFixed(2),
      mcap24hPct:+g.market_cap_change_percentage_24h_usd.toFixed(2),
      btcDominance:+g.market_cap_percentage.btc.toFixed(2),
      ethDominance:+g.market_cap_percentage.eth.toFixed(2)
    };
  } catch(e) {
    out.errors.push(`G: ${e.message}`);
  }

  // H: Sentiment (Fear & Greed)
  try {
    const f0 = (await proxyJson(`/api/fng/?limit=1`.replace("/api/","/api.alternative.me/"))).data?.[0];
    if (!f0) throw new Error("FNG missing");
    out.dataH = { fearGreed:`${f0.value} · ${f0.value_classification}` };
  } catch(e) {
    out.errors.push(`H: ${e.message}`);
  }

  return out;
}
