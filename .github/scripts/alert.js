#!/usr/bin/env node
/*  alert.js – BTC notifier (5-min cron, 60-min mute)
    v2 ▸ adds unified Quality-score (1-10) with per-play weights & tiered bonuses.
           Alerts STILL print when a setup is below its gate – they’re just labelled.

    v2.3 ▸ regime-aware gating (trend vs range) + robustness
      - Detect HTF regime (4h/1d) and LTF regime (15m) once per tick
      - Adjust per-play gates or deny plays that don’t fit the regime
      - Keeps Telegram output identical in format (same lines/labels/emojis)
      - Retains earlier fixes: sizing, TTL, A-tier bypass, robust fetch, etc.
*/

import fs   from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────── 0 ▸ ENV ---------------------------------------------------------------- */
const {
  TELEGRAM_BOT_TOKEN: BOT,
  TELEGRAM_CHAT_ID  : CHAT,
  LIVE_URL          : LIVE,
  HTTPS_PROXY       : PROXY,
  DEBUG,
  RISK_PCT,
  ACCOUNT_EQUITY,
  FETCH_TIMEOUT_MS,
  FETCH_RETRIES,
  SOFT_FAIL
} = process.env;

if (!BOT || !CHAT || !LIVE) {
  console.error("❌  Missing env vars (BOT, CHAT, LIVE_URL)"); process.exit(1);
}

const agent        = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
const riskPc       = parseFloat(RISK_PCT) || 0.5;
const acctEq       = parseFloat(ACCOUNT_EQUITY) || 10_000; // for sizing display only
const isDbg        = DEBUG === "true";
const fetchTimeout = parseInt(FETCH_TIMEOUT_MS || "", 10) || 45_000;
const fetchRetries = parseInt(FETCH_RETRIES || "", 10) || 2; // total attempts = retries+1
const softFail     = SOFT_FAIL === "true";

/* ───────── helpers ---------------------------------------------------------------- */
const $   = n => Number(n || 0);
const pct = (a,b)=>b?((a-b)/b*100):0;
const fmt = (n,d=0)=>Number(n||0).toLocaleString("en-US",{minimumFractionDigits:d,maximumFractionDigits:d});
const fmt$= n => "$"+fmt(n);
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const LOG=[]; const dbg = m => { if(isDbg) LOG.push(m); };

async function tg(html){
  const r=await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`,{
    method:"POST",agent,
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({chat_id:CHAT,text:html,parse_mode:"HTML",disable_web_page_preview:true})
  });
  const j=await r.json(); if(isDbg) console.log("TG:",j);
  if(!j.ok) throw new Error(`Telegram error: ${j.description}`);
}

// Retry + backoff wrapper for node-fetch v3+
async function safeJson(u, opt) {
  const { timeoutMs = fetchTimeout, retries = fetchRetries } =
    typeof opt === "number" ? { timeoutMs: opt, retries: fetchRetries } :
    (opt || {});

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(u, { agent, signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (err) {
      const isAbort = err?.name === "AbortError" || err?.type === "aborted";
      dbg(`safeJson attempt ${attempt + 1} failed: ${isAbort ? "AbortError" : err?.message}`);
      if (attempt === retries) throw err;
      const wait = Math.min(30_000, (500 << attempt) + Math.floor(Math.random() * 300)); // exp backoff + jitter
      await new Promise(res => setTimeout(res, wait));
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ───────── 1 ▸ quality-score engine ---------------------------------------------- */

/* per-factor weights (align, momentum, crowd, structure, risk) */
const WEIGHTS={
  default:[1,1,1,1,1],
  1:[1.0,1.0,1.0,1.2,0.8],
  2:[1.0,1.0,1.0,1.2,0.8],
  3:[0.7,1.0,1.5,0.6,1.2],
  4:[0.8,1.0,1.3,0.7,1.2],
  5:[1.0,1.0,1.2,0.9,0.9],
  6:[0.9,1.1,1.0,1.0,1.0],
  7:[0.9,1.2,1.1,0.8,1.0],
  8:[1.0,1.0,1.3,1.0,0.7],
  9:[1.0,1.2,1.2,0.9,0.7]
};

/* minimal gates */
const MIN_GATE={1:6,2:6,3:5,4:5,5:6,6:5,7:5,8:5,9:5};

/* tiered catalyst bonuses (+0/+1/+2) */
function vwapBandWidthPct(d){
  const up=$(d.dataF.levels?.vwapUpper), vw=$(d.dataF.levels?.vwap), lo=$(d.dataF.levels?.vwapLower);
  if(up && lo && vw) return ((up-lo)/(2*vw))*100; // symmetric width around mid
  if(up && vw)         return pct(up,vw);         // fallback to original behavior
  return null;
}
function playBonus(p,d){
  const liq=d.dataB.liquidations||{};
  const liq1h=Math.max($(liq.long1h),$(liq.short1h));
  const bandW=vwapBandWidthPct(d);
  const neckBreak=d.dataF.neckBreak;

  switch(p.id){
    case 2:  // AVWAP reclaim
      if(neckBreak){
        if(bandW!==null && bandW<=1.5) return 2;
        return 1;
      }
      return 0;
    case 4:  // Liq-Sweep
      if(liq1h>=80e6 || neckBreak) return 2;
      if(liq1h>=40e6) return 1;
      return 0;
    case 8:  // VWAP fade
      if(neckBreak){
        if(bandW!==null && bandW<=1.5) return 2;
        if(bandW!==null && bandW<=2.5) return 1;
      }
      return 0;
    default: return 0;
  }
}

/* compute five sub-factors, apply play-weights, add bonus, return 1-10 */
function computeQualityScore(d,play){
  const price=$(d.dataF.price);

  /* 1 ▸ Alignment (with tolerance & neutral handling) */
  const tol=0.0005; // ~0.05%
  const sign = v => (v>tol)? 1 : (v<-tol? -1 : 0);
  const tSign = tf=>{
    const ema50=$(d.dataA[tf].ema50);
    return sign((price-ema50)/price);
  };
  const a15=tSign("15m"), a1h=tSign("1h"), a4h=tSign("4h");
  const nonZero=[a15,a1h,a4h].filter(x=>x!==0);
  const allSame = nonZero.length===3 && nonZero.every(x=>x===nonZero[0]);
  const anyTwoSame = (a15!==0 && a15===a1h) || (a15!==0 && a15===a4h) || (a1h!==0 && a1h===a4h);
  const align = allSame ? 2 : anyTwoSame ? 1 : 0;

  /* 2 ▸ Momentum impulse */
  const roc10=$(d.dataC["15m"].roc10), roc20=$(d.dataC["15m"].roc20);
  const atrPct15=$(d.dataA["15m"].atrPct);
  const impulse = Math.max(Math.abs(roc10),Math.abs(roc20));
  const momentum = impulse >= atrPct15*2 ? 2 : impulse >= atrPct15 ? 1 : 0;

  /* 3 ▸ Liquidity & crowd (neutral for BREAK plays) */
  const relVol=d.dataD.relative["15m"]; const volHigh=relVol==="high"||relVol==="very high";
  const fundingZ=parseFloat(d.dataB.fundingZ);
  const liq=d.dataB.liquidations||{};
  const isLong  = play.dir==="LONG";
  const isShort = play.dir==="SHORT";
  const isBreak = play.dir==="BREAK";
  const fundOpp = isBreak ? false : (isLong ? fundingZ<0 : fundingZ>0);
  const liqBias = isBreak ? false : (isLong ? $(liq.short1h)>$(liq.long1h) : $(liq.long1h)>$(liq.short1h));
  const crowd = (volHigh && fundOpp && liqBias)?2 : ((volHigh&&fundOpp)||(fundOpp&&liqBias)||(volHigh&&liqBias))?1:0;

  /* 4 ▸ Structure confluence (ATR-scaled proximity) */
  const vwap=$(d.dataF.levels?.vwap); const poc=$(d.dataF.vpvr?.["4h"]?.poc); const neck=$(d.dataF.neckline);
  const atr15 = $(d.dataA["15m"].atrPct);
  const tolPct = Math.max(0.35*atr15, 0.5); // min 0.5%, scales up with ATR
  const near = lvl=>lvl && Math.abs(price-lvl)/price*100<=tolPct;
  let confl=0;
  if(near(vwap)) confl++;
  if(near(poc))  confl++;
  if(neck && near(neck)) confl++;
  const structure = confl>=2?2:confl>=1?1:0;

  /* 5 ▸ Risk backdrop */
  const stress=$(d.dataE.stressIndex);
  const risk = stress<3?2:stress<5?1:0;

  const rawFactors=[align,momentum,crowd,structure,risk];

  /* weighting & scaling */
  const w = WEIGHTS[play.id] || WEIGHTS.default;
  const weighted = rawFactors.reduce((s,v,i)=>s+v*w[i],0);
  const maxRaw   = w.reduce((s,x)=>s+x,0)*2;
  let score = Math.round((weighted/maxRaw)*10);

  /* catalyst bonus */
  score = Math.min(10, score + playBonus(play,d));

  return score;
}

/* ───────── 1.5 ▸ regime detection & gate adjusters -------------------------------- */

/* Classify market regime using available fields */
function computeRegime(d){
  const price=$(d.dataF.price);
  const ema50d=$(d.dataA["1d"]?.ema50);
  const ema200d=$(d.dataA["1d"]?.ema200);
  const ema50_4h=$(d.dataA["4h"]?.ema50);
  const adx4h=$(d.dataA["4h"]?.adx14);
  const relVol15=d.dataD?.relative?.["15m"];
  const volHigh15 = relVol15==="high" || relVol15==="very high";
  const atr15=$(d.dataA["15m"]?.atrPct);        // %
  const roc15=Math.abs($(d.dataC["15m"]?.roc10)); // %
  const bandW=vwapBandWidthPct(d);              // %

  // HTF trend using EMAs and ADX + price location
  const emaTrendUp   = ema50d && ema200d && ema50d > ema200d;
  const emaTrendDown = ema50d && ema200d && ema50d < ema200d;
  const adxStrong    = $(adx4h) >= 25;
  const above4h50    = price > $(ema50_4h);
  const below4h50    = price < $(ema50_4h);

  let htf="range";
  if ((emaTrendUp && above4h50) || (adxStrong && above4h50)) htf="up";
  else if ((emaTrendDown && below4h50) || (adxStrong && below4h50)) htf="down";

  // LTF compression/expansion
  const bandOK = bandW!=null && bandW <= 2.0;
  const lowATR = atr15!=null && atr15 <= 0.8;
  const compression = !!(bandOK && lowATR && !volHigh15);
  const expansion   = !compression && ((roc15!=null && atr15!=null && roc15 >= atr15) || volHigh15);

  const regime = { htf, adxStrong, ltfCompression: compression, ltfExpansion: expansion, bandW, atr15, relVol15 };
  dbg(`Regime: htf=${htf}, adxStrong=${adxStrong}, ltfCompression=${compression}, ltfExpansion=${expansion}, bandW=${bandW?.toFixed?.(2)}%, atr15=${atr15}`);
  return regime;
}

/* Per-signal regime-aware gate adjustment (or denial) */
function regimeAdjustGate(p, d, R){
  let gateAdj = 0;
  let deny = false;

  const oppToHTF =
    (R.htf==="up"   && p.dir==="SHORT") ||
    (R.htf==="down" && p.dir==="LONG");

  switch(p.id){
    /* Trend continuation plays */
    case 1: // HH20 Break-Retest (LONG)
    case 2: // AVWAP Reclaim (LONG)
    case 6: // EMA Pull-back (LONG)
    case 9: // Session Kick (LONG/SHORT)
      if(R.htf==="range") gateAdj += 1;                  // tougher in ranges
      if(R.adxStrong && oppToHTF) gateAdj += 2;          // much tougher against strong trend
      break;

    /* Mean-reversion plays */
    case 4: // Liq-Sweep
    case 8: // VWAP Fade
      if(R.adxStrong && R.htf!=="range" && !d.dataF.neckBreak) gateAdj += 2; // demand more on strong trend unless neckBreak
      if(R.ltfExpansion && !R.ltfCompression) gateAdj += 1;  // expansion regime: fades are trickier
      break;

    /* Breakout from balance (needs compression first) */
    case 5: // High-OI Box (BREAK)
    case 7: // Opening-Range (BREAK)
      if(!R.ltfCompression){
        deny = true; // not a balance → skip (keeps TG quiet)
        dbg(`Regime deny: Play #${p.id} requires LTF compression`);
      }
      break;

    /* Contrarian crowd play */
    case 3: // Funding Fade
      if(R.adxStrong){
        // Extra tough if fading a strong HTF trend
        if(oppToHTF) gateAdj += 2;
        else gateAdj += 1;
      }
      break;

    default: break;
  }

  return { gateAdj, deny };
}

/* ───────── 2 ▸ play generator ------------------------------------------------------ */
function detectPlays(d){
  const plays=[], price=$(d.dataF.price);
  const distOK =(lvl,p=5)=>lvl&&Math.abs(lvl-price)/price*100<=p;

  /* ------------------------------------------------ Play #1 HH20 Break-Retest */
  const HH20=$(d.dataF.levels?.HH20);
  if(distOK(HH20)&&price>HH20*1.001){
    plays.push({id:1,dir:"LONG",name:"Break-Retest",
      entry:[HH20*1.0005,HH20*1.0015],stop:HH20*0.992,tp1:HH20*1.015,lev:[5,15]});
  }

  /* ------------------------------------------------ Play #2 AVWAP Reclaim */
  const avwap=$(d.dataF.avwapCycle);
  const avAge=(Date.now()-$(d.dataF.avwapAnchorTs||0))/864e5;
  if(distOK(avwap)&&avAge<=30&&price>avwap*1.001){
    const atr4=$(d.dataA["4h"].atrPct)/100;
    plays.push({id:2,dir:"LONG",name:"AVWAP Reclaim",
      entry:[avwap,avwap*1.001],stop:avwap*(1-atr4),tp1:price*1.015,lev:[3,8]});
  }

  /* ------------------------------------------------ Play #3 Funding Fade */
  const fundingZ=parseFloat(d.dataB.fundingZ);
  if(Math.abs(fundingZ)>=2){
    const dir=fundingZ>0?"SHORT":"LONG",s=dir==="LONG"?1:-1;
    plays.push({id:3,dir,name:"Funding Fade",
      entry:[price],stop:price*(1-s*0.006),tp1:price*(1+s*0.0075),lev:[5,15]});
  }

  /* ------------------------------------------------ Play #4 Liq-Sweep */
  const liq=d.dataB.liquidations||{};
  const bigLiq=Math.max($(liq.long1h),$(liq.short1h));
  const atr15=$(d.dataA["15m"].atrPct);
  if(bigLiq>=25e6&&atr15<=1.5){
    const dir=$(liq.short1h)>$(liq.long1h)?"LONG":"SHORT",s=dir==="LONG"?1:-1;
    // widened tiny front-run to ~0.07% for reliability
    plays.push({id:4,dir,name:"Liq-Sweep",
      entry:[price-price*0.0007*s],stop:price-price*0.004*s,tp1:price+price*0.004*s,lev:[10,50]});
  }

  /* ------------------------------------------------ Play #5 High-OI Squeeze */
  const oiPct=$(d.dataB.oi30dPct), oiΔ=$(d.dataB.oiDelta24h);
  if(oiPct>=95&&Math.abs(oiΔ)<=2){
    plays.push({id:5,dir:"BREAK",name:"High-OI Box",
      entry:[price],stop:price*0.982,tp1:price*1.04,lev:[5,15]});
  }

  /* ------------------------------------------------ Play #6 EMA Pull-back */
  const adx14=$(d.dataA["4h"].adx14);
  if(adx14>20&&d.dataA["1d"].ema50>d.dataA["1d"].ema200&&price<d.dataA["4h"].ema50){
    const ema=d.dataA["4h"].ema50;
    const entry = ema*0.999;
    const stop  = ema*0.99;     // ~ -1%
    const tp1   = entry*1.02;   // +2% from entry
    plays.push({id:6,dir:"LONG",name:"EMA Pull-back",
      entry:[entry],stop,tp1,lev:[3,10]});
  }

  /* ------------------------------------------------ Play #7 Opening-Range */
  const now=new Date();
  if(now.getUTCMinutes()===20&&atr15<0.5&&d.dataD.sessionRelVol?.asia>1.2){
    // Enforce ≥1R: SL = atr%, TP1 >= 1.5R (rr=1.5)
    const slFrac = atr15/100;
    const rr = 1.5;
    const stop = price*(1 - slFrac);        // -ATR%
    const tp1  = price*(1 + slFrac*rr);     // +rr*ATR%
    plays.push({id:7,dir:"BREAK",name:"Opening-Range",
      entry:[price],stop,tp1,lev:[10,25]});
  }

  /* ------------------------------------------------ Play #8 VWAP Fade */
  const vwap=$(d.dataF.levels?.vwap),
        up=$(d.dataF.levels?.vwapUpper),
        lo=$(d.dataF.levels?.vwapLower),
        bandW=vwapBandWidthPct(d);
  if(bandW&&bandW<3){
    if(up&&price>up&&distOK(up,3)){
      plays.push({id:8,dir:"SHORT",name:"VWAP Fade",
        entry:[price],stop:price*1.007,tp1:vwap,lev:[5,20]});
    }
    if(lo&&price<lo&&distOK(lo,3)){
      plays.push({id:8,dir:"LONG",name:"VWAP Fade",
        entry:[price],stop:price*0.993,tp1:vwap,lev:[5,20]});
    }
  }

  /* ------------------------------------------------ Play #9 Session Kick */
  const roc1h=$(d.dataC["1h"].roc10), ses=d.dataD.sessionRelVol||{};
  const hr=now.getUTCHours();
  if((hr===8||hr===14)&&Math.abs(roc1h)>=0.4&&(ses.asia>1.5||ses.eu>1.5)){
    const dir=roc1h>0?"LONG":"SHORT",s=dir==="LONG"?1:-1;
    plays.push({id:9,dir,name:"Session Kick",
      entry:[price],stop:price*(1-s*0.004),tp1:price*(1+s*0.01),lev:[5,15]});
  }

  /* ---- score (quality) -------------------------------------------------- */
  const final=[];
  for(const p of plays){
    const q = computeQualityScore(d,p);
    p.quality = q;
    p.belowGate = false; // set later with regime-adjusted gate
    final.push(p);
  }
  return final;
}

/* quick one-liner (console only) */
const playLine = p =>
  `• #${p.id} (${p.quality}/10${p.belowGate?"⤓":""}) ${p.name} ${p.dir} @${fmt$(p.entry[0])}${p.entry[1]?`-${fmt$(p.entry[1])}`:""} SL:${fmt$(p.stop)}`;

/* ───────── 3 ▸ HTML builder (Telegram output unchanged) --------------------------- */
function buildMsg(p,d){
  const snap=
`• FundingZ <b>${esc(d.dataB.fundingZ)}</b> | OI30d <b>${esc(d.dataB.oi30dPct)}%</b>
• ADX 4h <b>${esc(d.dataA["4h"].adx14)}</b> | Stress <b>${esc(d.dataE.stressIndex)}</b>
• EU vol <b>${esc(d.dataD.sessionRelVol.eu)}</b> | 15 m vol <b>${esc(d.dataD.relative["15m"])}</b>`;

  // robust swings guard
  const hasSwings = !!d.dataF?.swings && d.dataF.swings.H1 != null && d.dataF.swings.H2 != null;
  const swings = hasSwings
    ? `\nSwings ➜ H1 ${fmt$(d.dataF.swings.H1)} • H2 ${fmt$(d.dataF.swings.H2)} • neckline ${fmt$(d.dataF.neckline)} (broken? ${d.dataF.neckBreak?"yes":"no"})`
    : "";

  // position sizing display: notional sized to risk, no leverage multiplier
  const entry0 = p.entry[0];
  const risk$  = acctEq * (riskPc/100);
  const riskD  = Math.abs(entry0 - p.stop);
  const qty    = riskD ? (risk$ / riskD) : 0; // BTC size
  const posUsd = qty * entry0;                // notional USD

  const ts=new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});
  const icon=p.dir==="LONG"?"🟢":"🔴";

  const warn = p.belowGate ? "\n⚠️ <b>Below quality gate – informational only</b>" : "";

  return `${icon} <b>BTC PERP | Play #${p.id} – ${p.name}</b>
<i>${esc(ts)}</i>

<b>Direction:</b> ${p.dir}
<b>Entry zone:</b> ${p.entry.map(v=>fmt$(v)).join(" – ")}
<b>Stop-loss:</b> ${fmt$(p.stop)}
<b>TP 1:</b> ${fmt$(p.tp1)}
<b>Leverage:</b> ${p.lev[0]}× – ${p.lev[1]}×
<b>Quality:</b> ${p.quality}/10${p.belowGate?" (sub-gate)":""}
<b>Risk:</b> ${riskPc}% → pos ≈ ${fmt(posUsd,1)} USD

${snap}${swings}${warn}

<b>Plan</b>
Enter within zone; abort if unfilled in 90 min or opposite trigger forms.

#BTC #Play${p.id}`;
}

/* ───────── 4 ▸ de-dupe & mute helpers -------------------------------------------- */
function playKey(p,d){
  // Prefer stable reference level per play; fallback to coarse price bucket
  const priceBucket = Math.round($(d.dataF.price)/50)*50;
  switch(p.id){
    case 1: return `1:${p.dir}:${Math.round($(d.dataF.levels?.HH20)||0)}`;
    case 2: return `2:${p.dir}:${Math.round($(d.dataF.avwapCycle)||0)}`;
    case 8: {
      const up=$(d.dataF.levels?.vwapUpper), lo=$(d.dataF.levels?.vwapLower);
      return `8:${p.dir}:${Math.round((p.dir==="LONG"?lo:up)||0)}`;
    }
    default: return `${p.id}:${p.dir}:${priceBucket}`;
  }
}

function loadCache(path){
  try{ return JSON.parse(fs.readFileSync(path,"utf8")); }catch{ return { ts:0, plays:{} }; }
}
function saveCache(path,obj){
  try{ fs.writeFileSync(path,JSON.stringify(obj)); }catch{}
}

/* ───────── 5 ▸ main --------------------------------------------------------------- */
(async()=>{
  try{
    const dash = await safeJson(LIVE, { timeoutMs: fetchTimeout, retries: fetchRetries });

    const price = $(dash.dataF.price);
    const HH20  = $(dash.dataF.levels?.HH20);
    const avwap = $(dash.dataF.avwapCycle);
    const fundingZ= parseFloat(dash.dataB.fundingZ);
    const bigLiq  = Math.max($(dash.dataB.liquidations?.long1h),$(dash.dataB.liquidations?.short1h));

    // Compute regime once
    const REGIME = computeRegime(dash);

    const plays = detectPlays(dash);

    // Apply regime-aware gate adjustments / denials BEFORE audit & sending
    for(const p of plays){
      const { gateAdj, deny } = regimeAdjustGate(p, dash, REGIME);
      const baseGate = MIN_GATE[p.id] || 5;
      const gate = Math.max(1, baseGate + gateAdj);
      p.belowGate = deny ? true : (p.quality < gate);
      if(deny) dbg(`Play #${p.id} denied by regime (gate ${baseGate}➜X)`); else if(p.quality < gate) dbg(`Play #${p.id} gated by regime: score ${p.quality} < gate ${gate} (base ${baseGate} + ${gateAdj})`);
    }

    /* audit (reflects regime-adjusted gates) */
    const idList=plays.map(p=>`${p.id}(${p.quality}${p.belowGate?"⤓":""})`).join(",")||"none";
    console.log(`ALERT SUMMARY | price=${fmt$(price)}  ${HH20?`HH20Δ=${pct(price,HH20).toFixed(2)}%  `:""}${avwap?`AVWAPΔ=${pct(price,avwap).toFixed(2)}%  `:""}fundingZ=${fundingZ}  bigLiq=$${fmt(bigLiq/1e6,0)}M  plays=[${idList}]`);
    plays.forEach(p=>console.log(playLine(p)));
    if(isDbg){
      console.log("===== TRACE =====");
      console.log(LOG.join("\n"));
      console.log("=================");
    }

    // Nothing detected or everything gated/denied
    const sendable = plays.filter(p=>!p.belowGate);
    if(!sendable.length){
      console.log("No plays passed (after regime adjust) – nothing to send.");
      return;
    }

    /* mute windows: global + per-play TTL with A-tier override */
    const cachePath="/tmp/alert_cache.json";
    const cache=loadCache(cachePath);
    const nowTs=Date.now();

    // A-tier bypass: allow sending if any play quality ≥ 8 even inside global window
    const hasATier = sendable.some(p=>p.quality>=8);

    // Per-play TTL (30 min) to prevent duplicates
    const TTL = 30*60*1000;

    // Global 60-min mute unless A-tier exists
    const globalMuted = !isDbg && (nowTs-(cache.ts||0) < 3_600_000) && !hasATier;
    if(globalMuted){
      console.log("Muted 60-min window"); return;
    }

    // Filter out sendable plays that are still inside their per-play TTL
    const fresh = sendable.filter(p=>{
      const key = playKey(p,dash);
      const lastTs = cache.plays?.[key] || 0;
      if(nowTs - lastTs < TTL) { console.log(`Skip duplicate (TTL) key=${key}`); return false; }
      return true;
    });

    if(!fresh.length){
      console.log("All plays within per-play TTL – nothing to send.");
      return;
    }

    for(const p of fresh) await tg(buildMsg(p,dash));

    // update cache: global ts only if we sent something and not in debug
    if(!isDbg){
      cache.ts = nowTs;
      cache.plays = cache.plays || {};
      for(const p of fresh){
        cache.plays[playKey(p,dash)] = nowTs;
      }
      saveCache(cachePath,cache);
    }

    console.log(`✅ Sent ${fresh.length} alert(s)`);

  }catch(err){
    console.error("❌",err);
    try{ await tg(esc(`Bot error: ${err.message}`)); }catch{}
    const isAbort = err?.name === "AbortError" || err?.type === "aborted";
    if (isAbort || softFail) {
      // transient fetch timeout — don’t fail the workflow
      process.exit(0);
    } else {
      process.exit(1);
    }
  }
})();
