// netlify/edge-functions/edge-data.js
export const config = {
  // The Edge Function becomes live at https://<yoursite>/edge-data
  path: "/edge-data",
  cache: "manual"           // tell Netlify you will set headers yourself
};

export default async function handler() {
  try {
    const url = "https://api.coingecko.com/api/v3/simple/price" +
                "?ids=bitcoin,ethereum&vs_currencies=usd";
    const up  = await fetch(url, { headers: { accept: "application/json" } });
    if (!up.ok) throw new Error(`CoinGecko ${up.status}`);
    return new Response(
      JSON.stringify({ ts: Date.now(), source: "coingecko", data: await up.json() }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=20, stale-while-revalidate=40",
          "access-control-allow-origin": "*"      // safe for GPT Actions
        }
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: "upstream_error", detail: err.message }),
                        { status: 502, headers: { "content-type": "application/json" } });
  }
}
