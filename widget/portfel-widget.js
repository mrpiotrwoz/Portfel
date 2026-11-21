// Widżet „Portfel” dla aplikacji Scriptable (iPhone / iPad).
// Czyta kursy zapisane przez GitHub Actions i liczy wartość portfela. Nie używa Claude ani tokenów.
// Ustawienia: wpisz adres swojej strony i swoje pozycje (ilość akcji i koszt zakupu w walucie pozycji).

const BASE_URL = "https://TWOJ-LOGIN.github.io/portfel/"; // adres strony z GitHub Pages, z ukośnikiem na końcu
const PAGE_URL = BASE_URL;                                 // co otwiera stuknięcie w widżet

/*HOLDINGS_START*/
const HOLDINGS = [
  // { sym: "AAPL.US", name: "Apple", qty: 5, cur: "USD", cost: 1600 },
];
const CASH = [
  // { acct: "PLN", cur: "PLN", amount: 0 },
];
/*HOLDINGS_END*/

// ---------- Dane ----------
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.cacheDirectory(), "portfel-latest.json");

async function loadLatest() {
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
  let value = 0, posValue = 0, cost = 0, dayChange = 0, prevValue = 0, missing = [], dates = new Set();
  const rows = [];
  for (const h of HOLDINGS) {
    const p = d.prices && d.prices[h.sym];
    const r = k(h.cur);
    if (!p || !(p.price > 0) || !r) { missing.push(h.sym); continue; }
    const v = h.qty * p.price * r;
    value += v; posValue += v; cost += (h.cost || 0) * r;
    dates.add(p.date);
    let chg = null;
    if (p.prevClose > 0) {
      chg = p.price / p.prevClose - 1;
      dayChange += h.qty * (p.price - p.prevClose) * r;
      prevValue += h.qty * p.prevClose * r;
    }
    rows.push({ name: h.name || h.sym.split(".")[0], sym: h.sym, chg, value: v });
  }
  for (const c of CASH) { const r = k(c.cur); if (r) value += c.amount * r; }
  return { value, posValue, cost, dayChange, dayPct: prevValue > 0 ? dayChange / prevValue : null, rows, missing,
    dates: [...dates].sort(), fx };
}

// ---------- Formatowanie ----------
const nf0 = (v) => new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(v);
const pln = (v) => nf0(v) + " zł";
const sgn = (v) => (v > 0 ? "+" : v < 0 ? "−" : "");
const pctTxt = (v) => v == null ? "—" : sgn(v) + new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v) * 100) + "%";
const fmtDate = (s) => s ? s.slice(8, 10) + "." + s.slice(5, 7) : "?";

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

// ---------- Widżet ----------
async function build() {
  const family = config.widgetFamily || "medium";
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = PAGE_URL;
  w.setPadding(14, 14, 14, 14);
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  const { d, offline } = await loadLatest();
  if (!d) { text(w, "Portfel", 13, C.muted, "semi"); w.addSpacer(6); text(w, "Brak danych – sprawdź BASE_URL.", 12, C.down); return w; }
  if (!HOLDINGS.length) { text(w, "Portfel", 13, C.muted, "semi"); w.addSpacer(6); text(w, "Uzupełnij HOLDINGS w skrypcie.", 12, C.down); return w; }
  const r = compute(d);

  const head = w.addStack(); head.centerAlignContent();
  text(head, "Portfel", 13, C.accent, "semi");
  head.addSpacer();
  text(head, (offline ? "offline · " : "") + "kursy " + r.dates.map(fmtDate).filter((x, i, a) => a.indexOf(x) === i).join("/"), 10, C.muted);

  w.addSpacer(family === "small" ? 6 : 4);
  text(w, pln(r.value), family === "small" ? 22 : 26, C.ink, "bold");
  const line = w.addStack(); line.centerAlignContent();
  text(line, sgn(r.dayChange) + pln(Math.abs(r.dayChange)) + "  " + pctTxt(r.dayPct), 13, tone(r.dayChange), "semi");
  if (family !== "small") {
    line.addSpacer();
    text(line, "od zakupu " + pctTxt(r.cost > 0 ? r.posValue / r.cost - 1 : null), 11, C.muted);
  }

  if (family === "small") {
    w.addSpacer();
    text(w, "od zakupu " + pctTxt(r.cost > 0 ? r.posValue / r.cost - 1 : null), 10, C.muted);
    return w;
  }

  w.addSpacer(8);
  const n = family === "medium" ? 3 : family === "large" ? 9 : 14;
  const movers = r.rows.filter((x) => x.chg != null).sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).slice(0, n);
  if (!movers.length) text(w, "Zmiany dzienne pojawią się po pierwszej aktualizacji.", 11, C.muted);
  for (const m of movers) {
    const row = w.addStack(); row.centerAlignContent();
    text(row, m.name, 12, C.ink);
    row.addSpacer();
    text(row, pctTxt(m.chg), 12, tone(m.chg), "semi");
    w.addSpacer(family === "medium" ? 2 : 4);
  }
  if (r.missing.length && family !== "medium") { w.addSpacer(4); text(w, "Bez kursu: " + r.missing.join(", "), 10, C.muted); }
  w.addSpacer();
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
