// fly-proxy/index.js
import http from "http";
import { URL } from "url";

const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const path = u.searchParams.get("path");
    if (!path) {
      res.writeHead(400, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({ error: "Missing 'path' query parameter" }));
    }

    // Pick the right host
    let host;
    if (path.startsWith("/fapi/")) host = "https://fapi.binance.com";
    else if (path.startsWith("/dapi/")) host = "https://dapi.binance.com";
    else host = "https://api.binance.com";

    const binanceRes = await fetch(host + path, { headers: { "User-Agent":"Mozilla/5.0" } });
    const body = await binanceRes.text();

    // Forward status and CORS headers
    res.writeHead(binanceRes.status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS"
    });
    res.end(body);

  } catch (err) {
    res.writeHead(500, {"Content-Type":"application/json"});
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Proxy listening on port ${PORT}`);
});
