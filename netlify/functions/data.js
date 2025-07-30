/*  Netlify Node 18 Edge Function – data.js
    Builds a BTC dashboard JSON with live price, indicators, VPVR, levels, and
    extra order‑flow + structure metrics used by the high‑conviction playbook.
    Outbound requests honour HTTPS_PROXY if set.
*/

import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

const AGENT = process.env.HTTPS_PROXY
  ? new HttpsProxyAgent(process.env.HTTPS_PROXY)
  : undefined;

async function safeJson(url) {
  const r = await fetch(url, { agent: AGENT, timeout: 20_000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ───────── Math helpers ───────── */
const sma = (a,p)=>a.slice(-p).reduce((s,v)=>s+v,0)/p;
const ema = (a,p)=>{ if(a.length<p) return 0; const k=2/(p+1); let e=sma(a.slice(0,p),p); for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k); return e; };
const rsi = (a,p)=>{ if(a.length<p+1) return 0; let up=0,dn=0; for(let i=1;i<=p;i++){const d=a[i]-a[i-1]; d>=0?up+=d:dn-=d;} let au=up/p,ad=dn/p; for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1]; au=(au*(p-1)+Math.max(d,0))/p; ad=(ad*(p-1)+Math.max(-d,0))/p;} return ad?100-100/(1+au/ad):100; };
const atr = (h,l,c,p)=>{ if(h.length<p+1) return 0; const tr=[]; for(let i=1;i<h.length;i++) tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return sma(tr,p); };
const roc = (a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;
// Wilder ADX
const adx=(h,l,c,p=14)=>{
  if(h.length<p+1) return 0;
  const dmP=[], dmM=[], tr=[];
  for(let i=1;i<h.length;i++){
    const up=h[i]-h[i-1], dn=l[i-1]-l[i];
    dmP.push(up>dn && up>0?up:0);
    dmM.push(dn>up && dn>0?dn:0);
    tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  }
  const smooth=a=>{const res=[sma(a.slice(0,p),p)]; for(let i=p;i<a.length;i++) res.push(res.at(-1)-(res.at(-1)/p)+a[i]); return res;};
  const tr14=smooth(tr), plus14=smooth(dmP), minus14=smooth(dmM);
  const dx=[]; for(let i=0;i<plus14.length;i++){ const pdi=plus14[i]/(tr14[i]||1)*100, mdi=minus14[i]/(tr14[i]||1)*100; dx.push(Math.abs(pdi-mdi)/(pdi+mdi||1)*100);}  return +(sma(dx.slice(-p),p).toFixed(2)); };

/* ───────── Dashboard builder ───────── */
async function buildDashboardData() {
  const SYMBOL = "BTCUSDT";
  const LIMIT  = 250;

  const out = {
    dataA:{}, dataB:null, dataC:{}, dataD:{}, dataE:null, dataF:null, dataG:null, dataH:null,
    errors:[]
  };

  /* A – Indicators */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c = kl.map(r=>+r[4]), h = kl.map(r=>+r[2]), l = kl.map(r=>+r[3]), last = c.at(-1)||1;
      const macdArr = c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      out.dataA[tf] = {
        ema50:+ema(c,50).toFixed(2),
        ema200:+ema(c,200).toFixed(2),
        rsi14:+rsi(c,14).toFixed(1),
        atrPct:+((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist:+(macdArr.at(-1)-ema(macdArr,9)).toFixed(2)
      };
      if(tf==="4h") out.dataA[tf].adx14 = adx(h,l,c,14);
    } catch(e){ out.errors.push(`A[${tf}]: ${e.message}`); }
  }

  /* B – Derivatives & Liquidations */
  try {
    // funding Z
    const fr = await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates = fr.slice(-42).map(r=>+r.fundingRate);
    const mu = sma(rates,rates.length);
    const sd = Math.sqrt(rates.reduce((s,x)=>s+(x-mu)**2,0)/rates.length);
    const fundingZ = sd?((rates.at(-1)-mu)/sd).toFixed(2):"0.00";

    // open interest — current & 30‑day percentile (500 h)
    const oiNow = await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiCurrent = +oiNow.openInterest;
    const oiHist = await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=500`);
    const histArr = oiHist.map(o=>+o.sumOpenInterest);
    const oi30dPct = +(histArr.filter(v=>v<=oiCurrent).length/histArr.length*100).toFixed(1);
    const base24 = histArr.length>25 ? histArr.at(-25) : histArr[0];
    const oiDelta24h = base24 ? (((oiCurrent-base24)/base24)*100).toFixed(1) : null;

    // liquidations snapshot
    const liqRaw = await safeJson("https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json");
    const btc = (liqRaw.data||[]).find(r=>r.symbol==="BTC")||{};

    out.dataB = {
      fundingZ,
      oiDelta24h,
      oiCurrent:+oiCurrent.toFixed(2),
      oi30dPct,
      liquidations:{
        long1h:btc.long1h||0, short1h:btc.short1h||0,
        long4h:btc.long4h||0, short4h:btc.short4h||0,
        long24h:btc.long24h||0, short24h:btc.short24h||0
      }
    };
  } catch(e){ out.errors.push(`B: ${e.message}`); out.dataB={fundingZ:null,oiDelta24h:null,oiCurrent:null,oi30dPct:null,liquidations:null}; }

  /* C – ROC */
  for (const tf of ["15m","1h","4h","1d"]) {
    try{
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const c = kl.map(r=>+r[4]);
      out.dataC[tf] = { roc10:+roc(c,10).toFixed(2), roc20:+roc(c,20).toFixed(2) };
    } catch(e){ out.errors.push(`C[${tf}]: ${e.message}`);} }

  $1
  }catch(e){ out.errors.push(`D: ${e.message}`); }

  /* E – Synthetic stress index */
  try {
    const bias=Math.min(3, Math.abs(+out.dataB.fundingZ||0));
    const lev=Math.min(3, out.dataB.oi30dPct ? (out.dataB.oi30dPct-50)/10 : 0);
    const vFlag=out.dataD.relative["15m"], vol=vFlag==="very high"?2:vFlag==="high"?1:0;
    const liq=out.dataB.liquidations||{}, imb=Math.abs((liq.long24h||0)-(liq.short24h||0)), liqScore=Math.min(2,imb/1e6);
    const stress=bias+lev+vol+liqScore;
    out.dataE={stressIndex:+stress.toFixed(2), highRisk:stress>=5, components:{biasScore:bias, levScore:lev, volScore:vol, liqScore}, source:"synthetic"};
  }catch(e){ out.errors.push(`E: ${e.message}`); }

  /* F – Structure: VPVR, price, anchored VWAP, intraday levels */
  try {
    const bars4h = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=96`);
    const bars1d = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=60`);
    const bars1w = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=60`);
    const vp=b=>{ const bkt={}; b.forEach(r=>{ const px=(+r[2]+ +r[3]+ +r[4])/3, key=Math.round(px/100)*100; bkt[key]=(bkt[key]||0)+ +r[5]; }); const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0]; return {poc,buckets:bkt}; };
    out.dataF={ vpvr:{"4h":vp(bars4h), "1d":vp(bars1d), "1w":vp(bars1w)} };

    // live price
    const last1m=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1`);
    out.dataF.price=+(+last1m[0][4]).toFixed(2);

    // cycle anchored VWAP (lowest weekly close of last 52w)
    const closesW=bars1w.map(r=>+r[4]), lows52=closesW.slice(-52), idxLow=lows52.indexOf(Math.min(...lows52));
    const anchorTs=+bars1w[bars1w.length-52+idxLow][0];
    const daily=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&startTime=${anchorTs}&limit=1000`);
    let num=0,den=0; daily.forEach(r=>{ const px=(+r[2]+ +r[3]+ +r[4])/3, vol=+r[5]; num+=px*vol; den+=vol; });
    out.dataF.avwapCycle=+(num/den).toFixed(2);

    // intraday levels
    const y=yesterday=>{ const [__,open,high,low,close]=yesterday; const p=(+high+ +low+ +close)/3; return {pivot:p,R1:2*p- +low,S1:2*p- +high}; };
    const yRow=bars1d.at(-2); if(yRow){
      const piv=y(yRow), h1=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=20`);
      const HH20=Math.max(...h1.map(r=>+r[2])), LL20=Math.min(...h1.map(r=>+r[3]));
      const mid=new Date(); mid.setUTCHours(0,0,0,0);
      const vBars=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${mid.getTime()}&limit=1440`);
      let sv=0,sp=0,sp2=0; vBars.forEach(b=>{ const vol=+b[5], px=(+b[1]+ +b[2]+ +b[3]+ +b[4])/4; sv+=vol; sp+=px*vol; sp2+=px*px*vol; });
      const vwap=sp/sv, sigma=Math.sqrt(Math.max(sp2/sv - vwap*vwap,0));
      out.dataF.levels={
        pivot:+piv.pivot.toFixed(2), R1:+piv.R1.toFixed(2), S1:+piv.S1.toFixed(2),
        HH20:+HH20.toFixed(2), LL20:+LL20.toFixed(2),
        vwap:+vwap.toFixed(2), vwapUpper:+(vwap+sigma).toFixed(2), vwapLower:+(vwap-sigma).toFixed(2)
      }; }
  }catch(e){ out.errors.push(`F: ${e.message}`); }

  /* G – Macro */
  try{ const g=await safeJson("https://api.coingecko.com/api/v3/global"); const d=g.data; out.dataG={ totalMcapT:+(d.total_market_cap.usd/1e12).toFixed(2), mcap24hPct:+d.market_cap_change_percentage_24h_usd.toFixed(2), btcDominance:+d.market_cap_percentage.btc.toFixed(2), ethDominance:+d.market_cap_percentage.eth.toFixed(2) }; }catch(e){ out.errors.push(`G: ${e.message}`);}  

  /* H – Sentiment */
  try{ const fg=await safeJson("https://api.alternative.me/fng/?limit=1"); const row=fg.data?.[0]; if(!row) throw new Error("FNG missing"); out.dataH={ fearGreed:`${row.value} · ${row.value_classification}` }; }catch(e){ out.errors.push(`H: ${e.message}`);}  

  return out;
}

/* ───────── Netlify handler ───────── */
export async function handler(){
  try{ const payload=await buildDashboardData(); payload.timestamp=Date.now(); return{ statusCode:200, headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"public, max-age=0, must-revalidate"}, body:JSON.stringify(payload)}; }catch(err){ console.error("Function error:",err); return {statusCode:500, body:JSON.stringify({error:"Service unavailable", details:err.message})}; }
}
