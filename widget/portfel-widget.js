// Widżet „Portfel” dla aplikacji Scriptable (iPhone / iPad).
// Czyta kursy zapisane przez GitHub Actions i liczy wartość portfela. Nie używa Claude ani tokenów.
// Pokazuje: wartość portfela, wynik z dziś (ostatniej sesji), wynik ogółem względem wpłat
// oraz najlepsze i najgorsze spółki dnia. Działa w rozmiarach małym, średnim i dużym.
// Ustawienia: adres strony, pozycje (ilość i koszt zakupu w walucie pozycji), gotówka i wpłaty netto.

const BASE_URL = "https://mrpiotrwoz.github.io/Portfel/"; // adres strony z GitHub Pages, z ukośnikiem na końcu
const PAGE_URL = BASE_URL;                                 // co otwiera stuknięcie w widżet

/*HOLDINGS_START*/
const HOLDINGS = [
  // { sym: "AAPL.US", name: "Apple", qty: 5, cur: "USD", cost: 1600 },
];
const CASH = [
  // { acct: "PLN", cur: "PLN", amount: 0 },
];
// Wpłaty netto: wpłaty minus wypłaty, razem z przelewami między rachunkami (z raportu XTB).
// Wpłaty w obcej walucie najlepiej wpisać w PLN po kursie z dnia wpłaty (tak liczy wykres na stronie);
// wpisane w USD będą przeliczane po dzisiejszym kursie. Puste = wynik od zakupu otwartych pozycji.
const INFLOW = [
  // { acct: "PLN", cur: "PLN", amount: 0 },
];
/*HOLDINGS_END*/

// ---------- Dane ----------
async function loadLatest() {
  const fm = FileManager.local();
  const cachePath = fm.joinPath(fm.cacheDirectory(), "portfel-latest.json");
  try {
    const req = new Request(BASE_URL + "data/latest.json?t=" + Date.now());
    req.timeoutInterval = 15;
    const d = await req.loadJSON();
    if (d && d.prices) { fm.writeString(cachePath, JSON.stringify(d)); return { d, offline: false }; }
  } catch (e) {}
  if (fm.fileExists(cachePath)) return { d: JSON.parse(fm.readString(cachePath)), offline: true };
  return { d: null, offline: true };
}

function compute(d) {
  const fx = Object.assign({ PLN: 1 }, d.fx || {});
  const k = (cur) => fx[cur] || null;
  let value = 0, posValue = 0, cost = 0, dayChange = 0, prevValue = 0, inflow = 0, hasInflow = false;
  const missing = [], dates = new Set(), rows = [];
  for (const h of HOLDINGS) {
    const p = d.prices && d.prices[h.sym];
    const r = k(h.cur);
    if (!p || !(p.price > 0) || !r) { missing.push(h.sym.split(".")[0]); continue; }
    const v = h.qty * p.price * r;
    value += v; posValue += v; cost += (h.cost || 0) * r;
    if (p.date) dates.add(p.date);
    let chg = null, chgAbs = null;
    if (p.prevClose > 0) {
      chg = p.price / p.prevClose - 1;
      chgAbs = h.qty * (p.price - p.prevClose) * r;
      dayChange += chgAbs;
      prevValue += h.qty * p.prevClose * r;
    }
    rows.push({ name: h.name || h.sym.split(".")[0], sym: h.sym, chg, chgAbs, value: v });
  }
  for (const c of CASH) { const r = k(c.cur); if (r) value += c.amount * r; }
  for (const f of INFLOW) { const r = k(f.cur); if (r) { inflow += f.amount * r; hasInflow = true; } }
  const total = hasInflow ? value - inflow : posValue - cost;
  const base = hasInflow ? inflow : cost;
  const withChg = rows.filter((x) => x.chg != null);
  return {
    value, dayChange, dayPct: prevValue > 0 ? dayChange / prevValue : null,
    total, totalPct: base > 0 ? total / base : null, totalLabel: hasInflow ? "Ogółem" : "Od zakupu",
    best: withChg.filter((x) => x.chg > 0).sort((a, b) => b.chg - a.chg),
    worst: withChg.filter((x) => x.chg < 0).sort((a, b) => a.chg - b.chg),
    missing, dates: [...dates].sort()
  };
}

// „Dziś”, gdy wszystkie kursy są z dzisiejszej sesji, inaczej data ostatniej sesji.
function dayLabel(dates, now) {
  now = now || new Date();
  const today = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  if (dates.length && dates.every((x) => x === today)) return "Dziś";
  const last = dates[dates.length - 1];
  return last ? "Sesja " + fmtDate(last) : "Dziś";
}

// ---------- Formatowanie ----------
const nf0 = (v) => new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(v);
const pln = (v) => nf0(v) + " zł";
const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
const signedPln = (v) => sgn(v) + pln(Math.abs(v));
const pctTxt = (v) => v == null ? "—" : sgn(v) + new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(v) * 100) + "%";
function fmtDate(s) { return s ? s.slice(8, 10) + "." + s.slice(5, 7) : "?"; }

// ---------- Widżet ----------
async function build() {
  const C = {
    bg: Color.dynamic(new Color("#ffffff"), new Color("#171d21")),
    ink: Color.dynamic(new Color("#10181f"), new Color("#eef1f3")),
    muted: Color.dynamic(new Color("#4a5762"), new Color("#9aa6af")),
    up: Color.dynamic(new Color("#006300"), new Color("#2fbf2f")),
    down: Color.dynamic(new Color("#c22f2f"), new Color("#f07a7a")),
    accent: Color.dynamic(new Color("#0f4c5c"), new Color("#7fcbdc"))
  };
  const tone = (v) => v > 0 ? C.up : v < 0 ? C.down : C.muted;
  function text(stack, s, size, color, weight) {
    const t = stack.addText(s);
    t.font = weight === "bold" ? Font.boldSystemFont(size) : weight === "semi" ? Font.semiboldSystemFont(size) : Font.systemFont(size);
    t.textColor = color || C.ink;
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.6;
    return t;
  }
  // Blok „Dziś” / „Ogółem”: etykieta, kwota i procent.
  function stat(stack, label, abs, pct, big) {
    const s = stack.addStack(); s.layoutVertically();
    text(s, label, big ? 11 : 10, C.muted);
    text(s, signedPln(abs), big ? 15 : 13, tone(abs), "semi");
    text(s, pctTxt(pct), big ? 12 : 11, tone(abs));
    return s;
  }
  // Kolumna spółek: tytuł i lista nazwa + zmiana.
  function moversCol(stack, title, list, n, showAbs) {
    const col = stack.addStack(); col.layoutVertically();
    text(col, title, 10, C.muted, "semi");
    col.addSpacer(2);
    if (!list.length) text(col, "—", 11, C.muted);
    for (const m of list.slice(0, n)) {
      const row = col.addStack(); row.centerAlignContent();
      text(row, m.name, 11, C.ink);
      row.addSpacer(4);
      text(row, pctTxt(m.chg) + (showAbs ? "  " + signedPln(m.chgAbs) : ""), 11, tone(m.chg), "semi");
      col.addSpacer(showAbs ? 3 : 1);
    }
    return col;
  }

  const family = config.widgetFamily || "medium";
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = PAGE_URL;
  w.setPadding(12, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  const { d, offline } = await loadLatest();
  if (!d) { text(w, "Portfel", 13, C.muted, "semi"); w.addSpacer(6); text(w, "Brak danych – sprawdź BASE_URL.", 12, C.down); return w; }
  if (!HOLDINGS.length) { text(w, "Portfel", 13, C.muted, "semi"); w.addSpacer(6); text(w, "Uzupełnij HOLDINGS w skrypcie.", 12, C.down); return w; }
  const r = compute(d);
  const day = dayLabel(r.dates);

  const head = w.addStack(); head.centerAlignContent();
  text(head, "Portfel", 12, C.accent, "semi");
  head.addSpacer();
  text(head, (offline ? "offline · " : "") + "kursy " + r.dates.map(fmtDate).filter((x, i, a) => a.indexOf(x) === i).join("/"), 9, C.muted);

  if (family === "small") {
    w.addSpacer(4);
    text(w, pln(r.value), 20, C.ink, "bold");
    w.addSpacer(4);
    const l1 = w.addStack(); l1.centerAlignContent();
    text(l1, day, 10, C.muted); l1.addSpacer();
    text(l1, pctTxt(r.dayPct), 12, tone(r.dayChange), "semi");
    text(w, signedPln(r.dayChange), 11, tone(r.dayChange));
    w.addSpacer(3);
    const l2 = w.addStack(); l2.centerAlignContent();
    text(l2, r.totalLabel, 10, C.muted); l2.addSpacer();
    text(l2, pctTxt(r.totalPct), 12, tone(r.total), "semi");
    text(w, signedPln(r.total), 11, tone(r.total));
    w.addSpacer();
    const b = r.best[0], s = r.worst[0];
    const l3 = w.addStack(); l3.centerAlignContent();
    if (b) text(l3, "▲ " + b.sym.split(".")[0] + " " + pctTxt(b.chg), 10, C.up, "semi");
    l3.addSpacer();
    if (s) text(l3, "▼ " + s.sym.split(".")[0] + " " + pctTxt(s.chg), 10, C.down, "semi");
    return w;
  }

  const large = family !== "medium";
  w.addSpacer(large ? 6 : 2);
  const top = w.addStack(); top.centerAlignContent();
  const valCol = top.addStack(); valCol.layoutVertically();
  text(valCol, "Wartość", large ? 11 : 10, C.muted);
  text(valCol, pln(r.value), large ? 26 : 21, C.ink, "bold");
  top.addSpacer();
  stat(top, day, r.dayChange, r.dayPct, large);
  top.addSpacer(large ? 18 : 12);
  stat(top, r.totalLabel, r.total, r.totalPct, large);

  w.addSpacer(large ? 14 : 8);
  const n = large ? 6 : 3;
  const cols = w.addStack(); cols.topAlignContent();
  moversCol(cols, "Najlepsze · " + day.toLowerCase(), r.best, n, large);
  cols.addSpacer(14);
  moversCol(cols, "Najgorsze · " + day.toLowerCase(), r.worst, n, large);

  if (large && r.missing.length) { w.addSpacer(8); text(w, "Bez kursu: " + r.missing.join(", "), 10, C.muted); }
  w.addSpacer();
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else if (args.widgetParameter === "small" || config.widgetFamily === "small") await widget.presentSmall();
else await widget.presentMedium();
Script.complete();
