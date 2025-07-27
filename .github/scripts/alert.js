#!/usr/bin/env node
// .github/scripts/alert.js

const BOT       = process.env.TELEGRAM_BOT_TOKEN;
const CHAT      = process.env.TELEGRAM_CHAT_ID;
const LIVE      = process.env.LIVE_URL;
const THRESHOLD = Number(process.env.THRESHOLD) || 6;

if (!BOT || !CHAT || !LIVE) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

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
  // (unchanged scoring logic)
  // ...
}

(async () => {
  const res = await fetch(LIVE);
  const raw = await res.json();
  const { long, short } = score(raw);
  let message = `Score ⚙️ Long: ${long}, Short: ${short}`;
  if (long >= THRESHOLD) message += "\n✅ Long threshold reached!";
  if (short >= THRESHOLD) message += "\n🛑 Short threshold reached!";
  await tg(message);
})();
