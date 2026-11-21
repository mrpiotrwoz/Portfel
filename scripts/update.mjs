// Pobiera kursy akcji, indeksów i walut, zapisuje data/latest.json i data/history.json.
// Uruchamiany przez GitHub Actions (Node 20+, bez dodatkowych pakietów). Nie używa Claude ani tokenów.
import { readFile, writeFile } from "node:fs/promises";

const DIR = new URL("../data/", import.meta.url);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_DAYS = 400;
const log = (...a) => console.log(...a);

async function readJSON(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DIR), "utf8")); } catch { return fallback; }
}
async function writeJSON(name, data) {
  await writeFile(new URL(name, DIR), JSON.stringify(data, null, 1) + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

// Pobranie z jedną powtórką przy przeciążeniu (429/5xx).
async function req(url, { type = "json", headers = {} } = {}) {
  for (let i = 0; i < 2; i++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...headers } });
    if ((res.status === 429 || res.status >= 500) && i === 0) { await sleep(1500); continue; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    return type === "json" ? res.json() : res.text();
  }
}
// Źródło, które kilka razy z rzędu odmawia, wyłączam do końca przebiegu (oszczędza czas).
const strikes = {}, disabled = new Set();
function noteFail(src, msg) {
  if (/HTTP (429|403)|crumb|ciasteczk/.test(msg)) { strikes[src] = (strikes[src] || 0) + 1; if (strikes[src] >= 3) disabled.add(src); }
}
function noteOk(src) { strikes[src] = 0; }

// Data (RRRR-MM-DD) i czas w strefie czasowej giełdy.
function dayIn(tz, unixSec) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(unixSec * 1000));
}
function minutesIn(tz) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const v = (t) => +p.find((x) => x.type === t).value;
  return (v("hour") % 24) * 60 + v("minute");
}
const MARKET = {
  US: { tz: "America/New_York", close: 16 * 60 + 10 },
  PL: { tz: "Europe/Warsaw", close: 17 * 60 + 10 }
};
// Czy kurs z danego dnia to już zamknięcie sesji.
function isFinal(mkt, date) {
  const m = MARKET[mkt] || MARKET.US;
  const today = dayIn(m.tz, Date.now() / 1000);
  return date < today || (date === today && minutesIn(m.tz) >= m.close);
}
function simpleResult(mkt, price, date, prevClose, currency, source) {
  const final = isFinal(mkt, date);
  return { price, date, prevClose, currency, final, closes: final ? [{ date, close: price }] : [], source };
}

// ---------- Yahoo Finance (z ciasteczkiem i „crumb”; bez nich zwraca 429) ----------
let ySess = null;
async function yahooSession() {
  if (ySess) return ySess;
  const r = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("brak ciasteczka Yahoo");
  const crumb = String(await req("https://query2.finance.yahoo.com/v1/test/getcrumb", { type: "text", headers: { Cookie: cookie } })).trim();
  if (!crumb || crumb.length > 40 || /[<{]/.test(crumb)) throw new Error("brak crumb Yahoo");
  ySess = { cookie, crumb };
  return ySess;
}
async function yahoo(ticker) {
  const { cookie, crumb } = await yahooSession();
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=1d&includePrePost=false&crumb=${encodeURIComponent(crumb)}`;
  const j = await req(url, { headers: { Cookie: cookie } });
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.meta) throw new Error("brak danych");
  const m = r.meta, tz = m.exchangeTimezoneName || "UTC";
  const now = Date.now() / 1000;
  const today = dayIn(tz, now);
  const regEnd = m.currentTradingPeriod && m.currentTradingPeriod.regular && m.currentTradingPeriod.regular.end;
  const sessionOver = regEnd ? now >= regEnd : false;
  const ts = r.timestamp || [], closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const byDay = new Map();
  ts.forEach((t, i) => { if (closes[i] > 0) byDay.set(dayIn(tz, t), closes[i]); });
  const price = m.regularMarketPrice;
  const date = m.regularMarketTime ? dayIn(tz, m.regularMarketTime) : today;
  if (!(price > 0)) throw new Error("brak kursu");
  byDay.set(date, price); // ostatni kurs sesji jest dokładniejszy niż świeca dzienna
  const days = [...byDay.keys()].sort();
  const prevDay = days.filter((d) => d < date).pop();
  const closed = days.filter((d) => d < today || (d === today && sessionOver)).map((d) => ({ date: d, close: byDay.get(d) }));
  return { price, date, currency: m.currency, prevClose: prevDay ? byDay.get(prevDay) : (m.chartPreviousClose || null),
    final: date < today || sessionOver, closes: closed, source: "yahoo" };
}

// ---------- Google Finance (strona notowania) ----------
function num(s) {
  const n = parseFloat(String(s || "").replace(/[^0-9.,-]/g, "").replace(/,/g, ""));
  return isFinite(n) ? n : null;
}
async function google(code, mkt) {
  const html = await req(`https://www.google.com/finance/quote/${code}?hl=en`, { type: "text" });
  const price = num((html.match(/data-last-price="([\d.,]+)"/) || [])[1]);
  if (!(price > 0)) throw new Error("brak kursu");
  const ts = +((html.match(/data-last-normal-market-timestamp="(\d+)"/) || [])[1] || 0);
  const currency = (html.match(/data-currency-code="([A-Z]{3})"/) || [])[1] || null;
  const prev = num((html.match(/Previous close<\/div>[\s\S]{0,400}?>([^<>]*\d[^<>]*)<\/div>/) || [])[1]);
  const tz = MARKET[mkt].tz;
  const date = ts ? dayIn(tz, ts) : dayIn(tz, Date.now() / 1000);
  return simpleResult(mkt, price, date, prev, currency, "google");
}
const GOOGLE_EX = { US: ["NASDAQ", "NYSE", "NYSEAMERICAN", "NYSEARCA"], PL: ["WSE"] };

// ---------- Stooq (CSV) ----------
async function stooq(sym, mkt) {
  let lastErr;
  for (const host of ["stooq.pl", "stooq.com"]) {
    try {
      const txt = await req(`https://${host}/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlc&h&e=csv`, { type: "text" });
      const lines = String(txt).trim().split(/\r?\n/);
      if (lines.length < 2) throw new Error("brak danych");
      const head = lines[0].toLowerCase().split(","), row = lines[1].split(",");
      const v = (k) => row[head.indexOf(k)];
      const close = parseFloat(v("close")), date = v("date");
      if (!(close > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("brak kursu");
      return simpleResult(mkt, close, date, null, null, "stooq");
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
function stooqSym(sym) {
  const [base, mkt] = sym.split(".");
  if (mkt === "PL") return base.toLowerCase();
  return `${base}.${mkt || "us"}`.toLowerCase();
}

// ---------- CNBC (USA i S&P 500, wiele symboli w jednym zapytaniu) ----------
let cnbcCache = null;
async function cnbcBatch(symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 20) {
    const part = symbols.slice(i, i + 20);
    const url = "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=" +
      encodeURIComponent(part.join("|")) + "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1";
    const j = await req(url, { headers: { Accept: "application/json" } });
    const list = (j && j.FormattedQuoteResult && j.FormattedQuoteResult.FormattedQuote) || [];
    for (const q of [].concat(list)) if (q && q.symbol) out[String(q.symbol).toUpperCase()] = q;
  }
  return out;
}
async function cnbc(sym) {
  if (!cnbcCache) throw new Error("brak danych CNBC");
  const q = cnbcCache[sym.toUpperCase()];
  if (!q) throw new Error("brak symbolu");
  const price = num(q.last);
  if (!(price > 0)) throw new Error("brak kursu");
  const date = /^\d{4}-\d{2}-\d{2}/.test(q.last_time || "") ? q.last_time.slice(0, 10) : dayIn(MARKET.US.tz, Date.now() / 1000);
  return simpleResult("US", price, date, num(q.previous_day_closing), q.currencyCode || "USD", "cnbc");
}

// ---------- Biznesradar (GPW) ----------
function lastSessionDay(tz) {
  // Dziś, a w weekend ostatni piątek.
  const d = new Date(dayIn(tz, Date.now() / 1000) + "T12:00:00Z");
  const wd = d.getUTCDay();
  if (wd === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (wd === 0) d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}
function plNum(s) {
  const n = parseFloat(String(s || "").replace(/[\s ]/g, "").replace(",", "."));
  return isFinite(n) ? n : null;
}
async function biznesradar(code) {
  const html = await req(`https://www.biznesradar.pl/notowania/${encodeURIComponent(code)}`, { type: "text" });
  const m = html.match(/class="q_ch_act"[^>]*>\s*([\d\s ]+(?:,\d+)?)/);
  const price = m ? plNum(m[1]) : null;
  if (!(price > 0)) throw new Error("brak kursu");
  // Data notowania: pełna data, jeśli jest w nagłówku, inaczej dzisiejsza sesja (w weekend piątek).
  const dm = html.match(/class="q_ch_date"[^>]*>[\s\S]{0,80}?(\d{2})\.(\d{2})\.(\d{4})/);
  const date = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : lastSessionDay(MARKET.PL.tz);
  const pm = html.match(/Kurs odniesienia[\s\S]{0,200}?>\s*([\d\s ]+,\d+)\s*</);
  return simpleResult("PL", price, date, pm ? plNum(pm[1]) : null, "PLN", "biznesradar");
}

// ---------- Test źródeł na starcie ----------
async function probe(name, url, marker) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
    const body = await res.text();
    const title = (body.match(/<title[^>]*>([^<]{0,80})/i) || [])[1] || "";
    const at = marker ? body.search(marker) : -1;
    const snip = (at >= 0 ? body.slice(Math.max(0, at - 60), at + 140) : body.slice(0, 160)).replace(/\s+/g, " ");
    log(`[test] ${name}: HTTP ${res.status}, ${body.length} B, ${at >= 0 ? "znacznik OK" : "BRAK znacznika"}${title ? `, title="${title.trim()}"` : ""} | ${snip}`);
    return res.ok && at >= 0;
  } catch (e) {
    log(`[test] ${name}: ${e.message}${e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""}`);
    return false;
  }
}

// Próbuje kolejnych źródeł, aż któreś poda kurs.
async function quote(cands) {
  const errs = [];
  for (const c of cands) {
    if (disabled.has(c.src)) { errs.push(`${c.src}: wyłączone`); continue; }
    try {
      const q = c.src === "yahoo" ? await yahoo(c.t) : c.src === "google" ? await google(c.t, c.mkt)
        : c.src === "cnbc" ? await cnbc(c.t) : c.src === "biznesradar" ? await biznesradar(c.t) : await stooq(c.t, c.mkt);
      noteOk(c.src);
      return q;
    } catch (e) {
      noteFail(c.src, e.message);
      errs.push(`${c.src}:${c.t} ${e.message}${e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""}`);
    }
    await sleep(250);
  }
  throw new Error(errs.join("; "));
}

// ---------- NBP ----------
async function nbp() {
  const out = {};
  for (const code of ["USD", "EUR"]) {
    const j = await req(`https://api.nbp.pl/api/exchangerates/rates/A/${code}/last/30/?format=json`);
    out[code] = (j.rates || []).map((r) => ({ date: r.effectiveDate, mid: r.mid }));
  }
  return out;
}
function fxOn(series, date) {
  const res = {};
  for (const code of Object.keys(series)) {
    const r = series[code].filter((x) => x.date <= date).pop();
    if (r) res[code] = r.mid;
  }
  return Object.keys(res).length ? res : null;
}

// ---------- Główna część ----------
const watch = await readJSON("watchlist.json", null);
if (!watch || !Array.isArray(watch.symbols) || !watch.symbols.length) { log("Brak data/watchlist.json – koniec."); process.exit(0); }
const latest = await readJSON("latest.json", {});
const history = await readJSON("history.json", { days: [] });

// Szybki test źródeł; niedziałające pomijam od razu.
const usBases = watch.symbols.filter((x) => !x.sym.endsWith(".PL")).map((x) => x.sym.split(".")[0]);
const plFirst = (watch.symbols.find((x) => x.sym.endsWith(".PL")) || { sym: "SNT.PL" }).sym.split(".")[0];
const tests = {
  cnbc: probe("cnbc", "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=MU&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json", /"last"/),
  biznesradar: probe("biznesradar", `https://www.biznesradar.pl/notowania/${plFirst}`, /q_ch_act/),
  google: probe("google", "https://www.google.com/finance/quote/MU:NASDAQ?hl=en", /data-last-price/),
  stooq: probe("stooq", "https://stooq.pl/q/l/?s=mu.us&f=sd2t2ohlc&h&e=csv", /\d{4}-\d{2}-\d{2}/)
};
for (const [k, pr] of Object.entries(tests)) if (!(await pr)) disabled.add(k);
try { await yahooSession(); log("[test] yahoo: ciasteczko i crumb OK"); }
catch (e) { log(`[test] yahoo: ${e.message}`); disabled.add("yahoo"); }
if (!disabled.has("cnbc")) {
  try { cnbcCache = await cnbcBatch([...usBases, ".SPX"]); log(`[test] cnbc: ${Object.keys(cnbcCache).length} symboli`); }
  catch (e) { log(`[test] cnbc batch: ${e.message}`); disabled.add("cnbc"); }
}
log(`Źródła wyłączone: ${[...disabled].join(", ") || "żadne"}`);

const prices = { ...(latest.prices || {}) };
const closesBySym = {};
const ok = [], failed = [];
for (const s of watch.symbols) {
  const mkt = s.sym.endsWith(".PL") ? "PL" : "US";
  const base = s.sym.split(".")[0];
  const cands = [];
  if (mkt === "US") cands.push({ src: "cnbc", t: base });
  if (mkt === "PL") cands.push({ src: "biznesradar", t: base });
  if (s.yahoo) cands.push({ src: "yahoo", t: s.yahoo });
  const gex = s.google ? [s.google] : GOOGLE_EX[mkt].map((ex) => `${base}:${ex}`);
  gex.forEach((g) => cands.push({ src: "google", t: g, mkt }));
  cands.push({ src: "stooq", t: s.stooq || stooqSym(s.sym), mkt });
  try {
    const q = await quote(cands);
    const currency = s.sym.endsWith(".PL") ? "PLN" : (q.currency || "USD");
    prices[s.sym] = { price: round(q.price), currency, date: q.date, prevClose: q.prevClose ? round(q.prevClose) : null,
      final: q.final, source: q.source };
    closesBySym[s.sym] = q.closes;
    ok.push(s.sym);
  } catch (e) {
    failed.push(s.sym);
    log(`! ${s.sym}: ${e.message} – zostaje poprzedni kurs`);
  }
  if (ok.includes(s.sym)) { const x = prices[s.sym]; log(`  ${s.sym}: ${x.price} ${x.currency} (${x.date}, ${x.source}${x.final ? ", zamknięcie" : ""})`); }
  await sleep(200);
}

const bench = {}, benchCloses = {};
const BENCH = {
  spx: [{ src: "cnbc", t: ".SPX" }, { src: "yahoo", t: "^GSPC" }, { src: "google", t: ".INX:INDEXSP", mkt: "US" }, { src: "stooq", t: "^spx", mkt: "US" }],
  wig: [{ src: "biznesradar", t: "WIG" }, { src: "yahoo", t: "WIG.WA" }, { src: "google", t: "WIG:WSE", mkt: "PL" }, { src: "stooq", t: "wig", mkt: "PL" }]
};
for (const k of Object.keys(BENCH)) {
  try {
    const q = await quote(BENCH[k]);
    bench[k] = { value: round(q.price, 2), date: q.date, final: q.final };
    benchCloses[k] = q.closes;
    log(`  indeks ${k}: ${bench[k].value} (${q.date}, ${q.source})`);
  } catch (e) { log(`! indeks ${k}: ${e.message}`); }
}

let fxSeries = null, fx = latest.fx || null;
try {
  fxSeries = await nbp();
  fx = { USD: fxSeries.USD.at(-1).mid, EUR: fxSeries.EUR.at(-1).mid };
} catch (e) { log(`! NBP: ${e.message} – zostają poprzednie kursy walut`); }

const now = new Date().toISOString();
const newLatest = {
  ...latest,
  prices, fx, bench,
  fxDate: fxSeries ? fxSeries.USD.at(-1).date : (latest.fxDate || null),
  updatedAt: now,
  source: "github-actions"
};
await writeJSON("latest.json", newLatest);

// Historia: uzupełniam kursy zamknięcia z ostatnich tygodni (tylko zakończone sesje).
const days = new Map((history.days || []).map((d) => [d.date, d]));
const touch = (date) => { if (!days.has(date)) days.set(date, { date, prices: {} }); const d = days.get(date); d.prices = d.prices || {}; return d; };
for (const sym of Object.keys(closesBySym)) {
  for (const c of closesBySym[sym]) touch(c.date).prices[sym] = round(c.close);
}
for (const k of Object.keys(benchCloses)) {
  for (const c of benchCloses[k]) {
    const d = touch(c.date); d.bench = d.bench || {}; d.bench[k] = round(c.close, 2);
  }
}
if (fxSeries) for (const d of days.values()) { const f = fxOn(fxSeries, d.date); if (f) d.fx = f; }
const sorted = [...days.values()].filter((d) => d.prices && Object.keys(d.prices).length).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-MAX_DAYS);
await writeJSON("history.json", { days: sorted, updatedAt: now });

log(`Odświeżono ${ok.length}/${watch.symbols.length} kursów.` + (failed.length ? ` Pominięte: ${failed.join(", ")}.` : ""));
log(`Indeksy: ${Object.keys(bench).join(", ") || "brak"}. Waluty: ${fx ? `USD ${fx.USD}, EUR ${fx.EUR}` : "brak"}. Dni w historii: ${sorted.length}.`);
if (!ok.length) process.exit(1);
