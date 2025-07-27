// netlify/functions/proxy.js
export const handler = async (event, context) => {
  const path = event.queryStringParameters?.path;
  if (!path) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing 'path' query parameter" })
    };
  }

  // Fetch from Binance on your behalf
  const target = `https://api.binance.com${path}`;
  const res = await fetch(target, { cache: "no-store" });
  const body = await res.text();

  // Pass through status & headers, adding CORS
  return {
    statusCode: res.status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS"
    },
    body
  };
};
