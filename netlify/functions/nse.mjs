/* =============================================================
 *  OBSIDIAN — NSE proxy as a Netlify Function (modern format)
 *
 *  PLACE THIS FILE AT:  netlify/functions/nse.mjs
 *  (delete any older netlify/functions/nse.js so there's only one)
 *
 *  Endpoints once deployed:
 *    https://YOURSITE.netlify.app/.netlify/functions/nse/health
 *    https://YOURSITE.netlify.app/.netlify/functions/nse/quotes?symbols=RELIANCE,INFY
 *
 *  In OBSIDIAN set the proxy URL to:
 *    https://YOURSITE.netlify.app/.netlify/functions/nse
 *
 *  Runs on Netlify's Node runtime (global fetch/Request/Response). No npm install.
 * ============================================================= */

const NSE_HOME = "https://www.nseindia.com";
const CACHE_MS = 8000;
const COOKIE_TTL_MS = 8 * 60e3;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": NSE_HOME + "/get-quotes/equity",
};

let cookie = "";
let cookieAt = 0;
const cache = new Map();

async function ensureCookie(force) {
  if (!force && cookie && Date.now() - cookieAt < COOKIE_TTL_MS) return;
  const res = await fetch(NSE_HOME, { headers: BROWSER_HEADERS });
  let set = [];
  if (typeof res.headers.getSetCookie === "function") set = res.headers.getSetCookie();
  else if (res.headers.get("set-cookie")) set = [res.headers.get("set-cookie")];
  if (set.length) {
    cookie = set.map((c) => c.split(";")[0]).join("; ");
    cookieAt = Date.now();
  }
}

async function fetchQuote(symbol, withMcap) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  await ensureCookie();
  const url = NSE_HOME + "/api/quote-equity?symbol=" + encodeURIComponent(symbol);
  let res = await fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
  if (res.status === 401 || res.status === 403) {
    await ensureCookie(true);
    res = await fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
  }
  if (!res.ok) throw new Error("NSE HTTP " + res.status);

  const j = await res.json();
  const p = j.priceInfo || {};
  const info = j.info || {};
  const meta = j.metadata || {};
  const ind = j.industryInfo || {};

  let mcap = null;
  if (withMcap) {
    try {
      const t = await fetch(url + "&section=trade_info", { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
      if (t.ok) {
        const tj = await t.json();
        const tc = tj && tj.marketDeptOrderBook && tj.marketDeptOrderBook.tradeInfo;
        if (tc && tc.totalMarketCap != null) mcap = +tc.totalMarketCap;
      }
    } catch (e) {}
  }

  const data = {
    price: p.lastPrice ?? null,
    prevClose: p.previousClose ?? null,
    open: p.open ?? null,
    dayHigh: p.intraDayHighLow ? p.intraDayHighLow.max : null,
    dayLow: p.intraDayHighLow ? p.intraDayHighLow.min : null,
    yearHigh: p.weekHighLow ? p.weekHighLow.max : null,
    yearLow: p.weekHighLow ? p.weekHighLow.min : null,
    change: p.change ?? null,
    pChange: p.pChange ?? null,
    name: info.companyName || symbol,
    industry: ind.industry || ind.basicIndustry || info.industry || "\u2014",
    pe: meta.pdSymbolPe ? +meta.pdSymbolPe : null,
    mcap: mcap,
    ts: Date.now(),
  };
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

async function mapLimit(arr, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const url = new URL(req.url);
  if (url.pathname.endsWith("/health")) {
    return new Response(JSON.stringify({ ok: true, cookie: !!cookie }), { status: 200, headers: cors });
  }

  const raw = url.searchParams.get("symbols") || "";
  const symbols = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 50);
  if (!symbols.length) {
    return new Response(JSON.stringify({ error: "pass ?symbols=RELIANCE,INFY" }), { status: 400, headers: cors });
  }

  try { await ensureCookie(); } catch (e) {}
  const single = symbols.length === 1;
  const results = await mapLimit(symbols, 8, async (sym) => {
    try { return [sym, await fetchQuote(sym, single)]; }
    catch (e) { return [sym, { error: String(e.message || e) }]; }
  });
  const out = {};
  results.forEach(([s, d]) => (out[s] = d));
  return new Response(JSON.stringify(out), { status: 200, headers: cors });
};
