#!/usr/bin/env node
/*  alert.js  – High-conviction BTC play notifier
    ------------------------------------------------------------
    ENV REQUIRED
      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LIVE_URL
    OPTIONAL
      HTTPS_PROXY, DEBUG, RISK_PCT (default 0.5 %)
*/

import fs   from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────── ENV & helpers ───────── */
const {
  TELEGRAM_BOT_TOKEN:BOT,
  TELEGRAM_CHAT_ID:CHAT,
  LIVE_URL:LIVE,
  HTTPS_PROXY:PROXY,
  DEBUG,
  RISK_PCT
}=process.env;

if(!BOT||!CHAT||!LIVE){ console.error("Missing env"); process.exit(1); }

const agent  = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
const riskPc = parseFloat(RISK_PCT)||0.5;

const tg = (text)=>fetch(
  `https://api.telegram.org/bot${BOT}/sendMessage`,
  { method:"POST", headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({chat_id:CHAT,text,parse_mode:"Markdown",
                         disable_web_page_preview:true}), agent });

const $ = n=>Number(n||0);
const fmt =(n,dec=0)=>n.toLocaleString("en-US",{minimumFractionDigits:dec,maximumFractionDigits:dec});
const fmt$= n=>"$"+fmt(n);
const pct  =(a,b)=>b?((a-b)/b*100):0;

/* ───────── Play detectors (mirror playbook) ───────── */
function detectPlays(d){
  const P=[], price=$(d.dataF.price);
  const HH20=$(d.dataF?.levels?.HH20), LL20=$(d.dataF?.levels?.LL20);
  const fundingZ=parseFloat(d.dataB.fundingZ);
  const liq=d.dataB.liquidations||{};
  const vwap=d.dataF?.levels?.vwap, up=d.dataF?.levels?.vwapUpper, lo=d.dataF?.levels?.vwapLower;
  const oiPct=$(d.dataB.oi30dPct), oiRange=$(d.dataB.oiDelta24h);
  const bandW  = (up&&lo)?pct(up, vwap):null;
  const atrPct = $(d.dataA["15m"].atrPct);
  const adx14  = $(d.dataA["4h"].adx14);

  /* 1 Break-&-Retest */
  if(HH20 && price>HH20*1.001 && d.dataA["4h"].rsi14>55){
    P.push({id:1,dir:"LONG",name:"Break-&-Retest",
            entry:[HH20*1.0005,HH20*1.0015],
            stop:HH20*0.992, tp1:price+price*0.01,
            lev:[5,15]});
  }
  /* 2 AVWAP Reclaim */
  const avwap=$(d.dataF.avwapCycle);
  if(avwap && price>avwap*1.001 && d.dataA["4h"].rsi14>55){
    P.push({id:2,dir:"LONG",name:"AVWAP Reclaim",
            entry:[avwap, avwap*1.001],
            stop:avwap*(1-$(d.dataA["4h"].atrPct)/100),
            tp1:price+price*0.015, lev:[3,8]});
  }
  /* 3 Funding extreme */
  if(Math.abs(fundingZ)>=2){
    const dir=fundingZ>0?"SHORT":"LONG";
    const sign=fundingZ>0?-1:1;
    P.push({id:3,dir,name:"Funding Fade",
            entry:[price],stop:price*(1-sign*0.006),
            tp1:price*(1+sign*0.0075),lev:[5,15]});
  }
  /* 4 Liq cluster */
  const bigLiq=Math.max($(liq.long1h),$(liq.short1h));
  if(bigLiq>=25_000_000){
    const dir=$(liq.short1h)>$(liq.long1h)?"LONG":"SHORT";
    const sign=dir==="LONG"?1:-1;
    P.push({id:4,dir,name:"Liq-Sweep Reversal",
            entry:[price-price*0.0004*sign,price-price*0.0002*sign],
            stop:price-price*0.004*sign,
            tp1:price+price*0.004*sign,lev:[10,50]});
  }
  /* 5 OI squeeze */
  if(oiPct>=95 && Math.abs(oiRange)<=2){
    P.push({id:5,dir:"BREAK",name:"High-OI Squeeze",
            entry:[price], stop:price*0.98, tp1:price*1.04,lev:[5,15]});
  }
  /* 6 EMA pull-back */
  if(adx14>20 && d.dataA["1d"].ema50>d.dataA["1d"].ema200 && price<d.dataA["4h"].ema50){
    P.push({id:6,dir:"LONG",name:"EMA Pull-back",
            entry:[d.dataA["4h"].ema50*0.999],
            stop:d.dataA["4h"].ema50*0.99,
            tp1:d.dataF.levels?.HH20||price*1.02,
            lev:[3,10]});
  }
  /* 7 ORB – needs small box & vol, approximate at 00:20 UTC */
  const now=new Date();
  if(now.getUTCMinutes()===20 && atrPct<0.5 && d.dataD.sessionRelVol?.asia>1.2){
    P.push({id:7,dir:"BREAK",name:"Opening-Range BO",
            entry:[price],stop:price*(1-atrPct/100),tp1:price*(1+atrPct/200),lev:[10,25]});
  }
  /* 8 VWAP bands */
  if(up && price>up && bandW<1){
    P.push({id:8,dir:"SHORT",name:"VWAP Fade",
            entry:[price], stop:price*1.007,
            tp1:vwap,lev:[5,20]});
  }
  if(lo && price<lo && bandW<1){
    P.push({id:8,dir:"LONG",name:"VWAP Fade",
            entry:[price], stop:price*0.993,
            tp1:vwap,lev:[5,20]});
  }
  /* 9 Session kick */
  const hr=now.getUTCHours();
  const roc1h=$(d.dataC["1h"].roc10);
  const sesVol=d.dataD.sessionRelVol;
  if((hr===8||hr===14)&&Math.abs(roc1h)>=0.4 && sesVol?.asia>1.5 || sesVol?.eu>1.5){
    const dir=roc1h>0?"LONG":"SHORT";
    P.push({id:9,dir,name:"Session Kick",
            entry:[price],stop:price*(1-(roc1h/2)/100),
            tp1:price*(1+Math.sign(roc1h)*0.01),
            lev:[5,15]});
  }
  return P;
}

/* ───────── Telegram formatter ───────── */
function buildMsg(p,d){
  const snap=()=>`• FundingZ *${d.dataB.fundingZ}*  |  OI% *${d.dataB.oi30dPct}%*
• ADX4h *${d.dataA["4h"].adx14}*  |  Stress *${d.dataE.stressIndex}*
• SessVol EU *${d.dataD.sessionRelVol.eu}*  |  15m vol *${d.dataD.relative["15m"]}*`;
  const riskUsd = acc => acc*(riskPc/100);
  const sampleSize = riskUsd(10000)/(Math.abs(p.entry[0]-p.stop)*p.lev[1]);
  const cet=new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
  return `
${p.dir==="LONG"?"🟢":"🔴"}  *BTC PERP | Play #${p.id} – ${p.name}*
_Time:_ ${cet}
────────────────
*Direction*    : ${p.dir}
*Entry*        : ${p.entry.map(fmt$).join(" – ")}
*Stop-loss*    : ${fmt$(p.stop)}
*TP 1*         : ${fmt$(p.tp1)}
*Leverage*     : ${p.lev[0]}× – ${p.lev[1]}× (isolated)
*Acct-risk %*  : ${riskPc}%  ⇒ size ≈ ${fmt(sampleSize,2)} USD at max L
────────────────
${snap()}
*Plan*  
Enter within zone, cancel if untouched in 90 min.  Reduce size if new liquidation wave or funding flips extreme.
#BTC #Play${p.id}`.trim();
}

/* ───────── Main loop ───────── */
(async ()=>{
  try{
    const raw = await safeJson(LIVE);
    const plays=detectPlays(raw);
    if(DEBUG) console.log(JSON.stringify(plays,null,2));

    if(!plays.length){ if(DEBUG) await tg("🤖 No high-conviction plays."); return; }

    /* spam guard */
    const cache="/tmp/alert_cache.json";
    let last={ts:0}; try{ last=JSON.parse(fs.readFileSync(cache,"utf8")); }catch{}
    const now=Date.now();
    if(!DEBUG && now-last.ts<3_600_000){ console.log("Muted 60m"); return; }

    for(const p of plays){
      const msg=buildMsg(p,raw);
      await tg(msg);
      if(DEBUG) console.log(msg);
    }
    fs.writeFileSync(cache,JSON.stringify({ts:now}));
  }catch(e){
    console.error(e);
    try{ await tg(`⚠️ Bot error: ${e.message}`);}catch{}
    process.exit(1);
  }
})();
