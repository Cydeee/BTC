// netlify/edge-functions/data.js

export const config = { path: ["/data","/data.json"], cache: "manual" };

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Methods":"GET, OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type"
      }
    });
  }

  try {
    const payload = await buildDashboardData();
    payload.timestamp = Date.now();
    return new Response(JSON.stringify(payload), {
      headers: {
        "Content-Type":"application/json; charset=utf-8",
        "Access-Control-Allow-Origin":"*",
        "Cache-Control":"public, max-age=0, must-revalidate",
        "CDN-Cache-Control":"public, s-maxage=60, must-revalidate"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status:500,
      headers:{ "Content-Type":"application/json; charset=utf-8" }
    });
  }
}

/* ─── Helpers ─── */

const PROXY_BASE = "https://binance-proxy.fly.dev?path=";

async function proxyJson(path) {
  const res = await fetch(PROXY_BASE + encodeURIComponent(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Indicator functions
const sma = (arr,p)=>arr.slice(-p).reduce((s,v)=>s+v,0)/p;
const ema = (arr,p)=>{ if(arr.length<p) return 0; const k=2/(p+1); let v=sma(arr.slice(0,p),p); for(let i=p;i<arr.length;i++) v=arr[i]*k+v*(1-k); return v; };
const rsi = (arr,p)=>{ if(arr.length<p+1) return 0; let up=0,down=0; for(let i=1;i<=p;i++){const d=arr[i]-arr[i-1]; d>0?up+=d:down-=d;} let au=up/p,ad=down/p; for(let i=p+1;i<arr.length;i++){const d=arr[i]-arr[i-1]; au=(au*(p-1)+Math.max(d,0))/p; ad=(ad*(p-1)+Math.max(-d,0))/p;} return ad?100-100/(1+au/ad):100; };
const atr = (h,l,c,p)=>{ if(h.length<p+1) return 0; const tr=[]; for(let i=1;i<h.length;i++) tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return sma(tr,p); };
const roc = (arr,n)=>arr.length>=n+1?((arr[arr.length-1]-arr[arr.length-1-n])/arr[arr.length-1-n])*100:0;

async function buildDashboardData() {
  const S="BTCUSDT", L=250;
  const out={ dataA:{}, dataB:null, dataC:{}, dataD:{}, dataE:null, dataF:null, dataG:null, dataH:null, errors:[] };

  // A: Indicators
  for (const tf of ["15m","1h","4h","1d"]) {
    try {
      const kl = await proxyJson(`/fapi/v1/klines?symbol=${S}&interval=${tf}&limit=${L}`);
      const c=kl.map(r=>+r[4]), h=kl.map(r=>+r[2]), l=kl.map(r=>+r[3]);
      const last=c.at(-1)||1;
      const e50=ema(c,50), e200=ema(c,200);
      const mArr=c.map((_,i)=>ema(c.slice(0,i+1),12)-ema(c.slice(0,i+1),26));
      const macdHist=mArr.at(-1)-ema(mArr,9);
      out.dataA[tf]={ema50:+e50.toFixed(2),ema200:+e200.toFixed(2),rsi14:+rsi(c,14).toFixed(1),atrPct:+((atr(h,l,c,14)/last)*100).toFixed(2),macdHist:+macdHist.toFixed(2)};
    } catch(e) {
      out.errors.push(`A[${tf}]: ${e.message}`);
    }
  }

  // B–H: Replace all external calls with proxyJson(...)
  // Funding, ROC, CVD, Stress, VPVR, Macro, Sentiment logic remains the same.

  return out;
}
