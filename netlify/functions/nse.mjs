/* =============================================================
 *  OBSIDIAN — India/global quotes proxy (Netlify Function, v3)
 *  PLACE AT:  netlify/functions/nse.mjs   (remove any old nse.js)
 *
 *  Endpoints:
 *    /.netlify/functions/nse/health
 *    /.netlify/functions/nse/quotes?symbols=RELIANCE,INFY,NIFTY
 *
 *  v3: fetches from Yahoo Finance instead of NSE directly. Yahoo mirrors
 *  NSE/BSE quotes AND indices, and (unlike NSE) does not block cloud IPs,
 *  so this returns REAL data from Netlify. Handles NSE equities (.NS) and
 *  Indian indices (NIFTY/SENSEX/BANKNIFTY/NIFTYIT/NIKKEI).
 * ============================================================= */
const YQ = "https://query1.finance.yahoo.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CACHE_MS = 8000;

// map terminal symbols -> Yahoo symbols; everything else is treated as an NSE equity
const YMAP = {
  NIFTY: "^NSEI", SENSEX: "^BSESN", BANKNIFTY: "^NSEBANK", NIFTYIT: "^CNXIT",
  NIKKEI: "^N225", SPX: "^GSPC", NDX: "^NDX", DJI: "^DJI",
};
function ymap(s) { return YMAP[s] || (s + ".NS"); }

let ycookie = "", ycrumb = "", crumbAt = 0;
const cache = new Map();

async function ensureCrumb(force) {
  if (!force && ycrumb && Date.now() - crumbAt < 25 * 60e3) return;
  const r1 = await fetch("https://finance.yahoo.com", { headers: { "User-Agent": UA, Accept: "text/html" } });
  let set = [];
  if (typeof r1.headers.getSetCookie === "function") set = r1.headers.getSetCookie();
  else if (r1.headers.get("set-cookie")) set = [r1.headers.get("set-cookie")];
  if (set.length) ycookie = set.map((c) => c.split(";")[0]).join("; ");
  const r2 = await fetch(YQ + "/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "text/plain" } });
  ycrumb = (await r2.text()).trim();
  crumbAt = Date.now();
}

function norm(sym, q) {
  if (!q || q.regularMarketPrice == null) return { error: "no data" };
  return {
    price: q.regularMarketPrice,
    prevClose: q.regularMarketPreviousClose ?? null,
    open: q.regularMarketOpen ?? null,
    dayHigh: q.regularMarketDayHigh ?? null,
    dayLow: q.regularMarketDayLow ?? null,
    yearHigh: q.fiftyTwoWeekHigh ?? null,
    yearLow: q.fiftyTwoWeekLow ?? null,
    change: q.regularMarketChange ?? null,
    pChange: q.regularMarketChangePercent ?? null,
    name: q.longName || q.shortName || sym,
    industry: q.industry || q.sector || "\u2014",
    pe: q.trailingPE ?? null,
    mcap: q.marketCap != null ? q.marketCap / 1e7 : null, // absolute INR -> Cr
    ts: Date.now(),
  };
}

async function fetchQuotes(symbols) {
  const out = {}, need = [];
  for (const s of symbols) {
    const h = cache.get(s);
    if (h && Date.now() - h.at < CACHE_MS) out[s] = h.data;
    else need.push(s);
  }
  if (!need.length) return out;

  await ensureCrumb();
  const pairs = need.map((s) => [s, ymap(s)]);
  const ys = encodeURIComponent(pairs.map((p) => p[1]).join(","));
  const build = () => YQ + "/v7/finance/quote?symbols=" + ys + "&crumb=" + encodeURIComponent(ycrumb);

  let r = await fetch(build(), { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) {
    await ensureCrumb(true);
    r = await fetch(build(), { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } });
  }
  if (!r.ok) throw new Error("Yahoo HTTP " + r.status);

  const j = await r.json();
  const list = (j.quoteResponse && j.quoteResponse.result) || [];
  const byY = {};
  list.forEach((q) => { byY[q.symbol] = q; });
  for (const [sym, y] of pairs) {
    const data = norm(sym, byY[y]);
    out[sym] = data;
    if (!data.error) cache.set(sym, { at: Date.now(), data });
  }
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
    return new Response(JSON.stringify({ ok: true, source: "yahoo", crumb: !!ycrumb }), { status: 200, headers: cors });
  }

  const raw = url.searchParams.get("symbols") || "";
  const symbols = raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
  if (!symbols.length) {
    return new Response(JSON.stringify({ error: "pass ?symbols=RELIANCE,INFY,NIFTY" }), { status: 400, headers: cors });
  }

  try {
    const out = await fetchQuotes(symbols);
    return new Response(JSON.stringify(out), { status: 200, headers: cors });
  } catch (e) {
    const out = {};
    symbols.forEach((s) => (out[s] = { error: String(e.message || e) }));
    return new Response(JSON.stringify(out), { status: 200, headers: cors });
  }
};
