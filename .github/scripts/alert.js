#!/usr/bin/env node
/*  alert.js  –  Consensus‑score Telegram bot (CET time, dup‑suppression)
    Env required:
      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LIVE_URL
      HTTPS_PROXY (optional)
      DEBUG=true  → include rule bullets inside Telegram message
*/

import fs   from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/*─────────────────────────────────*
 * 0 ▸  ENV & plumbing
 *─────────────────────────────────*/
const { TELEGRAM_BOT_TOKEN:BOT, TELEGRAM_CHAT_ID:CHAT, LIVE_URL:LIVE, HTTPS_PROXY:PROXY } = process.env;
if (!BOT || !CHAT || !LIVE) { console.error("Missing BOT/CHAT/LIVE_URL"); process.exit(1); }
const DEBUG  = process.env.DEBUG === "true";
const agent  = PROXY ? new HttpsProxyAgent(PROXY) : undefined;

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ chat_id:CHAT, text, parse_mode:"Markdown", disable_web_page_preview:true })
  });
}

/*─────────────────────────────────*
 * 1 ▸  Helper‑score engine
 *─────────────────────────────────*/
function helperScores(raw) {
  const safe = (v)=> (v===undefined||v===null||Number.isNaN(v)) ? 0 : v;
  const A=raw.dataA, B=raw.dataB, C=raw.dataC, D=raw.dataD, E=raw.dataE, F=raw.dataF, G=raw.dataG, H=raw.dataH;
  const lastPrice = safe(A["15m"]?.ema50);             // best proxy we have
  const poc1d     = safe(F?.vpvr?.["1d"]?.poc);

  /* Momentum */
  const trend15  = Math.sign(A["15m"].ema50 - A["15m"].ema200) || 0;
  const trend1h  = Math.sign(A["1h"].ema50  - A["1h"].ema200 ) || 0;
  const trend4h  = Math.sign(A["4h"].ema50  - A["4h"].ema200 ) || 0;
  const rsi1h    = A["1h"].rsi14>65 ? 1 : A["1h"].rsi14<35 ? -1 : 0;

  /* Velocity */
  const roc10    = C["15m"].roc10 >= 0.15 ? 1 : C["15m"].roc10 <= -0.15 ? -1 : 0;
  const roc20    = C["15m"].roc20 >= 0.25 ? 1 : C["15m"].roc20 <= -0.25 ? -1 : 0;

  /* Volume & Crowd */
  const volRel15 = ({"very high":2,"high":1,"normal":0,"low":-1})[D.relative["15m"]] ?? 0;
  const fundingBias = B.fundingZ <= -0.5 ? 1 : B.fundingZ >= 0.5 ? -1 : 0;
  const oiShift  = B.oiDelta24h >  2 ? 1 : B.oiDelta24h < -2 ? -1 : 0;
  const stressFlag = E ? (E.stressIndex>=6?2:E.stressIndex>=5?1:0) : 0;

  /* Macro & Sentiment */
  const macroDir = G ? (G.mcap24hPct>=1?1:G.mcap24hPct<=-1?-1:0) : 0;
  const fngVal = H ? parseInt(H.fearGreed.split(" ")[0]) : 50;
  const sentiment = fngVal>60?1:fngVal<40?-1:0;

  /* Liquidation bias   (longs – shorts across 1 h & 4 h) */
  const liq = B.liquidations||{};
  const liqImbalance = (liq.long1h+liq.long4h)-(liq.short1h+liq.short4h);
  const liqBias = Math.abs(liqImbalance) > 1e6 ? Math.sign(-liqImbalance) : 0; // +1 bullish if shorts liquidated

  /* PoC direction  (+1 if price above 1d PoC, -1 if below) */
  const pocDir = poc1d && lastPrice ? Math.sign(lastPrice - poc1d) : 0;

  return {
    trend15, trend1h, trend4h, rsi1h,
    roc10, roc20,
    volRel15, fundingBias, oiShift, stressFlag,
    macroDir, sentiment,
    liqBias, pocDir
  };
}

/*─────────────────────────────────*
 * 2 ▸  Consensus, direction, TL lights
 *─────────────────────────────────*/
function buildSignal(scores) {
  const { trend15,rsi1h,roc10,volRel15,fundingBias,
          trend1h,trend4h,roc20,oiShift,macroDir } = scores;

  const consensusFast  = trend15 + rsi1h + roc10 + volRel15 + fundingBias;
  const consensusSwing = trend1h + trend4h + roc20 + oiShift + macroDir;

  let dir="FLAT", conv="Low";
  if (consensusFast >= 3 || consensusSwing >= 4) { dir="LONG";  conv="High"; }
  else if (consensusFast <= -3 || consensusSwing <= -4){ dir="SHORT"; conv="High"; }
  else if (consensusFast >= 1 || consensusSwing >= 2) { dir="LONG"; conv="Medium"; }
  else if (consensusFast <= -1 || consensusSwing <= -2){dir="SHORT"; conv="Medium"; }

  return { dir, conv, consensusFast, consensusSwing };
}

/*─────────────────────────────────*/
(async()=>{
  try{
    const res = await fetch(LIVE,{agent,timeout:20000});
    if(!res.ok) throw new Error(`Fetch ${res.status}`);
    const raw = await res.json();

    /* Upstream audit */
    console.table(raw.errors?.length ? raw.errors.slice(0,6) : ["no upstream errors"]);
    const s = helperScores(raw);
    console.table(s);

    const sig = buildSignal(s);
    console.log("consFast",sig.consensusFast,"consSwing",sig.consensusSwing,"→",sig.dir,sig.conv);

    /* duplicate suppression */
    const hash=JSON.stringify({dir:sig.dir,conv:sig.conv});
    const cache="/tmp/last_signal.json"; let last=""; try{last=JSON.parse(fs.readFileSync(cache)).hash;}catch{}
    if(hash===last){ console.log("Same signal – skipped."); return;}
    fs.writeFileSync(cache,JSON.stringify({hash}));

    /* Time CET */
    const cet = new Date().toLocaleString("en-GB",{timeZone:"Europe/Paris",hour12:false});

    /* Color traffic lights per block */
    const tl = blk=>{
      switch(blk){
        case "A": return (s.trend15*(sig.dir==="LONG"?1:-1) >=0 && s.trend1h*(sig.dir==="LONG"?1:-1)>=0)?"🟢":"🔴";
        case "B": return ((s.fundingBias>=0 && sig.dir==="LONG")||(s.fundingBias<=0&&sig.dir==="SHORT"))?"🟢":"🟡";
        case "C": { const v=s.roc10+s.roc20; return v*(sig.dir==="LONG"?1:-1)>=1?"🟢":v===0?"🟡":"🔴"; }
        case "D": { const v=s.volRel15; return v>0?"🟢":v<0?"🔴":"🟡"; }
        case "E": return s.stressFlag===0?"🟢":s.stressFlag>=2?"🔴":"🟡";
        case "F": return s.pocDir*(sig.dir==="LONG"?1:-1)>=0?"🟢":"🟡";
        case "G": return s.macroDir*(sig.dir==="LONG"?1:-1)>0?"🟢":"🟡";
        case "H": return s.sentiment*(sig.dir==="LONG"?-1:1)>0?"🟢":"🟡";
        default: return "🟡";
      }
    };
    const tlSummary = ["A","B","C","D","E","F","G","H"].map(tl).join("");

    /* Build Telegram message */
    let msg = `Signal Block | BTC/USD | Time: ${cet}\n`;
    msg += `🚀 *${sig.dir}* (${sig.conv} conviction)\n`;
    msg += `🚦 Traffic-Light Summary: ${tlSummary}\n\n`;
    msg += `🧩 Consensus Scores\n`;
    msg += `• consensusFast: ${sig.consensusFast} – _fast bias_\n`;
    msg += `• consensusSwing: ${sig.consensusSwing} – _swing bias_\n`;
    msg += `→ Direction: ${sig.dir} / ${sig.conv}\n`;

    if(DEBUG){
      msg += `\nHelper Scores\n`;
      for(const [k,v] of Object.entries(s)) msg += `• ${k}: ${v}\n`;
    }

    await tg(msg);
    console.log("Telegram alert sent.");

  }catch(e){
    console.error("Script error:",e);
    await tg(`⚠️ *Alert error*: ${e.message}`);
    process.exit(1);
  }
})();
