// scripts/generate-live.js
import { mkdir, writeFile } from "fs/promises";

async function main() {
  const EDGE_URL = process.env.EDGE_URL
    || "https://btcsignal.netlify.app/data.json";

  console.log("🔍 Fetching Edge JSON from:", EDGE_URL);
  const res = await fetch(EDGE_URL, { cache: "no-store" });
  if (!res.ok) {
    console.error(`❌ HTTP ${res.status} fetching Edge JSON`);
    process.exit(1);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error("❌ Failed to parse JSON:", err);
    process.exit(1);
  }

  await mkdir("public", { recursive: true });
  await writeFile(
    "public/live.json",
    JSON.stringify(data, null, 2),
    "utf8"
  );

  console.log(`✅ public/live.json updated (${Buffer.byteLength(JSON.stringify(data))} bytes)`);
}

main().catch(err => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
