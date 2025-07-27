#!/usr/bin/env node
// .github/scripts/alert.js

// ← hard‑coded Telegram credentials
const BOT       = "8417682763:AAGZ1Darr0BgISB9JAG3RzHCQi-uqMylcOw";
const CHAT      = "6038110897";

// mirror URL & threshold also inlined
const LIVE      = "https://btcsignal.netlify.app/live.json";
const THRESHOLD = 6;

async function tg(msg) {
  await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT,
      text: msg,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    })
  });
}

function score(raw) {
  const A = raw.dataA?.["1h"]  || {};
  const B = raw.dataB          || {};
  const D = raw.dataD          || {};
  const F = raw.dataF          || {};
  const E = raw.dataE          || {};

  const rsi   = +A.rsi14    || 0;
  const macd  = +A.macdHist || 0;
  const fund  = +B.fundingZ || 0;
  const l24   = +B.liquidations?.long24h  || 0;
  const s24   = +B.liquidations?.short24h || 0;
  const cvd   = +D.cvd?.["1h"]            || 0;
  const vf    = D.relative?.["15m"]       || "unknown";
  const bull  = +D["15m"]?.bullVol        || 0;
  const bear  = +D["15m"]?.bearVol        || 0;
  const price = +A.ema50                  || 0;
  const poc4  = +F.vpvr?.["4h"]?.poc      || 0;
  const stress= +E.stressIndex            || 0;

  let L = 0, S = 0;
  if (rsi < 35)           L++; else if (rsi > 65)           S++;
  if (macd > 0)           L++; else if (macd < 0)            S++;
  if (fund < -1)          L++; else if (fund > 1)            S++;
  if (s24 > 2*l24)        L++; if (l24 > 2*s24)              S++;
  if (cvd > 1000 && (vf === "high"||vf==="very high"))       L += 2;
  if (cvd < -1000 && (vf === "high"||vf==="very high"))      S += 2;
  if (bull > bear)        L++; else if (bear > bull)          S++;
  if (price > poc4)       L++; else if (price < poc4)        S++;
  if (stress >= 3 && stress <= 5) { L++; S++; }

  return { long: L, short: S };
}

(async () => {
  consol
