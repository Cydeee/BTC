#!/usr/bin/env node
/*  alert.js  – High-conviction BTC play notifier
    ------------------------------------------------------------------
    ENV REQUIRED
      TELEGRAM_BOT_TOKEN   – bot token from @BotFather
      TELEGRAM_CHAT_ID     – numeric chat/channel ID
      LIVE_URL             – endpoint that returns dashboard JSON
    OPTIONAL
      HTTPS_PROXY          – http://user:pass@host:port
      DEBUG=true           – verbose console logs + no mute
      RISK_PCT             – % equity risk per trade (default 0.5)
*/

import fs   from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────── 0 ▸ ENV & basic utils ───────── */
const {
  TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_CHAT_ID:   CHAT,
  LIVE_URL:           LIVE,
  HTTPS_PROXY:        PROXY,
  DEBUG,
  RISK_PCT
} = process.env;

if (!BOT || !CHAT || !LIVE) {
  console.error("❌  Missing env vars (BOT, CHAT, LIVE_URL)"); process.exit(1);
}

const agent  = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
const riskPc = parseFloat(RISK_PCT) || 0.5;

/* ---------------- Telegram helper ---------------- */
const tg = (text)=> fetch(
  `https://api.telegram.org/bot${BOT}/sendMessage`,
  { method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({
      chat_id:CHAT,
      text,
      parse_mode:"Markdown",
      disable_web_page_preview:true
    }),
    agent });

/* ---------------- fetch helper (missing before) --- */
async function safeJson (url) {
  const r = await fetch(url, { agent, timeout:20_000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------------- small helpers ------------------ */
const $   = n=>Number(n||0);
const fmt = (n,dec=0)=> n.toLocaleString("en-US",{minimumFractionDigits:dec,maximumFractionDigits:dec});
const fmt$= n=>"$"+fmt(n);
const pct = (a,b)=> b ? (a-b)/b*100 : 0;

/* ───────── 1 ▸ Play detectors (nine rules) ───────── */
function detectPlays(d){
  const P=[], price=$(d.dataF.price);

  /* handy extracts */
  const HH20=$(d.dataF?.levels?.HH20), LL20=$(d.dataF?.levels?.LL20);
  const fundingZ=parseFloat(d.dataB.fundingZ);
  const liq=d.dataB.liquidations||{};
  const vwap=d.dataF?.levels?.vwap,
        up  =d.dataF?.levels?.vwapUpper,
        lo  =d.dataF?.levels?.vwapLower;
  const oiPct =$(d.dataB.oi30dPct), oiΔ=$(d.dataB.oiDelta24h);
  const bandW =(up&&lo)?pct(up,vwap):null;
  const atr15 =$(d.dataA["15m"].atrPct);
  const adx14 =$(d.dataA["4h"].adx14);

  /* 1 Break-&-Retest (long) */
  if(HH20 && price>HH20*1.001){
    P.push({id:1,dir:"LONG",name:"Break-&-Retest",
            entry:[HH20*1.0005,HH20*1.0015],
            stop:HH20*0.992, tp1:HH20*1.015,
            lev:[5,15]});
  }
  /* 2 AVWAP reclaim */
  const avwap=$(d.dataF.avwapCycle);
  if(avwap && price>avwap*1.001){
    P.push({id:2,dir:"LONG",name:"AVWAP Reclaim",
            entry:[avwap,avwap*1.001],
            stop:avwap*(1-$(d.dataA["4h"].atrPct)/100),
            tp1:price*1.015,lev:[3,8]});
  }
  /* 3 Funding extreme fade */
  if(Math.abs(fundingZ)>=2){
    const dir=fundingZ>0?"SHORT":"LONG",
          sign=dir==="LONG"?1:-1;
    P.push({id:3,dir,name:"Funding Fade",
            entry:[price],stop:price*(1-sign*0.006),
            tp1:price*(1+sign*0.0075),lev:[5,15]});
  }
  /* 4 Liquidation-sweep reversal */
  const bigLiq=Math.max($(liq.long1h),$(liq.short1h));
  if(bigLiq>=25_000_000){
    const dir=$(liq.short1h)>$(liq.long1h)?"LONG":"SHORT",
          sign=dir==="LONG"?1:-1;
    P.push({id:4,dir,name:"Liq-Sweep Reversal",
            entry:[price-price*0.0003*sign],  // small pull-back
            stop:price-price*0.004*sign,
            tp1:price+price*0.004*sign, lev:[10,50]});
  }
  /* 5 High-OI squeeze */
  if(oiPct>=95 && Math.abs(oiΔ)<=2){
    P.push({id:5,dir:"BREAK",name:"High-OI Squeeze",
            entry:[price],stop:price*0.982,
            tp1:price*1.04,lev:[5,15]});
  }
  /* 6 EMA pull-back */
  if(adx14>20 && d.dataA["1d"].ema50>d.dataA["1d"].ema200 &&
     price<d.dataA["4h"].ema50){
    const ema=d.dataA["4h"].ema50;
    P.push({id:6,dir:"LONG",name:"EMA Pull-back",
            entry:[ema*0.999],stop:ema*0.99,
            tp1:price*1.02,lev:[3,10]});
  }
  /* 7 ORB (approx 00:20 UTC) */
  const now=new Date();
  if(now.getUTCMinutes()===20 && atr15<0.5 && d.dataD.sessionRelVol?.asia>1.2){
    P.push({id:7,dir:"BREAK",name:"Opening-Range Break",
            entry:[price],stop:price*(1-atr15/100),
            tp1:price*(1+atr15/200),lev:[10,25]});
  }
  /* 8 VWAP fade */
  if(up && price>up && bandW<1){
    P.push({id:8,dir:"SHORT",name:"VWAP Fade",
            entry:[price],stop:price*1.007,
            tp1:vwap,lev:[5,20]});
  }
  if(lo && price<lo && bandW<1){
    P.push({id:8,dir:"LONG",name:"VWAP Fade",
            entry:[price],stop:price*0.993,
            tp1:vwap,lev:[5,20]});
  }
  /* 9 Session kick */
  const hr=now.getUTCHours();
  const roc1h=$(d.dataC["1h"].roc10);
  const ses=d.dataD.sessionRelVol||{};
  if((hr===8||hr===14)&&Math.abs(roc1h)>=0.4 && (ses.asia>1.5||ses.eu>1.5)){
    const dir=roc1h>0?"LONG":"SHORT", sign=dir==="LONG"?1:-1;
    P.push({id:9,dir,name:"Session Kick",
            entry:[price],stop:price*(1-sign*0.004),
            tp1:price*(1+sign*0.01),lev:[5,15]});
  }
  return P;
}

/* ───────── 2 ▸ Message builder ───────── */
function buildMsg(p,d){
  /* tiny dashboard snapshot */
  const snap=
`• FundingZ *${d.dataB.fundingZ}* | OI30d *${d.dataB.oi30dPct}%*
• ADX4h *${d.dataA["4h"].adx14}* | Stress *${d.dataE.stressIndex}
• VolRel EU *${d.dataD.sessionRelVol.eu}* | 15m vol *${d.dataD.relative["15m"]}*`;

  /* naive size hint for 10 k equity */
  const posUsd = riskPc/100*10_000*p.lev[1]/Math.abs(p.entry[0]-p.stop);

  const cet = new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
  return `
${p.dir==="LONG"?"🟢":"🔴"} *BTC PERP | Play #${p.id} – ${p.name}*
_Time:_ ${cet}
────────────────
*Direction*  : ${p.dir}
*Entry zone* : ${p.entry.map(fmt$).join(" – ")}
*Stop-loss*  : ${fmt$(p.stop)}
*TP 1*       : ${fmt$(p.tp1)}
*Leverage*   : ${p.lev[0]}× – ${p.lev[1]}×
*Risk*       : ${riskPc}% acct ➜ size ≈ ${fmt(posUsd,2)} USD @ max L
────────────────
${snap}
*Plan*  
Enter inside zone; abort if entry not tagged within 90 min or new opposite-trigger appears.
#BTC #Play${p.id}`.trim();
}

/* ───────── 3 ▸ Main routine ───────── */
(async()=>{
  try{
    const dash = await safeJson(LIVE);
    const plays = detectPlays(dash);
    if(DEBUG) console.log(JSON.stringify(plays,null,2));

    if(!plays.length){
      if(DEBUG) await tg("🤖 No high-conviction plays in this scan."); return;
    }

    /* spam guard 60 min */
    const cachePath="/tmp/alert_cache.json";
    let last={ts:0}; try{last=JSON.parse(fs.readFileSync(cachePath,"utf8"));}catch{}
    const now=Date.now();
    if(!DEBUG && now-last.ts<3_600_000){
      console.log("🔇  Alerts muted (60 min window)."); return;
    }

    for(const p of plays){
      const msg=buildMsg(p,dash);
      await tg(msg);
      if(DEBUG) console.log(msg);
    }
    fs.writeFileSync(cachePath,JSON.stringify({ts:now}));
    console.log(`✅  Sent ${plays.length} alert(s).`);

  }catch(err){
    console.error("❌ Script error:", err);
    try{ await tg(`⚠️ Alert script error: ${err.message}`);}catch{}
    process.exit(1);
  }
})();
