// netlify/edge-functions/data.js
// Blocks: A indicators | B derivatives+liquidations | C ROC | D volume+CVD | E stress (bias+lev+vol+liq) | F structure+VPVR | G macro | H sentiment

export const config = { path: ["/data", "/data.json"], cache: "manual" };

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  const wantJson = new URL(request.url).pathname.endsWith("/data.json");
  try {
    const payload = await buildDashboardData(request);
    payload.timestamp = Date.now();
    const body = wantJson
      ? JSON.stringify(payload)
      : `<!DOCTYPE html><html><body><pre id="dashboard-data">${JSON.stringify(
          payload
        )}</pre></body></html>`;
    const hdrs = wantJson
      ? {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control": "public, s-maxage=60, must-revalidate",
        }
      : {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        };
    return new Response(body, { headers: hdrs });
  } catch (err) {
    console.error("Edge Function error", err);
    return new Response("Service temporarily unavailable.", {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function buildDashboardData(request) {
  const SYMBOL = "BTCUSDT";
  const LIMIT = 250;
  const result = {
    dataA: {}, dataB: null, dataC: {}, dataD: {},
    dataE: null, dataF: null, dataG: null, dataH: null, errors: []
  };

  /* helpers */
  const safeJson = async u => { const r = await fetch(u); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  const sma = (a,p)=>a.slice(-p).reduce((s,x)=>s+x,0)/p;
  const ema = (a,p)=>{ if(a.length<p) return 0; const k=2/(p+1); let e=sma(a.slice(0,p),p); for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k); return e; };
  const rsi=(a,p)=>{ if(a.length<p+1) return 0; let up=0,down=0; for(let i=1;i<=p;i++){const d=a[i]-a[i-1]; d>=0?up+=d:down-=d;} let au=up/p,ad=down/p; for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1]; au=(au*(p-1)+Math.max(d,0))/p; ad=(ad*(p-1)+Math.max(-d,0))/p;} return ad?100-100/(1+au/ad):100; };
  const atr=(h,l,c,p)=>{ if(h.length<p+1) return 0; const tr=[]; for(let i=1;i<h.length;i++) tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return sma(tr,p); };
  const roc=(a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;

  /* BLOCK A indicators */
  for(const tf of ["15m","1h","4h","1d"]){
    try{
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const closes=kl.map(r=>+r[4]), highs=kl.map(r=>+r[2]), lows=kl.map(r=>+r[3]), last=closes.at(-1)||1;
      const e50=ema(closes,50), e200=ema(closes,200);
      const macdArr=[]; for(let i=0;i<closes.length;i++){const sub=closes.slice(0,i+1); macdArr.push(ema(sub,12)-ema(sub,26));}
      const macdHist=macdArr.at(-1)-ema(macdArr,9);
      result.dataA[tf]={ ema50:+e50.toFixed(2), ema200:+e200.toFixed(2), rsi14:+rsi(closes,14).toFixed(1), atrPct:+((atr(highs,lows,closes,14)/last)*100).toFixed(2), macdHist:+macdHist.toFixed(2)};
    }catch(e){ result.errors.push(`A[${tf}]: ${e.message}`);} }

  /* BLOCK B derivatives + liquidations */
  try{
    const fr=await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates=fr.slice(-42).map(d=>+d.fundingRate), mean=rates.reduce((s,x)=>s+x,0)/rates.length;
    const sd=Math.sqrt(rates.reduce((s,x)=>s+(x-mean)**2,0)/rates.length);
    const fundingZ=sd?((rates.at(-1)-mean)/sd).toFixed(2):"0.00";
    const oiNow=await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiHist=await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=24`);
    const oiDelta24h=((+oiNow.openInterest-+oiHist[0].sumOpenInterest)/+oiHist[0].sumOpenInterest*100).toFixed(1);
    const RAW="https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json";
    const liqJson=await safeJson(RAW), btc=(liqJson.data||[]).find(r=>r.symbol==="BTC")||{};
    result.dataB={ fundingZ, oiDelta24h, liquidations:{ long1h:btc.long1h??0, short1h:btc.short1h??0, long4h:btc.long4h??0, short4h:btc.short4h??0, long24h:btc.long24h??0, short24h:btc.short24h??0 } };
  }catch(e){ result.dataB={ fundingZ:null, oiDelta24h:null, liquidations:null }; result.errors.push("B: "+e.message);}  

  /* BLOCK C ROC */
  for(const tf of ["15m","1h","4h","1d"]){
    try{
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const closes=kl.map(r=>+r[4]);
      result.dataC[tf]={ roc10:+roc(closes,10).toFixed(2), roc20:+roc(closes,20).toFixed(2) };
    }catch(e){ result.errors.push(`C[${tf}]: ${e.message}`);} }

  /* BLOCK D volume + CVD */
  try{
    const wins={ "15m":0.25,"1h":1,"4h":4,"24h":24 }; result.dataD.cvd={};
    for(const [lbl,hrs] of Object.entries(wins)){
      const end=Date.now(), start=end-hrs*3600000;
      const kl=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start}&endTime=${end}&limit=1500`);
      let bull=0,bear=0; for(const k of kl){ +k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]; }
      const trades=await safeJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; for(const t of trades){ const q=+t.q; cvd += t.m? -q : q; }
      result.dataD[lbl]={ bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) };
      result.dataD.cvd[lbl]=+cvd.toFixed(2);
    }
    const tot24=result.dataD["24h"].totalVol, base={ "15m":tot24/96,"1h":tot24/24,"4h":tot24/6 };
    result.dataD.relative={};
    for(const lbl of ["15m","1h","4h"]){
      const r=result.dataD[lbl].totalVol/Math.max(base[lbl],1);
      result.dataD.relative[lbl]=r>2?"very high":r>1.2?"high":r<0.5?"low":"normal";
    }
  }catch(e){ result.errors.push("D: "+e.message);}  

  /* BLOCK E synthetic stress (bias+lev+vol+liq) */
  try{
    const biasScore=Math.min(3,Math.abs(+result.dataB.fundingZ||0));
    const levScore=Math.max(0,(+result.dataB.oiDelta24h||0)/5);
    const volFlag=result.dataD.relative["15m"], volScore=volFlag==="very high"?2:volFlag==="high"?1:0;
    const liq=result.dataB.liquidations||{}, liqImb=Math.abs((liq.long24h||0)-(liq.short24h||0));
    const liqScore=Math.min(2, liqImb/1e6);   // scale: 0‑2 pts per ~1 M imbalance
    const stress=biasScore+levScore+volScore+liqScore;
    result.dataE={ stressIndex:+stress.toFixed(2), highRisk:stress>=5, components:{biasScore,levScore,volScore,liqScore}, source:"synthetic" };
  }catch(e){ result.dataE=null; result.errors.push("E: "+e.message);}  

  /* BLOCK F structure + VPVR */
  try{
    const bars4h=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=96`);
    const bars1d=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=30`);
    const bars1w=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=12`);
    const vp=(bars)=>{ const bkt={}; for(const b of bars){ const px=(+b[2]+ +b[3]+ +b[4])/3, v=+b[5], key=Math.round(px/100)*100; bkt[key]=(bkt[key]||0)+v; } const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0]; return {poc,buckets:bkt}; };
    result.dataF={ vpvr:{ "4h":vp(bars4h), "1d":vp(bars1d), "1w":vp(bars1w) } };
  }catch(e){ result.errors.push("F: "+e.message);}  

  /* BLOCK G macro */
  try{
    const gv=await safeJson("https://api.coingecko.com/api/v3/global"), gd=gv.data;
    result.dataG={ totalMcapT:+(gd.total_market_cap.usd/1e12).toFixed(2), mcap24hPct:+gd.market_cap_change_percentage_24h_usd.toFixed(2), btcDominance:+gd.market_cap_percentage.btc.toFixed(2), ethDominance:+gd.market_cap_percentage.eth.toFixed(2) };
  }catch(e){ result.errors.push("G: "+e.message);}  

  /* BLOCK H sentiment */
  try{
    const fg=await safeJson("https://api.alternative.me/fng/?limit=1"), f0=fg.data?.[0]; if(!f0) throw new Error("FNG missing");
    result.dataH={ fearGreed:`${f0.value} · ${f0.value_classification}` };
  }catch(e){ result.errors.push("H: "+e.message);}  

  return result;
}
