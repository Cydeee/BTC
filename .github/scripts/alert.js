#!/usr/bin/env node
/*  alert.js  –  generates Telegram alerts from btcsignal.netlify.app data
    ENV required:
      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LIVE_URL
      (optional) DEBUG=true  → verbose Telegram message           */

import fs from "fs";
import fetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

/* ───────────── env & helpers ───────────── */
const BOT  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const LIVE = process.env.LIVE_URL;
const PROXY = process.env.HTTPS_PROXY || "";

if (!BOT || !CHAT || !LIVE) {
  console.error("Missing TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID or LIVE_URL");
  process.exit(1);
}
const agent = PROXY ? new HttpsProxyAgent(PROXY) : undefined;
const DEBUG = process.env.DEBUG === "true";

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    })
  });
}

/* ───────────── scoring ───────────── */
function scoreBuckets(raw) {
  const A = raw.dataA, B = raw.dataB, C = raw.dataC, D = raw.dataD, E = raw.dataE, F = raw.dataF;
  const scores = {
    long_conf: 0, short_conf: 0,
    long_rew: 0, short_rew: 0,
    details: { long_conf: [], short_conf: [], long_rew: [], short_rew: [] }
  };
  /* helper macro */
  const add = (bucket, pts, txt) => { scores[bucket] += pts; scores.details[bucket].push(txt); };

  /* --- High‑confidence LONG --- */
  if (A["1h"].ema50 > A["1h"].ema200 && A["4h"].ema50 > A["4h"].ema200 && A["1h"].macdHist > 0)
    add("long_conf", 1, "trend up");
  if (A["15m"].rsi14 < 30)
    add("long_conf", 1, "RSI<30 pullback");
  if (A["15m"].macdHist > 0)
    add("long_conf", 1, "momentum turn");
  if (D.relative["15m"] !== "very high" && A["15m"].atrPct <= 1.0)
    add("long_conf", 1, "quiet vol");
  if (E && E.stressIndex < 4)
    add("long_conf", 1, "low stress");
  if (D.cvd["15m"] > 0)
    add("long_conf", 1, "CVD diverge");

  /* --- High‑confidence SHORT --- */
  if (A["1h"].ema50 < A["1h"].ema200 && A["4h"].ema50 < A["4h"].ema200 && A["1h"].macdHist < 0)
    add("short_conf", 1, "trend down");
  if (A["15m"].rsi14 > 70)
    add("short_conf", 1, "RSI>70 pullback");
  if (A["15m"].macdHist < 0)
    add("short_conf", 1, "momentum turn");
  if (D.relative["15m"] !== "very high" && A["15m"].atrPct <= 1.0)
    add("short_conf", 1, "quiet vol");
  if (E && E.stressIndex < 4)
    add("short_conf", 1, "low stress");
  if (D.cvd["15m"] < 0)
    add("short_conf", 1, "CVD diverge");

  /* --- High‑reward LONG (breakout/squeeze) --- */
  if (D.relative["15m"] === "very high")
    add("long_rew", 2, "ignition vol");
  if (C["15m"].roc10 > 2 && C["15m"].roc10 > C["15m"].roc20)
    add("long_rew", 1, "ROC thrust");
  if (B.fundingZ <= -1.5)
    add("long_rew", 1, "cheap funding");
  if (B.oiDelta24h > 5)
    add("long_rew", 1, "fresh leverage");
  if (E && E.stressIndex >= 5)
    add("long_rew", 1, "crowded stress");

  /* --- High‑reward SHORT (climax / blow‑off) --- */
  if (D.relative["15m"] === "very high")
    add("short_rew", 2, "climax vol");
  if (A["15m"].rsi14 > 80)
    add("short_rew", 2, "RSI>80 extreme");
  if (A["15m"].macdHist < 0)
    add("short_rew", 1, "MACD roll");
  if (B.fundingZ >= 1.5)
    add("short_rew", 1, "expensive funding");
  if (B.oiDelta24h < -5)
    add("short_rew", 1, "longs exiting");
  if (E && E.stressIndex >= 5)
    add("short_rew", 1, "crowded stress");

  return scores;
}

/* ───────────── main ───────────── */
(async () => {
  try {
    const r = await fetch(LIVE, { agent, timeout: 20_000 });
    const raw = await r.json();

    const s = scoreBuckets(raw);

    /* thresholds */
    const sigs = [];
    if (s.long_conf >= 4)  sigs.push({ tag: "High‑confidence LONG", score: s.long_conf, det: s.details.long_conf });
    if (s.short_conf >= 4) sigs.push({ tag: "High‑confidence SHORT", score: s.short_conf, det: s.details.short_conf });
    if (s.long_rew >= 5)   sigs.push({ tag: "High‑reward LONG", score: s.long_rew, det: s.details.long_rew });
    if (s.short_rew >= 5)  sigs.push({ tag: "High‑reward SHORT", score: s.short_rew, det: s.details.short_rew });

    if (!sigs.length) {
      console.log("No signal this run.");
      return;
    }

    /* dedup – skip if identical signature sent last time */
    const sigHash = JSON.stringify(sigs.map(o => o.tag));
    const cacheFile = "/tmp/last_signal.json";
    let lastHash = "";
    try { lastHash = JSON.parse(fs.readFileSync(cacheFile, "utf8")).hash; } catch {}
    if (sigHash === lastHash) {
      console.log("Signal unchanged since last alert – skipping.");
      return;
    }
    fs.writeFileSync(cacheFile, JSON.stringify({ hash: sigHash }));

    /* build message */
    let msg = `*BTC Intraday Signals*  \n_Time: ${new Date().toUTCString()}_\n`;
    for (const o of sigs) {
      msg += `\n*${o.tag}*  (score ${o.score})`;
      if (DEBUG && o.det.length) msg += `\n• ${o.det.join("\n• ")}`;
    }
    if (raw.errors?.length)
      msg += `\n_Warning: ${raw.errors.filter(e=>!e.includes("HTTP 200")).slice(0,4).join("; ")}_`;

    await tg(msg);
    console.log("Alert sent:", msg.replace(/\n/g, " "));
  } catch (err) {
    console.error("Alert script failed:", err);
    await tg(`⚠️ *Alert script error*: ${err.message}`);
    process.exit(1);
  }
})();
