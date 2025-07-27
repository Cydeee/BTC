// netlify/edge-functions/edge-data.js
export const config = {
  path: "/edge-data",   // public route
  cache: "manual"       // we'll control headers ourselves
};

export default async function handler(request) {
  /* Build absolute URL of your own serverless function */
  const origin = new URL(request.url).origin;
  const target = `${origin}/.netlify/functions/data`;

  /* One internal fetch — no proxy credentials involved */
  const upstream = await fetch(target, {
    headers: { accept: "application/json" }
  });

  /* Clone body & headers */
  const body    = await upstream.text();
  const headers = new Headers(upstream.headers);
  headers.set("access-control-allow-origin", "*");      // CORS for GPT mobile :contentReference[oaicite:2]{index=2}

  /* Pass through original status and cache policy */
  return new Response(body, { status: upstream.status, headers });
}
