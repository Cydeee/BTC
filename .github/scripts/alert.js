#!/usr/bin/env node
/*  alert.js – BTC high-conviction notifier (5-min cron, 60-min mute) */

import fs from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────── 0 ▸ ENV ---------------------------------------------------------------- */
const {
  TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_CHAT_ID  : CHAT,
  LIVE_URL          : LIVE,
  HTTPS_PROXY       : PROXY,
  DEBUG,
  RISK_PCT
} = process.env;

if (!BOT || !CHAT || !LIVE) {
  console.error("❌  Missing env vars (BOT, CHAT, LIVE_URL)"); process.exit(1);
}

const agent  = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
const riskPc = parseFloat(RISK_PCT) || 0.5;
const isDbg  = DEBUG === "true";

/* ───────── helpers ---------------------------------------------------------------- */
const $   = n => Number(n || 0);
const pct = (a,b)=>b?((a-b)/b*100):0;
const fmt = (n,d=0)=>n.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmt$= n => "$"+fmt(n);
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

/* debug collector */
const LOG=[]; const dbg = m => { if(isDbg) LOG.push(m); };

/* send Telegram (HTML mode) */
async function tg(html){
  const r = await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`,{
    method:"POST",agent,
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({chat_id:CHAT,text:html,parse_mode:"HTML",disable_web_page_preview:true})
  });
  const j = await r.json(); if(isDbg) console.log("TG:",j);
  if(!j.ok) throw new Error(`Telegram error: ${j.description}`);
}

/* safe fetch JSON */
const safeJson = u => fetch(u,{agent,timeout:20_000})
  .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

/* ───────── 1 ▸ distance-aware detectors ------------------------------------------- */
function detectPlays(d){
  const P=[], price=$(d.dataF.price);
  const distOK = (lvl,p=5)=>lvl&&Math.abs(lvl-price)/price*100<=p;

  const HH20=$(d.dataF.levels?.HH20);
  if(HH20) dbg(`HH20=${HH20} Δ=${pct(price,HH20).toFixed(2)}%`);
  if(distOK(HH20)&&price>HH20*1.001){
    P.push({id:1,dir:"LONG",name:"Break-Retest",
            entry:[HH20*1.0005,HH20*1.0015],stop:HH20*0.992,tp1:HH20*1.015,lev:[5,15]});
    dbg("→ Play1 added");
  }

  const avwap=$(d.dataF.avwapCycle);
  const avAge=(Date.now()-$(d.dataF.avwapAnchorTs||0))/864e5;
  dbg(`AVWAP=${avwap} age=${avAge.toFixed(1)}d Δ=${pct(price,avwap).toFixed(2)}%`);
  if(distOK(avwap)&&avAge<=30&&price>avwap*1.001){
    const atr4=$(d.dataA["4h"].atrPct)/100;
    P.push({id:2,dir:"LONG",name:"AVWAP Reclaim",
            entry:[avwap,avwap*1.001],stop:avwap*(1-atr4),tp1:price*1.015,lev:[3,8]});
    dbg("→ Play2 added");
  }

  const fundingZ=parseFloat(d.dataB.fundingZ);
  dbg(`FundingZ=${fundingZ}`);
  if(Math.abs(fundingZ)>=2){
    const dir=fundingZ>0?"SHORT":"LONG",s=dir==="LONG"?1:-1;
    P.push({id:3,dir,name:"Funding Fade",
            entry:[price],stop:price*(1-s*0.006),tp1:price*(1+s*0.0075),lev:[5,15]});
    dbg("→ Play3 added");
  }

  const liq=d.dataB.liquidations||{};
  const bigLiq=Math.max($(liq.long1h),$(liq.short1h));
  const atr15=$(d.dataA["15m"].atrPct);
  dbg(`Liq1h=$${fmt(bigLiq/1e6,0)}M ATR15=${atr15}`);
  if(bigLiq>=25e6&&atr15<=1.5){
    const dir=$(liq.short1h)>$(liq.long1h)?"LONG":"SHORT",s=dir==="LONG"?1:-1;
    P.push({id:4,dir,name:"Liq-Sweep",
            entry:[price-price*0.0003*s],stop:price-price*0.004*s,tp1:price+price*0.004*s,lev:[10,50]});
    dbg("→ Play4 added");
  }

  const oiPct=$(d.dataB.oi30dPct), oiΔ=$(d.dataB.oiDelta24h);
  dbg(`OI%=${oiPct} OIΔ24h=${oiΔ}`);
  if(oiPct>=95&&Math.abs(oiΔ)<=2){
    P.push({id:5,dir:"BREAK",name:"High-OI Squeeze",
            entry:[price],stop:price*0.982,tp1:price*1.04,lev:[5,15]});
    dbg("→ Play5 added");
  }

  const adx14=$(d.dataA["4h"].adx14);
  if(adx14>20&&d.dataA["1d"].ema50>d.dataA["1d"].ema200&&price<d.dataA["4h"].ema50){
    const ema=d.dataA["4h"].ema50;
    P.push({id:6,dir:"LONG",name:"EMA Pull-back",
            entry:[ema*0.999],stop:ema*0.99,tp1:price*1.02,lev:[3,10]});
    dbg("→ Play6 added");
  }

  const now=new Date();
  if(now.getUTCMinutes()===20&&atr15<0.5&&d.dataD.sessionRelVol?.asia>1.2){
    P.push({id:7,dir:"BREAK",name:"Opening-Range",
            entry:[price],stop:price*(1-atr15/100),
            tp1:price*(1+atr15/200),lev:[10,25]});
    dbg("→ Play7 added");
  }

  const vwap=$(d.dataF.levels?.vwap),
        up=$(d.dataF.levels?.vwapUpper),
        lo=$(d.dataF.levels?.vwapLower),
        bandW=(up&&lo)?pct(up,vwap):null;
  if(bandW) dbg(`VWAP band=${bandW.toFixed(2)}%`);
  if(bandW&&bandW<3){
    if(up&&price>up&&distOK(up,3)){
      P.push({id:8,dir:"SHORT",name:"VWAP Fade",
              entry:[price],stop:price*1.007,tp1:vwap,lev:[5,20]});
      dbg("→ Play8-S added");
    }
    if(lo&&price<lo&&distOK(lo,3)){
      P.push({id:8,dir:"LONG",name:"VWAP Fade",
              entry:[price],stop:price*0.993,tp1:vwap,lev:[5,20]});
      dbg("→ Play8-L added");
    }
  }

  const roc1h=$(d.dataC["1h"].roc10), ses=d.dataD.sessionRelVol||{};
  const hr=now.getUTCHours();
  if((hr===8||hr===14)&&Math.abs(roc1h)>=0.4&&(ses.asia>1.5||ses.eu>1.5)){
    const dir=roc1h>0?"LONG":"SHORT",s=dir==="LONG"?1:-1;
    P.push({id:9,dir,name:"Session Kick",
            entry:[price],stop:price*(1-s*0.004),
            tp1:price*(1+s*0.01),lev:[5,15]});
    dbg("→ Play9 added");
  }

  return P;
}

/* helper to print one play in summary */
const playLine = p =>
  `• #${p.id} ${p.name} ${p.dir} @${fmt$(p.entry[0])}${p.entry[1]?`-${fmt$(p.entry[1])}`:""} SL:${fmt$(p.stop)}`;

/* ───────── 2 ▸ HTML builder -------------------------------------------------------- */
function buildMsg(p,d){
  const snap=
`• FundingZ <b>${esc(d.dataB.fundingZ)}</b> | OI30d <b>${esc(d.dataB.oi30dPct)}%</b>
• ADX 4h <b>${esc(d.dataA["4h"].adx14)}</b> | Stress <b>${esc(d.dataE.stressIndex)}</b>
• EU vol <b>${esc(d.dataD.sessionRelVol.eu)}</b> | 15 m vol <b>${esc(d.dataD.relative["15m"])}</b>`;
  const posUsd=(riskPc/100*10_000)*p.lev[1]/Math.abs(p.entry[0]-p.stop);
  const ts=new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
  const icon=p.dir==="LONG"?"🟢":"🔴";

  return `${icon} <b>BTC PERP | Play #${p.id} – ${p.name}</b>
<i>${esc(ts)}</i>

<b>Direction:</b> ${p.dir}
<b>Entry zone:</b> ${p.entry.map(v=>fmt$(v)).join(" – ")}
<b>Stop-loss:</b> ${fmt$(p.stop)}
<b>TP 1:</b> ${fmt$(p.tp1)}
<b>Leverage:</b> ${p.lev[0]}× – ${p.lev[1]}×
<b>Risk:</b> ${riskPc}% → pos ≈ ${fmt(posUsd,1)} USD

${snap}

<b>Plan</b>
Enter within zone; abort if unfilled in 90 min or opposite trigger forms.

#BTC #Play${p.id}`;
}

/* ───────── 3 ▸ main --------------------------------------------------------------- */
(async()=>{
  try{
    const dash = await safeJson(LIVE);

    /* quick globals for summary line */
    const price   = $(dash.dataF.price);
    const HH20    = $(dash.dataF.levels?.HH20);
    const avwap   = $(dash.dataF.avwapCycle);
    const fundingZ= parseFloat(dash.dataB.fundingZ);
    const bigLiq  = Math.max($(dash.dataB.liquidations?.long1h), $(dash.dataB.liquidations?.short1h));

    const plays = detectPlays(dash);

    /* === Audit summary (always printed) ========================================== */
    const headline =
      `ALERT SUMMARY | price=${fmt$(price)}  `+
      (HH20?`HH20Δ=${pct(price,HH20).toFixed(2)}%  `:"")+
      (avwap?`AVWAPΔ=${pct(price,avwap).toFixed(2)}%  `:"")+
      `fundingZ=${fundingZ}  bigLiq=$${fmt(bigLiq/1e6,0)}M  plays=[${plays.map(p=>p.id).join(",")||"none"}]`;
    console.log(headline);
    plays.forEach(p=>console.log(playLine(p)));

    if(isDbg){
      console.log("===== DETAIL TRACE =====");
      console.log(LOG.join("\n"));
      console.log("========================");
    }

    if(!plays.length) return;

    /* mute guard */
    const cache="/tmp/alert_cache.json";
    let last={ts:0}; try{ last=JSON.parse(fs.readFileSync(cache,"utf8")); }catch{}
    if(!isDbg && Date.now()-last.ts<3_600_000){
      console.log("Muted 60-min window"); return;
    }

    for(const p of plays) await tg(buildMsg(p,dash));
    fs.writeFileSync(cache,JSON.stringify({ts:Date.now()}));
    console.log(`✅ Sent ${plays.length} alert(s)`);

  }catch(err){
    console.error("❌",err);
    try{ await tg(esc(`Bot error: ${err.message}`)); }catch{}
    process.exit(1);
  }
})();
