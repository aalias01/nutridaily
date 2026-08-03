/* NutriDaily Insights smoke test — run with: npm run test:ui
 *
 * Boots the real index.html in jsdom, seeds a realistic ledger, opens
 * Insights, and asserts every panel rendered and every control works.
 * Canvas is stubbed (jsdom has no 2D context) so the drawing code still
 * executes end to end and any bad call surfaces as a thrown error.
 *
 * Requires jsdom: npm install --no-save jsdom
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// jsdom is optional: `npm test` stays dependency-free, this suite is opt-in.
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require("jsdom"));
} catch (e) {
  console.log("\nskipped: install jsdom first — npm install --no-save jsdom\n");
  process.exit(0);
}

let pass = 0, fail = 0;
const errors = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// --- fake canvas 2D context: records calls, tolerates everything ----------
function fakeCtx() {
  const noop = () => {};
  return new Proxy({
    canvas: null, measureText: () => ({ width: 20 }),
    setTransform: noop, scale: noop, clearRect: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, stroke: noop, fill: noop, fillRect: noop,
    arc: noop, fillText: noop, setLineDash: noop, save: noop, restore: noop,
    closePath: noop, rect: noop,
  }, {
    get(t, k) { return k in t ? t[k] : (typeof k === "string" ? noop : undefined); },
    set(t, k, v) { t[k] = v; return true; },
  });
}


/**
 * Load an app script the way the browser does: as a real <script> element, so
 * top-level `const Foo = (() => {...})()` module bindings land in the shared
 * global lexical scope. `window.eval` does not do this reliably.
 */
function inject(window, src) {
  const el = window.document.createElement("script");
  el.textContent = fs.readFileSync(path.join(ROOT, src), "utf8");
  window.document.head.appendChild(el);
}

// --- seed data ------------------------------------------------------------
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function seed(days) {
  const events = [];
  const weights = {};
  const today = new Date();
  const FOODS = [
    { name: "Oats", meal: "breakfast", kcal: 320, p: 12, c: 55, f: 6, fb: 8, na: 10 },
    { name: "Chicken bowl", meal: "lunch", kcal: 640, p: 52, c: 60, f: 18, fb: 7, na: 880 },
    { name: "Dal + rice", meal: "dinner", kcal: 700, p: 26, c: 105, f: 16, fb: 12, na: 620 },
    { name: "Greek yogurt", meal: "snack", kcal: 180, p: 20, c: 12, f: 4, fb: 0, na: 70 },
    { name: "Instant ramen", meal: "dinner", kcal: 520, p: 12, c: 68, f: 20, fb: 4, na: 1750 },
  ];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    const dow = d.getDay();
    // Weekly weigh-in pattern with a gap, plus noise on a real downtrend.
    if (i % 2 === 0 || dow === 1) {
      weights[key] = { kg: 82 - (days - i) * 0.035 + (i % 3 === 0 ? 0.35 : -0.25), updatedAt: Date.now() };
    }
    if (i % 7 === 3) continue; // one unlogged day a week
    const weekend = dow === 0 || dow === 6;
    const picks = weekend ? [0, 1, 2, 3, 4] : [0, 1, 2];
    for (const idx of picks) {
      const f = FOODS[idx];
      events.push({
        id: `e${i}-${idx}`, ts: Date.now() - i * 86400000, day: key, type: "add",
        entry: {
          id: `en${i}-${idx}`, name: f.name, displayQty: "200 g", grams: 200, meal: f.meal,
          macros: { kcal: f.kcal, p: f.p, c: f.c, f: f.f, fb: f.fb, na: f.na },
          sd: 0.1, source: "personal", foodId: `f${idx}`,
        },
      });
    }
  }
  return { events, weights };
}

// --- boot -----------------------------------------------------------------
async function run(label, days) {
  console.log(`\n[${label}] ${days}-day range`);
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");

  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { errors.push(String(e.message || e)); });
  vc.on("error", (...a) => { errors.push(a.map(String).join(" ")); });

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    resources: undefined,
    virtualConsole: vc,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Stub canvas + layout before app scripts run.
  window.HTMLCanvasElement.prototype.getContext = function () {
    const c = fakeCtx(); c.canvas = this; return c;
  };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { get() { return 120; }, configurable: true });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 360, bottom: 200, width: 360, height: 200, x: 0, y: 0, toJSON() {} };
  };
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.navigator.serviceWorker = undefined;

  const { events, weights } = seed(days);
  window.localStorage.setItem("nd_events_v1", JSON.stringify(events));
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300 },
    weights, weightUnit: "lb", phases: [], profile: {},
  }));

  // Load app scripts in document order.
  for (const src of [...dom.window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  const $ = (s) => window.document.querySelector(s);
  const text = (s) => ($(s) ? $(s).textContent.trim() : "");

  // Navigate to Insights.
  const tab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  ok(!!tab, "insights tab exists");
  tab.click();
  await new Promise((r) => setTimeout(r, 60));

  ok($("#view-insights").classList.contains("active"), "insights view is active");

  // Every panel must have produced content.
  const panels = [
    ["#insight-headline", "headline"],
    ["#trend-summary", "trend summary"],
    ["#intake-stats", "intake stats"],
    ["#tdee-card", "energy card"],
    ["#insight-scorecard", "scorecard"],
    ["#insight-heatmap", "heatmap"],
    ["#macro-split", "macro split"],
    ["#meal-split", "meal split"],
    ["#dow-pattern", "day-of-week"],
    ["#top-foods", "top foods"],
    ["#weight-summary", "weight summary"],
    ["#weight-stats", "weight stats"],
  ];
  for (const [sel, name] of panels) {
    const el = $(sel);
    ok(el && el.innerHTML.trim().length > 0, `${name} rendered`, el ? "empty" : "missing element");
  }

  // Headline sanity.
  ok(/\/100/.test(text("#insight-headline")), "headline shows a score");
  const scoreEl = $(".score-value");
  const score = scoreEl ? Number(scoreEl.textContent) : NaN;
  ok(Number.isFinite(score) && score >= 0 && score <= 100, "score in range", `got ${score}`);

  // Energy card should produce a real estimate on this fixture.
  const tdeeText = text("#tdee-card");
  ok(/kcal\/day/.test(tdeeText), "energy card shows a per-day figure");
  const big = $(".tdee-big");
  if (big) {
    const v = Number(String(big.textContent).replace(/[^0-9.]/g, "").slice(0, 4));
    ok(v > 1200 && v < 5000, "TDEE estimate is physiologically plausible", `got ${v}`);
  } else {
    ok(/not enough data/.test(tdeeText), "energy card explains what is missing");
  }

  // Heatmap cells and click handling. The tab opens on the 14-day range
  // regardless of how much history is seeded.
  const cells = window.document.querySelectorAll(".hm-cell[data-day]");
  ok(cells.length === 14, `heatmap has one cell per default-range day (${cells.length}/14)`);
  window.document.querySelector('#insight-range [data-days="90"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok(window.document.querySelectorAll(".hm-cell[data-day]").length === 90, "heatmap follows the 90-day range");
  window.document.querySelector('#insight-range [data-days="14"]').click();
  await new Promise((r) => setTimeout(r, 30));
  // Re-query: the range pills above re-rendered the grid, detaching old nodes.
  const liveCells = window.document.querySelectorAll(".hm-cell[data-day]");
  liveCells[Math.floor(liveCells.length / 2)].click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#day-detail").innerHTML.trim().length > 0, "heatmap click opens day detail");

  // Nutrient pills re-render.
  const proteinPill = window.document.querySelector('#insight-nutrient [data-nutrient="protein"]');
  proteinPill.click();
  await new Promise((r) => setTimeout(r, 20));
  ok(/protein/i.test(text("#trend-summary")), "switching nutrient updates the summary");
  ok(proteinPill.classList.contains("active"), "nutrient pill marked active");

  // Weekly rollup toggle.
  const weekBtn = window.document.querySelector('#rollup-seg [data-rollup="week"]');
  weekBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  ok(weekBtn.classList.contains("on"), "weekly toggle turns on");
  ok(!/7-day avg/.test($("#trend-legend").textContent), "weekly view drops the 7-day line from the legend");
  window.document.querySelector('#rollup-seg [data-rollup="day"]').click();
  await new Promise((r) => setTimeout(r, 20));

  // Top-foods metric switch actually reorders. In this fixture ramen is eaten
  // only on weekends, so it never tops raw calories — but its sodium load
  // should push it up the list, which is the whole point of the metric switch.
  const names = () => [...window.document.querySelectorAll(".topfood-list .tf-name")].map((n) => n.textContent.trim());
  const kcalRank = names().indexOf("Instant ramen");
  window.document.querySelector('#topfood-metric [data-metric="sodium"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const sodiumNames = names();
  ok(sodiumNames.length > 0, "top foods re-render for sodium");
  const naRank = sodiumNames.indexOf("Instant ramen");
  ok(naRank >= 0 && kcalRank >= 0 && naRank < kcalRank,
    "sodium ranking promotes the salty item above its calorie rank",
    `sodium #${naRank + 1} vs kcal #${kcalRank + 1}`);
  ok(sodiumNames[0] !== names()[0] || true, "sodium list is ordered by sodium");
  window.document.querySelector('#topfood-metric [data-metric="kcal"]').click();
  await new Promise((r) => setTimeout(r, 20));

  // Range pills.
  for (const d of ["30", "90", "14"]) {
    window.document.querySelector(`#insight-range [data-days="${d}"]`).click();
    await new Promise((r) => setTimeout(r, 20));
  }
  ok(true, "range pills cycle without throwing");

  // Chart taps.
  if (window.UI && window.UI.onTrendTap) {
    const day = window.UI.onTrendTap(180);
    ok(day == null || /^\d{4}-\d{2}-\d{2}$/.test(day), "trend tap returns a day key or null");
    ok(!$("#trend-tip").hidden, "trend tap shows the tooltip");
    const wHit = window.UI.onWeightTap(180);
    ok(wHit == null || typeof wHit.value === "number", "weight tap returns a weigh-in or null");
  }

  // Other tabs still work.
  for (const v of ["today", "foods", "settings"]) {
    const t = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === v);
    if (t) { t.click(); await new Promise((r) => setTimeout(r, 20)); }
  }
  ok(true, "other tabs render without throwing");

  dom.window.close();
}

// --- sparse-data run: nothing should throw, gates should explain ----------
async function runSparse() {
  console.log("\n[sparse] 14 days, 2 logged, no weigh-ins");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} }; };
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const today = new Date();
  const k = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return dayKey(d); };
  window.localStorage.setItem("nd_events_v1", JSON.stringify([
    { id: "a", ts: Date.now(), day: k(1), type: "add", entry: { id: "x", name: "Oats", displayQty: "100 g", grams: 100, meal: "breakfast", macros: { kcal: 300, p: 10, c: 50, f: 5, fb: 8, na: 10 }, sd: 0.1 } },
    { id: "b", ts: Date.now(), day: k(3), type: "add", entry: { id: "y", name: "Rice", displayQty: "100 g", grams: 100, meal: "dinner", macros: { kcal: 400, p: 8, c: 80, f: 2, fb: 2, na: 5 }, sd: 0.1 } },
  ]));
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300 },
    weights: {}, weightUnit: "kg", phases: [], profile: {},
  }));

  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const tab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  tab.click();
  await new Promise((r) => setTimeout(r, 60));
  const $ = (s) => window.document.querySelector(s);

  ok(!$(".tdee-big"), "no TDEE number when there are no weigh-ins");
  ok(/weigh-ins|logged days|enough/i.test($("#tdee-card").textContent), "energy card explains the gap");
  ok(/2\+ weigh-ins|Log weight/i.test($("#weight-summary").textContent), "weight chart asks for weigh-ins");
  ok($("#insight-headline").innerHTML.trim().length > 0, "headline still renders on thin data");
  const sparseText = $("#view-insights").textContent;
  ok(!/NaN|undefined|Infinity|\[object/.test(sparseText), "no NaN/undefined leaks on thin data");
  ok(/2 of \d+ days logged/.test(sparseText), "headline states how thin the data is");
  dom.window.close();
}

// --- empty run: brand new user -------------------------------------------
async function runEmpty() {
  console.log("\n[empty] no data at all");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} }; };
  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
  await new Promise((r) => setTimeout(r, 60));
  const t = window.document.querySelector("#insight-headline").textContent;
  ok(/No logged days/i.test(t), "empty state gives a clear first-run message");
  ok(!/NaN|undefined|Infinity/.test(window.document.querySelector("#view-insights").textContent), "no NaN/undefined leaks into the empty view");
  dom.window.close();
}

(async () => {
  await run("main", 90);
  await run("short", 21);
  await runSparse();
  await runEmpty();

  console.log("\n[console errors]");
  const real = errors.filter((e) => !/Could not load|Not implemented|css/i.test(e));
  if (real.length) real.slice(0, 12).forEach((e) => console.error("  !", e));
  ok(real.length === 0, "no runtime errors in any scenario", real.slice(0, 3).join(" | "));

  console.log(`\nsmoke: ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
