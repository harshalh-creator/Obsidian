/* =============================================================
 *  OBSIDIAN — India/global quotes proxy (Cloudflare Worker)
 *  Same code as the Netlify function, exported in Workers module format.
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

async function search(q) {
  const url = YQ + "/v1/finance/search?q=" + encodeURIComponent(q) + "&quotesCount=12&newsCount=0&listsCount=0&enableFuzzyQuery=false";
  let r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) {
    await ensureCrumb(true);
    r = await fetch(url, { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } });
  }
  if (!r.ok) throw new Error("search " + r.status);
  const j = await r.json();
  const seen = new Set(), out = [];
  (j.quotes || []).forEach((x) => {
    if (x.quoteType !== "EQUITY") return;
    if (x.exchange !== "NSI" && x.exchange !== "BSE") return; // NSE / BSE only
    const sym = (x.symbol || "").replace(/\.(NS|BO)$/, "");
    if (!sym || seen.has(sym)) return;
    seen.add(sym);
    out.push({ symbol: sym, name: x.longname || x.shortname || sym, exch: x.exchange === "NSI" ? "NSE" : "BSE" });
  });
  return out;
}

async function fundamentals(symbol) {
  await ensureCrumb();
  const y = ymap(symbol);
  const isINR = /\.(NS|BO)$/.test(y);
  const div = isINR ? 1e7 : 1e6;                 // absolute -> ₹ Cr or $ mn
  const unit = isINR ? "\u20b9 Cr" : "$ mn";
  const mods = "incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory,defaultKeyStatistics,financialData";
  const url = YQ + "/v10/finance/quoteSummary/" + encodeURIComponent(y) + "?modules=" + mods + "&crumb=" + encodeURIComponent(ycrumb);
  let r = await fetch(url, { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) { await ensureCrumb(true); r = await fetch(url, { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } }); }
  if (!r.ok) throw new Error("qs " + r.status);
  const j = await r.json();
  const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!res) throw new Error("no data");
  const num = (x) => (x && typeof x.raw === "number") ? x.raw : null;
  const sc = (v) => v != null ? v / div : null;
  const IS = ((res.incomeStatementHistory || {}).incomeStatementHistory || []).slice().reverse();
  const BS = ((res.balanceSheetHistory || {}).balanceSheetStatements || []).slice().reverse();
  const CF = ((res.cashflowStatementHistory || {}).cashflowStatements || []).slice().reverse();
  if (!IS.length) throw new Error("no statements");
  const yr = (x) => { const d = x && x.endDate && x.endDate.raw; return d ? "FY" + new Date(d * 1000).getFullYear().toString().slice(-2) : ""; };
  const dep = CF.map((x) => sc(num(x.depreciation)));
  const ebit = IS.map((x) => sc(num(x.ebit)));
  return {
    ok: true, unit, source: "Yahoo",
    years: IS.map(yr),
    revenue: IS.map((x) => sc(num(x.totalRevenue))),
    ebit,
    ebitda: ebit.map((v, k) => v != null ? v + (dep[k] || 0) : null),
    netIncome: IS.map((x) => sc(num(x.netIncome))),
    totalAssets: BS.map((x) => sc(num(x.totalAssets))),
    equity: BS.map((x) => sc(num(x.totalStockholderEquity))),
    debt: BS.map((x) => { const l = num(x.longTermDebt) || 0, s = num(x.shortLongTermDebt) || 0; return (l + s) ? sc(l + s) : null; }),
    cash: BS.map((x) => sc(num(x.cash))),
    ocf: CF.map((x) => sc(num(x.totalCashFromOperatingActivities))),
    capex: CF.map((x) => sc(num(x.capitalExpenditures))),
  };
}

async function profile(symbol) {
  await ensureCrumb();
  const y = ymap(symbol);
  const mods = "assetProfile,summaryProfile,majorHoldersBreakdown,defaultKeyStatistics,summaryDetail";
  const url = YQ + "/v10/finance/quoteSummary/" + encodeURIComponent(y) + "?modules=" + mods + "&crumb=" + encodeURIComponent(ycrumb);
  let r = await fetch(url, { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) { await ensureCrumb(true); r = await fetch(url, { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } }); }
  if (!r.ok) throw new Error("profile " + r.status);
  const j = await r.json();
  const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!res) throw new Error("no data");
  const ap = res.assetProfile || res.summaryProfile || {};
  const mh = res.majorHoldersBreakdown || {};
  const num = (x) => (x && typeof x.raw === "number") ? x.raw : null;
  const execs = (ap.companyOfficers || []).slice(0, 6).map((o) => ({ name: o.name || "", title: o.title || "", pay: num(o.totalPay), age: o.age || null }));
  return {
    ok: true,
    summary: ap.longBusinessSummary || "",
    sector: ap.sector || "", industry: ap.industry || "",
    employees: ap.fullTimeEmployees || null,
    website: ap.website || "", country: ap.country || "", city: ap.city || "",
    execs,
    holders: { insiders: num(mh.insidersPercentHeld), institutions: num(mh.institutionsPercentHeld), instFloat: num(mh.institutionsFloatPercentHeld), instCount: num(mh.institutionsCount) },
  };
}

async function events(symbol) {
  await ensureCrumb();
  const y = ymap(symbol);
  const isINR = /\.(NS|BO)$/.test(y);
  const div = isINR ? 1e7 : 1e6;
  const mods = "calendarEvents,earningsTrend,financialData,recommendationTrend,insiderTransactions,earnings";
  const url = YQ + "/v10/finance/quoteSummary/" + encodeURIComponent(y) + "?modules=" + mods + "&crumb=" + encodeURIComponent(ycrumb);
  let r = await fetch(url, { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) { await ensureCrumb(true); r = await fetch(url, { headers: { "User-Agent": UA, Cookie: ycookie, Accept: "application/json" } }); }
  if (!r.ok) throw new Error("events " + r.status);
  const j = await r.json();
  const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  if (!res) throw new Error("no data");
  const num = (x) => (x && typeof x.raw === "number") ? x.raw : null;
  const dt = (x) => { const d = num(x); return d ? new Date(d * 1000).toISOString().slice(0, 10) : null; };
  const ce = res.calendarEvents || {}; const cee = ce.earnings || {};
  const fd = res.financialData || {};
  const rt = ((res.recommendationTrend || {}).trend || [])[0] || {};
  const et = (res.earningsTrend || {}).trend || [];
  const pick = (p) => et.find((t) => t.period === p) || {};
  const estRow = (p, label) => { const t = pick(p); const e = t.earningsEstimate || {}; const rv = t.revenueEstimate || {}; return { period: label, epsAvg: num(e.avg), epsLow: num(e.low), epsHigh: num(e.high), epsN: num(e.numberOfAnalysts), epsGrowth: num(e.growth) != null ? num(e.growth) * 100 : null, revAvg: num(rv.avg) != null ? num(rv.avg) / div : null, revGrowth: num(rv.growth) != null ? num(rv.growth) * 100 : null }; };
  const rev0 = (pick("0q").epsRevisions) || {};
  const ins = ((res.insiderTransactions || {}).transactions || []).slice(0, 8).map((t) => ({ name: t.filerName || "", text: t.transactionText || "", relation: t.filerRelation || "", shares: num(t.shares), value: num(t.value), date: dt(t.startDate) }));
  return {
    ok: true, currency: isINR ? "INR" : "USD",
    calendar: { earnings: (cee.earningsDate || []).map(dt).filter(Boolean), exDiv: dt(ce.exDividendDate), divDate: dt(ce.dividendDate) },
    target: { mean: num(fd.targetMeanPrice), high: num(fd.targetHighPrice), low: num(fd.targetLowPrice), median: num(fd.targetMedianPrice), n: num(fd.numberOfAnalystOpinions), key: fd.recommendationKey || "", recMean: num(fd.recommendationMean) },
    consensus: { strongBuy: rt.strongBuy || 0, buy: rt.buy || 0, hold: rt.hold || 0, sell: rt.sell || 0, strongSell: rt.strongSell || 0 },
    estimates: [estRow("0q", "Current Qtr"), estRow("+1q", "Next Qtr"), estRow("0y", "Current Yr"), estRow("+1y", "Next Yr")],
    revisions: { up7: num(rev0.upLast7days) || 0, up30: num(rev0.upLast30days) || 0, down7: num(rev0.downLast7days) || 0, down30: num(rev0.downLast30days) || 0 },
    insiders: ins,
  };
}

const _handler = async (req) => {
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
  if (url.pathname.endsWith("/search")) {
    const q = (url.searchParams.get("q") || "").trim();
    if (q.length < 2) return new Response("[]", { status: 200, headers: cors });
    try { return new Response(JSON.stringify(await search(q)), { status: 200, headers: cors }); }
    catch (e) { return new Response("[]", { status: 200, headers: cors }); }
  }
  if (url.pathname.endsWith("/fundamentals")) {
    const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
    if (!sym) return new Response(JSON.stringify({ error: "pass ?symbol=RELIANCE" }), { status: 400, headers: cors });
    try { return new Response(JSON.stringify(await fundamentals(sym)), { status: 200, headers: cors }); }
    catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 200, headers: cors }); }
  }
  if (url.pathname.endsWith("/profile")) {
    const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
    if (!sym) return new Response(JSON.stringify({ error: "pass ?symbol=RELIANCE" }), { status: 400, headers: cors });
    try { return new Response(JSON.stringify(await profile(sym)), { status: 200, headers: cors }); }
    catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 200, headers: cors }); }
  }
  if (url.pathname.endsWith("/events")) {
    const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
    if (!sym) return new Response(JSON.stringify({ error: "pass ?symbol=RELIANCE" }), { status: 400, headers: cors });
    try { return new Response(JSON.stringify(await events(sym)), { status: 200, headers: cors }); }
    catch (e) { return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 200, headers: cors }); }
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

export async function onRequest(context) { return _handler(context.request); }
