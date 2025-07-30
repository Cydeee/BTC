#!/usr/bin/env node
/*  alert.js  – High-conviction BTC notifier (5-min cron, 60-min mute)
    ------------------------------------------------------------------
    ENV REQUIRED
      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LIVE_URL
    OPTIONAL
      HTTPS_PROXY, DEBUG=true, RISK_PCT=0.5
*/

import fs   from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────── env ───────── */
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

/* ---------- small helpers ---------- */
const $   = n=>Number(n||0);
const fmt = (n,d=0)=> n.toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmt$= n=>"$"+fmt(n);
const pct =(a,b)=>b?((a-b)/b*100):0;

/* HTML-escape dynamic fields */
const H = s=>String(s)
  .replace(/&/g,"&amp;")
  .replace(/</g,"&lt;")
  .replace(/>/g,"&gt;");

/* Telegram send (HTML mode) */
async function tg(html){
  const res = await fetch(
    `https://api.telegram.org/bot${BOT}/sendMessage`,
    { method:"POST", agent,
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({
        chat_id:CHAT,
        text:html,
        parse_mode:"HTML",
        disable_web_page_preview:true
      })});
  const j=await res.json();
  if(DEBUG) console.log("TG response:", j);
  if(!j.ok) throw new Error(`Telegram error: ${j.description}`);
}

/* safe Json fetch */
const safeJson=url=>fetch(url,{agent,timeout:20_000})
  .then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();});

/* ───────── play detectors ───────── */
function detectPlays(d){
  const P=[], price=$(d.dataF.price);
  const HH20=$(d.dataF?.levels?.HH20), avwap=$(d.dataF.avwapCycle);
  const fundingZ=parseFloat(d.dataB.fundingZ);
  const liq=d.dataB.liquidations||{};
  const vwap=d.dataF?.levels?.vwap,
        up  =d.dataF?.levels?.vwapUpper,
        lo  =d.dataF?.levels?.vwapLower;
  const oiPct=$(d.dataB.oi30dPct), oiΔ=$(d.dataB.oiDelta24h);
  const bandW=(up&&lo)?pct(up,vwap):null;
  const atr15=$(d.dataA["15m"].atrPct), adx14=$(d.dataA["4h"].adx14);
  const now=new Date(), hr=now.getUTCHours();

  if(HH20 && price>HH20*1.001){
    P.push({id:1,dir:"LONG",name:"Break-Retest",
      entry:[HH20*1.0005,HH20*1.0015],stop:HH20*0.992,tp1:HH20*1.015,lev:[5,15]});
  }
  if(avwap && price>avwap*1.001){
    const atr4=$(d.dataA["4h"].atrPct)/100;
    P.push({id:2,dir:"LONG",name:"AVWAP Reclaim",
      entry:[avwap,avwap*1.001],stop:avwap*(1-atr4),tp1:price*1.015,lev:[3,8]});
  }
  if(Math.abs(fundingZ)>=2){
    const dir=fundingZ>0?"SHORT":"LONG", s=dir==="LONG"?1:-1;
    P.push({id:3,dir,name:"Funding Fade",
      entry:[price],stop:price*(1-s*0.006),tp1:price*(1+s*0.0075),lev:[5,15]});
  }
  const bigLiq=Math.max($(liq.long1h),$(liq.short1h));
  if(bigLiq>=25_000_000){
    const dir=$(liq.short1h)>$(liq.long1h)?"LONG":"SHORT", s=dir==="LONG"?1:-1;
    P.push({id:4,dir,name:"Liq-Sweep",
      entry:[price-price*0.0003*s],stop:price-price*0.004*s,tp1:price+price*0.004*s,lev:[10,50]});
  }
  if(oiPct>=95 && Math.abs(oiΔ)<=2){
    P.push({id:5,dir:"BREAK",name:"High-OI Squeeze",
      entry:[price],stop:price*0.982,tp1:price*1.04,lev:[5,15]});
  }
  if(adx14>20 && d.dataA["1d"].ema50>d.dataA["1d"].ema200 &&
     price<d.dataA["4h"].ema50){
    const ema=d.dataA["4h"].ema50;
    P.push({id:6,dir:"LONG",name:"EMA Pull-back",
      entry:[ema*0.999],stop:ema*0.99,tp1:price*1.02,lev:[3,10]});
  }
  if(now.getUTCMinutes()===20 && atr15<0.5 && d.dataD.sessionRelVol?.asia>1.2){
    P.push({id:7,dir:"BREAK",name:"Opening-Range",
      entry:[price],stop:price*(1-atr15/100),tp1:price*(1+atr15/200),lev:[10,25]});
  }
  if(up&&price>up&&bandW<1){
    P.push({id:8,dir:"SHORT",name:"VWAP Fade",
      entry:[price],stop:price*1.007,tp1:vwap,lev:[5,20]});
  }
  if(lo&&price<lo&&bandW<1){
    P.push({id:8,dir:"LONG",name:"VWAP Fade",
      entry:[price],stop:price*0.993,tp1:vwap,lev:[5,20]});
  }
  const roc1h=$(d.dataC["1h"].roc10), ses=d.dataD.sessionRelVol||{};
  if((hr===8||hr===14)&&Math.abs(roc1h)>=0.4&&(ses.asia>1.5||ses.eu>1.5)){
    const dir=roc1h>0?"LONG":"SHORT", s=dir==="LONG"?1:-1;
    P.push({id:9,dir,name:"Session Kick",
      entry:[price],stop:price*(1-s*0.004),tp1:price*(1+s*0.01),lev:[5,15]});
  }
  return P;
}

/* ───────── message builder (HTML) ───────── */
function buildMsg(p,d){
  const snap =
`• FundingZ <b>${H(d.dataB.fundingZ)}</b> &nbsp;|&nbsp; OI30d <b>${H(d.dataB.oi30dPct)}%</b><br>
• ADX4h <b>${H(d.dataA["4h"].adx14)}</b> &nbsp;|&nbsp; Stress <b>${H(d.dataE.stressIndex)}</b><br>
• Vol EU <b>${H(d.dataD.sessionRelVol.eu)}</b> &nbsp;|&nbsp; 15m vol <b>${H(d.dataD.relative["15m"])}</b>`;

  const posUsd=(riskPc/100*10_000)*p.lev[1]/
               Math.abs(p.entry[0]-p.stop);

  const cet=new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
  const header = p.dir==="LONG" ? "🟢" : "🔴";

  return `${header} <b>BTC PERP | Play #${p.id} – ${p.name}</b><br>
<i>${H(cet)} (Paris)</i><br><br>
<b>Direction</b> : ${p.dir}<br>
<b>Entry zone</b> : ${p.entry.map(v=>fmt$(v)).join(" – ")}<br>
<b>Stop-loss</b> : ${fmt$(p.stop)}<br>
<b>TP 1</b>      : ${fmt$(p.tp1)}<br>
<b>Leverage</b>   : ${p.lev[0]}× – ${p.lev[1]}×<br>
<b>Risk</b>       : ${riskPc}% acct → size ≈ ${fmt(posUsd,1)} USD<br><br>
${snap}<br><br>
<b>Plan</b><br>
Enter inside zone; abort if no fill in 90 min or opposite trigger forms.<br><br>
#BTC #Play${p.id}`;
}

/* ───────── main routine ───────── */
(async()=>{
  try{
    const dash = await safeJson(LIVE);
    const plays = detectPlays(dash);
    if(DEBUG) console.log(JSON.stringify(plays,null,2));

    if(!plays.length){
      if(DEBUG) await tg("No high-conviction plays this scan."); return;
    }

    /* mute window 60 min */
    const cache="/tmp/alert_cache.json";
    let last={ts:0}; try{last=JSON.parse(fs.readFileSync(cache,"utf8"));}catch{};
    const now=Date.now();
    if(!DEBUG && now-last.ts<3_600_000){ console.log("Muted 60 min"); return; }

    for(const p of plays){
      const html=buildMsg(p,dash);
      await tg(html);
      if(DEBUG) console.log(html+"\n---");
    }
    fs.writeFileSync(cache,JSON.stringify({ts:now}));
    console.log(`✅  Sent ${plays.length} alert(s)`);
  }catch(err){
    console.error("❌",err);
    try{ await tg(H(`Bot error: ${err.message}`)); }catch{}
    process.exit(1);
  }
})();
