#!/usr/bin/env node
/*  alert.js  –  Telegram signal bot with CET time & X/6 score display  */

import fs from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ─── ENV ─── */
const { TELEGRAM_BOT_TOKEN:BOT, TELEGRAM_CHAT_ID:CHAT, LIVE_URL:LIVE, HTTPS_PROXY:PROXY } = process.env;
if (!BOT || !CHAT || !LIVE) { console.error("Missing env vars."); process.exit(1); }
const DEBUG  = process.env.DEBUG === "true";
const agent  = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

/* ─── Telegram helper ─── */
async function tg(text){
  await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`,{
    method:"POST",headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:CHAT, text, parse_mode:"Markdown", disable_web_page_preview:true })
  });
}

/* ─── scoring helpers (unchanged rules) ─── */
function add(o,b,p,n){ o[b]+=p; o.details[b].push(n); }
function scoreBuckets(r){
  const A=r.dataA,B=r.dataB,C=r.dataC,D=r.dataD,E=r.dataE;
  const s={long_conf:0,short_conf:0,long_rew:0,short_rew:0,
           details:{long_conf:[],short_conf:[],long_rew:[],short_rew:[]}};

  /* high‑confidence LONG */
  if(A["1h"].ema50>A["1h"].ema200&&A["4h"].ema50>A["4h"].ema200&&A["1h"].macdHist>0) add(s,"long_conf",1,"trend up");
  if(A["15m"].rsi14<30)     add(s,"long_conf",1,"RSI<30");
  if(A["15m"].macdHist>0)   add(s,"long_conf",1,"MACD flip up");
  if(D.relative["15m"]!=="very high"&&A["15m"].atrPct<=1.0) add(s,"long_conf",1,"quiet vol");
  if(E&&E.stressIndex<4)    add(s,"long_conf",1,"low stress");
  if(D.cvd["15m"]>0)        add(s,"long_conf",1,"CVD div");

  /* high‑confidence SHORT */
  if(A["1h"].ema50<A["1h"].ema200&&A["4h"].ema50<A["4h"].ema200&&A["1h"].macdHist<0) add(s,"short_conf",1,"trend down");
  if(A["15m"].rsi14>70)     add(s,"short_conf",1,"RSI>70");
  if(A["15m"].macdHist<0)   add(s,"short_conf",1,"MACD flip dn");
  if(D.relative["15m"]!=="very high"&&A["15m"].atrPct<=1.0) add(s,"short_conf",1,"quiet vol");
  if(E&&E.stressIndex<4)    add(s,"short_conf",1,"low stress");
  if(D.cvd["15m"]<0)        add(s,"short_conf",1,"CVD div");

  /* high‑reward LONG */
  if(D.relative["15m"]==="very high")                               add(s,"long_rew",2,"ignition vol");
  if(C["15m"].roc10>2&&C["15m"].roc10>C["15m"].roc20)               add(s,"long_rew",1,"ROC thrust");
  if(B.fundingZ<=-1.5)                                             add(s,"long_rew",1,"cheap funding");
  if(B.oiDelta24h>5)                                               add(s,"long_rew",1,"OI spike");
  if(E&&E.stressIndex>=5)                                          add(s,"long_rew",1,"crowded stress");

  /* high‑reward SHORT */
  if(D.relative["15m"]==="very high")                              add(s,"short_rew",2,"climax vol");
  if(A["15m"].rsi14>80)                                            add(s,"short_rew",2,"RSI>80");
  if(A["15m"].macdHist<0)                                          add(s,"short_rew",1,"MACD roll");
  if(B.fundingZ>=1.5)                                              add(s,"short_rew",1,"rich funding");
  if(B.oiDelta24h<-5)                                              add(s,"short_rew",1,"OI flush");
  if(E&&E.stressIndex>=5)                                          add(s,"short_rew",1,"crowded stress");

  return s;
}

/* ─── compact audit table ─── */
function logSnapshot(r){
  console.table({
    "RSI15":r.dataA["15m"].rsi14,
    "MACD15":r.dataA["15m"].macdHist,
    "EMA50/200 1h": `${r.dataA["1h"].ema50}|${r.dataA["1h"].ema200}`,
    "VolTag15": r.dataD.relative["15m"],
    "ROC10": r.dataC["15m"].roc10,
    "FundZ": r.dataB.fundingZ,
    "OIΔ24h%": r.dataB.oiDelta24h,
    "Stress": r.dataE?.stressIndex??"n/a"
  });
}

/* ─── main ─── */
(async()=>{
  try{
    const res=await fetch(LIVE,{agent,timeout:20000});
    const raw=await res.json();

    logSnapshot(raw);
    if(raw.errors?.length) console.log("Upstream errs:",raw.errors.slice(0,4));

    const sc=scoreBuckets(raw);
    console.table({Bucket:["long_conf","short_conf","long_rew","short_rew"],
                   Score:[sc.long_conf,sc.short_conf,sc.long_rew,sc.short_rew]});

    const max=6; /* all buckets top at 6 with current weights */
    const sigs=[];
    if(sc.long_conf>=4)  sigs.push({tag:"High‑confidence LONG",score:`${sc.long_conf}/${max}`,det:sc.details.long_conf});
    if(sc.short_conf>=4) sigs.push({tag:"High‑confidence SHORT",score:`${sc.short_conf}/${max}`,det:sc.details.short_conf});
    if(sc.long_rew>=5)   sigs.push({tag:"High‑reward LONG",score:`${sc.long_rew}/${max}`,det:sc.details.long_rew});
    if(sc.short_rew>=5)  sigs.push({tag:"High‑reward SHORT",score:`${sc.short_rew}/${max}`,det:sc.details.short_rew});

    if(!sigs.length){ console.log("No signal."); return; }

    /* dedup */
    const hash=JSON.stringify(sigs.map(o=>o.tag));
    const cache="/tmp/last_signal.json"; let last=""; try{last=JSON.parse(fs.readFileSync(cache)).hash;}catch{}
    if(hash===last){ console.log("Duplicate signal – skipped."); return;}
    fs.writeFileSync(cache,JSON.stringify({hash}));

    /* CET time */
    const cet=new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});

    let msg=`*BTC Intraday Signals*\n_Time: ${cet} CET_\n`;
    for(const o of sigs){
      msg+=`\n*${o.tag}* (score ${o.score})`;
      if(DEBUG) msg+=`\n• ${o.det.join("\n• ")}`;
    }
    if(raw.errors?.length) msg+=`\n_Warn: ${raw.errors.slice(0,3).join("; ")}_`;

    await tg(msg);
    console.log("Telegram alert sent.");

  }catch(err){
    console.error("Script error:",err);
    await tg(`⚠️ *Alert error*: ${err.message}`);
    process.exit(1);
  }
})();
