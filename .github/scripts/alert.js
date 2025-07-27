#!/usr/bin/env node
// .github/scripts/alert.js 
// Send a Telegram alert when a high‑conviction trade signal appears.

import { HttpsProxyAgent } from "https-proxy-agent";
import process from "node:process";

// ─────────────────────────
// 1. Environment & helpers
// ─────────────────────────
const BOT       = process.env.TELEGRAM_BOT_TOKEN;
const CHAT      = process.env.TELEGRAM_CHAT_ID;
const LIVE      = process.env.LIVE_URL;
const THRESHOLD = Number(process.env.THRESHOLD ?? 6);
const PROXY_URL = process.env.HTTPS_PROXY;

if (!BOT || !CHAT || !LIVE) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

const fetchOptions = PROXY_URL
  ? { agent: new HttpsProxyAgent(PROXY_URL) }
  : undefined;

async function tg(text) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT}/sendMessage`,
    {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({
        chat_id: CHAT,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
      ...fetchOptions,
    },
  );
  if (!res.ok) {
    console.error("Telegram API error:", res.status, await res.text());
  }
}

// handy “safe get” helper
const get = (o, path, d = 0) =>
  path.reduce((t, k) => (t && t[k] !== undefined ? t[k] : undefined), o) ?? d;

// ─────────────────────────
// 2. Scoring logic
// ─────────────────────────
function score(data) {
  if (!data || typeof data !== "object") return { long: 0, short: 0 };

  let long = 0;
  let short = 0;

  // ✦ Trend direction (EMA 50 vs 200 on the 1 h chart)
  const ema50_1h  = get(data, ["dataA", "1h", "ema50"]);
  const ema200_1h = get(data, ["dataA", "1h", "ema200"]);
  if (ema50_1h > ema200_1h) long += 2;
  if (ema50_1h < ema200_1h) short += 2;

  // ✦ MACD histogram on 1 h
  const macdHist1h = get(data, ["dataA", "1h", "macdHist"]);
  if (macdHist1h > 0) long += 1;
  if (macdHist1h < 0) short += 1;

  // ✦ Short‑term momentum (ROC‑10 on 15 m)
  const roc10_15m = get(data, ["dataC", "15m", "roc10"]);
  if (roc10_15m > 0) long += 1;
  if (roc10_15m < 0) short += 1;

  // ✦ Stress index (contrarian)
  const stress = get(data, ["dataE", "stressIndex"]);
  if (stress >= 6) short += 2;     // overheated → fade longs
  if (stress <= 1) long  += 2;     // washed‑out → fade shorts

  // ✦ Volume spike flag (15 m)
  const volFlag = get(data, ["dataD", "relative", "15m"], "normal");
  if (volFlag === "very high") {
    long  += 1;
    short += 1; // both sides risky – prize conviction signals
  }

  return { long, short };
}

// ─────────────────────────
// 3. Main routine
// ─────────────────────────
(async () => {
  try {
    const res = await fetch(LIVE, { ...fetchOptions, timeout: 20_000 });
    if (!res.ok) {
      console.error("Dashboard fetch error:", res.status, await res.text());
      return;
    }

    const raw = await res.json();
    const { long, short } = score(raw);

    console.log(`Score ⚙️ Long: ${long}, Short: ${short}`);

    let message = `*High‑Conviction BTC Signal*\n` +
                  `Score ⚙️ Long: *${long}* · Short: *${short}*`;

    if (long >= THRESHOLD) {
      message += `\n\n✅ *Long threshold reached!*`;
    }
    if (short >= THRESHOLD) {
      message += `\n\n🛑 *Short threshold reached!*`;
    }

    // Send only if at least one side breaches the threshold
    if (long >= THRESHOLD || short >= THRESHOLD) {
      await tg(message);
    } else {
      console.log("Threshold not met – no alert sent.");
    }
  } catch (err) {
    console.error("Alert script error:", err);
  }
})();
