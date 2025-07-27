#!/usr/bin/env node
/*  alert.js  –  Consensus-score bot (CET, adaptive ROC, PoC debounce)
    Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LIVE_URL  [required]
         HTTPS_PROXY (optional)  DEBUG=true (optional)
*/

import fs   from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/*────────────────── ENV ──────────────────*/
const { TELEGRAM_BOT_TOKEN:BOT, TELEGRAM_CHAT_ID:CHAT, LIVE_URL:LIVE, HTTPS_PROXY:PROXY } = process.env;
if(!BOT||!CHAT||!LIVE){console.error("Missing BOT/CHAT/LIVE_URL");process.exit(1);}
const DEBUG = process.env.DEBUG==="true";
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

/*───────────────── Telegram ───────────────*/
const tg = async txt =>
  fetch(`https://api.telegram.org/bot${BOT}/sendMessage`,{
    method:"POST",headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:CHAT, text:txt, parse_mode:"Markdown", disable_web_page_preview:true })
  });

/*──────── Helper‑score engine (refined) ───────*/
function helperScores(r){
  const A=r.dataA,B=r.dataB,C=r.dataC,D=r.dataD,E=r.dataE,F=r.dataF,G=r.dataG,H=r.dataH;
  const safe = v=> (v===undefined||v===null||Number.isNaN(v))?0:v;

  const atrPct = safe(A["15m"].atrPct);                       // already %
  /* Momentum */
  const trend15 = Math.sign(A["15m"].ema50 - A["15m"].ema200) || 0;
  const trend1h = Math.sign(A["1h"].ema50  - A["1h"].ema200) || 0;
  const trend4h = Math.sign(A["4h"].ema50  - A["4h"].ema200) || 0;
  const rsi1h   = A["1h"].rsi14>65?1:A["1h"].rsi14<35?-1:0;

  /* Adaptive thresholds */
  const t10 = 0.4*atrPct, t20 = 0.8*atrPct;

  /* Velocity */
  const roc10 = C["15m"].roc10 >=  t10 ?  1
               :C["15m"].roc10 <= -t10 ? -1 : 0;
  const roc20 = C["15m"].roc20 >=  t20 ?  1
               :C["15m"].roc20 <= -t20 ? -1 : 0;

  /* Volume & Crowd */
  const volRel15 = ({"very high":2,"high":1,"normal":0,"low":-1})[D.relative["15m"]]??0;
  const fundingBias = B.fundingZ<=-0.5?1:B.fundingZ>=0.5?-1:0;
  const oiShift  = B.oiDelta24h>=2?1:B.oiDelta24h<=-2?-1:0;
  const stressFlag = E? (E.stressIndex>=7?2:E.stressIndex>=5?1:0):0;

  /* Liquidation imbalance (1h+4h) */
  const liq=B.liquidations||{};
  const liqImb=(liq.long1h+liq.long4h)-(liq.short1h+liq.short4h);
  const liqBias=Math.abs(liqImb)>1e6?Math.sign(-liqImb):0;

  /* Structure: PoC */
  const lastPx = safe(A["15m"].ema50);
  const poc1d  = safe(F?.vpvr?.["1d"]?.poc);
  let pocDir=0;
  if(poc1d&&lastPx){
    const diffPct=Math.abs(lastPx-poc1d)/poc1d*100;
    if(diffPct>=0.2*atrPct) pocDir=Math.sign(lastPx-poc1d);
  }

  /* Macro & Sentiment */
  const macroDir = G? (G.mcap24hPct>=1?1:G.mcap24hPct<=-1?-1:0):0;
  const fng=H?parseInt(H.fearGreed):50;
  const sentiment = fng>60?1:fng<40?-1:0;

  return {trend15,trend1h,trend4h,rsi1h,roc10,roc20,volRel15,fundingBias,oiShift,stressFlag,liqBias,pocDir,macroDir,sentiment,atrPct,rsi15:A["15m"].rsi14};
}

/*──────── Consensus & direction ───────*/
function consensus(scores){
  const {trend15,rsi1h,roc10,volRel15,fundingBias,liqBias,pocDir,
         trend1h,trend4h,roc20,oiShift,macroDir,stressFlag}=scores;

  const fast = trend15 + rsi1h + roc10 + volRel15 + fundingBias + liqBias + pocDir;   // ±7
  const swing= trend1h + trend4h + roc20 + oiShift + macroDir + stressFlag;           // ±9

  let dir="FLAT", conv="Low";
  if      (fast>=4 || swing>=5){ dir="LONG";  conv="High";}
  else if (fast<=-4|| swing<=-5){ dir="SHORT"; conv="High";}
  else if (fast>=2 || swing>=3){ dir="LONG";  conv="Medium";}
  else if (fast<=-2|| swing<=-3){ dir="SHORT"; conv="Medium";}

  /* Mean‑reversion guard */
  if(dir==="LONG" && scores.rsi15>75 && conv!=="Low") conv = conv==="High"?"Medium":"Low";
  if(dir==="SHORT"&& scores.rsi15<25 && conv!=="Low") conv = conv==="High"?"Medium":"Low";

  return {dir,conv,fast,swing};
}

/*──────── Traffic‑light helper ───────*/
function traffic(scores,dir){
  const s=scores;
  const align = dir==="LONG"?1:-1;
  const tlBlk={
    A:(s.trend15*align>=0 && s.trend1h*align>=0)?"🟢":"🔴",
    B:((s.fundingBias*align>=0) && s.oiShift>=0)?"🟢":(s.fundingBias*align<0)?"🔴":"🟡",
    C:(((s.roc10+s.roc20)*align)>=1)?"🟢":((s.roc10+s.roc20)*align<=-1)?"🔴":"🟡",
    D:(s.volRel15>0)?"🟢":(s.volRel15<0)?"🔴":"🟡",
    E:(s.stressFlag===0)?"🟢":(s.stressFlag>=2?"🔴":"🟡"),
    F:(s.pocDir*align>=0)?"🟢":"🟡",
    G:(s.macroDir*align>0)?"🟢":"🟡",
    H:(s.sentiment*align<0 && Math.abs(s.sentiment)===1)?"🟢":"🟡"
  };
  return ["A","B","C","D","E","F","G","H"].map(k=>tlBlk[k]).join("");
}

/*──────── main ───────*/
(async()=>{
  try{
    const res=await fetch(LIVE,{agent,timeout:20000});
    if(!res.ok) throw new Error(`Fetch ${res.status}`);
    const raw=await res.json();

    const scores=helperScores(raw);
    console.table(scores);

    const sig=consensus(scores);
    console.log("Fast",sig.fast,"Swing",sig.swing,"=>",sig.dir,sig.conv);

    if(sig.conv!=="High"){ console.log("Conviction not High – no alert."); return; }

    /* duplicate suppression */
    const hash=JSON.stringify({d:sig.dir, f:sig.fast, s:sig.swing});
    const cache="/tmp/last_signal.json"; let last="";try{last=JSON.parse(fs.readFileSync(cache)).hash;}catch{}
    if(hash===last){console.log("Same high‑conv signal – skipped.");return;}
    fs.writeFileSync(cache,JSON.stringify({hash}));

    /* CET time */
    const cet=new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});

    /* Build message */
    let msg=`Signal Block | BTC/USD | Time: ${cet}\n`;
    msg+=`🚀 *${sig.dir}* (High conviction)\n`;
    msg+=`🚦 Traffic-Light Summary: ${traffic(scores,sig.dir)}\n\n`;
    msg+=`🧩 Consensus Scores\n• consensusFast: ${sig.fast} – _fast bias_\n• consensusSwing: ${sig.swing} – _swing bias_\n→ Direction: ${sig.dir} / High`;

    if(DEBUG){
      msg+=`\n\nHelper Scores`;
      for(const [k,v] of Object.entries(scores)) msg+=`\n• ${k}: ${v}`;
    }

    await tg(msg);
    console.log("Telegram alert sent.");

  }catch(err){
    console.error("Script error:",err);
    await tg(`⚠️ *Alert script error*: ${err.message}`);
    process.exit(1);
  }
})();
