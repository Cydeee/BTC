// netlify/edge-functions/data.js
// Blocks: A indicators | B derivatives+liquidations | C ROC | D volume+CVD
//         E stress | F structure+VPVR+price | G macro | H sentiment
//         +  xOI stats  | Anchored-VWAP | ADX | Session relative volume

export const config = { path: ["/data", "/data.json"], cache: "manual" };

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

  const wantJson = new URL(request.url).pathname.endsWith("/data.json");

  try {
    const payload = await buildDashboardData();
    payload.timestamp = Date.now();

    const body = wantJson
      ? JSON.stringify(payload)
      : `<!DOCTYPE html><html><body><pre id="dashboard-data">${
          JSON.stringify(payload, null, 2)
        }</pre></body></html>`;

    const headers = wantJson
      ? {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control": "public, s-maxage=60, must-revalidate"
        }
      : {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        };

    return new Response(body, { headers });
  } catch (err) {
    console.error("Edge Function error:", err);
    return new Response("Service temporarily unavailable.", {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
}

async function buildDashboardData () {
  const SYMBOL = "BTCUSDT";
  const LIMIT  = 250;

  const result = {
    dataA: {}, dataB: null, dataC: {}, dataD: {},
    dataE: null, dataF: null, dataG: null, dataH: null, errors: []
  };

  /* helpers */
  const safeJson = async url => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const sma = (a,p)=>a.slice(-p).reduce((s,x)=>s+x,0)/p;
  const ema = (a,p)=>{ if(a.length<p) return 0;
    const k=2/(p+1); let e=sma(a.slice(0,p),p);
    for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k);
    return e;
  };
  const rsi =(a,p)=>{ if(a.length<p+1) return 0;
    let up=0,dn=0;
    for(let i=1;i<=p;i++){ const d=a[i]-a[i-1]; d>=0?up+=d:dn-=d; }
    let au=up/p, ad=dn/p;
    for(let i=p+1;i<a.length;i++){
      const d=a[i]-a[i-1];
      au=(au*(p-1)+Math.max(d,0))/p;
      ad=(ad*(p-1)+Math.max(-d,0))/p;
    }
    return ad ? 100-100/(1+au/ad) : 100;
  };
  const atr=(h,l,c,p)=>{ if(h.length<p+1) return 0;
    const tr=[]; for(let i=1;i<h.length;i++)
      tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
    return sma(tr,p);
  };
  const roc=(a,n)=>a.length>=n+1?((a.at(-1)-a.at(-(n+1)))/a.at(-(n+1)))*100:0;

  // Wilder's ADX helper
  const adx = (h,l,c,p=14)=>{
    if(h.length<p+1) return 0;
    const dmPlus=[], dmMinus=[], tr=[];
    for(let i=1;i<h.length;i++){
      const up=h[i]-h[i-1], dn=l[i-1]-l[i];
      dmPlus.push(up>dn && up>0? up:0);
      dmMinus.push(dn>up && dn>0? dn:0);
      tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
    }
    const smooth = (arr)=>{
      const res=[sma(arr.slice(0,p),p)];
      for(let i=p;i<arr.length;i++) res.push(res.at(-1)-(res.at(-1)/p)+arr[i]);
      return res;
    };
    const tr14=smooth(tr), plus14=smooth(dmPlus), minus14=smooth(dmMinus);
    const dx=[];
    for(let i=0;i<plus14.length;i++){
      const plusDI=plus14[i]/tr14[i]*100, minusDI=minus14[i]/tr14[i]*100;
      const d=Math.abs(plusDI-minusDI)/(plusDI+minusDI||1)*100;
      dx.push(d);
    }
    return +(sma(dx.slice(-p),p).toFixed(2));
  };

  /* BLOCK A ---------------------------------------------------------------- */
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`);
      const c  = kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]), last=c.at(-1)||1;
      const macdArr=c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      result.dataA[tf] = {
        ema50   : +ema(c,50).toFixed(2),
        ema200  : +ema(c,200).toFixed(2),
        rsi14   : +rsi(c,14).toFixed(1),
        atrPct  : +((atr(h,l,c,14)/last)*100).toFixed(2),
        macdHist: +(macdArr.at(-1)-ema(macdArr,9)).toFixed(2)
      };
      // add ADX only for 4h to limit calc load
      if(tf==="4h") result.dataA[tf].adx14 = adx(h,l,c,14);
    } catch(e){ result.errors.push(`A[${tf}]: ${e.message}`); }
  }

  /* BLOCK B  --------------------------------------------------------------- */
  try {
    // Funding Z-score (unchanged)
    const fr   = await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`);
    const rates= fr.slice(-42).map(d=>+d.fundingRate);
    const mean = rates.reduce((s,x)=>s+x,0)/rates.length;
    const sd   = Math.sqrt(rates.reduce((s,x)=>s+(x-mean)**2,0)/rates.length);
    const fundingZ = sd ? ((rates.at(-1)-mean)/sd).toFixed(2) : "0.00";

    // Absolute OI now
    const oiNow  = await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiCurrent = +oiNow.openInterest;

    // 30-day hourly OI history (720 bars)
    const oiHist = await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=720`);
    const histArr = oiHist.map(o=>+o.sumOpenInterest);
    const max30d  = Math.max(...histArr);
    const pctRank = +(histArr.filter(v=>v<=oiCurrent).length / histArr.length * 100).toFixed(1);
    const oiDelta24h = (((oiCurrent - histArr.at(-25)) / histArr.at(-25))*100).toFixed(1);

    // Liquidations (as before)
    const liqRaw = await safeJson("https://raw.githubusercontent.com/Cydeee/Testliquidation/main/data/totalLiquidations.json");
    const btc    = (liqRaw.data||[]).find(r=>r.symbol==="BTC")||{};
    result.dataB = {
      fundingZ, oiDelta24h,
      oiCurrent:+oiCurrent.toFixed(2), oi30dPct:pctRank,
      liquidations:{
        long1h:btc.long1h??0, short1h:btc.short1h??0,
        long4h:btc.long4h??0, short4h:btc.short4h??0,
        long24h:btc.long24h??0, short24h:btc.short24h??0
      }
    };
  }catch(e){ result.dataB={fundingZ:null,oiDelta24h:null,liquidations:null}; result.errors.push("B: "+e.message); }

  /* BLOCK C (unchanged) ---------------------------------------------------- */
  for (const tf of ["15m","1h","4h","1d"]) {
    try{
      const kl = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=21`);
      const c  = kl.map(r=>+r[4]);
      result.dataC[tf] = { roc10:+roc(c,10).toFixed(2), roc20:+roc(c,20).toFixed(2) };
    }catch(e){ result.errors.push(`C[${tf}]: ${e.message}`); }
  }

  /* BLOCK D ---------------------------------------------------------------- */
  try{
    // session relative vol + cvd
    const histH = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1h&limit=240`); // 10 days
    const buckets = { asia:[], eu:[], us:[] };
    histH.forEach(k=>{
      const hr = new Date(+k[0]).getUTCHours();
      const vol= +k[7]; // quote asset vol
      if(hr<8) buckets.asia.push(vol);
      else if(hr<14) buckets.eu.push(vol);
      else if(hr<22) buckets.us.push(vol);
    });
    const rel = arr=>{
      if(arr.length<21) return 1;
      const mean20 = arr.slice(-21,-1).reduce((s,v)=>s+v,0)/20;
      return +(arr.at(-1)/(mean20||1)).toFixed(2);
    };

    result.dataD.sessionRelVol={ asia:rel(buckets.asia), eu:rel(buckets.eu), us:rel(buckets.us) };

    // existing vol + cvd logic ----------------------------------
    const win={ "15m":0.25,"1h":1,"4h":4,"24h":24 }; result.dataD.cvd={};
    for(const [lbl,hrs] of Object.entries(win)){
      const end=Date.now(), start=end-hrs*3600000;
      const kl  = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&startTime=${start}&endTime=${end}&limit=1500`);
      let bull=0,bear=0; for(const k of kl){ +k[4]>=+k[1]?bull+=+k[5]:bear+=+k[5]; }
      const trd = await safeJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&startTime=${start}&endTime=${end}&limit=1000`);
      let cvd=0; for(const t of trd){ const q=+t.q; cvd += t.m? -q : q; }

      result.dataD[lbl] = { bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) };
      result.dataD.cvd[lbl] = +cvd.toFixed(2);
    }
    const tot24=result.dataD["24h"].totalVol, base={ "15m":tot24/96,"1h":tot24/24,"4h":tot24/6 };
    result.dataD.relative={};
    for(const lbl of ["15m","1h","4h"]){
      const r=result.dataD[lbl].totalVol/Math.max(base[lbl],1);
      result.dataD.relative[lbl]=r>2?"very high":r>1.2?"high":r<0.5?"low":"normal";
    }
  }catch(e){ result.errors.push("D: "+e.message); }

  /* BLOCK E  --------------------------------------------------------------- */
  try{
    const b=Math.min(3,Math.abs(+result.dataB.fundingZ||0));
    const lComp=Math.min(3,result.dataB.oi30dPct? (result.dataB.oi30dPct-50)/10 : 0); // leverage skew: >90% = +4 etc.
    const vFlag=result.dataD.relative["15m"]; const v=vFlag==="very high"?2:vFlag==="high"?1:0;
    const liq=result.dataB.liquidations||{}, imb=Math.abs((liq.long24h||0)-(liq.short24h||0));
    const q=Math.min(2,imb/1e6);
    const stress=b+lComp+v+q;
    result.dataE={ stressIndex:+stress.toFixed(2), highRisk:stress>=5,
                   components:{biasScore:b,levScore:lComp,volScore:v,liqScore:q},
                   source:"synthetic" };
  }catch(e){ result.dataE=null; result.errors.push("E: "+e.message); }

  /* BLOCK F ---------------------------------------------------------------- */
  try{
    const bars4h=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=4h&limit=96`);
    const bars1d=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&limit=60`);
    const bars1w=await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1w&limit=60`);
    const vp=b=>{
      const bkt={}; for(const r of b){
        const px=(+r[2]+ +r[3]+ +r[4])/3, key=Math.round(px/100)*100;
        bkt[key]=(bkt[key]||0)+ +r[5];
      }
      const poc=+Object.entries(bkt).sort((a,b)=>b[1]-a[1])[0][0];
      return { poc, buckets:bkt };
    };
    result.dataF={ vpvr:{ "4h":vp(bars4h), "1d":vp(bars1d), "1w":vp(bars1w) } };

    // live price
    const last1m = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1`);
    const live   = +last1m[0][4];
    result.dataF.price = +live.toFixed(2);

    // ------------------------------------------------------------------
    // Anchored VWAP (cycle low)
    const closesWeekly = bars1w.map(r=>+r[4]);
    const lows52 = closesWeekly.slice(-52);
    const idxLow = lows52.indexOf(Math.min(...lows52));
    const anchorIndex = bars1w.length - 52 + idxLow; // absolute index in bars1w

    // accumulate minute klines from anchor date to now (costly); instead use daily bars for approximation
    const anchorTs = +bars1w[anchorIndex][0];
    const dayStart = Math.floor(anchorTs/86400000)*86400000;
    const daily = await safeJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1d&startTime=${dayStart}&limit=1000`);
    let num=0,den=0;
    daily.forEach(r=>{ const price=(+r[2]+ +r[3]+ +r[4])/3; const vol=+r[5]; num+=price*vol; den+=vol; });
    result.dataF.avwapCycle = +(num/den).toFixed(2);
  }catch(e){ result.errors.push("F: "+e.message); }

  /* BLOCK G macro ---------------------------------------------------------- */
  try{
    const gv=await safeJson("https://api.coingecko.com/api/v3/global"), gd=gv.data;
    result.dataG={ totalMcapT:+(gd.total_market_cap.usd/1e12).toFixed(2),
                   mcap24hPct:+gd.market_cap_change_percentage_24h_usd.toFixed(2),
                   btcDominance:+gd.market_cap_percentage.btc.toFixed(2),
                   ethDominance:+gd.market_cap_percentage.eth.toFixed(2) };
  }catch(e){ result.errors.push("G: "+e.message); }

  /* BLOCK H sentiment ------------------------------------------------------ */
  try{
    const fg=await safeJson("https://api.alternative.me/fng/?limit=1"), d=fg.data?.[0];
    if(!d) throw new Error("FNG missing");
    result.dataH={ fearGreed:`${d.value} · ${d.value_classification}` };
  }catch(e){ result.errors.push("H: "+e.message); }

  return result;
}
