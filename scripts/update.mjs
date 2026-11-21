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
async function get(url, asText = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: asText ? "text/csv,*/*" : "application/json,*/*" } });
      if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { fatal: true });
      return asText ? await res.text() : await res.json();
    } catch (e) {
      if (e.fatal || i === 2) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

// Data (RRRR-MM-DD) w strefie czasowej giełdy.
function dayIn(tz, unixSec) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(unixSec * 1000));
}

// ---------- Yahoo Finance (wykres dzienny) ----------
async function yahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=1d&includePrePost=false`;
  const j = await get(url);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.meta) throw new Error("brak danych");
  const m = r.meta, tz = m.exchangeTimezoneName || "UTC";
  const now = Date.now() / 1000;
  const today = dayIn(tz, now);
  const regEnd = m.currentTradingPeriod && m.currentTradingPeriod.regular && m.currentTradingPeriod.regular.end;
  const sessionOver = regEnd ? now >= regEnd : false;
  const ts = r.timestamp || [], closes = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const bars = [];
  ts.forEach((t, i) => { if (closes[i] > 0) bars.push({ date: dayIn(tz, t), close: closes[i] }); });
  // Jeden wpis na dzień (Yahoo czasem dubluje bieżący dzień).
  const byDay = new Map();
  bars.forEach((b) => byDay.set(b.date, b.close));
  const price = m.regularMarketPrice;
  const date = m.regularMarketTime ? dayIn(tz, m.regularMarketTime) : today;
  if (!(price > 0)) throw new Error("brak kursu");
  byDay.set(date, price); // ostatni kurs sesji jest dokładniejszy niż świeca dzienna
  const days = [...byDay.keys()].sort();
  const prevDay = days.filter((d) => d < date).pop();
  // Zamknięte dni: wcześniejsze niż dziś albo dzisiejszy po końcu sesji.
  const closed = days.filter((d) => d < today || (d === today && sessionOver)).map((d) => ({ date: d, close: byDay.get(d) }));
  return {
    price, date, currency: m.currency, prevClose: prevDay ? byDay.get(prevDay) : (m.chartPreviousClose || null),
    final: date < today || sessionOver, time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    closes: closed, source: "yahoo"
  };
}

// ---------- Stooq (zapasowe źródło, tylko bieżący kurs) ----------
async function stooq(sym) {
  const txt = await get(`https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlc&h&e=csv`, true);
  const lines = String(txt).trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("brak danych");
  const head = lines[0].toLowerCase().split(","), row = lines[1].split(",");
  const v = (k) => row[head.indexOf(k)];
  const close = parseFloat(v("close")), date = v("date");
  if (!(close > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("brak kursu");
  return { price: close, date, prevClose: null, final: null, time: null, closes: [], source: "stooq" };
}

function stooqSym(sym) {
  const [base, mkt] = sym.split(".");
  if (mkt === "PL") return base.toLowerCase();
  return `${base}.${mkt || "us"}`.toLowerCase();
}

async function quote(cands) {
  const errs = [];
  for (const c of cands) {
    try { return await (c.src === "yahoo" ? yahoo(c.t) : stooq(c.t)); }
    catch (e) { errs.push(`${c.src}:${c.t} ${e.message}`); }
    await sleep(400);
  }
  throw new Error(errs.join("; "));
}

// ---------- NBP ----------
async function nbp() {
  const out = {};
  for (const code of ["USD", "EUR"]) {
    const j = await get(`https://api.nbp.pl/api/exchangerates/rates/A/${code}/last/30/?format=json`);
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

const prices = { ...(latest.prices || {}) };
const closesBySym = {};
const ok = [], failed = [];
for (const s of watch.symbols) {
  const cands = [];
  if (s.yahoo) cands.push({ src: "yahoo", t: s.yahoo });
  cands.push({ src: "stooq", t: s.stooq || stooqSym(s.sym) });
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
  await sleep(300);
}

const bench = {}, benchCloses = {};
const BENCH = {
  spx: [{ src: "yahoo", t: "^GSPC" }, { src: "stooq", t: "^spx" }],
  wig: [{ src: "stooq", t: "wig" }, { src: "yahoo", t: "WIG.WA" }]
};
for (const k of Object.keys(BENCH)) {
  try {
    const q = await quote(BENCH[k]);
    bench[k] = { value: round(q.price, 2), date: q.date, final: q.final };
    benchCloses[k] = q.closes.length ? q.closes : (q.source === "stooq" ? [{ date: q.date, close: q.price, maybeOpen: true }] : []);
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
// Stooq nie mówi, czy sesja się skończyła – zapisuję tylko po godzinie zamknięcia giełdy.
const todayWarsaw = dayIn("Europe/Warsaw", Date.now() / 1000);
const hourWarsaw = +new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", hour12: false }).format(new Date());
for (const k of Object.keys(benchCloses)) {
  for (const c of benchCloses[k]) {
    if (c.maybeOpen && c.date === todayWarsaw && hourWarsaw < (k === "wig" ? 18 : 23)) continue;
    const d = touch(c.date); d.bench = d.bench || {}; d.bench[k] = round(c.close, 2);
  }
}
if (fxSeries) for (const d of days.values()) { const f = fxOn(fxSeries, d.date); if (f) d.fx = f; }
const sorted = [...days.values()].filter((d) => d.prices && Object.keys(d.prices).length).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-MAX_DAYS);
await writeJSON("history.json", { days: sorted, updatedAt: now });

log(`Odświeżono ${ok.length}/${watch.symbols.length} kursów.` + (failed.length ? ` Pominięte: ${failed.join(", ")}.` : ""));
log(`Indeksy: ${Object.keys(bench).join(", ") || "brak"}. Waluty: ${fx ? `USD ${fx.USD}, EUR ${fx.EUR}` : "brak"}. Dni w historii: ${sorted.length}.`);
if (!ok.length) process.exit(1);
