/* =============================================================
 *  OBSIDIAN — NSE quote proxy
 *  Serves live NSE India equity quotes to the browser terminal.
 *
 *  Why this exists: NSE/BSE block cross-origin browser requests
 *  (no CORS headers) and gate their API behind session cookies.
 *  This tiny proxy fetches NSE server-side, keeps a cookie jar,
 *  caches briefly, and re-exposes the data WITH CORS so the
 *  OBSIDIAN front-end can read it.
 *
 *  Requirements: Node.js 18+ (uses built-in fetch & http). No npm install.
 *
 *  Run locally:      node nse-proxy.js
 *                    → listening on http://localhost:8787
 *  In OBSIDIAN:      open DATA, paste  http://localhost:8787  as the
 *                    NSE proxy URL, Save & Reconnect.
 *
 *  Endpoints:
 *    GET /quotes?symbols=RELIANCE,INFY,TCS
 *        → { "RELIANCE": { "price": 2945.5, "prevClose": 2930, ... }, ... }
 *    GET /health  → { ok: true }
 *
 *  Deploy free: Render / Railway / Fly / a small VPS. Note that some
 *  cloud IP ranges are throttled by NSE; a home/VPS IP is most reliable.
 *  Set PORT via env var if your host requires it.
 * ============================================================= */

const http = require("http");

const PORT = process.env.PORT || 8787;
const NSE_HOME = "https://www.nseindia.com";
const CACHE_MS = 8000;          // serve cached quote for 8s per symbol
const COOKIE_TTL_MS = 9 * 60e3; // refresh session cookie every ~9 min

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
const cache = new Map(); // symbol -> { at, data }

/* --- cookie jar: NSE hands out cookies on the homepage --- */
async function ensureCookie(force = false) {
  if (!force && cookie && Date.now() - cookieAt < COOKIE_TTL_MS) return;
  const res = await fetch(NSE_HOME, { headers: BROWSER_HEADERS });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie()
            : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  if (set.length) {
    cookie = set.map(c => c.split(";")[0]).join("; ");
    cookieAt = Date.now();
  }
}

async function fetchQuote(symbol) {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  await ensureCookie();
  const url = NSE_HOME + "/api/quote-equity?symbol=" + encodeURIComponent(symbol);
  let res = await fetch(url, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });

  // one retry with a fresh cookie if the session was rejected
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

  // second call for market cap (best effort — don't fail the quote if it errors)
  let mcap = null;
  try {
    const t = await fetch(url + "&section=trade_info", { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
    if (t.ok) {
      const tj = await t.json();
      const tc = tj && tj.marketDeptOrderBook && tj.marketDeptOrderBook.tradeInfo;
      if (tc && tc.totalMarketCap != null) mcap = +tc.totalMarketCap; // ₹ Cr (approx)
    }
  } catch (e) {}

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
    industry: ind.industry || ind.basicIndustry || info.industry || "—",
    pe: meta.pdSymbolPe ? +meta.pdSymbolPe : null,
    mcap: mcap,
    ts: Date.now(),
  };
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

function send(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") return send(res, 204, {});
  if (u.pathname === "/health") return send(res, 200, { ok: true, cookie: !!cookie });

  if (u.pathname === "/quotes") {
    const symbols = (u.searchParams.get("symbols") || "")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
    if (!symbols.length) return send(res, 400, { error: "pass ?symbols=RELIANCE,INFY" });

    const out = {};
    // sequential with a tiny gap keeps NSE happy; symbols are cached 8s
    for (const sym of symbols) {
      try { out[sym] = await fetchQuote(sym); }
      catch (e) { out[sym] = { error: String(e.message || e) }; }
    }
    return send(res, 200, out);
  }

  send(res, 404, { error: "try /quotes?symbols=RELIANCE,INFY or /health" });
});

server.listen(PORT, () => {
  console.log(`OBSIDIAN NSE proxy → http://localhost:${PORT}`);
  console.log(`  test: http://localhost:${PORT}/quotes?symbols=RELIANCE,INFY`);
  ensureCookie().catch(() => {});
});
