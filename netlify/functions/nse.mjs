/* =============================================================
 *  OBSIDIAN — NSE proxy as a Netlify Function (modern format, v2)
 *  PLACE AT:  netlify/functions/nse.mjs   (remove any old nse.js)
 *  Endpoints:
 *    /.netlify/functions/nse/health
 *    /.netlify/functions/nse/quotes?symbols=RELIANCE,INFY
 *  v2: stronger browser emulation + per-symbol warm-up to reduce NSE 403s.
 * ============================================================= */
const NSE_HOME = "https://www.nseindia.com";
const CACHE_MS = 8000;
const COOKIE_TTL_MS = 5 * 60e3;
const NAV_HEADERS = {
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language":"en-US,en;q=0.9",
  "sec-ch-ua":'"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile":"?0","sec-ch-ua-platform":'"Windows"',
  "sec-fetch-dest":"document","sec-fetch-mode":"navigate","sec-fetch-site":"none","sec-fetch-user":"?1",
  "upgrade-insecure-requests":"1",
};
let jar = {};
let cookieAt = 0;
const cache = new Map();
function absorb(res){
  let set=[];
  if(typeof res.headers.getSetCookie==="function")set=res.headers.getSetCookie();
  else if(res.headers.get("set-cookie"))set=res.headers.get("set-cookie").split(/,(?=[^;]+=[^;]+)/);
  set.forEach((c)=>{const kv=c.split(";")[0];const i=kv.indexOf("=");if(i>0)jar[kv.slice(0,i).trim()]=kv.slice(i+1).trim();});
}
function cookieHeader(){return Object.entries(jar).map(([k,v])=>`${k}=${v}`).join("; ");}
async function primeSession(symbol){
  try{absorb(await fetch(NSE_HOME+"/",{headers:NAV_HEADERS}));}catch(e){}
  if(symbol){try{absorb(await fetch(NSE_HOME+"/get-quotes/equity?symbol="+encodeURIComponent(symbol),{headers:{...NAV_HEADERS,Referer:NSE_HOME+"/"}}));}catch(e){}}
  cookieAt=Date.now();
}
function apiHeaders(symbol){
  return {
    "User-Agent":NAV_HEADERS["User-Agent"],
    "Accept":"application/json, text/plain, */*",
    "Accept-Language":"en-US,en;q=0.9",
    "sec-ch-ua":NAV_HEADERS["sec-ch-ua"],
    "sec-ch-ua-mobile":"?0","sec-ch-ua-platform":'"Windows"',
    "sec-fetch-dest":"empty","sec-fetch-mode":"cors","sec-fetch-site":"same-origin",
    "X-Requested-With":"XMLHttpRequest",
    "Referer":NSE_HOME+"/get-quotes/equity?symbol="+encodeURIComponent(symbol),
    "Cookie":cookieHeader(),
  };
}
async function fetchQuote(symbol,withMcap){
  const hit=cache.get(symbol);
  if(hit&&Date.now()-hit.at<CACHE_MS)return hit.data;
  if(Date.now()-cookieAt>COOKIE_TTL_MS||!Object.keys(jar).length)await primeSession(symbol);
  const url=NSE_HOME+"/api/quote-equity?symbol="+encodeURIComponent(symbol);
  let res=await fetch(url,{headers:apiHeaders(symbol)});
  if(res.status===401||res.status===403||res.status===419){
    jar={};await primeSession(symbol);
    res=await fetch(url,{headers:apiHeaders(symbol)});
  }
  if(!res.ok)throw new Error("NSE HTTP "+res.status);
  const j=await res.json();
  const p=j.priceInfo||{};const info=j.info||{};const meta=j.metadata||{};const ind=j.industryInfo||{};
  let mcap=null;
  if(withMcap){try{const t=await fetch(url+"&section=trade_info",{headers:apiHeaders(symbol)});
    if(t.ok){const tj=await t.json();const tc=tj&&tj.marketDeptOrderBook&&tj.marketDeptOrderBook.tradeInfo;if(tc&&tc.totalMarketCap!=null)mcap=+tc.totalMarketCap;}}catch(e){}}
  const data={
    price:p.lastPrice??null,prevClose:p.previousClose??null,open:p.open??null,
    dayHigh:p.intraDayHighLow?p.intraDayHighLow.max:null,dayLow:p.intraDayHighLow?p.intraDayHighLow.min:null,
    yearHigh:p.weekHighLow?p.weekHighLow.max:null,yearLow:p.weekHighLow?p.weekHighLow.min:null,
    change:p.change??null,pChange:p.pChange??null,
    name:info.companyName||symbol,industry:ind.industry||ind.basicIndustry||info.industry||"\u2014",
    pe:meta.pdSymbolPe?+meta.pdSymbolPe:null,mcap:mcap,ts:Date.now(),
  };
  cache.set(symbol,{at:Date.now(),data});
  return data;
}
async function mapLimit(arr,limit,fn){
  const out=[];let i=0;
  const workers=Array.from({length:Math.min(limit,arr.length)},async()=>{while(i<arr.length){const idx=i++;out[idx]=await fn(arr[idx]);}});
  await Promise.all(workers);return out;
}
export default async (req)=>{
  const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"*","Content-Type":"application/json","Cache-Control":"no-store"};
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
  const url=new URL(req.url);
  if(url.pathname.endsWith("/health"))return new Response(JSON.stringify({ok:true,cookies:Object.keys(jar).length}),{status:200,headers:cors});
  const raw=url.searchParams.get("symbols")||"";
  const symbols=raw.split(",").map((s)=>s.trim().toUpperCase()).filter(Boolean).slice(0,50);
  if(!symbols.length)return new Response(JSON.stringify({error:"pass ?symbols=RELIANCE,INFY"}),{status:400,headers:cors});
  const single=symbols.length===1;
  if(single){try{if(Date.now()-cookieAt>COOKIE_TTL_MS)await primeSession(symbols[0]);}catch(e){}}
  const results=await mapLimit(symbols,6,async(sym)=>{try{return [sym,await fetchQuote(sym,single)];}catch(e){return [sym,{error:String(e.message||e)}];}});
  const out={};results.forEach(([s,d])=>(out[s]=d));
  return new Response(JSON.stringify(out),{status:200,headers:cors});
};
us: 200, headers: cors });
};
