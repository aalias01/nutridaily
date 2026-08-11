/* NutriDaily Insights smoke test — run with: npm run test:ui
 *
 * Boots the real index.html in jsdom, seeds a realistic ledger, opens
 * Insights, and asserts every panel rendered and every control works.
 * Canvas is stubbed (jsdom has no 2D context) so the drawing code still
 * executes end to end and any bad call surfaces as a thrown error.
 *
 * jsdom is a declared dev dependency; this suite must never silently skip.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const { JSDOM, VirtualConsole } = require("jsdom");

let pass = 0, fail = 0;
const errors = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

function dialogName(el) {
  const direct = (el.getAttribute("aria-label") || "").trim();
  if (direct) return direct;
  const ids = (el.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter(Boolean);
  const labelled = ids.map((id) => {
    const node = el.ownerDocument.getElementById(id);
    return node ? node.textContent.trim() : "";
  }).filter(Boolean).join(" ");
  if (labelled) return labelled;
  const heading = el.querySelector("h1, h2, h3");
  return heading ? heading.textContent.trim() : "";
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const rgb = (String(hex).match(/[0-9a-f]{2}/gi) || []).map((part) => parseInt(part, 16) / 255);
    const linear = rgb.map((value) => value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
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

function installPrimaryLock(window) {
  Object.defineProperty(window.navigator, "locks", {
    configurable: true,
    value: {
      request(name, options, callback) {
        return Promise.resolve().then(() => callback({ name, mode: options && options.mode || "exclusive" }));
      },
    },
  });
}


/**
 * Wait for the app to boot.
 *
 * jsdom fires DOMContentLoaded itself once parsing settles, so dispatching one
 * manually booted the app a second time and bound every listener twice — which
 * made a single click run its handler twice and would have masked or invented
 * bugs throughout this suite. Wait for the real event instead, and only force
 * one if it has already fired before the app scripts were injected.
 */
async function bootApp(window) {
  const booted = () => {
    const el = window.document.querySelector("#day-label");
    return !!(el && el.textContent.trim());
  };
  for (let i = 0; i < 60; i++) {
    if (booted()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  // Never fired (document already complete): boot it once, by hand.
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 40));
  if (!booted()) throw new Error("app did not boot");
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


/** A calorie adjustment planned before logging, for the audit surfaces. */
function energyAdjustmentFixture(days) {
  const today = new Date();
  const at = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return dayKey(d); };
  const endOf = (key) => { const d = new Date(key + "T12:00:00"); d.setHours(24, 0, 0, 0); return d.getTime(); };
  if (days < 12) return {};
  const planned = at(9);
  return {
    [planned]: { bumps: { kcal: 400 }, updatedAt: Date.now() - 9 * 86400e3 - 3600e3 },
  };
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

  if (label === "main") {
    const inlineScripts = [...window.document.querySelectorAll("script:not([src])")];
    ok(inlineScripts.length === 0, "CSP-compatible index has no inline scripts", `found ${inlineScripts.length}`);
    ok(!!window.document.querySelector('head > script[src="js/boot.js"]'), "early boot is an external head script");
    const swText = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
    ok(swText.indexOf("e.waitUntil(cacheUpdate)") >= 0 && swText.indexOf("e.waitUntil(cacheUpdate)") < swText.indexOf("e.respondWith"),
      "service-worker fetch waitUntil is registered synchronously");
    const cssText = fs.readFileSync(path.join(ROOT, "css/style.css"), "utf8");
    const controlFills = [...cssText.matchAll(/--control-accent:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
    ok(controlFills.length >= 2 && controlFills.every((color) => contrastRatio("#ffffff", color) >= 4.5) &&
        /\.btn\s*\{[^}]*background:\s*var\(--control-accent\)[^}]*color:\s*#fff/s.test(cssText),
      "filled interactive accents meet WCAG AA with normal white text in every theme");
    ok(contrastRatio("#2c7a57", "#ffffff") >= 4.5 && contrastRatio("#6cc39a", "#1f2226") >= 4.5,
      "light and dark interactive accent text meets WCAG AA");
    ok(/--hm-size:\s*24px/.test(cssText) && /\.hm-cell\s*\{[^}]*width:\s*var\(--hm-size\)[^}]*height:\s*var\(--hm-size\)/s.test(cssText),
      "interactive heatmap cells expose at least a 24px CSS target");
    // Dock uses --card at 92% mix; assert the solid --card tokens that feed it.
    const cardFills = [...cssText.matchAll(/^\s*--card:\s*(#[0-9a-f]{6})/gim)].map((m) => m[1]);
    ok(cardFills.length >= 2 &&
        cardFills.every((color) => contrastRatio("#23282d", color) >= 4.5 || contrastRatio("#e8e6e1", color) >= 4.5),
      "insight-dock card surfaces keep text-level contrast in every theme");
    ok(/\.insight-section\[hidden\][^}]*display:\s*none\s*!important/s.test(cssText),
      "insight-section [hidden] uses display:none !important");
    ok(/\.insight-panel\[hidden\][^}]*display:\s*none\s*!important/s.test(cssText),
      "insight-panel [hidden] uses display:none !important");
    ok(/\.seg\[hidden\][^}]*display:\s*none\s*!important/s.test(cssText),
      "seg [hidden] uses display:none !important (Rank-by must actually hide)");
    ok(/\.bar\.warn-over::after[^}]*border-color:\s*transparent\s+var\(--warn\)/s.test(cssText) &&
        /\.bar\.warn-over::after[^}]*border-width:\s*5px\s+7px\s+5px\s+0/s.test(cssText),
      "HUD over bars use a left-pointing warn chevron as a track-end expansion");
    ok(!/\.bar\.warn::after[^}]*content:\s*"!"/s.test(cssText),
      "HUD bars no longer use a bang glyph for over/near");
    ok(/\.insight-carousel-track[^}]*scroll-snap-type:\s*x\s+mandatory/s.test(cssText) &&
        /\.carousel-dot\.on\s*\{/s.test(cssText),
      "Intake carousel uses mandatory scroll-snap and shaded pagination dots");
    ok(/#view-insights\s+\.view-head[^}]*position:\s*sticky/s.test(cssText) &&
        /#view-insights\s+\.view-head[^}]*z-index:\s*5/s.test(cssText),
      "Insights view-head is sticky above chart table headers");
    ok(/\.insight-dock\.is-inactive\s*\{[^}]*\}/s.test(cssText) &&
        (() => {
          const m = cssText.match(/\.insight-dock\.is-inactive\s*\{([^}]*)\}/s);
          if (!m) return false;
          const props = [...m[1].matchAll(/(?:^|;)\s*([a-z-]+)\s*:/gi)].map((x) => x[1].toLowerCase());
          return props.length > 0 && props.every((p) => p === "opacity");
        })(),
      "dock is-inactive dims via opacity only (no height/padding/margin)");
    ok(/data-dock-status="good"\]::after[^}]*background:\s*var\(--accent\)/s.test(cssText) &&
        /data-dock-status="mid"\]::after[^}]*border:/s.test(cssText) &&
        /data-dock-status="bad"\]::after[^}]*border:/s.test(cssText) &&
        /data-dock-status="none"\]::after[^}]*dashed/s.test(cssText),
      "dock status dots use filled / ring / hollow shapes, not colour alone");
    const uiText = fs.readFileSync(path.join(ROOT, "js/ui.js"), "utf8");
    ok(/row\.n\s*>=\s*3/.test(uiText) && /rate\s*>=\s*0\.8/.test(uiText) && /rate\s*>=\s*0\.5/.test(uiText),
      "dock status thresholds stay n>=3 scored days and 0.8/0.5 hit-rate bands");
  }

  // Stub canvas + layout before app scripts run.
  window.HTMLCanvasElement.prototype.getContext = function () {
    const c = fakeCtx(); c.canvas = this; return c;
  };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { get() { return 120; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 360, bottom: 200, width: 360, height: 200, x: 0, y: 0, toJSON() {} };
  };
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.navigator.serviceWorker = undefined;
  window.__ndScrollIntoView = [];
  window.HTMLElement.prototype.scrollIntoView = function (...args) {
    window.__ndScrollIntoView.push({ el: this, id: this.id, nutrient: this.dataset && this.dataset.nutrient, args });
  };
  window.__ndIO = [];
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; window.__ndIO.push(this); }
    observe(el) {
      this.el = el;
      this.cb([{ target: el, isIntersecting: true }]);
    }
    disconnect() { this.dead = true; }
    unobserve() {}
  };
  installPrimaryLock(window);

  // Count listeners per element id so a double boot is caught, not tolerated.
  window.__ndListenerCounts = {};
  const _addEL = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, fn, opt) {
    if (this && this.id) {
      const key = `#${this.id}:${type}`;
      window.__ndListenerCounts[key] = (window.__ndListenerCounts[key] || 0) + 1;
    }
    return _addEL.call(this, type, fn, opt);
  };

  const { events, weights } = seed(days);
  window.localStorage.setItem("nd_events_v1", JSON.stringify(events));
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300 },
    weights, weightUnit: "lb", phases: [], profile: {},
    dayGoals: energyAdjustmentFixture(days),
  }));

  // Load app scripts in document order.
  for (const src of [...dom.window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  await bootApp(window);

  const $ = (s) => window.document.querySelector(s);
  const text = (s) => ($(s) ? $(s).textContent.trim() : "");

  if (label === "main") {
    const allSheets = [...window.document.querySelectorAll(".sheet")];
    ok(allSheets.every((sheet) => sheet.hasAttribute("aria-label") || sheet.hasAttribute("aria-labelledby") || !!sheet.querySelector("h1, h2, h3")),
      "every sheet has a stable label or heading source");
    $("#fab-add").click();
    await new Promise((r) => setTimeout(r, 20));
    const visibleDialogs = allSheets.filter((sheet) => !sheet.hidden);
    ok(visibleDialogs.length > 0 && visibleDialogs.every((sheet) => sheet.getAttribute("role") === "dialog" && !!dialogName(sheet)),
      "every visible sheet dialog has an accessible name",
      visibleDialogs.filter((sheet) => !dialogName(sheet)).map((sheet) => sheet.id).join(", "));
    const addSheet = $("#sheet-add");
    ok(!$("#pick-mode-seg"), "add picker has no Single/Multi mode seg");
    ok(!$("#pick-multi-bar").hidden && $("#btn-pick-multi-continue"),
      "add picker shows multi continue bar by default");
    ok(!$("#pick-single-actions").hidden,
      "add picker keeps Log once / NUTRI / Import visible in multi");
    ok(addSheet.contains(window.document.activeElement), "Add food moves focus inside its dialog without opening search");
    ok(!addSheet.parentElement.hasAttribute("inert"), "modal sheet ancestor is never inert");
    ok($("#view-today").closest("main").hasAttribute("inert"), "modal makes the background view inert");
    $("#day-label").focus();
    ok(addSheet.contains(window.document.activeElement), "escaped programmatic focus is pulled back into the top dialog");
    $("#sheet-add [data-close='sheet-add']").click();
    await new Promise((r) => setTimeout(r, 220));

    // Multi-step sheets keep inactive steps in the DOM. Their controls must
    // not become the apparent end of the modal's keyboard loop.
    $("#fab-add").click();
    $("#btn-paste-new").click();
    await new Promise((r) => setTimeout(r, 20));
    const pasteSheet = $("#sheet-paste");
    const manual = $("#btn-manual-food");
    const firstVisible = [...pasteSheet.querySelectorAll('button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])')]
      .find((node) => !node.closest('[hidden], [aria-hidden="true"]'));
    manual.focus();
    manual.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    ok(window.document.activeElement === firstVisible,
      "focus trap excludes controls inside a hidden multi-step panel");
    pasteSheet.querySelector("[data-close='sheet-paste']").click();
    await new Promise((r) => setTimeout(r, 220));
  }

  if (label === "main") {
    const storageError = new window.Error("storage full");
    storageError.code = "ledger-persistence-failed";
    window.dispatchEvent(new window.ErrorEvent("error", { error: storageError }));
    ok(/last diary change was not saved/i.test(text("#toast")), "typed persistence failures show durable-save guidance");
  }

  // Navigate to Insights.
  const tab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  ok(!!tab, "insights tab exists");
  tab.click();
  await new Promise((r) => setTimeout(r, 60));

  ok($("#view-insights").classList.contains("active"), "insights view is active");

  // §3 dock + section-order guards (Phases 1–2 contract) + category IA.
  const cats = $("#insight-cats");
  ok(!!cats, "insight category tablist exists");
  ok(cats.getAttribute("role") === "tablist", "insight-cats is a tablist");
  const catBtns = [...cats.querySelectorAll("[data-insight-cat]")];
  ok(JSON.stringify(catBtns.map((b) => b.dataset.insightCat)) ===
      JSON.stringify(["overview", "patterns", "body", "intake"]),
    "Insights categories are Overview · Patterns · Body · Intake");
  ok(!$("#insight-panel-overview").hidden &&
      $("#insight-panel-intake").hidden &&
      $("#insight-panel-body").hidden &&
      $("#insight-panel-patterns").hidden,
    "default category is Overview (only overview panel visible)");
  const dock = $("#insight-dock");
  ok(!!dock, "insight-dock exists");
  ok(dock.hidden && !window.document.body.classList.contains("has-insight-dock"),
    "nutrient dock hidden on Overview (Intake-only lane)");
  ok(!!$("#insight-teasers"), "Overview mounts Patterns/Body/Intake teaser row");
  ok([...window.document.querySelectorAll("#insight-teasers .insight-teaser")].length === 3,
    "Overview teasers cover Patterns, Body, and Intake");
  ok(/swipe/i.test(text("#insight-teasers")) && /Where macros/i.test(text("#insight-teasers")),
    "Overview teasers describe destinations without restating tile numbers");
  cats.querySelector('[data-insight-cat="intake"]').click();
  await new Promise((r) => setTimeout(r, 40));
  ok(!$("#insight-panel-intake").hidden && $("#insight-panel-overview").hidden,
    "Intake category shows the intake panel");
  ok(!dock.hidden, "insight-dock visible on Intake");
  ok(window.document.body.classList.contains("has-insight-dock"), "body.has-insight-dock set on Intake");
  ok($("#insight-nutrient") && dock.contains($("#insight-nutrient")),
    "insight-nutrient is a descendant of insight-dock");
  ok($('#insight-nutrient [data-nutrient="overall"]') &&
      $('#insight-nutrient [data-nutrient="overall"]').classList.contains("active"),
    "Overall is the default Intake dock pill");
  ok(/Overall|targets hit/i.test(text("#section-intake") + text("#trend-summary")),
    "Overall paints Intake copy about targets hit");
  const carDotsTop = [...window.document.querySelectorAll("#intake-carousel-dots .carousel-dot")];
  if (carDotsTop[2]) carDotsTop[2].click();
  await new Promise((r) => setTimeout(r, 20));
  ok(!$("#topfoods-rank").hidden,
    "Top foods Rank-by chips show under Overall");
  ok($('#topfoods-rank [data-topfood-metric="kcal"].on'),
    "Overall Top foods defaults Rank-by to Kcal");
  $('#topfoods-rank [data-topfood-metric="fiber"]').click();
  await new Promise((r) => setTimeout(r, 20));
  ok($('#topfoods-rank [data-topfood-metric="fiber"].on'),
    "Rank-by can switch to Fiber under Overall");
  window.document.querySelector('#insight-nutrient [data-nutrient="protein"]').click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#topfoods-rank").hidden,
    "Rank-by hides when a single nutrient is selected");
  ok($('#topfoods-rank [data-topfood-metric="protein"].on') &&
      !$('#topfoods-rank [data-topfood-metric="fiber"].on'),
    "Rank-by chip tracks the dock nutrient after leaving Overall");
  ok(/Protein/i.test(text("#topfoods-scope")),
    "Top foods scope label matches the dock nutrient");
  if (carDotsTop[0]) carDotsTop[0].click();
  await new Promise((r) => setTimeout(r, 20));
  window.document.querySelector('#insight-nutrient [data-nutrient="kcal"]').click();
  await new Promise((r) => setTimeout(r, 20));
  if (carDotsTop[2]) carDotsTop[2].click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#topfoods-rank").hidden,
    "Rank-by stays hidden under Kcal dock");
  window.document.querySelector('#insight-nutrient [data-nutrient="overall"]').click();
  await new Promise((r) => setTimeout(r, 20));
  if (carDotsTop[0]) carDotsTop[0].click();
  await new Promise((r) => setTimeout(r, 20));
  ok(window.document.querySelectorAll(".nutrient-pills").length === 1 &&
      window.document.querySelectorAll("#insight-nutrient [data-nutrient]").length === 8,
    "exactly one nutrient pill group");
  ok(!$("#topfood-metric"), "topfood-metric removed; Top foods follows the dock");
  const sectionIds = [...window.document.querySelectorAll("#view-insights .insight-section")].map((s) => s.id);
  ok(JSON.stringify(sectionIds) === JSON.stringify([
    "section-composition", "section-adherence", "section-compare",
    "section-weight", "section-energy", "section-intake",
  ]), "Insights section order matches Overview→Patterns→Body→Intake layout", sectionIds.join(", "));
  ok($("#section-compare").hidden === $("#phase-compare").hidden,
    "section-compare.hidden mirrors phase-compare.hidden");
  ok($("#intake-page-trend") && $("#intake-page-trend").contains($("#intake-stats")) &&
      !$("#day-detail"),
    "trend carousel page owns chart stats and no longer mounts a day-detail panel");
  ok($("#intake-carousel-dots") &&
      $("#intake-carousel").firstElementChild === $("#intake-carousel-dots"),
    "Intake pagination dots sit above the carousel track");
  ok($("#intake-page-heatmap") && $("#intake-page-heatmap").contains($("#insight-heatmap")) &&
      $("#intake-page-topfoods") && $("#intake-page-topfoods").contains($("#top-foods-card")) &&
      !$("#intake-page-dow") && !$("#dow-pattern"),
    "heatmap / top foods each own a carousel page (no day-of-week page)");
  const carDots = [...window.document.querySelectorAll("#intake-carousel-dots .carousel-dot")];
  ok(carDots.length === 3 &&
      carDots.every((d, i) => Number(d.dataset.intakePage) === i),
    "Intake carousel has 3 pagination dots");
  ok(carDots[0].classList.contains("on") && carDots[0].getAttribute("aria-selected") === "true",
    "carousel starts on page 0 (Trend)");
  carDots[2].click();
  await new Promise((r) => setTimeout(r, 20));
  ok(carDots[2].classList.contains("on") && !carDots[0].classList.contains("on"),
    "dot click advances active page shading");
  carDots[0].click();
  await new Promise((r) => setTimeout(r, 20));
  ok(!$("#section-intake").hidden && !$("#section-weight").hidden &&
      !$("#section-energy").hidden && !$("#section-adherence").hidden &&
      !$("#section-composition").hidden,
    "full-tier fixture boots with core sections visible");
  ok($("#section-composition").compareDocumentPosition($("#section-adherence")) &
      window.Node.DOCUMENT_POSITION_FOLLOWING,
    "Patterns lists Composition before Adherence");
  // Scorecard carousel is asserted after the full Insights render below.
  const dockPills = [...window.document.querySelectorAll("#insight-nutrient [data-nutrient]")];
  ok(dockPills.length === 8 && dockPills.every((b) => b.dataset.dockStatus),
    "every dock pill carries a data-dock-status mark");
  ok(dockPills.every((b) => /,\s*(?:not enough scored days|\d+% of days on target|\d+% targets hit on avg)$/.test(b.getAttribute("aria-label") || "")),
    "dock pill aria-label names hit-rate state (not colour alone)");
  ok(dockPills.some((b) => /^(good|mid|bad)$/.test(b.dataset.dockStatus)),
    "full fixture paints at least one scored dock status (not all none)");
  {
    const Ledger = window.eval("Ledger");
    const Phases = window.eval("Phases");
    const Analytics = window.eval("Analytics");
    const settings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
    const todayKey = Ledger.todayKey();
    const keys = [];
    const end = new Date(todayKey + "T12:00:00");
    for (let i = 13; i >= 0; i--) {
      const d = new Date(end); d.setDate(d.getDate() - i);
      keys.push(Ledger.todayKey(d));
    }
    const scorecard = Phases.scoreRange(keys, (day) => Ledger.totalsFor(day), settings, { excludeDay: todayKey });
    const expectedDockStatus = (row) => {
      if (!row || !row.n || row.n < 3) return "none";
      const rate = row.hit / row.n;
      if (rate >= 0.8) return "good";
      if (rate >= 0.5) return "mid";
      return "bad";
    };
    for (const b of dockPills) {
      if (b.dataset.nutrient === "overall") {
        const days = Analytics.buildDays({
          keys,
          totalsForDay: (day) => Ledger.totalsFor(day),
          goalsForDay: (day) => Phases.goalsForDay(day, settings),
        });
        for (const d of days) d.overallHit = Analytics.dayTargetHitRate(d, Phases.scoreDayTotals);
        const rates = days
          .filter((d) => !(todayKey && d.day === todayKey))
          .map((d) => d.overallHit)
          .filter((hr) => hr && Number.isFinite(hr.rate) && hr.n > 0);
        let expected = "none";
        if (rates.length >= 3) {
          const avg = rates.reduce((s, hr) => s + hr.rate, 0) / rates.length;
          expected = avg >= 0.8 ? "good" : avg >= 0.5 ? "mid" : "bad";
        }
        ok(b.dataset.dockStatus === expected,
          "dock overall status matches n>=3 / 0.8 / 0.5 cuts",
          `${b.dataset.dockStatus} vs ${expected} (n=${rates.length})`);
        continue;
      }
      const row = (scorecard.nutrients || []).find((n) => n.key === b.dataset.nutrient);
      ok(b.dataset.dockStatus === expectedDockStatus(row),
        `dock ${b.dataset.nutrient} status matches n>=3 / 0.8 / 0.5 cuts`,
        `${b.dataset.dockStatus} vs ${expectedDockStatus(row)} (n=${row && row.n}, hit=${row && row.hit})`);
    }
  }
  const activeDock = dockPills.find((b) => b.classList.contains("active"));
  ok(activeDock && activeDock.tabIndex === 0 &&
      dockPills.filter((b) => b.tabIndex === 0).length === 1 &&
      dockPills.every((b) => b === activeDock || b.tabIndex === -1),
    "dock uses a single roving tabindex on the active pill");
  // Category gate owns dock (retired scroll-dim observer).
  ok(!window.__ndIO.some((o) => !o.dead && o.el && o.el.id === "section-intake"),
    "no IntersectionObserver on #section-intake for dock dimming");
  cats.querySelector('[data-insight-cat="overview"]').click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#insight-dock").hidden && !window.document.body.classList.contains("has-insight-dock"),
    "leaving Intake for Overview hides the nutrient dock");
  cats.querySelector('[data-insight-cat="intake"]').click();
  await new Promise((r) => setTimeout(r, 40));
  ok(!$("#insight-dock").hidden && window.document.body.classList.contains("has-insight-dock"),
    "returning to Intake restores the nutrient dock");
  activeDock.focus();
  activeDock.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  const afterArrow = window.document.activeElement;
  ok(afterArrow && afterArrow.dataset && afterArrow.dataset.nutrient && afterArrow !== activeDock &&
      afterArrow.tabIndex === 0 && activeDock.tabIndex === -1,
    "ArrowRight moves dock focus and roving tabindex without requiring a click");
  window.__ndScrollIntoView.length = 0;
  afterArrow.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  ok(afterArrow.classList.contains("active") &&
      (new RegExp(afterArrow.dataset.dockName || afterArrow.dataset.nutrient, "i").test(text("#intake-head")) ||
        (afterArrow.dataset.nutrient === "kcal" && /Calories/i.test(text("#intake-head"))) ||
        (afterArrow.dataset.nutrient === "overall" && /Overall/i.test(text("#intake-head")))),
    "Enter activates the focused dock pill");
  ok(window.__ndScrollIntoView.filter((s) => s.nutrient === afterArrow.dataset.nutrient).length === 1,
    "Enter activates exactly once (no double refreshInsights)");
  afterArrow.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  const afterSecondArrow = window.document.activeElement;
  window.__ndScrollIntoView.length = 0;
  afterSecondArrow.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  ok(afterSecondArrow.classList.contains("active"),
    "Space activates the focused dock pill");
  ok(window.__ndScrollIntoView.filter((s) => s.nutrient === afterSecondArrow.dataset.nutrient).length === 1,
    "Space activates the pill exactly once through the keydown handler");
  window.__ndScrollIntoView.length = 0;
  window.document.querySelector('#insight-nutrient [data-nutrient="potassium"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok(window.__ndScrollIntoView.some((s) => s.nutrient === "potassium" && s.args[0] && s.args[0].behavior === "smooth"),
    "active potassium pill scrolls with behavior:smooth by default");
  const prevMatchMedia = window.matchMedia;
  window.matchMedia = (q) => ({
    matches: /prefers-reduced-motion:\s*reduce/i.test(String(q)),
    media: String(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  window.__ndScrollIntoView.length = 0;
  window.document.querySelector('#insight-nutrient [data-nutrient="fiber"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok(window.__ndScrollIntoView.some((s) => s.nutrient === "fiber" && s.args[0] && s.args[0].behavior === "auto"),
    "active pill scroll uses behavior:auto under prefers-reduced-motion");
  window.matchMedia = prevMatchMedia;
  window.__ndScrollIntoView.length = 0;
  window.document.querySelector('#insight-range [data-days="30"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok(window.__ndScrollIntoView.filter((s) => s.nutrient).length === 0,
    "range change does not re-scroll the dock when nutrient is unchanged");
  window.document.querySelector('#insight-range [data-days="14"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const kcalPill = window.document.querySelector('#insight-nutrient [data-nutrient="kcal"]');
  kcalPill.click();
  await new Promise((r) => setTimeout(r, 20));
  kcalPill.focus();
  kcalPill.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  const focusBrowse = window.document.activeElement;
  ok(focusBrowse && focusBrowse.dataset.nutrient && focusBrowse.dataset.nutrient !== "kcal",
    "setup: arrow browse leaves focus on a non-active dock pill");
  window.document.querySelector('#rollup-seg [data-rollup="week"]').click();
  await new Promise((r) => setTimeout(r, 20));
  ok(focusBrowse.tabIndex === 0 &&
      [...window.document.querySelectorAll("#insight-nutrient [data-nutrient]")].filter((b) => b.tabIndex === 0).length === 1,
    "roving tabindex stays with focused pill across an unrelated re-render");
  window.document.querySelector('#rollup-seg [data-rollup="day"]').click();
  await new Promise((r) => setTimeout(r, 20));
  window.document.querySelector('#insight-nutrient [data-nutrient="kcal"]').click();
  await new Promise((r) => setTimeout(r, 20));

  // Regression: the app must boot exactly once. A double boot binds every
  // listener twice, so one click runs its handler twice — which is how the
  // TDEE "Use" button appeared to apply two revisions in a row.
  const listenerCounts = window.__ndListenerCounts || {};
  const doubled = Object.entries(listenerCounts).filter(([, v]) => v > 1);
  ok(doubled.length === 0, "no element has a duplicate listener (app booted once)",
    doubled.slice(0, 3).map(([k, v]) => `${k} x${v}`).join(", "));


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
    ["#top-foods", "top foods"],
    ["#weight-summary", "weight summary"],
    ["#weight-stats", "weight stats"],
  ];
  for (const [sel, name] of panels) {
    const el = $(sel);
    ok(el && el.innerHTML.trim().length > 0, `${name} rendered`, el ? "empty" : "missing element");
  }
  ok(window.document.querySelectorAll("#insight-scorecard .score-tile").length === 7 &&
      !!$("#insight-scorecard .score-tile-grid"),
    "Target scorecard renders a 7-tile nutrient grid");

  const trendCanvas = $("#trend-canvas");
  const weightCanvas = $("#weight-canvas");
  const trendData = $("#trend-data .chart-data");
  const weightData = $("#weight-data .chart-data");
  ok(trendCanvas.getAttribute("role") === "img" && /data table below/i.test(trendCanvas.getAttribute("aria-label") || "") &&
      /trend-data-summary/.test(trendCanvas.getAttribute("aria-describedby") || ""),
    "intake canvas has a screen-reader chart summary and exact-data alternative");
  ok(weightCanvas.getAttribute("role") === "img" && /data table below/i.test(weightCanvas.getAttribute("aria-label") || "") &&
      /weight-data-summary/.test(weightCanvas.getAttribute("aria-describedby") || ""),
    "weight canvas has a screen-reader chart summary and exact-data alternative");
  ok(trendData && trendData.querySelector("summary") && trendData.querySelector("table.chart-data-table") &&
      trendData.querySelectorAll("tbody tr").length === 14,
    "intake chart exposes its full default series in a compact semantic table");
  ok(weightData && weightData.querySelector("summary") && weightData.querySelector("table.chart-data-table") &&
      weightData.querySelectorAll("tbody tr").length === 14,
    "weight chart exposes weigh-ins and trend values in a compact semantic table");
  const tableDay = trendData && trendData.querySelector("button.chart-day-link[data-action='goto-day']");
  ok(!!tableDay, "daily intake data exposes semantic day buttons that open Today");
  if (tableDay) {
    const day = tableDay.dataset.day;
    trendData.open = true;
    tableDay.click();
    await new Promise((r) => setTimeout(r, 20));
    const App = window.eval("App");
    ok(App.state.viewDay === day &&
        window.document.querySelector("#view-today") &&
        window.document.querySelector("#view-today").classList.contains("active"),
      "keyboard-equivalent intake day activation opens that day in Today");
  }
  // Restore calendar-today before other Insights assertions that assume it.
  {
    const App = window.eval("App");
    const Ledger = window.eval("Ledger");
    App.state.viewDay = Ledger.todayKey();
  }
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
  await new Promise((r) => setTimeout(r, 40));
  const weightDayFresh = $("#weight-data .chart-data") &&
    $("#weight-data .chart-data").querySelector("button.chart-day-link[data-action='goto-day']");
  ok(!!weightDayFresh, "weight data exposes semantic weigh-in day buttons that open Today");
  if (weightDayFresh) {
    const day = weightDayFresh.dataset.day;
    $("#weight-data .chart-data").open = true;
    weightDayFresh.click();
    await new Promise((r) => setTimeout(r, 20));
    const App = window.eval("App");
    ok(App.state.viewDay === day &&
        window.document.querySelector("#view-today") &&
        window.document.querySelector("#view-today").classList.contains("active"),
      "keyboard-equivalent weight day activation opens that day in Today");
    App.state.viewDay = window.eval("Ledger").todayKey();
  }
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
  await new Promise((r) => setTimeout(r, 40));

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
  const loggedCell = [...liveCells].find((c) => /hm-(hit|over|under|logged)/.test(c.className))
    || liveCells[Math.floor(liveCells.length / 2)];
  loggedCell.click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#heatmap-tip") && !$("#heatmap-tip").hidden &&
      $("#heatmap-tip [data-action='goto-day']") &&
      $("#heatmap-tip [data-action='goto-day']").dataset.day === loggedCell.dataset.day,
    "heatmap click opens a tip with Open day for that cell");

  // Nutrient pills re-render.
  const proteinPill = window.document.querySelector('#insight-nutrient [data-nutrient="protein"]');
  proteinPill.click();
  await new Promise((r) => setTimeout(r, 20));
  ok(/Protein per day vs target band/i.test(text("#trend-summary")),
    "switching nutrient updates the chart caption");
  ok(/Protein/i.test(text("#intake-head")), "intake heading tracks the dock nutrient");
  ok(proteinPill.classList.contains("active"), "nutrient pill marked active");
  ok($("#trend-data details").open && /Protein/.test($("#trend-data table caption").textContent),
    "open semantic chart data stays open and updates with the selected nutrient");

  // Weekly rollup toggle.
  const weekBtn = window.document.querySelector('#rollup-seg [data-rollup="week"]');
  weekBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  ok(weekBtn.classList.contains("on"), "weekly toggle turns on");
  ok(/Protein per week vs target band/i.test(text("#trend-summary")),
    "weekly caption names the week rollup");
  ok(!/tap a bar/i.test(text("#trend-summary")),
    "weekly caption does not promise a per-day tap that does nothing");
  ok(!/7-day avg/.test($("#trend-legend").textContent), "weekly view drops the 7-day line from the legend");
  ok(!$("#trend-data [data-action='goto-day']") && /weekly averages/i.test($("#trend-data table caption").textContent),
    "weekly chart table exposes exact periods without inventing a single-day drilldown");
  window.document.querySelector('#rollup-seg [data-rollup="day"]').click();
  await new Promise((r) => setTimeout(r, 20));

  // Top foods follows the dock nutrient. In this fixture ramen is eaten only
  // on weekends, so it never tops raw calories — but its sodium load should
  // push it up the list.
  const names = () => [...window.document.querySelectorAll("#top-foods .topfood-list .tf-name")].map((n) => n.textContent.trim());
  window.document.querySelector('#insight-nutrient [data-nutrient="kcal"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const kcalRank = names().indexOf("Instant ramen");
  window.document.querySelector('#insight-nutrient [data-nutrient="sodium"]').click();
  await new Promise((r) => setTimeout(r, 20));
  const sodiumNames = names();
  ok(sodiumNames.length > 0, "top foods re-render for sodium");
  const naRank = sodiumNames.indexOf("Instant ramen");
  ok(naRank >= 0 && kcalRank >= 0 && naRank < kcalRank,
    "sodium ranking promotes the salty item above its calorie rank",
    `sodium #${naRank + 1} vs kcal #${kcalRank + 1}`);
  ok(/Sodium/i.test(text("#topfoods-scope")), "top foods scope chip follows the dock");

  // Totals vs Peaks: repeated modest sodium beats a spike on Totals; Peaks flips it.
  {
    const Analytics = window.eval("Analytics");
    const LedgerPeak = window.eval("Ledger");
    const peakToday = LedgerPeak.todayKey();
    const stapleDays = [];
    for (let i = 1; i <= 8; i += 1) stapleDays.push(Analytics.addDays(peakToday, -i));
    for (const day of stapleDays) {
      LedgerPeak.addEntry(day, {
        name: "Daily tofu staple",
        displayQty: "100 g", grams: 100, meal: "lunch",
        macros: { kcal: 150, p: 15, c: 5, f: 8, fb: 2, na: 450, k: null },
        sd: 0.1,
      });
    }
    const spikeDay = stapleDays[1];
    LedgerPeak.addEntry(spikeDay, {
      name: "Hot Iron Mongolian Grill Lunch",
      displayQty: "1 portion", grams: 500, meal: "lunch", source: "once",
      macros: { kcal: 900, p: 45, c: 70, f: 35, fb: 5, na: 2601, k: null },
      sd: 0.2,
    });
    window.document.querySelector('#insight-range [data-days="14"]').click();
    window.document.querySelector('#insight-nutrient [data-nutrient="sodium"]').click();
    await new Promise((r) => setTimeout(r, 30));
    const carDotsPeak = [...window.document.querySelectorAll("#intake-carousel-dots .carousel-dot")];
    if (carDotsPeak[2]) carDotsPeak[2].click();
    await new Promise((r) => setTimeout(r, 20));
    $("#topfoods-mode [data-topfood-mode='totals']").click();
    await new Promise((r) => setTimeout(r, 20));
    const topNames = () => [...window.document.querySelectorAll("#top-foods .tf-name")]
      .map((n) => n.childNodes[0] && n.childNodes[0].textContent
        ? n.childNodes[0].textContent.trim()
        : n.textContent.trim().replace(/\s*One-off\s*$/i, "").replace(/\s*Quick\s*$/i, "").trim());
    const totalsRank = topNames();
    const stapleTot = totalsRank.indexOf("Daily tofu staple");
    const spikeTot = totalsRank.indexOf("Hot Iron Mongolian Grill Lunch");
    ok(stapleTot >= 0 && spikeTot >= 0 && stapleTot < spikeTot,
      "Totals ranks the repeated staple above the one-off spike",
      `staple #${stapleTot + 1} spike #${spikeTot + 1} :: ${totalsRank.join(", ")}`);
    $("#topfoods-mode [data-topfood-mode='peaks']").click();
    await new Promise((r) => setTimeout(r, 20));
    ok($("#topfoods-mode [data-topfood-mode='peaks']").classList.contains("on"),
      "Peaks mode chip is active");
    ok(topNames()[0] === "Hot Iron Mongolian Grill Lunch",
      "Peaks mode crowns the single sodium spike",
      `got ${topNames()[0]}`);
    ok(/One-off/i.test($("#top-foods .tf-name").textContent),
      "Peaks row badges the one-off source");
    ok(/Biggest single logs/i.test(text("#top-foods")),
      "Peaks footer explains single-log ranking");
    $("#top-foods [data-action='topfood-expand']").click();
    await new Promise((r) => setTimeout(r, 20));
    ok(!!$("#top-foods .tf-day-pills") && $("#top-foods [data-action='topfood-peak-day']"),
      "Peaks expand shows date pills instead of jumping");
    $("#top-foods [data-action='topfood-peak-day']").click();
    await new Promise((r) => setTimeout(r, 30));
    const AppPeak = window.eval("App");
    ok(AppPeak.state.viewDay === spikeDay &&
        window.document.querySelector('.tab[data-view="today"].active'),
      "Peaks date pill opens that day on Today");
    ok(!!$("#today-day-detail") && /Hot Iron|Sodium/i.test(text("#today-day-detail")),
      "Peaks pill jump opens day contribution for the spike");
    ok(!$("#insights-back").hidden,
      "Back to Insights > Top Foods chip appears after a pill jump");
    ok(/Back to Insights > Top Foods/i.test(text("#insights-back-btn")),
      "return chip uses Insights > Top Foods path label");
    ok($("#insights-back").dataset.flashed === "1" &&
        (/@keyframes\s+insights-back-pulse/.test(fs.readFileSync(path.join(ROOT, "css/style.css"), "utf8"))),
      "return chip arming records a one-shot flash with CSS pulse");
    $("#insights-back [data-action='back-to-insights']").click();
    await new Promise((r) => setTimeout(r, 30));
    ok(window.document.querySelector('.tab[data-view="insights"].active') &&
        !$("#insight-panel-intake").hidden,
      "Back to Insights > Top Foods returns to Insights Intake");
    ok($("#topfoods-mode [data-topfood-mode='peaks']").classList.contains("on"),
      "Back restores Peaks mode");
    $("#topfoods-search").value = "Hot Iron";
    $("#topfoods-search").dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    ok(/Matches/i.test(text("#top-foods")) &&
        /Hot Iron Mongolian Grill Lunch/i.test(text("#top-foods")),
      "search promotes matching meal names above Top foods");
    $("#topfoods-search").value = "";
    $("#topfoods-search").dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    $("#topfoods-mode [data-topfood-mode='totals']").click();
    await new Promise((r) => setTimeout(r, 20));

    // Heatmap Open day arms a contextual return chip; browsing 3 days clears it.
    window.document.querySelector('#insight-nutrient [data-nutrient="sodium"]').click();
    await new Promise((r) => setTimeout(r, 20));
    const hmDots = [...window.document.querySelectorAll("#intake-carousel-dots .carousel-dot")];
    if (hmDots[1]) hmDots[1].click();
    await new Promise((r) => setTimeout(r, 20));
    const hmCell = [...window.document.querySelectorAll(".hm-cell[data-day]")]
      .find((c) => /hit|over|under|logged/i.test(c.className) && c.dataset.day);
    if (hmCell) {
      hmCell.click();
      await new Promise((r) => setTimeout(r, 20));
      const openDay = $("#heatmap-tip [data-action='goto-day']");
      if (openDay) {
        openDay.click();
        await new Promise((r) => setTimeout(r, 30));
        ok(!$("#insights-back").hidden && /Back to Insights > Heatmap/i.test(text("#insights-back-btn")),
          "heatmap Open day shows Back to Insights > Heatmap chip");
        $("#btn-day-prev").click();
        await new Promise((r) => setTimeout(r, 15));
        $("#btn-day-prev").click();
        await new Promise((r) => setTimeout(r, 15));
        ok($("#insights-back").hidden,
          "Insights return chip clears after browsing 3 distinct Today days");
        [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }


  window.document.querySelector('#insight-nutrient [data-nutrient="kcal"]').click();
  await new Promise((r) => setTimeout(r, 20));

  // Dock clears when leaving Insights.
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#insight-dock").hidden && !window.document.body.classList.contains("has-insight-dock"),
    "insight-dock hidden and has-insight-dock cleared off Insights");
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
  await new Promise((r) => setTimeout(r, 20));


  // --- band semantics in the rendered DOM --------------------------------
  // Sodium: a ceiling. Lower is better, so no day should be painted as a
  // shortfall and the wording must never imply eating more salt.
  window.document.querySelector('#insight-nutrient [data-nutrient="sodium"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok(/ceiling|lower is better/i.test(text("#insight-heatmap")), "sodium heatmap states it is a ceiling");
  ok(!/\bunder\b/.test($("#insight-heatmap .hm-key").textContent), "sodium heatmap key drops the impossible 'under' state");
  ok(/Limit/.test(text("#trend-legend")), "sodium chart labels the line a limit, not a target");

  const naRow = [...window.document.querySelectorAll("#insight-scorecard .score-tile")]
    .find((li) => /Sodium/.test(li.textContent));
  ok(!!naRow, "scorecard has a sodium tile");
  ok(!/\bunder\b/.test(naRow.textContent), "sodium scorecard tile never says 'under'");
  const naBar = naRow && naRow.querySelector(".score-bar");
  ok(/within|headroom|over/.test((naBar && naBar.getAttribute("aria-label")) || naRow.textContent),
    "sodium framed as within / headroom / over",
    (naBar && naBar.getAttribute("aria-label")) || naRow.textContent.trim());

  // Day contribution: tip + Open day, then verify Today contribution % match Analytics.
  const loggedNaCell = [...window.document.querySelectorAll(".hm-cell[data-day]")]
    .find((c) => /hit|over|under|logged/i.test(c.className) && c.dataset.day);
  if (loggedNaCell) {
    loggedNaCell.click();
    await new Promise((r) => setTimeout(r, 20));
    const dayKey = loggedNaCell.dataset.day;
    const tipGoto = $("#heatmap-tip [data-action='goto-day']");
    ok($("#heatmap-tip") && !$("#heatmap-tip").hidden && tipGoto && tipGoto.dataset.day === dayKey,
      "sodium heatmap tip offers Open day for the tapped cell");
    // Classic-script `const Analytics` is not on window; resolve via the realm.
    const Analytics = window.eval("Analytics");
    const Ledger = window.eval("Ledger");
    const UI = window.eval("UI");
    const App = window.eval("App");
    const Phases = window.eval("Phases");
    const expected = Analytics.topFoods(
      [dayKey],
      (d) => Ledger.entriesFor(d),
      "sodium",
      6
    );
    UI.renderDayDetail(dayKey, {
      metric: "sodium",
      root: "#today-day-detail",
      settings: App.state.settings,
      goals: Phases.goalsForDay(dayKey, App.state.settings),
    });
    const detailNames = [...window.document.querySelectorAll("#today-day-detail .topfood-list .tf-name")]
      .map((n) => n.textContent.trim());
    const detailPcts = [...window.document.querySelectorAll("#today-day-detail .topfood-list .tf-v .small")]
      .map((n) => Number(String(n.textContent).replace(/[^0-9.]/g, "")));
    ok(detailNames.length > 0, "sodium day detail lists contributing foods");
    ok(/limit|headroom|over/i.test(text("#today-day-detail")), "day detail uses ceiling wording for sodium");
    ok(expected.length > 0, "Analytics.topFoods returns rows for the tapped day");
    if (expected.length) {
      ok(detailNames[0] === expected[0].name, "day detail top food matches Analytics.topFoods",
        `got ${detailNames[0]} vs ${expected[0].name}`);
      ok(detailPcts[0] === Math.round(expected[0].pct * 100),
        "day detail % matches Analytics.topFoods",
        `got ${detailPcts[0]} vs ${Math.round(expected[0].pct * 100)}`);
    }

    // Nutrient pill re-renders Insights; Today contribution stays until closed.
    window.document.querySelector('#insight-nutrient [data-nutrient="protein"]').click();
    await new Promise((r) => setTimeout(r, 20));
    ok($("#today-day-detail").innerHTML.trim().length > 0, "nutrient pill leaves Today contribution card intact");
    window.document.querySelector('#insight-nutrient [data-nutrient="sodium"]').click();
    await new Promise((r) => setTimeout(r, 20));
  } else {
    ok(false, "expected a logged heatmap cell for day-contribution check");
  }

  // Protein: a floor. Exceeding it must never be flagged, matching Today.
  window.document.querySelector('#insight-nutrient [data-nutrient="protein"]').click();
  await new Promise((r) => setTimeout(r, 30));
  ok(/floor|more is fine/i.test(text("#insight-heatmap")), "protein heatmap states it is a floor");
  ok(!/\bover\b/.test($("#insight-heatmap .hm-key").textContent), "protein heatmap key drops the impossible 'over' state");
  ok(/Minimum/.test(text("#trend-legend")), "protein chart labels the line a minimum");

  const pRow = [...window.document.querySelectorAll("#insight-scorecard .score-tile")]
    .find((li) => /Protein/.test(li.textContent));
  ok(pRow && !/\bover\b/.test(pRow.textContent), "protein scorecard tile never says 'over'");

  ok(/floors/i.test(text("#insight-scorecard")) && /ceiling/i.test(text("#insight-scorecard")),
    "scorecard explains the three target shapes");

  window.document.querySelector('#insight-nutrient [data-nutrient="kcal"]').click();
  await new Promise((r) => setTimeout(r, 30));


  // --- new analytics surfaces --------------------------------------------
  ok(/day plan/i.test(text("#insight-observations")), "planned calorie adjustments are disclosed");
  ok(!/after the day ended/i.test(text("#insight-observations")), "planned-only fixture is not described as retroactive");
  ok(window.document.querySelectorAll(".hm-planned").length >= 1, "adjusted calorie days are marked on the heatmap");

  // §3 test #9 (light check on the main fixture) — honesty top-level + jump.
  // Cap / <details> branch coverage lives in runObservationsTriage().
  {
    const HONESTY = new Set(["partial-days", "bumps", "fasts", "macro-incomplete", "excluded-days"]);
    const root = $("#insight-observations");
    const topNotes = [...root.children].filter((el) => el.matches(".obs"));
    const moreNotes = [...root.querySelectorAll("details.obs-more .obs")];
    const visibleInfo = topNotes.filter((el) =>
      el.classList.contains("obs-info") && !HONESTY.has(el.dataset.obsId));
    ok(visibleInfo.length <= 3, "at most three non-protected info observations visible",
      `got ${visibleInfo.length}`);
    ok(moreNotes.every((el) =>
      el.classList.contains("obs-info") && !HONESTY.has(el.dataset.obsId)),
      "More notes only holds surplus non-protected info observations");
    ok($('#insight-observations > [data-obs-id="bumps"]'),
      "bumps honesty note stays top-level regardless of the info cap");
    const jump = root.querySelector("[data-jump]");
    ok(!!jump, "at least one observation jump control rendered");
    if (jump) {
      const sel = jump.dataset.jump;
      jump.click();
      await new Promise((r) => setTimeout(r, 20));
      const target = $(sel);
      ok(!!target, "observation jump target exists");
      const heading = target && (target.querySelector(".card-head-row b, h3, b")
        || (target.closest(".insight-section") && target.closest(".insight-section").querySelector(".section-head")));
      ok(heading && window.document.activeElement === heading,
        "observation jump moves focus to the panel heading");
    }
  }

  // Heatmap must not rely on colour alone.
  const hmStyles = [...window.document.querySelectorAll(".hm-cell[data-day]")]
    .map((c) => c.className);
  ok(hmStyles.some((c) => /hm-(hit|over|under)/.test(c)), "heatmap cells carry status classes");
  const cssText = fs.readFileSync(path.join(ROOT, "css/style.css"), "utf8");
  ok(/\.hm-over\s*\{[^}]*repeating-linear-gradient/.test(cssText), "over cells add a stripe pattern, not just colour");
  ok(/\.hm-under\s*\{[^}]*border:/.test(cssText), "under cells are hollow, not just a lighter colour");

  // Every heatmap cell must be readable without seeing it.
  const labelled = [...window.document.querySelectorAll(".hm-cell[data-day]")]
    .every((c) => (c.getAttribute("aria-label") || "").length > 8);
  ok(labelled, "every heatmap cell has a descriptive aria-label");

  // TDEE apply buttons.
  const applyBtns = window.document.querySelectorAll("[data-action='apply-tdee']");
  if ($(".tdee-big")) {
    if (/Target actions are paused/i.test(text("#tdee-card"))) {
      ok(applyBtns.length === 0, "low-confidence/partial TDEE pauses target actions", `got ${applyBtns.length}`);
    } else {
      ok(applyBtns.length >= 2, "qualified energy estimate offers one-tap targets", `got ${applyBtns.length}`);
    }
    ok([...applyBtns].every((b) => Number(b.dataset.kcal) >= 1200),
      "automated TDEE actions never offer a target below 1200 kcal");
    ok($("#dg-kcal").min === "200" && $("#dg-kcal").step === "10",
      "manual energy adjustments use the widened 200 kcal floor and round-to-10 step (Part VIII.6)");

    if (label === "main") {
      const unsafeLow = window.document.createElement("button");
      unsafeLow.dataset.action = "apply-tdee";
      unsafeLow.dataset.kcal = "1100";
      $("#tdee-card").appendChild(unsafeLow);
      unsafeLow.click();
      ok(/Automated targets must be 1200/i.test(text("#toast")),
        "TDEE UI rejects an injected sub-1200 automated target with a clear explanation");
      unsafeLow.remove();

      const TdeeApp = window.eval("App");
      const TdeePhaseMath = window.eval("Phases");
      const TdeeLedger = window.eval("Ledger");
      const active = TdeePhaseMath.activePhase(TdeeApp.state.settings.phases);
      const activeRevision = active && TdeePhaseMath.revisionForDay(active, TdeeLedger.todayKey());
      if (activeRevision) {
        const priorKcal = activeRevision.goals.kcal;
        const priorProtein = activeRevision.goals.protein;
        // Keep the fixture itself policy-valid (40% protein at 2500 kcal) so
        // the persistent-target quarantine does not correctly bypass it.
        activeRevision.goals.kcal = 2500;
        activeRevision.goals.protein = 250;
        const impossible = window.document.createElement("button");
        impossible.dataset.action = "apply-tdee";
        impossible.dataset.kcal = "1200";
        $("#tdee-card").appendChild(impossible);
        impossible.click();
        ok(/cannot fit protected protein plus at least 30 g fat/i.test(text("#toast")),
          "TDEE UI explains when protected protein and minimum fat cannot fit");
        impossible.remove();
        activeRevision.goals.kcal = priorKcal;
        activeRevision.goals.protein = priorProtein;
      } else {
        ok(false, "expected an active phase revision for TDEE feasibility UI test");
      }

      // Applying an estimate is a settings transaction. A quota failure must
      // not expose the newly appended revision in memory or schedule Drive.
      const settingsKey = "nd_settings_v1";
      const fixtureSettingsRaw = window.localStorage.getItem(settingsKey);
      const fixtureProfile = JSON.parse(JSON.stringify(TdeeApp.state.settings.profile));
      TdeeApp.state.settings.profile = {
        dob: "1990-01-01", sex: "female", heightCm: 165, activity: "moderate",
        notes: "", updatedAt: 1, resetEpoch: 0,
      };
      window.localStorage.setItem(settingsKey, JSON.stringify(TdeeApp.state.settings));
      const beforeTdeeMemory = JSON.stringify(TdeeApp.state.settings);
      const beforeTdeeDisk = window.localStorage.getItem(settingsKey);
      const failedApply = window.document.createElement("button");
      failedApply.dataset.action = "apply-tdee";
      failedApply.dataset.kcal = "2000";
      failedApply.dataset.label = "failure fixture";
      $("#tdee-card").appendChild(failedApply);
      const storageProto = window.Storage.prototype;
      const originalSetItem = storageProto.setItem;
      const originalSchedulePush = window.eval("Sync").schedulePush;
      const originalConfirm = window.confirm;
      let failTdeeWriteOnce = true;
      let tdeeSyncCalls = 0;
      storageProto.setItem = function (key, value) {
        if (failTdeeWriteOnce && key === settingsKey) {
          failTdeeWriteOnce = false;
          throw new window.DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      };
      window.eval("Sync").schedulePush = () => { tdeeSyncCalls += 1; };
      window.confirm = () => true;
      try { failedApply.click(); }
      finally {
        storageProto.setItem = originalSetItem;
        window.eval("Sync").schedulePush = originalSchedulePush;
        window.confirm = originalConfirm;
      }
      ok(!$("#sheet-new-phase").hidden && Number($("#np-kcal").value) === 2000 &&
          JSON.stringify(TdeeApp.state.settings) === beforeTdeeMemory &&
          window.localStorage.getItem(settingsKey) === beforeTdeeDisk &&
          tdeeSyncCalls === 0,
        "TDEE Apply opens Change targets for review and leaves settings unchanged until save");
      $("#np-cancel").click();
      failedApply.remove();
      TdeeApp.state.settings.profile = fixtureProfile;
      originalSetItem.call(window.localStorage, settingsKey, fixtureSettingsRaw);
    }
  }


  // --- potassium and the Na:K ratio ---------------------------------------
  // The main fixture has no potassium on its foods, so the ratio must refuse
  // to compute rather than report a falsely bad number.
  ok(/no potassium data|not recorded|not enough complete data/i.test(text("#nak-card")),
    "ratio refuses to compute without potassium data");
  ok(!/molar Na:K/.test(text("#nak-card")), "and shows no ratio figure");
  ok(!/NaN|Infinity/.test(text("#nak-card")), "no NaN or Infinity leaks from a zero denominator");

  if (label === "main") {
    // A legacy PHASE v1 reply without K must preserve the current target.
    const settingsTab = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === "settings");
    settingsTab.click();
    await new Promise((r) => setTimeout(r, 20));
    const summaryBefore = text("#phase-summary");
    $("#btn-ai-targets").click();
    $("#ai-phase-paste").value = `PHASE v1
Kind: maintain
Option: 1 | Balanced
Kcal: 2200
Protein: 150
Carbs: 250
Fat: 70
Fiber: 30
Sodium: 2300
Reason: fixture
Sources: fixture
END`;
    $("#btn-parse-phase").click();
    let apply = $("#ai-phase-options .ai-apply-opt");
    ok(!!apply, "legacy PHASE reply still parses");
    $("#ai-phase-paste").value = $("#ai-phase-paste").value.replace(/\nEND$/, "");
    $("#btn-parse-phase").click();
    ok(!$("#ai-phase-options .ai-apply-opt") && text("#phase-summary") === summaryBefore,
      "truncated PHASE reply exposes no apply action and leaves targets unchanged");
    ok(/standalone END/i.test(text("#toast")), "truncated PHASE reply explains the END requirement");
    $("#ai-phase-paste").value += "\nEND";
    $("#btn-parse-phase").click();
    apply = $("#ai-phase-options .ai-apply-opt");
    const PhaseMath = window.eval("Phases");
    const DateMath = window.eval("Analytics");
    const loggedToday = window.eval("Ledger.todayKey()");
    const baseline = PhaseMath.goalsForDay(
      loggedToday, JSON.parse(window.localStorage.getItem("nd_settings_v1"))
    );
    const baselineK = (baseline._phase || baseline).potassium;
    apply.click();
    ok(!$("#sheet-new-phase").hidden &&
        Number($("#np-potassium").value) === Number(baselineK != null ? baselineK : 3400),
      "legacy PHASE reply opens Change targets and preserves potassium");
    $("#np-cancel").click();
    const targetBeforeSave = baseline.kcal;
    ok(!!$("#btn-change-targets"), "Change targets is the Settings entry point");
    $("#btn-change-targets").click();
    $("#np-kcal").value = String(targetBeforeSave + 100);
    $("#np-save").click();
    const deferredSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
    ok(PhaseMath.goalsForDay(loggedToday, deferredSettings).kcal === targetBeforeSave &&
        PhaseMath.goalsForDay(DateMath.addDays(loggedToday, 1), deferredSettings).kcal === targetBeforeSave + 100,
      "same-kind Change targets after today's first add takes effect tomorrow");
    ok(/Saved .*effective tomorrow/i.test(text("#toast")),
      "successful deferred save confirms it starts tomorrow");
    ok(/From tomorrow:/.test(text("#phase-summary")) &&
        text("#phase-summary").indexOf(String(targetBeforeSave + 100)) >= 0,
      "Settings summary shows pending tomorrow targets after deferred save");
    $("#btn-change-targets").click();
    ok(Number($("#np-kcal").value) === targetBeforeSave + 100 &&
        /from tomorrow/i.test(text("#np-title") + " " + text("#np-blurb")),
      "reopening Change targets shows tomorrow’s pending numbers");
    $("#np-save").click();
    ok(/No changes · tomorrow/i.test(text("#toast")),
      "re-saving the same tomorrow targets explains no changes");

    // Once today's logging has begun, Reduced plans stay editable; Fast grace
    // remains open for same-day and next-day declarations (§10).
    const LedgerK = window.eval("Ledger");
    const AppK = window.eval("App");
    AppK.state.viewDay = LedgerK.todayKey();
    const todayTabForK = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === "today");
    todayTabForK.click();
    await new Promise((r) => setTimeout(r, 20));
    $("#btn-day-goals").click();
    ok(!$("#sheet-day-goals").hidden, "logged day can still open the plan sheet");
    $("#dg-intent-seg button[data-dg-intent='reduced']").click();
    ok($("#dg-intent-seg button[data-dg-intent='reduced']").getAttribute("aria-pressed") === "true",
      "logged day can still select Reduced");
    ok(!$("#dg-protein") && !$("#dg-sodium") && !$("#dg-potassium"), "energy adjustment sheet has no nutrient bump fields");
    const todayKey = window.eval("Ledger.todayKey()");
    window.eval("UI").closeSheet("sheet-day-goals");
    // Shared foods retain nullable/known K and exact logging semantics.
    const Share = window.eval("Share");
    const shared = Share.unpack(Share.pack({
      name: "K bowl", per100: { kcal: 100, p: 2, c: 20, f: 1, fb: 3, na: 50, k: 725 },
      units: { serving: 180 }, logAs: "grams", recipe: { ingredients: [] },
    }));
    ok(shared.ok && shared.food.per100.k === 725, "share v4 round-trip retains potassium");
    ok(shared.food.units.serving === 180 && !shared.food.units.piece && shared.food.logAs === "grams",
      "share v4 round-trip retains serving/logging semantics");

    // The dock nutrient control ranks potassium, not calories.
    const Ledger = window.eval("Ledger");
    Ledger.addEntry(todayKey, { name: "High calorie low K", displayQty: "100 g", grams: 100, meal: "snack", macros: { kcal: 900, p: 1, c: 1, f: 1, fb: 0, na: 20, k: 10 }, sd: 0.1 });
    Ledger.addEntry(todayKey, { name: "Low calorie high K", displayQty: "100 g", grams: 100, meal: "snack", macros: { kcal: 100, p: 1, c: 1, f: 1, fb: 0, na: 20, k: 900 }, sd: 0.1 });
    tab.click();
    await new Promise((r) => setTimeout(r, 30));
    $("#insight-nutrient [data-nutrient='potassium']").click();
    await new Promise((r) => setTimeout(r, 20));
    ok($("#top-foods .tf-name").textContent.trim() === "Low calorie high K", "potassium dock nutrient ranks top foods by K");

    const gapText = window.eval("GapPrompt").buildGapPrompt({
      day: todayKey,
      totals: Ledger.totalsFor(todayKey),
      goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300, potassium: 3400 },
      candidates: [],
    });
    ok(/Potassium 3400 mg/.test(gapText) && /salt substitutes/.test(gapText), "Planner AI fill includes potassium and safety guidance");

    // GAP paste is untrusted: truncated blocks fail, and dishonest safety/
    // projection claims cannot bypass local food math or manual review.
    const GapApp = window.eval("App");
    const GapUI = window.eval("UI");
    const unsafeGapFood = {
      id: "gap-unsafe-fixture",
      name: "Unsafe gap fixture",
      per100: { kcal: 100, p: 1, c: 20, f: 1, fb: 1, na: 5000, k: 100 },
      units: {}, logAs: "grams",
    };
    GapApp.state.gapSelected = { "id:gap-unsafe-fixture": unsafeGapFood };
    const todayTab = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === "today");
    todayTab.click();
    $("#btn-close-gap").click();
    // Planner opens plan-first; enter the AI fill path, then dismiss the
    // one-time intro if shown so the shared Add-food picker can Continue.
    $("#btn-gap-recalc").click();
    if (!$("#gap-step-intro").hidden) $("#btn-gap-intro-ok").click();
    $("#btn-pick-multi-continue").click();
    $("#gap-paste").value = `GAP v1
Day: ${todayKey}
Reachable: yes
Item: Unsafe gap fixture | 100 g | snack
Projected: 1 kcal | P 999 | C 0 | F 0 | Fiber 99 | Sodium 0 | Potassium 9999`;
    $("#btn-gap-parse").click();
    ok(/Incomplete GAP v1 block|END line is required/i.test(text("#toast")),
      "GAP UI rejects a truncated block before any plan can be used");
    ok(!$("#gap-step-prompt").hidden && !(GapApp.state.settings.dayPlans || {})[todayKey],
      "truncated GAP paste remains at review and creates no plan");

    $("#gap-paste").value += "\nEND";
    $("#btn-gap-parse").click();
    ok(!$("#gap-step-choose").hidden && !(GapApp.state.settings.dayPlans || {})[todayKey],
      "unsafe GAP option goes to the chooser instead of auto-applying");
    ok(/Manual review required/i.test(text("#gap-option-list")) &&
        /local sodium projection exceeds|local mineral coverage is incomplete/i.test(text("#gap-option-list")),
      "GAP chooser explains the failed local checks");
    ok(!/1 kcal.*P 999.*Sodium 0/i.test(text("#gap-option-list")),
      "GAP chooser ignores the AI's dishonest Projected values");
    const priorConfirm = window.confirm;
    let gapConfirms = 0;
    window.confirm = () => { gapConfirms += 1; return false; };
    $("#gap-option-list [data-action='apply-gap-option']").click();
    window.confirm = priorConfirm;
    ok(gapConfirms === 1 && !(GapApp.state.settings.dayPlans || {})[todayKey],
      "review-only GAP option requires explicit confirmation before use");

    // Two individually valid items can still overflow only when aggregated.
    // The parser must flag and omit that derived projection, and the apply
    // handler must refuse the option before confirmation, persistence, or sync.
    const GapMath = window.eval("GapPrompt");
    const GapSync = window.eval("Sync");
    const aggregateFood = {
      id: "gap-aggregate-boundary", name: "Aggregate boundary",
      per100: { kcal: 100, p: 0, c: 0, f: 0, fb: 0, na: 0, k: 0 },
      units: {}, logAs: "grams", recipe: { ingredients: [] },
    };
    const aggregateCandidate = {
      id: aggregateFood.id, name: aggregateFood.name, per100: aggregateFood.per100,
      units: {}, logAs: "grams", food: aggregateFood,
    };
    const parseAggregate = (secondGrams, context) => GapMath.parseGapBlock(`GAP v1
Day: ${todayKey}
Option: 1 | Aggregate boundary
Item: Aggregate boundary | 500000000 g | snack
Item: Aggregate boundary | ${secondGrams} g | snack
Reachable: yes
Projected: 1000000000 kcal | P 0 | C 0 | F 0 | Fiber 0 | Sodium 0 | Potassium 0
    END`, [aggregateCandidate], (query, name) => query === name ? 1 : 0, context);
    const aggregateFixture = {
      gapParsed: JSON.parse(JSON.stringify(GapApp.state.gapParsed)),
      gapSelected: JSON.parse(JSON.stringify(GapApp.state.gapSelected)),
    };
    const allStorage = () => JSON.stringify(Array.from(
      { length: window.localStorage.length },
      (_, i) => {
        const key = window.localStorage.key(i);
        return [key, window.localStorage.getItem(key)];
      }
    ).sort((a, b) => a[0].localeCompare(b[0])));
    const overAggregate = parseAggregate("500000001", {
      totals: Ledger.totalsFor(todayKey),
      goals: PhaseMath.goalsForDay(todayKey, GapApp.state.settings),
    });
    GapApp.state.gapSelected = { [`id:${aggregateFood.id}`]: aggregateFood };
    GapApp.state.gapParsed = overAggregate;
    const beforeAggregateState = JSON.stringify(GapApp.state);
    const beforeAggregateStorage = allStorage();
    const originalGapSchedulePush = GapSync.schedulePush;
    let aggregateSyncCalls = 0;
    let aggregateApplyConfirms = 0;
    GapSync.schedulePush = () => { aggregateSyncCalls += 1; };
    window.confirm = () => { aggregateApplyConfirms += 1; return true; };
    $("#gap-option-list [data-action='apply-gap-option']").click();
    ok(overAggregate.options[0].flags.includes("aggregate-out-of-range") &&
        overAggregate.options[0].localProjected == null,
      "GAP parser flags aggregate limit + 1 and omits its outbound-invalid projection");
    ok(JSON.stringify(GapApp.state) === beforeAggregateState && allStorage() === beforeAggregateStorage &&
        aggregateSyncCalls === 0 && aggregateApplyConfirms === 0,
      "GAP aggregate limit + 1 apply leaves exact state/storage and schedules zero sync");

    // A zero logged-total context isolates the producer boundary and proves
    // the exact maximum remains eligible for application.
    const zeroAggregateContext = {
      means: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0 },
      goals: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0 },
    };
    const boundaryAggregate = parseAggregate("500000000", zeroAggregateContext);
    ok(boundaryAggregate.options[0].localProjected.kcal === 1e9 &&
        !boundaryAggregate.options[0].flags.includes("aggregate-out-of-range") &&
        boundaryAggregate.options[0].autoApply === true,
      "GAP exact aggregate boundary remains eligible for application");
    GapSync.schedulePush = originalGapSchedulePush;
    window.confirm = priorConfirm;
    GapApp.state.gapParsed = aggregateFixture.gapParsed;
    GapApp.state.gapSelected = aggregateFixture.gapSelected;
    GapUI.closeSheet("sheet-gap");
    GapApp.state.gapParsed = null;
    GapApp.state.gapSelected = {};
    if (GapApp.state.settings.gapDrafts) delete GapApp.state.settings.gapDrafts[todayKey];

    // Manual nutrient entry rejects negative K instead of converting it to unknown.
    settingsTab.click();
    const foodsTab = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === "foods");
    foodsTab.click();
    $("#btn-add-food").click();
    $("#btn-manual-food").click();
    $("#rev-name").value = "Invalid K";
    $("#rev-k").value = "-10";
    $("#rev-k").dispatchEvent(new window.Event("input", { bubbles: true }));
    ok($("#btn-review-save").disabled && /Potassium can't be negative/.test(text("#review-errors")),
      "manual food form blocks negative potassium");

    $("#rev-k").value = "";
    $("#rev-na").value = "1,00";
    $("#rev-na").dispatchEvent(new window.Event("input", { bubbles: true }));
    ok($("#btn-review-save").disabled && /Sodium must be a number/.test(text("#review-errors")),
      "manual food form rejects malformed comma grouping");
    $("#rev-name").value = "Unknown minerals";
    $("#rev-na").value = "";
    $("#rev-k").value = "";
    $("#rev-k").dispatchEvent(new window.Event("input", { bubbles: true }));
    ok(!$("#btn-review-save").disabled, "blank sodium and potassium remain valid unknown values");
    $("#btn-review-save").click();
    const unknownMinerals = JSON.parse(window.localStorage.getItem("nd_personal_v1") || "[]")
      .find((food) => food.name === "Unknown minerals");
    ok(unknownMinerals && unknownMinerals.per100.na === null && unknownMinerals.per100.k === null,
      "manual save persists blank sodium and potassium as null", text("#toast"));
    $("#sheet-detail [data-close='sheet-detail']").click();
    await new Promise((r) => setTimeout(r, 220));

    $("#btn-add-food").click();
    $("#btn-manual-food").click();
    $("#rev-name").value = "Comma minerals";
    $("#rev-kcal").value = "250";
    $("#rev-na").value = "1,000";
    $("#rev-k").value = "2,500";
    $("#rev-k").dispatchEvent(new window.Event("input", { bubbles: true }));
    ok(!$("#btn-review-save").disabled, "correctly grouped nutrient thousands are accepted");
    $("#btn-review-save").click();
    const commaMinerals = JSON.parse(window.localStorage.getItem("nd_personal_v1") || "[]")
      .find((food) => food.name === "Comma minerals");
    ok(commaMinerals && commaMinerals.per100.na === 1000 && commaMinerals.per100.k === 2500,
      "comma-formatted nutrients save as their numeric values", text("#toast"));
    $("#sheet-detail [data-close='sheet-detail']").click();
    await new Promise((r) => setTimeout(r, 220));

    const sharedCode = Share.pack({
      name: "Exact shared bites",
      per100: { kcal: 200, p: 8, c: 28, f: 6, fb: 3, na: null, k: null },
      units: { serving: 187.25, piece: 42.75 },
      logAs: "piece", countLabel: "bite",
      batch: { grams: 987.65, servings: 13.5, weighed: true },
      recipe: { ingredients: ["fixture"] },
    });
    $("#btn-import-shared").click();
    $("#shared-import-text").value = sharedCode;
    $("#btn-shared-parse").click();
    ok(/Na unknown.*K unknown/s.test(text("#shared-import-preview")) && /Batch: 987.65 g \/ 13.5 servings/.test(text("#shared-import-preview")),
      "shared-food preview exposes unknown minerals and exact batch semantics");
    $("#btn-shared-save").click();
    const importedShared = JSON.parse(window.localStorage.getItem("nd_personal_v1") || "[]")
      .find((food) => food.name === "Exact shared bites");
    ok(importedShared && importedShared.per100.na === null && importedShared.per100.k === null &&
        importedShared.units.serving === 187.25 && importedShared.units.piece === 42.75 &&
        importedShared.logAs === "piece" && importedShared.countLabel === "bite" &&
        importedShared.batch.grams === 987.65 && importedShared.batch.servings === 13.5,
      "share preview-to-save workflow preserves nullable minerals, units, logging, and batch", text("#toast"));
  }

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
    if (day) {
      ok($("#trend-tip [data-action='goto-day']") &&
          $("#trend-tip [data-action='goto-day']").dataset.day === day,
        "trend tip offers Open day instead of auto-opening a contribution panel");
    }
    const wHit = window.UI.onWeightTap(180);
    ok(wHit == null || typeof wHit.value === "number", "weight tap returns a weigh-in or null");
    if (wHit && wHit.day) {
      const App = window.eval("App");
      const Analytics = window.eval("Analytics");
      ok(!$("#weight-tip").hidden, "weight tap shows the tooltip");
      ok(!!$("#weight-tip .tip-day") && text("#weight-tip .tip-day").length > 0,
        "weight tip shows the weigh-in date");
      ok(new RegExp(`${wHit.value.toFixed(1)}\\s*${wHit.unit}`).test(text("#weight-tip")),
        "weight tip shows the weigh-in value");
      const prevBtn = $("#weight-tip [data-action='goto-day']");
      const expectedPrev = Analytics.addDays(wHit.day, -1);
      ok(prevBtn && /Open previous day/i.test(prevBtn.textContent) &&
          prevBtn.dataset.day === expectedPrev,
        "weight tip offers Open previous day for the day before the weigh-in");
      prevBtn.click();
      await new Promise((r) => setTimeout(r, 30));
      ok(!!$("#view-today.active"), "Open previous day jumps to Today");
      ok(App.state.viewDay === expectedPrev,
        "Open previous day opens the calendar day before the weigh-in");
      ok(!$("#insights-back").hidden && /Back to Insights > Weight/i.test(text("#insights-back-btn")),
        "Open previous day arms Back to Insights > Weight");
      const insightsTab = [...window.document.querySelectorAll(".tab")]
        .find((x) => x.dataset.view === "insights");
      if (insightsTab) { insightsTab.click(); await new Promise((r) => setTimeout(r, 40)); }
    }
  }

  // Today HUD → same contribution card for the viewed day.
  // Set Insights nutrient to protein first so we can assert HUD taps do not bleed.
  window.document.querySelector('#insight-nutrient [data-nutrient="protein"]').click();
  await new Promise((r) => setTimeout(r, 20));
  ok(window.document.querySelector('#insight-nutrient [data-nutrient="protein"]').classList.contains("active"),
    "Insights nutrient parked on protein before HUD tap");
  const todayTab = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === "today");
  if (todayTab) { todayTab.click(); await new Promise((r) => setTimeout(r, 20)); }
  const sodiumHud = window.document.querySelector('#hud [data-hud-nutrient="sodium"]');
  ok(!!sodiumHud, "HUD sodium row is tappable");
  sodiumHud.click();
  await new Promise((r) => setTimeout(r, 20));
  const todayDetail = $("#today-day-detail");
  ok(todayDetail && todayDetail.innerHTML.trim().length > 0, "HUD tap opens Today contribution card");
  ok(todayDetail.querySelector(".topfood-list"), "Today contribution shows food % bars");
  ok(/Sodium|sodium|limit|headroom|over/i.test(todayDetail.textContent), "Today contribution is sodium-scoped");
  const closeBtn = todayDetail.querySelector("[data-action='close-day-contrib']");
  ok(!!closeBtn, "Today contribution has a close control");
  if (closeBtn) {
    closeBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    ok(!$("#today-day-detail").innerHTML.trim(), "close clears Today contribution");
  }
  // Cross-tab: Today HUD must not rewrite the Insights nutrient selection.
  const insightsTab = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === "insights");
  if (insightsTab) { insightsTab.click(); await new Promise((r) => setTimeout(r, 40)); }
  ok(window.document.querySelector('#insight-nutrient [data-nutrient="protein"]').classList.contains("active"),
    "Today HUD tap does not rewrite Insights nutrient");
  ok(/Minimum/.test(text("#trend-legend")), "Insights protein framing survives a Today HUD sodium tap");

  // Other tabs still work.
  for (const v of ["today", "foods", "settings"]) {
    const t = [...window.document.querySelectorAll(".tab")].find((x) => x.dataset.view === v);
    if (t) { t.click(); await new Promise((r) => setTimeout(r, 20)); }
  }
  ok(true, "other tabs render without throwing");

  dom.window.close();
}

/**
 * §3 #9 rich fixture — force enough notes that the info cap and <details>
 * branch actually execute (the main seed only fires ~4 notes).
 */
async function runObservationsTriage() {
  console.log("\n[obs-triage] force honesty + watch + surplus cappable info for the cap");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  installPrimaryLock(window);
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { get() { return 120; }, configurable: true });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 360, bottom: 200, width: 360, height: 200, x: 0, y: 0, toJSON() {} };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

  const today = new Date();
  const k = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return dayKey(d); };
  const events = [];
  const weights = {};
  const dayGoals = {};
  let eid = 0;
  const add = (day, name, macros, meal = "lunch") => {
    events.push({
      id: `ot-${eid++}`, ts: Date.now() - eid * 1000, day, type: "add",
      entry: {
        id: `ote-${eid}`, name, displayQty: "100 g", grams: 100, meal,
        macros: { na: 200, fb: 5, ...macros }, sd: 0.1,
      },
    });
  };

  // Build day list with known weekend offsets.
  const meta = [];
  for (let i = 27; i >= 1; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    meta.push({ i, key: k(i), weekend: d.getDay() === 0 || d.getDay() === 6 });
  }
  const weekendKeys = meta.filter((m) => m.weekend).map((m) => m.key);
  const weekdayKeys = meta.filter((m) => !m.weekend).map((m) => m.key);
  // Log two weekends high for weekend-kcal; leave the rest empty for
  // weekend-logging + sparse coverage.
  const logWeekends = new Set(weekendKeys.slice(0, 2));
  // Dense recent weekdays (momentum + weekdayRate), sparse early ones.
  const logWeekdays = new Set(
    weekdayKeys.filter((key) => {
      const age = meta.find((m) => m.key === key).i;
      return age <= 14 ? true : age % 4 === 0;
    })
  );
  const partialKeys = weekdayKeys.filter((key) => logWeekdays.has(key) && meta.find((m) => m.key === key).i > 14).slice(0, 2);

  for (const m of meta) {
    if (m.i % 3 === 0) weights[m.key] = { kg: 80 - m.i * 0.02, updatedAt: Date.now() };
    if (partialKeys.includes(m.key)) {
      add(m.key, "Bite", { kcal: 180, p: 5, c: 20, f: 5 }, "snack");
      continue;
    }
    if (logWeekends.has(m.key)) {
      add(m.key, "Brunch", { kcal: 3200, p: 140, c: 320, f: 120 }, "lunch");
      add(m.key, "Dinner", { kcal: 900, p: 40, c: 80, f: 40 }, "dinner");
      continue;
    }
    if (!logWeekdays.has(m.key)) continue;
    const late = m.i <= 7; // only the trailing week vs the week before (momentum windows)
    const high = m.i % 3 === 1;
    // Large recent vs prior gap so momentum clears 8% after protein-per-kg left.
    const kcal = late ? (high ? 3400 : 3000) : (high ? 1500 : 1200);
    add(m.key, "Meal A", { kcal: Math.round(kcal * 0.55), p: 60, c: 80, f: 30 }, "lunch");
    add(m.key, "Meal B", { kcal: Math.round(kcal * 0.45), p: 50, c: 70, f: 25 }, "dinner");
  }

  // Reduced plan on a logged weekday that isn't partial.
  const planDay = weekdayKeys.find((key) => logWeekdays.has(key) && !partialKeys.includes(key));
  if (planDay) {
    dayGoals[planDay] = {
      bumps: { kcal: -400 },
      intent: "reduced",
      plannedAt: Date.now() - 20 * 86400e3,
      updatedAt: Date.now() - 20 * 86400e3,
    };
  }

  // Honoured fast: targetKcal/baseKcal shape required (bumps:{kcal:0} is not a fast).
  const fastDay = weekdayKeys.find((key) => !logWeekdays.has(key) && !partialKeys.includes(key));
  if (fastDay) {
    dayGoals[fastDay] = {
      targetKcal: 0,
      baseKcal: 2200,
      intent: "fast",
      fastAcknowledged: true,
      plannedAt: Date.now() - 15 * 86400e3,
      updatedAt: Date.now() - 15 * 86400e3,
    };
  }

  window.localStorage.setItem("nd_events_v1", JSON.stringify(events));
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300, potassium: 3400 },
    weights, weightUnit: "kg", phases: [], profile: {}, dayGoals,
  }));

  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  await bootApp(window);
  const $ = (s) => window.document.querySelector(s);
  const tab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  tab.click();
  await new Promise((r) => setTimeout(r, 80));
  window.document.querySelector('#insight-range [data-days="30"]').click();
  await new Promise((r) => setTimeout(r, 60));

  const Analytics = window.eval("Analytics");
  const Ledger = window.eval("Ledger");
  const Phases = window.eval("Phases");
  const App = window.eval("App");
  const settings = App.state.settings;
  const todayKey = Ledger.todayKey();
  const keys = [];
  for (let i = 29; i >= 0; i--) keys.push(k(i));
  const days = Analytics.buildDays({
    keys,
    totalsForDay: (day) => Ledger.totalsFor(day),
    goalsForDay: (day) => Phases.goalsForDay(day, settings),
    weightKgForDay: (day) => Phases.weightForDay(settings, day),
    dayPlanForDay: (day) => (settings.dayGoals && settings.dayGoals[day]) || null,
    firstAddAt: (day) => Ledger.firstAddAt(day),
  });
  const emitted = Analytics.observations(days, { todayKey });
  const HONESTY = new Set(["partial-days", "bumps", "fasts", "macro-incomplete", "excluded-days"]);
  const cappable = emitted.filter((o) => o.tone !== "watch" && !HONESTY.has(o.id));
    ok(cappable.length >= 4, "obs-triage fixture fires ≥4 cappable info notes (enough to force the cap)",
    emitted.map((o) => o.id).join(", "));
  ok(cappable.length > 3, "cappable info exceeds the visible cap of 3",
    `cappable=${cappable.length}`);
  ok(emitted.some((o) => o.id === "momentum"),
    "obs-triage fixture includes momentum among cappable notes");
  ok(emitted.some((o) => o.tone === "watch"), "obs-triage fixture includes a watch note");
  ok(emitted.some((o) => HONESTY.has(o.id)), "obs-triage fixture includes an honesty note");
  ok(emitted.some((o) => o.id === "partial-days") && emitted.some((o) => o.id === "bumps"),
    "obs-triage fixture includes partial-days and bumps together");

  const root = $("#insight-observations");
  const topNotes = [...root.children].filter((el) => el.matches(".obs"));
  const details = root.querySelector("details.obs-more");
  const moreNotes = details ? [...details.querySelectorAll(".obs")] : [];
  const visibleInfo = topNotes.filter((el) =>
    el.classList.contains("obs-info") && !HONESTY.has(el.dataset.obsId));
  const alwaysNotes = topNotes.filter((el) =>
    el.classList.contains("obs-watch") || HONESTY.has(el.dataset.obsId));

  ok(visibleInfo.length === 3, "exactly three non-protected info notes visible when capped",
    `got ${visibleInfo.length}; ids=${visibleInfo.map((el) => el.dataset.obsId).join(",")}`);
  ok(!!details, "More notes <details> renders when surplus info exists");
  ok(moreNotes.length >= 1, "More notes holds at least one surplus info observation",
    `got ${moreNotes.length}`);
  const summary = details && details.querySelector("summary");
  ok(summary && new RegExp(`More notes \\(${moreNotes.length}\\)`).test(summary.textContent),
    "More notes summary count matches its children", summary && summary.textContent);
  ok(moreNotes.every((el) =>
    el.classList.contains("obs-info") && !HONESTY.has(el.dataset.obsId) && !el.classList.contains("obs-watch")),
    "More notes contains no watch or honesty observations");
  ok($('#insight-observations > [data-obs-id="bumps"]') ||
      $('#insight-observations > [data-obs-id="partial-days"]') ||
      $('#insight-observations > [data-obs-id="fasts"]'),
    "at least one honesty note is top-level outside More notes");
  ok(!!$('#insight-observations > [data-obs-id="bumps"]') &&
      !!$('#insight-observations > [data-obs-id="partial-days"]'),
    "partial-days and bumps both stay top-level regardless of the info cap");

  const pri = { "partial-days": 0, bumps: 0, fasts: 0, "macro-incomplete": 0, "excluded-days": 0, coverage: 10, "weekend-logging": 20,
    "weekend-kcal": 30, variability: 40, momentum: 50 };
  const priOk = (ids) => {
    for (let i = 1; i < ids.length; i++) {
      if ((pri[ids[i]] ?? 99) < (pri[ids[i - 1]] ?? 99)) return false;
    }
    return true;
  };
  ok(priOk(alwaysNotes.map((el) => el.dataset.obsId)),
    "protected notes are ordered non-decreasing by priority",
    alwaysNotes.map((el) => el.dataset.obsId).join(" → "));
  ok(priOk(visibleInfo.map((el) => el.dataset.obsId)),
    "visible info notes are ordered non-decreasing by priority",
    visibleInfo.map((el) => el.dataset.obsId).join(" → "));
  const weJump = $('#insight-observations [data-obs-id="weekend-kcal"]');
  ok(weJump && /\d+\s*kcal/.test(weJump.textContent) && !/\d+\s*→\s*\d+/.test(weJump.textContent),
    "rendered weekend-kcal keeps magnitude without weekday→weekend restatement");
  const varJump = $('#insight-observations [data-obs-id="variability"]');
  ok(varJump && /\d+\s*kcal/.test(varJump.textContent) && !/around \d+/.test(varJump.textContent),
    "rendered variability keeps ±sd kcal without restating the average");
  ok(root.querySelectorAll("[data-jump]").length >= 1,
    "obs-triage fixture renders at least one jump control");

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
  installPrimaryLock(window);
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
  await bootApp(window);
  const tab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  tab.click();
  await new Promise((r) => setTimeout(r, 60));
  const $ = (s) => window.document.querySelector(s);

  ok(!$(".tdee-big"), "no TDEE number when there are no weigh-ins");
  ok(/weigh-ins|logged days|enough/i.test($("#tdee-card").textContent),
    "energy card keeps its refusal copy intact behind the thin-tier gate");
  ok(/2\+ weigh-ins|Log weight/i.test($("#weight-summary").textContent), "weight chart asks for weigh-ins");
  ok($("#insight-headline").innerHTML.trim().length > 0, "headline still renders on thin data");
  const sparseText = $("#view-insights").textContent;
  ok(!/NaN|undefined|Infinity|\[object/.test(sparseText), "no NaN/undefined leaks on thin data");
  ok(/2 of \d+ days logged/.test(sparseText), "thin maturity: exactly 2 logged days in range");
  ok(!$("#section-intake").hidden && !$("#section-adherence").hidden && !$("#section-weight").hidden,
    "thin maturity keeps intake, weight, and adherence");
  ok($("#section-energy").hidden && $("#section-composition").hidden && $("#section-compare").hidden,
    "thin maturity hides energy, composition, and compare");
  // Dock is Intake-only; open that category before asserting the lane.
  const thinCats = $("#insight-cats");
  thinCats.querySelector('[data-insight-cat="intake"]').click();
  await new Promise((r) => setTimeout(r, 40));
  ok(!$("#insight-dock").hidden && window.document.body.classList.contains("has-insight-dock"),
    "thin maturity keeps the nutrient dock visible on Intake");
  thinCats.querySelector('[data-insight-cat="overview"]').click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#insight-dock").hidden, "thin maturity still hides dock on Overview");
  thinCats.querySelector('[data-insight-cat="intake"]').click();
  await new Promise((r) => setTimeout(r, 20));
  // P5-N1/N2: recovery path must unhide after crossing the <3 boundary mid-session.
  // Logging a 3rd day and re-entering Insights is the only way the full state is
  // reached through applyInsightMaturity's unhide loop (HTML defaults stay full).
  const Ledger = window.eval("Ledger");
  Ledger.addEntry(k(2), {
    name: "Eggs", displayQty: "100 g", grams: 100, meal: "breakfast",
    macros: { kcal: 155, p: 13, c: 1, f: 11, fb: 0, na: 140 }, sd: 0.1,
  });
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  await new Promise((r) => setTimeout(r, 20));
  tab.click();
  await new Promise((r) => setTimeout(r, 60));
  const afterText = $("#view-insights").textContent;
  ok(/3 of \d+ days logged/.test(afterText), "full maturity: exactly 3 logged days after the 2→3 transition");
  ok(!$("#section-energy").hidden && !$("#section-composition").hidden,
    "maturity unhide restores energy and composition after 2→3");
  ok($("#section-compare").hidden, "section-compare stays owned by renderPhaseCompare after 2→3");
  ok(!/NaN|undefined|Infinity|\[object/.test(afterText), "no NaN/undefined leaks after maturity recovery");
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
  installPrimaryLock(window);
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} }; };
  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  await bootApp(window);
  const $ = (s) => window.document.querySelector(s);

  await new Promise((r) => setTimeout(r, 25));
  const onboarding = $("#onboarding");
  const appMain = $(".shell > main");
  const onbStart = $("#btn-onb-start");
  const onbSkip = $("#btn-onb-skip");
  ok(!onboarding.hidden && onboarding.getAttribute("role") === "dialog" &&
      onboarding.getAttribute("aria-modal") === "true" && dialogName(onboarding) === "Your nutrition tracker",
    "first-run onboarding is a named accessible modal dialog");
  ok(appMain.hasAttribute("inert") && appMain.getAttribute("aria-hidden") === "true",
    "onboarding makes the background inert and hidden from assistive technology");
  ok(window.document.activeElement === onbStart, "onboarding moves initial focus to its primary action");
  onbStart.focus();
  onbStart.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  ok(window.document.activeElement === onbSkip, "Shift-Tab wraps to the last onboarding control");
  onbSkip.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  ok(window.document.activeElement === onbStart, "Tab wraps to the first onboarding control");
  const backgroundTab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  backgroundTab.focus();
  ok(onboarding.contains(window.document.activeElement), "escaped focus is pulled back into onboarding");
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 220));
  ok(onboarding.hidden && window.localStorage.getItem("nd_onboarded_v1") === "1",
    "Escape performs the documented skip-for-now dismissal");
  ok(!appMain.hasAttribute("inert") && !appMain.hasAttribute("aria-hidden"),
    "onboarding dismissal restores background accessibility state");

  const focusReturn = $("#fab-add");
  focusReturn.focus();
  window.eval("UI.showOnboarding(true)");
  await new Promise((r) => setTimeout(r, 25));
  ok(window.document.activeElement === onbStart, "reopened onboarding receives initial focus consistently");
  onbSkip.click();
  await new Promise((r) => setTimeout(r, 20));
  ok(onboarding.hidden && window.document.activeElement === focusReturn,
    "closing onboarding restores focus to its invoking control");

  const insightsTab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  insightsTab.click();
  await new Promise((r) => setTimeout(r, 60));
  const emptyHeadline = $("#insight-headline").textContent;
  ok(/No logged days/i.test(emptyHeadline), "empty state gives a clear first-run message");
  ok(/fills in/i.test(emptyHeadline), "empty headline promises the tab will fill in after logging");
  ok(!/NaN|undefined|Infinity/.test($("#view-insights").textContent), "no NaN/undefined leaks into the empty view");
  const visibleEmptySections = [...window.document.querySelectorAll("#view-insights .insight-section")]
    .filter((s) => !s.hidden);
  ok(visibleEmptySections.length === 0, "empty maturity hides every insight-section");
  ok($("#insight-dock").hidden, "empty maturity hides the nutrient dock");
  ok(!window.document.body.classList.contains("has-insight-dock"),
    "empty maturity clears has-insight-dock lane reservation");
  const emptyCats = [...window.document.querySelectorAll("#insight-cats [data-insight-cat]")];
  ok(emptyCats.length === 4 &&
      emptyCats.every((b) => b.dataset.insightCat === "overview" ? !b.disabled : b.disabled),
    "empty maturity disables Intake / Body / Patterns category tabs");
  ok(!$("#insight-panel-overview").hidden, "empty maturity keeps Overview panel");
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  await new Promise((r) => setTimeout(r, 20));

  // Day plans are calories-only (or a declared fast), made before the first log.
  const Phases = window.eval("Phases");
  const Ledger = window.eval("Ledger");
  const todayKey = Ledger.todayKey();
  const before = Phases.goalsForDay(todayKey, JSON.parse(window.localStorage.getItem("nd_settings_v1") || "{}"));
  $("#btn-day-goals").click();
  ok(!$("#sheet-day-goals").hidden, "unlogged today can open the energy adjustment editor");
  ok(!!$("#dg-kcal") && !$("#dg-protein") && !$("#dg-sodium") && !$("#dg-potassium"),
    "energy adjustment editor is calories-only");
  // 700 is a real 5:2 / alternate-day plan now, so the boundary probe moves
  // below the widened floor. A fast is declared, never typed, so 0 is still
  // not reachable from this field.
  $("#dg-kcal").value = "150";
  $("#dg-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  ok($("#dg-kcal").getAttribute("aria-invalid") === "true" && /200–6000/.test($("#energy-adjustment-preview").textContent),
    "out-of-range energy target is rejected in preview");
  // Part VIII.8: dg-save rounds to the nearest 10 before validating/storing
  // (Analytics.retargetForKcal only resolves cleanly on round tens); the
  // preview must round the same way, or it can show one number while saving
  // another — 1505 previewed as itself but stored as 1510, or 195 rejected in
  // preview yet quietly saved as 200.
  $("#dg-kcal").value = "1505";
  $("#dg-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  ok($("#dg-kcal").getAttribute("aria-invalid") !== "true" &&
      /Planned target: 1510 kcal/.test($("#energy-adjustment-preview").textContent),
    "the preview rounds a typed 1505 to 1510, matching what dg-save will store");
  $("#dg-kcal").value = "195";
  $("#dg-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  ok($("#dg-kcal").getAttribute("aria-invalid") !== "true",
    "the preview accepts a typed 195 — it rounds to the 200 floor instead of rejecting a value that would save anyway");
  // Part X.6: the same tie-break symmetry at the ceiling. 6004 already rounds
  // down to 6000 and was never the problem; 6005 sits on the tie and
  // Math.round breaks it up to 6010, which used to bounce as over budget.
  $("#dg-kcal").value = "6005";
  $("#dg-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  ok($("#dg-kcal").getAttribute("aria-invalid") !== "true" &&
      /Planned target: 6000 kcal/.test($("#energy-adjustment-preview").textContent),
    "X.6: the preview clamps a typed 6005 to the 6000 ceiling instead of rounding it up to 6010 and rejecting it");
  $("#dg-kcal").value = "700";
  $("#dg-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  ok($("#dg-kcal").getAttribute("aria-invalid") !== "true",
    "a 700 kcal reduced-day plan is accepted in preview");
  $("#dg-save").click();
  ok(!((JSON.parse(window.localStorage.getItem("nd_settings_v1") || "{}").dayGoals || {})[todayKey]),
    "out-of-range energy target is rejected on save");
  $("#dg-kcal").value = "1100";
  $("#dg-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  ok(/clinician supervision/i.test($("#energy-adjustment-preview").textContent),
    "very-low-calorie preview gives an explicit clinician-supervision warning");
  let lowTargetWarning = "";
  window.confirm = (message) => { lowTargetWarning = String(message); return false; };
  $("#dg-save").click();
  ok(/clinician supervision/i.test(lowTargetWarning) &&
      !((JSON.parse(window.localStorage.getItem("nd_settings_v1") || "{}").dayGoals || {})[todayKey]),
    "very-low-calorie save requires explicit clinician-supervision acknowledgement");
  const target = before.kcal + 300;
  $("#dg-kcal").value = String(target);
  $("#dg-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  $("#dg-save").click();
  const plannedSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  const planned = plannedSettings.dayGoals[todayKey];
  const after = Phases.goalsForDay(todayKey, plannedSettings);
  ok(planned && planned.targetKcal === target && planned.baseKcal === before.kcal &&
      Number.isFinite(planned.plannedAt) && !planned.bumps,
    "planned calories persist as a frozen absolute target and baseline");
  ok(after.kcal === before.kcal + 300, "planned calorie adjustment changes today's calorie target");
  ok(after.protein === before.protein && after.sodium === before.sodium && after.potassium === before.potassium,
    "energy adjustment does not change protein, sodium, or potassium targets");
  ok(!/late/i.test($("#btn-day-goals").title) && $("#btn-day-goals").textContent === "Planned",
    "on-time day plan keeps short Planned chrome without a late title");

  const firstAdd = Ledger.addEntry(todayKey, {
    name: "First log", displayQty: "100 kcal", grams: 0, meal: "snack",
    macros: { kcal: 100, p: 0, c: 0, f: 0, fb: 0, na: 0, k: 0 }, sd: 0,
  });
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#btn-day-goals").textContent === "Planned" && !/locked/i.test($("#btn-day-goals").title),
    "existing planned calories remain visible and editable after logging begins");
  ok(!/late/i.test($("#btn-day-goals").title),
    "a plan set before the first log is not labeled late after food is logged");
  // S3: rewrite plannedAt after first-add to force declaredLate provenance and
  // confirm Today's link discloses the same fact Insights would report.
  const App = window.eval("App");
  const firstTs = Ledger.firstAddAt(todayKey);
  App.state.settings.dayGoals[todayKey].plannedAt = firstTs + 60e3;
  App.state.settings.dayGoals[todayKey].updatedAt = firstTs + 60e3;
  window.localStorage.setItem("nd_settings_v1", JSON.stringify(App.state.settings));
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#btn-day-goals").textContent === "Planned" && /late/i.test($("#btn-day-goals").title) &&
      !/locked/i.test($("#btn-day-goals").title),
    "Today's day-plan chrome stays Planned; title discloses late when provenance is declaredLate");
  ok(/after logging began/i.test($("#btn-day-goals").title),
    "late marker title explains the disclosure without punishing");
  // Restore on-time plannedAt so the remainder of the edit scenario stays stable.
  App.state.settings.dayGoals[todayKey].plannedAt = planned.plannedAt;
  App.state.settings.dayGoals[todayKey].updatedAt = planned.updatedAt;
  window.localStorage.setItem("nd_settings_v1", JSON.stringify(App.state.settings));
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  await new Promise((r) => setTimeout(r, 20));
  $("#btn-day-goals").click();
  await new Promise((r) => setTimeout(r, 20));
  ok($("#sheet-day-goals").classList.contains("open"),
    "logged day still opens Day plan for edits and Mark incomplete");
  ok(!!$("#dg-incomplete"), "Day plan sheet exposes Mark incomplete after food is logged");
  const revisedTarget = target - 50;
  $("#dg-kcal").value = String(revisedTarget);
  $("#dg-save").click();
  await new Promise((r) => setTimeout(r, 20));
  const revisedSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  ok(revisedSettings.dayGoals[todayKey].targetKcal === revisedTarget,
    "logged day can revise its planned calorie adjustment");
  $("#btn-day-goals").click();
  await new Promise((r) => setTimeout(r, 20));
  $("#dg-clear").click();
  await new Promise((r) => setTimeout(r, 20));
  const clearedSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  ok(clearedSettings.dayGoals[todayKey].cleared === true ||
      !(clearedSettings.dayGoals[todayKey].targetKcal === revisedTarget),
    "logged day can clear its planned calorie adjustment");
  // Restore a plan so later previous-day Fast checks still have a baseline day.
  App.state.settings.dayGoals[todayKey] = {
    targetKcal: target, baseKcal: before.kcal, plannedAt: planned.plannedAt,
    updatedAt: Date.now(), intent: "reduced",
  };
  window.localStorage.setItem("nd_settings_v1", JSON.stringify(App.state.settings));
  Ledger.removeEntry(todayKey, firstAdd.entry.id);
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  await new Promise((r) => setTimeout(r, 20));
  ok(Ledger.entriesFor(todayKey).length === 0 && $("#btn-day-goals").textContent === "Planned",
    "deleting the last visible entry keeps the day plan available");

  $("#btn-day-prev").click();
  $("#btn-day-goals").click();
  // §10: a Fast may still be declared on the calendar day after the target
  // day, so yesterday opens (on Fast), while a Reduced plan cannot.
  ok(!$("#sheet-day-goals").hidden, "previous day can open for a same-evening Fast declaration");
  ok(!!$("#dg-intent-seg button[data-dg-intent='fast']"), "previous-day sheet still exposes the Fast control");
  $("#dg-intent-seg button[data-dg-intent='reduced']").click();
  ok(/lock after the first food|day before|before it ends|cannot be changed|grace window/i.test($("#toast").textContent) ||
      $("#dg-intent-seg button[data-dg-intent='reduced']").getAttribute("aria-pressed") !== "true",
    "previous-day Reduced stays blocked even though Fast grace is still open");

  // F4 / S3: declare yesterday's Fast through the live producer and assert the
  // persisted declaredAfterDay path — short Fast chrome + "day ended" title,
  // not the derived "after logging began" copy used for reduced late plans.
  $("#dg-intent-seg button[data-dg-intent='fast']").click();
  const fastAck = $("#dg-fast-ack");
  ok(!!fastAck, "fast acknowledgement control is present for a late Fast declare");
  if (fastAck) fastAck.checked = true;
  $("#dg-save").click();
  await new Promise((r) => setTimeout(r, 40));
  const yesterdayKey = App.state.viewDay;
  const lateFastRec = (App.state.settings.dayGoals || {})[yesterdayKey];
  ok(lateFastRec && lateFastRec.intent === "fast" && lateFastRec.declaredAfterDay === true,
    "live Fast declare for yesterday stamps declaredAfterDay");
  ok($("#btn-day-goals").textContent === "Fast" && /late/i.test($("#btn-day-goals").title),
    "Today's day-plan chrome stays Fast; title discloses late for a declared-after-day Fast");
  ok(/after the day ended/i.test($("#btn-day-goals").title) &&
      !/after logging began/i.test($("#btn-day-goals").title),
    "late Fast title names the day-ended fact, not the first-add wording");

  dom.window.close();
}

// --- active-tab lock ------------------------------------------------------
async function lockScenario(lockApi) {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  installPrimaryLock(window);
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} }; };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.navigator.serviceWorker = undefined;
  Object.defineProperty(window.navigator, "locks", { value: lockApi, configurable: true });
  window.localStorage.setItem("nd_onboarded_v1", "1");
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300, potassium: 3400 },
    weights: {}, weightUnit: "lb", phases: [], profile: {},
  }));
  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
  return { dom, window };
}

async function runActiveTabLock() {
  console.log("\n[active-tab lock]");

  let primaryArgs = null;
  let primaryReleased = false;
  const primaryApi = {
    request(name, opts, callback) {
      primaryArgs = { name, opts };
      const held = Promise.resolve().then(() => callback({ name, mode: "exclusive" }));
      held.then(() => { primaryReleased = true; });
      return held;
    },
  };
  const primary = await lockScenario(primaryApi);
  ok(primaryArgs && primaryArgs.opts.ifAvailable === true && primaryArgs.opts.mode === "exclusive",
    "primary tab requests an if-available exclusive Web Lock");
  ok(primary.window.eval("App.state.viewDay") != null, "primary lock holder initializes the app");
  ok(primary.window.document.querySelector("#active-tab-blocker").hidden, "primary lock holder is not blocked");
  ok(!primaryReleased, "primary tab holds the lock for its lifetime");
  primary.window.dispatchEvent(new primary.window.Event("pagehide"));
  await new Promise((r) => setTimeout(r, 10));
  ok(primaryReleased, "pagehide releases the active-tab lock");
  primary.dom.window.close();

  let bfcacheRequests = 0;
  let bfcacheReleased = false;
  let bfcacheReloads = 0;
  const bfcache = await lockScenario({
    request(name, opts, callback) {
      bfcacheRequests += 1;
      const held = Promise.resolve().then(() => callback({ name, mode: "exclusive" }));
      held.then(() => { bfcacheReleased = true; });
      return held;
    },
  });
  bfcache.window.__ndActiveTabReloadForTest = () => { bfcacheReloads += 1; };
  const persistedHide = new bfcache.window.Event("pagehide");
  Object.defineProperty(persistedHide, "persisted", { value: true });
  bfcache.window.dispatchEvent(persistedHide);
  await new Promise((r) => setTimeout(r, 10));
  const bfcacheBlocker = bfcache.window.document.querySelector("#active-tab-blocker");
  const bfcacheShell = bfcache.window.document.querySelector(".shell");
  ok(bfcacheReleased && !bfcacheBlocker.hidden && bfcacheShell.inert,
    "persisted pagehide releases the lock but makes the booted page non-interactive");
  const suspendedSync = await bfcache.window.eval("Sync").fullSync(false);
  ok(suspendedSync && suspendedSync.suspended,
    "BFCache-suspended page cannot start a Drive sync before safe reload");
  const persistedShow = new bfcache.window.Event("pageshow");
  Object.defineProperty(persistedShow, "persisted", { value: true });
  bfcache.window.dispatchEvent(persistedShow);
  await new Promise((r) => setTimeout(r, 10));
  ok(bfcacheReloads === 1 && bfcacheRequests === 1 && bfcache.window.__ndActiveTabReady === false,
    "persisted pageshow reloads the guarded document instead of resuming an unlocked App");
  ok(/restored from browser history|reload before/i.test(bfcacheBlocker.textContent),
    "BFCache recovery surface explains the safety reload");
  bfcache.dom.window.close();

  let secondaryRequested = false;
  const secondary = await lockScenario({
    request(name, opts, callback) {
      secondaryRequested = true;
      return Promise.resolve().then(() => callback(null));
    },
  });
  const blocker = secondary.window.document.querySelector("#active-tab-blocker");
  ok(secondaryRequested && !blocker.hidden, "secondary tab shows the blocking surface");
  ok(/already open in another tab|Another tab is using/i.test(blocker.textContent), "secondary tab explains how to recover");
  ok(secondary.window.eval("App.state.viewDay") == null, "secondary tab does not initialize mutable app state");
  ok(!secondary.window.localStorage.getItem("nd_first_seen_at"), "secondary tab does not mutate initialization storage");
  secondary.dom.window.close();

  const failed = await lockScenario({ request() { return Promise.reject(new Error("lock service failed")); } });
  ok(!failed.window.document.querySelector("#active-tab-blocker").hidden,
    "Web Lock API failure takes the conservative blocked path");
  ok(failed.window.eval("App.state.viewDay") == null, "lock failure does not initialize mutable app state");
  failed.dom.window.close();

  const unsupported = await lockScenario(undefined);
  const unsupportedBlocker = unsupported.window.document.querySelector("#active-tab-blocker");
  ok(unsupported.window.eval("App.state.viewDay") == null && !unsupportedBlocker.hidden,
    "browser without Web Locks fails closed before App initialization");
  ok(/Browser update required|Web Locks support|supported browser/i.test(unsupportedBlocker.textContent),
    "unsupported browser gets accessible upgrade guidance");
  ok(unsupportedBlocker.getAttribute("role") === "alertdialog"
      && unsupportedBlocker.getAttribute("aria-modal") === "true"
      && unsupported.window.document.activeElement.id === "active-tab-title",
    "unsupported-browser guidance is announced and receives focus");
  ok(!unsupported.window.localStorage.getItem("nd_first_seen_at"),
    "unsupported browser does not mutate nutrition storage");
  unsupported.dom.window.close();
}

async function importBackup(window, payload) {
  const input = window.document.querySelector("#import-file");
  const file = new window.File([JSON.stringify(payload)], "backup.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));
}

// --- generation rollout through the real App Drive normalizer ------------
async function runGenerationRolloutIntegration() {
  console.log("\n[generation rollout / real App normalizer]");
  const fingerprints = [];
  const scenarios = ["forward", "reverse", "local-only"];

  for (const scenario of scenarios) {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
      .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
    const vc = new VirtualConsole();
    vc.on("jsdomError", (error) => errors.push(String(error.message || error)));
    const dom = new JSDOM(html, {
      url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true,
    });
    const { window } = dom;
    installPrimaryLock(window);
    window.HTMLCanvasElement.prototype.getContext = function () { const ctx = fakeCtx(); ctx.canvas = this; return ctx; };
    Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
    window.Element.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} };
    };
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.matchMedia = window.matchMedia || (() => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));

    const shift = (day, delta) => {
      const date = new Date(`${day}T12:00:00`);
      date.setDate(date.getDate() + delta);
      return dayKey(date);
    };
    const today = dayKey(new Date());
    const day = (delta) => shift(today, delta);
    const epoch = 100;
    const goals = {
      kcal: 2200, protein: 140, carbs: 250, fat: 70,
      fiber: 28, sodium: 2300, potassium: 3510,
    };
    const nutrition = { kcal: 100, p: 5, c: 12, f: 3, fb: 2, na: 30, k: 80 };
    const entry = (id) => ({
      id, name: id, displayQty: "100 g", grams: 100, qty: 100, unit: "g", meal: "snack",
      macros: { ...nutrition }, sd: 0.1, source: "personal", cat: "dish", foodId: null,
    });
    const addEvent = (id, clock, eventDay) => ({
      id: `${id}-event`, ts: clock, day: eventDay, type: "add", resetEpoch: 0,
      causal: { entryId: `${id}-entry`, seq: 0, parentEventId: null },
      entry: entry(`${id}-entry`),
    });
    const food = (id, clock) => ({
      id: `${id}-food`, name: `${id} food`, aliases: [id], cat: "dish",
      per100: { ...nutrition }, units: {}, logAs: "grams", countLabel: null, batch: null,
      recipe: { ingredients: [], prep: "", notes: "" }, confidence: "high", sd: 0.1,
      version: 1, history: [], raw: "", createdAt: clock, updatedAt: clock,
      lastUsedAt: 0, useCount: 0, source: "personal", resetEpoch: 0,
    });
    const phase = (id, clock, startDay, includeStale) => ({
      id: `${id}-phase`, name: "Maintain v1.0", kind: "maintain", versionMajor: 1, versionMinor: 0,
      startDay, endDay: null, createdAt: clock, updatedAt: clock, archived: false, resetEpoch: 0,
      revisionTombstones: includeStale
        ? { [`${id}-stale-tomb`]: 50, [`${id}-current-tomb`]: clock }
        : { [`${id}-current-tomb`]: clock },
      revisionTombstoneEpochs: includeStale
        ? { [`${id}-stale-tomb`]: 0, [`${id}-current-tomb`]: 0 }
        : { [`${id}-current-tomb`]: 0 },
      revisions: [
        ...(includeStale ? [{
          id: `${id}-stale-revision`, effectiveFrom: day(-20), goals,
          kind: "maintain", createdAt: 50, updatedAt: 50, resetEpoch: 0,
          version: "0.9", label: "Maintain v0.9",
        }] : []),
        {
          id: `${id}-current-revision`, effectiveFrom: startDay, goals,
          kind: "maintain", createdAt: clock, updatedAt: clock, resetEpoch: 0,
          version: "1.0", label: "Maintain v1.0",
        },
      ],
    });
    const plan = (id, clock) => ({
      updatedAt: clock, resetEpoch: 0, reachable: true, note: id, optionLabel: id,
      candidates: [], items: [], projected: null,
    });
    const draft = (id, clock) => ({
      selected: [{ foodId: null, catalogId: null, name: id }], step: "select",
      updatedAt: clock, resetEpoch: 0,
    });

    const localCurrentDay = day(-3), localStaleDay = day(-30);
    const localSettings = {
      goals, goalsUpdatedAt: 150, goalsResetEpoch: 0,
      theme: "light", imperial: false, weightUnit: "lb",
      dayGoals: {
        [localStaleDay]: { targetKcal: 2300, baseKcal: 2200, updatedAt: 50, resetEpoch: 0 },
        [localCurrentDay]: { targetKcal: 2300, baseKcal: 2200, updatedAt: 150, resetEpoch: 0 },
      },
      dayPlans: {
        [day(-29)]: plan("local-stale-plan", 50),
        [day(-2)]: plan("local-current-plan", 150),
      },
      gapDrafts: {
        [day(-28)]: draft("local-stale-draft", 50),
        [day(-1)]: draft("local-current-draft", 150),
      },
      phases: [phase("local", 150, day(-10), true)],
      weights: {
        [day(-27)]: { kg: 85, updatedAt: 50, resetEpoch: 0 },
        [today]: { kg: 80, updatedAt: 150, resetEpoch: 0 },
      },
      profile: {
        dob: "1990-01-01", sex: "male", heightCm: 180, activity: "moderate",
        notes: "local current profile", updatedAt: 150, resetEpoch: 0,
      },
    };
    window.localStorage.setItem("nd_events_v1", JSON.stringify([
      addEvent("local-stale", 50, localStaleDay), addEvent("local-current", 150, localCurrentDay),
    ]));
    window.localStorage.setItem("nd_personal_v1", JSON.stringify([
      food("local-stale", 50), food("local-current", 150),
    ]));
    window.localStorage.setItem("nd_settings_v1", JSON.stringify(localSettings));
    window.localStorage.setItem("nd_reset_at", String(epoch));
    window.localStorage.setItem("nd_onboarded_v1", "1");
    // Deliberately omit nd_generation_schema_version: this is the released
    // pre-marker shape whose producers could already have materialized zero.

    for (const src of [...window.document.querySelectorAll("script[src]")].map((script) => script.getAttribute("src"))) {
      if (!src || /^https?:/.test(src)) continue;
      inject(window, src);
    }
    await bootApp(window);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const App = window.eval("App");
    const GDrive = window.eval("GDrive");
    const Ledger = window.eval("Ledger");
    const Sync = window.eval("Sync");
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const emptyDoc = () => ({
      version: 4, resetAt: epoch, events: [], personalFoods: [], dayGoals: {}, dayPlans: {},
      gapDrafts: {}, phases: [], weights: {},
    });
    const remoteA = {
      ...emptyDoc(), updatedAt: 160,
      events: [addEvent("remote-a-current", 160, day(-4))],
      personalFoods: [food("remote-a-current", 160)],
      dayGoals: { [day(-4)]: { targetKcal: 2350, baseKcal: 2200, updatedAt: 160, resetEpoch: 0 } },
      dayPlans: { [day(-5)]: plan("remote-a-current-plan", 160) },
      profile: {
        dob: "1991-01-01", sex: "female", heightCm: 170, activity: "light",
        notes: "remote current profile", updatedAt: 160, resetEpoch: 0,
      },
    };
    const remoteBGoals = { ...goals, kcal: 2300, carbs: 275 };
    const remoteB = {
      ...emptyDoc(), updatedAt: 170,
      gapDrafts: { [day(-6)]: draft("remote-b-current-draft", 170) },
      phases: [phase("remote-b", 170, day(-5), false)],
      weights: { [day(-6)]: { kg: 79, updatedAt: 170, resetEpoch: 0 } },
      goals: remoteBGoals, goalsUpdatedAt: 170, goalsResetEpoch: 0,
    };
    // Every singleton/collection here is provably pre-reset. In particular,
    // filtered null profile/goals must stay null through App normalization and
    // must not synthesize a competing default phase before the aggregate merge.
    const remoteStale = {
      ...emptyDoc(), updatedAt: 50,
      events: [addEvent("remote-stale", 50, day(-40))],
      personalFoods: [food("remote-stale", 50)],
      dayGoals: { [day(-40)]: { targetKcal: 1800, baseKcal: 2200, updatedAt: 50, resetEpoch: 0 } },
      dayPlans: { [day(-39)]: plan("remote-stale-plan", 50) },
      gapDrafts: { [day(-38)]: draft("remote-stale-draft", 50) },
      phases: [phase("remote-stale", 50, day(-40), false)],
      weights: { [day(-37)]: { kg: 90, updatedAt: 50, resetEpoch: 0 } },
      profile: { sex: "male", notes: "remote stale profile", updatedAt: 50, resetEpoch: 0 },
      goals: { kcal: 1800, protein: 120, carbs: 180, fat: 67, fiber: 25, sodium: 2200, potassium: 3400 },
      goalsUpdatedAt: 50, goalsResetEpoch: 0,
    };
    const orderedRemote = scenario === "forward"
      ? [{ id: "stale", doc: remoteStale }, { id: "a", doc: remoteA }, { id: "b", doc: remoteB }]
      : scenario === "reverse"
        ? [{ id: "b", doc: remoteB }, { id: "a", doc: remoteA }, { id: "stale", doc: remoteStale }]
        : [];
    let ownDoc = null;
    let driveWrites = 0;
    GDrive.withWriterLock = async (callback) => callback("rollout-writer");
    GDrive.readShards = async () => ({
      docs: [
        ...orderedRemote.map((item) => ({ id: item.id, fileId: item.id, doc: clone(item.doc) })),
        ...(ownDoc ? [{ id: "own", fileId: "own", doc: clone(ownDoc) }] : []),
      ],
      ownFileId: ownDoc ? "own" : null,
    });
    GDrive.writeOwnShard = async (_own, doc) => {
      driveWrites += 1;
      ownDoc = clone(doc);
    };

    const storageProto = window.Storage.prototype;
    const originalSetItem = storageProto.setItem;
    const coreKeys = new Set([
      "nd_events_v1", "nd_personal_v1", "nd_settings_v1", "nd_reset_at", "nd_generation_schema_version",
    ]);
    let coreWrites = 0;
    storageProto.setItem = function (key, value) {
      if (coreKeys.has(String(key))) coreWrites += 1;
      return originalSetItem.call(this, key, value);
    };
    const originalReplaceAll = Ledger.replaceAll;
    let applies = 0;
    Ledger.replaceAll = function (events) {
      applies += 1;
      return originalReplaceAll.call(Ledger, events);
    };

    const first = await Sync.fullSync(false);
    const firstWrites = driveWrites;
    const firstCoreWrites = coreWrites;
    const firstApplies = applies;
    const stored = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
    const currentEvents = Ledger.allEvents();
    const currentFoods = App.state.personalFoods;
    const allExact = (records) => records.every((record) => record && record.resetEpoch === epoch);
    const allMapExact = (map) => Object.values(map || {}).every((record) => record && record.resetEpoch === epoch);
    const phaseEpochsExact = stored.phases.every((item) => item.resetEpoch === epoch &&
      item.revisions.every((revision) => revision.resetEpoch === epoch) &&
      Object.keys(item.revisionTombstones || {}).every((id) => item.revisionTombstoneEpochs[id] === epoch));
    ok(first.ok && firstWrites === 1 && firstApplies === 1 && firstCoreWrites > 0 &&
        window.localStorage.getItem("nd_generation_schema_version") === "1",
      `${scenario}: first real-normalizer sync atomically persists the rollout and writes one owned shard`,
      JSON.stringify({ first, firstWrites, firstApplies, firstCoreWrites,
        marker: window.localStorage.getItem("nd_generation_schema_version"),
        errorMessage: first && first.error && first.error.message }));
    ok(allExact(currentEvents) && allExact(currentFoods) && allMapExact(stored.dayGoals) &&
        allMapExact(stored.dayPlans) && allMapExact(stored.gapDrafts) && allMapExact(stored.weights) &&
        phaseEpochsExact && stored.profile.resetEpoch === epoch && stored.goalsResetEpoch === epoch,
      `${scenario}: events, foods, maps, phases, profile, and goals all carry the winning reset generation`);
    ok(!currentEvents.some((event) => /stale/.test(event.id)) &&
        !currentFoods.some((item) => /stale/.test(item.id)) &&
        !Object.keys(stored.dayGoals).some((key) => key === localStaleDay || key === day(-40)) &&
        !stored.phases.some((item) => /stale/.test(item.id)) &&
        !stored.phases.some((item) => item.revisions.some((revision) => /stale/.test(revision.id))) &&
        !stored.phases.some((item) => Object.keys(item.revisionTombstones || {}).some((id) => /stale/.test(id))) &&
        !stored.phases.some((item) => item.syntheticLegacy) && stored.profile.notes !== "remote stale profile",
      `${scenario}: provably pre-reset rows and filtered null singletons are not recreated during normalization`);
    if (scenario !== "local-only") {
      ok(currentEvents.some((event) => event.id === "local-current-event") &&
          currentEvents.some((event) => event.id === "remote-a-current-event") &&
          currentFoods.some((item) => item.id === "local-current-food") &&
          currentFoods.some((item) => item.id === "remote-a-current-food") &&
          stored.phases.some((item) => item.id === "local-phase") &&
          stored.phases.some((item) => item.id === "remote-b-phase"),
        `${scenario}: current records survive without loss across local and remote shards`);
      if (ownDoc) fingerprints.push(Sync.fingerprint(ownDoc));
      // The winning profile singleton (remote-a, the latest updatedAt among
      // local/remote-a/remote-stale) must retain its actual field content
      // through the rollout, not just an updated resetEpoch stamp.
      ok(stored.profile.notes === "remote current profile" &&
          stored.profile.dob === "1991-01-01" &&
          stored.profile.heightCm === 170,
        `${scenario}: migrated profile singleton retains its winning field content, not just resetEpoch`,
        JSON.stringify(stored.profile));
    } else {
      // No remote shards at all: the local profile is the only candidate and
      // must survive the local-only rollout migration with its own content.
      ok(stored.profile.notes === "local current profile" &&
          stored.profile.dob === "1990-01-01" &&
          stored.profile.heightCm === 180,
        `${scenario}: migrated profile singleton retains its winning field content, not just resetEpoch`,
        JSON.stringify(stored.profile));
    }

    const stateAfterFirst = JSON.stringify({
      events: currentEvents, foods: currentFoods, settings: stored,
    });
    const second = await Sync.fullSync(false);
    const storedSecond = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
    ok(second.ok && driveWrites === firstWrites && applies === firstApplies && coreWrites === firstCoreWrites &&
        JSON.stringify({ events: Ledger.allEvents(), foods: App.state.personalFoods, settings: storedSecond }) === stateAfterFirst,
      `${scenario}: second real-normalizer sync is stable with zero additional apply or write`);

    Ledger.replaceAll = originalReplaceAll;
    storageProto.setItem = originalSetItem;
    dom.window.close();
  }

  ok(fingerprints.length === 2 && fingerprints[0] === fingerprints[1],
    "real App normalization converges to the same canonical shard in both remote shard orders");
}

// --- import boundary, rendering safety, and quick-kcal completeness -------
async function runImportSecurity() {
  console.log("\n[import/security] detached validation and untrusted rendering");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  installPrimaryLock(window);
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} }; };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.matchMedia = window.matchMedia || (() => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  }));
  window.confirm = () => true;

  const today = dayKey(new Date());
  window.localStorage.setItem("nd_events_v1", JSON.stringify([{
    id: "baseline-event", ts: 10, day: today, type: "add",
    entry: {
      id: "baseline-entry", name: "Baseline", displayQty: "100 g", grams: 100,
      macros: { kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 20, k: 40 },
      sd: 0.1, meal: "snack", source: "personal", cat: "dish", foodId: "baseline-food",
    },
  }]));
  window.localStorage.setItem("nd_personal_v1", JSON.stringify([{
    id: "baseline-food", name: "Baseline", aliases: ["baseline"], cat: "dish",
    per100: { kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 20, k: 40 }, units: {},
    logAs: "grams", countLabel: null, batch: null,
    recipe: { ingredients: [], prep: "", notes: "" }, confidence: "high", sd: 0.1,
    version: 1, history: [], raw: "", createdAt: 1, updatedAt: 1, lastUsedAt: 0,
    useCount: 0, source: "personal",
  }]));
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300, potassium: 3400 },
    goalsUpdatedAt: 1, weights: {}, weightUnit: "lb", theme: "light", imperial: false,
    phases: [], profile: {}, dayGoals: {}, dayPlans: {}, gapDrafts: {},
  }));
  window.localStorage.setItem("nd_onboarded_v1", "1");

  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  await bootApp(window);
  const $ = (s) => window.document.querySelector(s);
  const Ledger = window.eval("Ledger");
  const Phases = window.eval("Phases");
  const App = window.eval("App");
  const Sync = window.eval("Sync");
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const currentBackup = () => ({
    version: 3,
    events: clone(Ledger.allEvents()),
    personalFoods: clone(App.state.personalFoods),
    settings: clone(App.state.settings),
  });
  const storageSnapshot = () => ({
    events: window.localStorage.getItem("nd_events_v1"),
    foods: window.localStorage.getItem("nd_personal_v1"),
    settings: window.localStorage.getItem("nd_settings_v1"),
    reset: window.localStorage.getItem("nd_reset_at"),
    onboarded: window.localStorage.getItem("nd_onboarded_v1"),
    signinSeen: window.localStorage.getItem("nd_signin_banner_seen"),
    reconnectHide: window.localStorage.getItem("nd_reconnect_hide_day"),
    firstSeen: window.localStorage.getItem("nd_first_seen_at"),
  });
  const memorySnapshot = () => JSON.stringify({
    events: Ledger.allEvents(),
    settings: App.state.settings,
    personalFoods: App.state.personalFoods,
    gapSelected: App.state.gapSelected,
    gapPendingItemId: App.state.gapPendingItemId,
    gapPendingDay: App.state.gapPendingDay,
    gapPendingEditOnly: App.state.gapPendingEditOnly,
    gapParsed: App.state.gapParsed,
    gapStep: App.state.gapStep,
    pickFood: App.state.pickFood,
    editEntryId: App.state.editEntryId,
    editEntryDay: App.state.editEntryDay,
    pendingCatalogFood: App.state.pendingCatalogFood,
    viewDay: App.state.viewDay,
    insightDays: App.state.insightDays,
    insightNutrient: App.state.insightNutrient,
  });

  // Reset commits use four durable core writes; Start fresh also updates four
  // onboarding/banner keys. Fail each write once and let production rollback
  // prove that no test-side repair is required.
  window.localStorage.setItem("nd_signin_banner_seen", "1");
  window.localStorage.setItem("nd_reconnect_hide_day", today);
  const storageProto = window.Storage.prototype;
  const originalSetItem = storageProto.setItem;
  const originalRemoveItem = storageProto.removeItem;
  const originalFullSync = Sync.fullSync;

  // Every ordinary detached settings commit passes through the outbound
  // canonical guard. Corrupt live state must fail before even the first write,
  // while preserving that exact pre-attempt state for explicit recovery.
  const priorStagedPlan = App.state.settings.dayPlans[today]
    ? clone(App.state.settings.dayPlans[today]) : undefined;
  App.state.settings.dayPlans[today] = {
    updatedAt: Date.now(), optionLabel: "Invalid staged projection", items: [],
    projected: {
      kcal: 1e9 + 1, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0,
    },
  };
  const beforeStagedStorage = JSON.stringify(storageSnapshot());
  const beforeStagedMemory = memorySnapshot();
  const originalStagedSchedulePush = Sync.schedulePush;
  let stagedWrites = 0;
  let stagedSyncCalls = 0;
  storageProto.setItem = function (key, value) {
    stagedWrites += 1;
    return originalSetItem.call(this, key, value);
  };
  Sync.schedulePush = () => { stagedSyncCalls += 1; };
  $("#theme-seg [data-theme-opt='dark']").click();
  storageProto.setItem = originalSetItem;
  Sync.schedulePush = originalStagedSchedulePush;
  ok(stagedWrites === 0 && stagedSyncCalls === 0 &&
      JSON.stringify(storageSnapshot()) === beforeStagedStorage && memorySnapshot() === beforeStagedMemory,
    "ordinary settings commit rejects an outbound-invalid staged plan with exact state/storage and zero writes or sync");
  if (priorStagedPlan === undefined) delete App.state.settings.dayPlans[today];
  else App.state.settings.dayPlans[today] = priorStagedPlan;

  let resetSyncCalls = 0;
  Sync.fullSync = () => { resetSyncCalls += 1; return Promise.resolve({ ok: true }); };
  const exerciseResetFailures = (selector, writeCount, failurePattern) => {
    let exactRollback = true;
    let surfaced = true;
    for (let failAt = 1; failAt <= writeCount; failAt++) {
      const beforeStorage = JSON.stringify(storageSnapshot());
      const beforeMemory = memorySnapshot();
      let operation = 0;
      let injected = false;
      const maybeFail = () => {
        operation += 1;
        if (!injected && operation === failAt) {
          injected = true;
          throw new window.DOMException("quota", "QuotaExceededError");
        }
      };
      storageProto.setItem = function (key, value) {
        maybeFail();
        return originalSetItem.call(this, key, value);
      };
      storageProto.removeItem = function (key) {
        maybeFail();
        return originalRemoveItem.call(this, key);
      };
      try {
        $(selector).click();
      } finally {
        storageProto.setItem = originalSetItem;
        storageProto.removeItem = originalRemoveItem;
      }
      exactRollback = exactRollback && injected
        && JSON.stringify(storageSnapshot()) === beforeStorage
        && memorySnapshot() === beforeMemory;
      surfaced = surfaced && failurePattern.test($("#toast").textContent);
    }
    return { exactRollback, surfaced };
  };
  const clearFailures = exerciseResetFailures("#btn-clear", 4, /Clear failed.*unchanged/i);
  ok(clearFailures.exactRollback,
    "Clear logs rolls raw events, foods, settings, reset, and live state back at every write failure");
  ok(clearFailures.surfaced, "Clear logs reports failure without a success message");
  const factoryFailures = exerciseResetFailures("#btn-factory-reset", 8, /Start fresh failed.*unchanged/i);
  ok(factoryFailures.exactRollback,
    "Start fresh rolls every core and onboarding write plus live state back at every failure");
  ok(factoryFailures.surfaced, "Start fresh reports failure without a success message");
  ok(resetSyncCalls === 0, "failed clear/reset attempts schedule zero Drive syncs");
  Sync.fullSync = originalFullSync;

  // A food recipe edit can append one or more ledger amendments. If the food
  // write then fails, both stores and both in-memory models must roll back.
  const foodsTab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "foods");
  foodsTab.click();
  await new Promise((r) => setTimeout(r, 20));
  $("#foods-list [data-id='baseline-food']").click();
  $("#detail-body [data-action='edit-food']").click();
  $("#rev-kcal").value = "175";
  $("#rev-kcal").dispatchEvent(new window.Event("input", { bubbles: true }));
  const beforeFoodEdit = JSON.stringify({
    eventsRaw: window.localStorage.getItem("nd_events_v1"),
    foodsRaw: window.localStorage.getItem("nd_personal_v1"),
    events: Ledger.allEvents(),
    foods: App.state.personalFoods,
  });
  let foodSyncCalls = 0;
  const originalSchedulePush = Sync.schedulePush;
  Sync.schedulePush = () => { foodSyncCalls += 1; };
  let failFoodEditOnce = true;
  storageProto.setItem = function (key, value) {
    if (failFoodEditOnce && key === "nd_personal_v1") {
      failFoodEditOnce = false;
      throw new window.DOMException("quota", "QuotaExceededError");
    }
    return originalSetItem.call(this, key, value);
  };
  try {
    $("#btn-review-save").click();
  } finally {
    storageProto.setItem = originalSetItem;
    Sync.schedulePush = originalSchedulePush;
  }
  const afterFoodEdit = JSON.stringify({
    eventsRaw: window.localStorage.getItem("nd_events_v1"),
    foodsRaw: window.localStorage.getItem("nd_personal_v1"),
    events: Ledger.allEvents(),
    foods: App.state.personalFoods,
  });
  ok(failFoodEditOnce === false && afterFoodEdit === beforeFoodEdit,
    "failed food edit rolls linked ledger amendments and food state back exactly");
  ok(foodSyncCalls === 0 && /nothing changed/i.test($("#toast").textContent) && !/Food updated/.test($("#toast").textContent),
    "failed food edit emits no success or sync signal");
  $("#sheet-paste [data-close='sheet-paste']").click();
  await new Promise((r) => setTimeout(r, 220));

  // Catalog promotion and its first log are one cross-store transaction.
  const todayTab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today");
  todayTab.click();
  $("#fab-add").click();
  const catalogPick = $("#pick-list [data-action='pick-catalog']");
  ok(!!catalogPick, "catalog fixture is available for atomic promotion test");
  catalogPick.click();
  $("#btn-pick-multi-continue").click();
  const beforePromotion = JSON.stringify({
    eventsRaw: window.localStorage.getItem("nd_events_v1"),
    foodsRaw: window.localStorage.getItem("nd_personal_v1"),
    events: Ledger.allEvents(),
    foods: App.state.personalFoods,
  });
  let promotionSyncCalls = 0;
  Sync.schedulePush = () => { promotionSyncCalls += 1; };
  let failPromotionOnce = true;
  storageProto.setItem = function (key, value) {
    if (failPromotionOnce && key === "nd_personal_v1") {
      failPromotionOnce = false;
      throw new window.DOMException("quota", "QuotaExceededError");
    }
    return originalSetItem.call(this, key, value);
  };
  try {
    $("#multi-qty-save").click();
  } finally {
    storageProto.setItem = originalSetItem;
    Sync.schedulePush = originalSchedulePush;
  }
  const afterPromotion = JSON.stringify({
    eventsRaw: window.localStorage.getItem("nd_events_v1"),
    foodsRaw: window.localStorage.getItem("nd_personal_v1"),
    events: Ledger.allEvents(),
    foods: App.state.personalFoods,
  });
  ok(failPromotionOnce === false && afterPromotion === beforePromotion,
    "failed catalog log rolls both the new event and promoted food back exactly");
  ok(promotionSyncCalls === 0 && /nothing changed/i.test($("#toast").textContent) && !/^Logged$/.test($("#toast").textContent.trim()),
    "failed catalog log emits no success or sync signal");
  $("#multi-qty-cancel").click();
  await new Promise((r) => setTimeout(r, 220));

  const installPendingGap = (itemId) => {
    App.state.settings.dayPlans[today] = {
      updatedAt: 500,
      optionLabel: "Atomic fixture",
      note: "Must commit together",
      items: [{
        id: itemId, foodId: "baseline-food", name: "Baseline", qty: 100,
        grams: 100, unit: "g", meal: "snack", status: "pending", loggedEntryId: null,
      }],
    };
    App.state.settings.gapDrafts[today] = {
      selected: [{ foodId: "baseline-food", catalogId: null, name: "Baseline" }],
      step: "plan", updatedAt: 499,
    };
    originalSetItem.call(window.localStorage, "nd_settings_v1", JSON.stringify(App.state.settings));
  };
  // writeCount: plan-edit uses commitGapPlanAndFoods (foods+settings = 2);
  // diary amend + gapPending uses commitGapEntryChange (events+foods+settings = 3).
  const exerciseGapWriteFailures = (writeCount = 3) => {
    let exactRollback = true;
    let pendingPreserved = true;
    let surfaced = true;
    for (let failAt = 1; failAt <= writeCount; failAt++) {
      const beforeStorage = JSON.stringify(storageSnapshot());
      const beforeMemory = memorySnapshot();
      let write = 0;
      let injected = false;
      storageProto.setItem = function (key, value) {
        write += 1;
        if (!injected && write === failAt) {
          injected = true;
          throw new window.DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      };
      try { $("#qty-save").click(); }
      finally { storageProto.setItem = originalSetItem; }
      const plan = App.state.settings.dayPlans[today];
      const pending = plan && plan.items && plan.items[0];
      exactRollback = exactRollback && injected &&
        JSON.stringify(storageSnapshot()) === beforeStorage && memorySnapshot() === beforeMemory;
      pendingPreserved = pendingPreserved && pending && pending.status === "pending" &&
        App.state.settings.gapDrafts[today] && App.state.gapPendingItemId === pending.id;
      surfaced = surfaced && /plan item.*nothing changed|GAP item.*nothing changed/i.test($("#toast").textContent) &&
        !/^Logged$/.test($("#toast").textContent.trim()) &&
        !/^Updated plan$/.test($("#toast").textContent.trim());
    }
    return { exactRollback, pendingPreserved, surfaced };
  };

  // Edit opens qty to adjust a pending plan row only (does not log). Fail each
  // durable write and require exact rollback with the item still pending.
  installPendingGap("gap-new-atomic");
  $("#btn-gap-plan").click();
  // Edit lives in the expanded row actions (one-tap + is always on the row).
  $("#gap-plan-list [data-action='toggle-gap-item']").click();
  $("#gap-plan-list [data-action='edit-gap-item']").click();
  ok(!$("#sheet-qty").hidden && App.state.gapPendingItemId === "gap-new-atomic" &&
      App.state.gapPendingEditOnly === true && /Save to plan/i.test($("#qty-save").textContent),
    "Edit on a pending GAP item opens qty in plan-edit mode");
  let gapSyncCalls = 0;
  Sync.schedulePush = () => { gapSyncCalls += 1; };
  const failedGapAdd = exerciseGapWriteFailures(2);
  ok(failedGapAdd.exactRollback && failedGapAdd.pendingPreserved,
    "failed GAP plan edit rolls ledger, foods, plan, draft, and pending memory back at every write");
  ok(failedGapAdd.surfaced && gapSyncCalls === 0,
    "failed GAP plan edit reports no success and schedules no sync");
  // Successful Edit saves to the plan without logging.
  const eventsBeforePlanEdit = Ledger.allEvents().length;
  $("#qty-input").value = "150";
  $("#qty-input").dispatchEvent(new window.Event("input", { bubbles: true }));
  $("#qty-save").click();
  await new Promise((r) => setTimeout(r, 30));
  {
    const plan = App.state.settings.dayPlans[today];
    const pending = plan && plan.items && plan.items[0];
    ok(pending && pending.status === "pending" && Number(pending.qty) === 150 &&
        Number(pending.grams) === 150,
      "Edit → Save to plan updates qty and keeps the item pending");
    ok(Ledger.allEvents().length === eventsBeforePlanEdit,
      "Edit → Save to plan does not append a diary log");
    ok(/Updated plan/i.test($("#toast").textContent), "plan edit toasts Updated plan");
  }
  gapSyncCalls = 0;
  try { $("#btn-gap-plan-close").click(); } catch (_) {}
  await new Promise((r) => setTimeout(r, 100));

  // One-tap Log on a pending item uses the same commitGapEntryChange transaction
  // without opening qty — fail each durable write and require exact rollback.
  installPendingGap("gap-log-now-atomic");
  $("#btn-gap-plan").click();
  {
    let exactRollback = true;
    let pendingPreserved = true;
    let surfaced = true;
    for (let failAt = 1; failAt <= 3; failAt++) {
      const beforeStorage = JSON.stringify(storageSnapshot());
      const beforeMemory = memorySnapshot();
      let write = 0;
      let injected = false;
      storageProto.setItem = function (key, value) {
        write += 1;
        if (!injected && write === failAt) {
          injected = true;
          throw new window.DOMException("quota", "QuotaExceededError");
        }
        return originalSetItem.call(this, key, value);
      };
      try { $("#gap-plan-list [data-action='log-gap-item']").click(); }
      finally { storageProto.setItem = originalSetItem; }
      const plan = App.state.settings.dayPlans[today];
      const pending = plan && plan.items && plan.items[0];
      exactRollback = exactRollback && injected &&
        JSON.stringify(storageSnapshot()) === beforeStorage && memorySnapshot() === beforeMemory;
      pendingPreserved = pendingPreserved && pending && pending.status === "pending" &&
        App.state.settings.gapDrafts[today];
      surfaced = surfaced && /plan item.*nothing changed|GAP item.*nothing changed/i.test($("#toast").textContent) &&
        !/^Logged$/.test($("#toast").textContent.trim());
    }
    ok(exactRollback && pendingPreserved,
      "failed one-tap GAP log rolls ledger, foods, plan, and draft back at every write");
    ok(surfaced && gapSyncCalls === 0,
      "failed one-tap GAP log reports no success and schedules no sync");
  }

  // The same transaction is used if an existing diary line is amended while
  // satisfying a pending GAP item (edit-only flag stays off).
  installPendingGap("gap-edit-atomic");
  $("#day-log [data-action='toggle-entry'][data-id='baseline-entry']").click();
  $("#day-log [data-action='edit-entry'][data-id='baseline-entry']").click();
  App.state.gapPendingItemId = "gap-edit-atomic";
  App.state.gapPendingDay = today;
  App.state.gapPendingEditOnly = false;
  const failedGapEdit = exerciseGapWriteFailures();
  ok(failedGapEdit.exactRollback && failedGapEdit.pendingPreserved,
    "failed GAP edit rolls ledger, foods, plan, draft, and pending memory back at every write");
  ok(failedGapEdit.surfaced && gapSyncCalls === 0,
    "failed GAP edit reports no success and schedules no sync");
  $("#qty-cancel").click();
  await new Promise((r) => setTimeout(r, 220));

  // Clear writes one settings candidate containing both the plan tombstone and
  // draft deletion. A failed write leaves the open plan and all state intact.
  $("#btn-gap-plan").click();
  const beforeGapClearStorage = JSON.stringify(storageSnapshot());
  const beforeGapClearMemory = memorySnapshot();
  let failGapClearOnce = true;
  storageProto.setItem = function (key, value) {
    if (failGapClearOnce && key === "nd_settings_v1") {
      failGapClearOnce = false;
      throw new window.DOMException("quota", "QuotaExceededError");
    }
    return originalSetItem.call(this, key, value);
  };
  try { $("#btn-gap-clear-plan").click(); }
  finally { storageProto.setItem = originalSetItem; }
  ok(!failGapClearOnce && JSON.stringify(storageSnapshot()) === beforeGapClearStorage &&
      memorySnapshot() === beforeGapClearMemory && App.state.settings.gapDrafts[today],
    "failed GAP clear preserves the plan, tombstone state, draft, and memory exactly");
  ok(gapSyncCalls === 0 && /nothing changed/i.test($("#toast").textContent),
    "failed GAP clear reports no success and schedules no sync");
  let clearSettingsWrites = 0;
  storageProto.setItem = function (key, value) {
    if (key === "nd_settings_v1") clearSettingsWrites += 1;
    return originalSetItem.call(this, key, value);
  };
  try { $("#btn-gap-clear-plan").click(); }
  finally {
    storageProto.setItem = originalSetItem;
    Sync.schedulePush = originalSchedulePush;
  }
  ok(clearSettingsWrites === 1 && App.state.settings.dayPlans[today].cleared === true &&
      !App.state.settings.gapDrafts[today],
    "GAP clear commits its plan tombstone and draft deletion in one settings write");

  // Trusted diary producers must reject values that their own import/Drive
  // normalizer would reject, before any event or sync signal exists.
  const producerDay = "2020-01-02";
  App.state.viewDay = producerDay;
  $("#fab-add").click();
  $("#btn-once-food").click();
  $("#once-name").value = "Q".repeat(161);
  $("#once-kcal").value = "1000000001";
  $("#once-qty").value = "1";
  // Macros closed → calories-only (source:quick) producer path.
  if ($("#once-macros")) $("#once-macros").open = false;
  const beforeQuickReject = window.localStorage.getItem("nd_events_v1");
  let producerRejectSyncs = 0;
  Sync.schedulePush = () => { producerRejectSyncs += 1; };
  $("#once-save").click();
  ok(window.localStorage.getItem("nd_events_v1") === beforeQuickReject && producerRejectSyncs === 0 &&
      !$("#sheet-once").hidden,
    "overbound quick-kcal name and amount cause no event, UI close, or sync");
  $("#once-name").value = "Q".repeat(160);
  $("#once-kcal").value = "1000000000";
  Sync.schedulePush = originalSchedulePush;
  $("#once-save").click();
  const quickBoundary = Ledger.entriesFor(producerDay).find((entry) => entry.source === "quick");
  ok(quickBoundary && quickBoundary.name.length === 160 && quickBoundary.qty === 1e9 &&
      quickBoundary.unit === "kcal" && quickBoundary.macros.kcal === 1e9,
    "quick-kcal accepts the exact producer/import name and numeric boundaries");

  $("#fab-add").click();
  $("#pick-list [data-action='pick-food'][data-id='baseline-food']").click();
  $("#btn-pick-multi-continue").click();
  const diaryRow = $("#multi-qty-list .multi-qty-row");
  diaryRow.querySelector("[data-multi-units] [data-unit='g']").click();
  diaryRow.querySelector("[data-multi-qty]").value = "1000000001";
  const beforeDiaryReject = window.localStorage.getItem("nd_events_v1");
  producerRejectSyncs = 0;
  Sync.schedulePush = () => { producerRejectSyncs += 1; };
  $("#multi-qty-save").click();
  ok(window.localStorage.getItem("nd_events_v1") === beforeDiaryReject && producerRejectSyncs === 0 &&
      !$("#sheet-multi-qty").hidden,
    "overbound diary grams, quantity, and derived macros cause no event, UI close, or sync");
  diaryRow.querySelector("[data-multi-qty]").value = "1000000000";
  Sync.schedulePush = originalSchedulePush;
  $("#multi-qty-save").click();
  const diaryBoundary = Ledger.entriesFor(producerDay).find((entry) => entry.source !== "quick");
  ok(diaryBoundary && diaryBoundary.grams === 1e9 && diaryBoundary.qty === 1e9 &&
      diaryBoundary.macros.kcal === 1e9,
    "diary quantity accepts the exact producer/import numeric boundary");
  $("#day-label").click();

  // Food-detail batch scaling is another trusted producer. Reject each
  // canonical limit + 1 before any write, mutation, or sync; accept the exact
  // same maxima that import and Drive accept.
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "foods").click();
  await new Promise((r) => setTimeout(r, 20));
  $("#foods-list [data-id='baseline-food']").click();
  await new Promise((r) => setTimeout(r, 20));
  const beforeBatchFoodRaw = window.localStorage.getItem("nd_personal_v1");
  const beforeBatchFoodMemory = JSON.stringify(App.state.personalFoods);
  const originalPrompt = window.prompt;
  let batchWrites = 0;
  let batchSyncCalls = 0;
  storageProto.setItem = function (key, value) {
    if (key === "nd_personal_v1") batchWrites += 1;
    return originalSetItem.call(this, key, value);
  };
  Sync.schedulePush = () => { batchSyncCalls += 1; };
  const submitBatch = (answers) => {
    const queue = answers.slice();
    window.prompt = () => queue.shift();
    $("#detail-body [data-action='scale-batch']").click();
  };
  try {
    submitBatch(["1000000001"]);
    submitBatch(["1000000000", "10000001"]);
  } finally {
    window.prompt = originalPrompt;
  }
  ok(batchWrites === 0 && batchSyncCalls === 0 &&
      window.localStorage.getItem("nd_personal_v1") === beforeBatchFoodRaw &&
      JSON.stringify(App.state.personalFoods) === beforeBatchFoodMemory,
    "food-detail batch rejects grams/servings limit + 1 with zero mutation, write, or sync");
  try {
    submitBatch(["1000000000", "10000000"]);
  } finally {
    window.prompt = originalPrompt;
    storageProto.setItem = originalSetItem;
    Sync.schedulePush = originalSchedulePush;
  }
  const boundaryBatchFood = App.state.personalFoods.find((food) => food.id === "baseline-food");
  const storedBoundaryBatchFood = JSON.parse(window.localStorage.getItem("nd_personal_v1"))
    .find((food) => food.id === "baseline-food");
  ok(batchWrites === 1 && batchSyncCalls === 1 && boundaryBatchFood && storedBoundaryBatchFood &&
      boundaryBatchFood.batch.grams === 1e9 && boundaryBatchFood.batch.servings === 1e7 &&
      storedBoundaryBatchFood.batch.grams === 1e9 && storedBoundaryBatchFood.batch.servings === 1e7,
    "food-detail batch accepts and persists exact 1e9 gram / 1e7 serving boundaries");
  $("#sheet-detail [data-close='sheet-detail']").click();
  await new Promise((r) => setTimeout(r, 220));

  // Manual-food boundaries are validated on the raw form, so invalid values
  // cannot be silently dropped or truncated into a different saved food.
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "foods").click();
  $("#btn-add-food").click();
  $("#btn-manual-food").click();
  const foodsBeforeManualReject = window.localStorage.getItem("nd_personal_v1");
  App.state.reviewParsed.food.raw = "R".repeat(12001);
  $("#rev-name").value = "M".repeat(161);
  $("#rev-aliases").value = Array.from({ length: 51 }, (_, i) => `alias-${i}`).join(",");
  $("#rev-ingredients").value = "I".repeat(501);
  $("#rev-prep").value = "P".repeat(5001);
  $("#rev-notes").value = "N".repeat(5001);
  $("#rev-serving").value = "1000000001";
  $("#rev-batch-g").value = "1000000001";
  $("#rev-batch-s").value = "10000001";
  $("#rev-na").value = "1000000001";
  $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
  $("#btn-review-save").click();
  ok($("#btn-review-save").disabled &&
      window.localStorage.getItem("nd_personal_v1") === foodsBeforeManualReject &&
      /160 characters|50 aliases|500 characters|5,000|12,000|supported range/i.test($("#review-errors").textContent),
    "overbound manual-food fields are rejected without truncation or durable mutation");

  const boundaryAliases = Array.from({ length: 50 }, (_, i) =>
    (`alias-${i}-` + "a".repeat(160)).slice(0, 160));
  App.state.reviewParsed.food.raw = "R".repeat(12000);
  $("#rev-name").value = "M".repeat(160);
  $("#rev-aliases").value = boundaryAliases.join(",");
  $("#rev-ingredients").value = "I".repeat(500);
  $("#rev-prep").value = "P".repeat(5000);
  $("#rev-notes").value = "N".repeat(5000);
  $("#rev-log-as [data-log-as='piece']").click();
  $("#rev-count-as").value = "c".repeat(32);
  $("#rev-piece").value = "1000000000";
  $("#rev-serving").value = "1000000000";
  $("#rev-batch-g").value = "1000000000";
  $("#rev-batch-s").value = "10000000";
  $("#rev-kcal").value = "0";
  $("#rev-p").value = "0";
  $("#rev-c").value = "0";
  $("#rev-f").value = "0";
  $("#rev-fb").value = "0";
  // Sodium/potassium are capped by physical plausibility (40000/60000 mg per
  // 100 g), not the generic 1e9 producer/import ceiling used by other numeric
  // fields, so their boundary values here are the plausibility ceiling.
  $("#rev-na").value = "40000";
  $("#rev-k").value = "60000";
  $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
  ok(!$("#btn-review-save").disabled, "manual-food form accepts every exact producer/import boundary");
  $("#btn-review-save").click();
  const manualBoundary = App.state.personalFoods.find((food) => food.name === "M".repeat(160));
  ok(manualBoundary && manualBoundary.aliases.length === 50 && manualBoundary.aliases.every((alias) => alias.length === 160) &&
      manualBoundary.recipe.ingredients[0].text.length === 500 && manualBoundary.recipe.prep.length === 5000 &&
      manualBoundary.recipe.notes.length === 5000 && manualBoundary.raw.length === 12000 &&
      manualBoundary.units.serving === 1e9 && manualBoundary.units.piece === 1e9 &&
      manualBoundary.batch.grams === 1e9 && manualBoundary.batch.servings === 1e7 &&
      manualBoundary.countLabel.length === 32 && manualBoundary.per100.na === 40000 && manualBoundary.per100.k === 60000,
    "manual-food producer stores exact text, unit, batch, and nutrient boundaries intact");
  $("#sheet-detail [data-close='sheet-detail']").click();
  await new Promise((r) => setTimeout(r, 220));
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();

  const beforeMalformed = storageSnapshot();
  const malformed = currentBackup();
  malformed.settings.phases[0].revisions[0].goals.kcal = "<img id=bad-number>";
  await importBackup(window, malformed);
  ok(/Import failed/i.test($("#toast").textContent), "malformed nested phase data is rejected");
  ok(JSON.stringify(storageSnapshot()) === JSON.stringify(beforeMalformed),
    "malformed backup leaves ledger, foods, settings, and reset marker untouched");

  // Event history is validated as a detached state machine before any import
  // write. Error text must identify the broken transition so a damaged backup
  // is diagnosable instead of merely disappearing behind "invalid data".
  const eventFixtureBackup = currentBackup();
  const baseImportedEntry = clone(eventFixtureBackup.events[0].entry);
  const importedEntry = (id, name) => ({
    ...clone(baseImportedEntry),
    id,
    name: name || id,
  });
  const causal = (entryId, seq, parentEventId) => ({ entryId, seq, parentEventId });
  const eventBackup = (events) => ({ ...clone(eventFixtureBackup), events });
  const rejectEventImport = async (events, condition, label) => {
    const beforeStorage = JSON.stringify(storageSnapshot());
    const beforeMemory = memorySnapshot();
    await importBackup(window, eventBackup(events));
    const message = $("#toast").textContent;
    ok(/^Import failed:/i.test(message) && condition.test(message), `${label} is identified clearly`);
    ok(JSON.stringify(storageSnapshot()) === beforeStorage && memorySnapshot() === beforeMemory,
      `${label} is rejected before storage or live state changes`);
  };

  await rejectEventImport([
    { id: "duplicate-event", ts: 1, day: today, type: "add", entry: importedEntry("dup-entry-a"), causal: causal("dup-entry-a", 0, null) },
    { id: "duplicate-event", ts: 2, day: today, type: "add", entry: importedEntry("dup-entry-b"), causal: causal("dup-entry-b", 0, null) },
  ], /duplicate event/i, "duplicate event IDs");

  await rejectEventImport([
    { id: "orphan-amend", ts: 1, day: today, type: "amend", target: "missing-entry", patch: { grams: 120 }, causal: causal("missing-entry", 1, "missing-add") },
  ], /orphan|missing (?:target|parent)|parent.*not found/i, "orphan amendments");

  await rejectEventImport([
    { id: "orphan-remove", ts: 1, day: today, type: "remove", target: "missing-remove-entry", causal: causal("missing-remove-entry", 1, "missing-remove-add") },
  ], /orphan|missing (?:target|parent)|parent.*not found/i, "orphan removals");

  const otherDay = today === "2000-01-01" ? "2000-01-02" : "2000-01-01";
  await rejectEventImport([
    { id: "cross-add", ts: 1, day: today, type: "add", entry: importedEntry("cross-entry"), causal: causal("cross-entry", 0, null) },
    { id: "cross-amend", ts: 2, day: otherDay, type: "amend", target: "cross-entry", patch: { grams: 130 }, causal: causal("cross-entry", 1, "cross-add") },
  ], /cross.day|different day|more than one day/i, "cross-day targets");

  await rejectEventImport([
    { id: "live-add", ts: 1, day: today, type: "add", entry: importedEntry("live-entry"), causal: causal("live-entry", 0, null) },
    { id: "live-add-again", ts: 2, day: today, type: "add", entry: importedEntry("live-entry", "duplicate"), causal: causal("live-entry", 1, "live-add") },
  ], /duplicate.*live|already live|add.*live/i, "duplicate live entry adds");

  await rejectEventImport([
    { id: "twice-add", ts: 1, day: today, type: "add", entry: importedEntry("twice-entry"), causal: causal("twice-entry", 0, null) },
    { id: "twice-remove", ts: 2, day: today, type: "remove", target: "twice-entry", causal: causal("twice-entry", 1, "twice-add") },
    { id: "twice-remove-again", ts: 3, day: today, type: "remove", target: "twice-entry", causal: causal("twice-entry", 2, "twice-remove") },
  ], /remove.*(?:removed|invalid)|invalid.*remove/i, "removing an already removed entry");

  await rejectEventImport([
    { id: "removed-add", ts: 1, day: today, type: "add", entry: importedEntry("removed-entry"), causal: causal("removed-entry", 0, null) },
    { id: "removed-remove", ts: 2, day: today, type: "remove", target: "removed-entry", causal: causal("removed-entry", 1, "removed-add") },
    { id: "removed-amend", ts: 3, day: today, type: "amend", target: "removed-entry", patch: { grams: 140 }, causal: causal("removed-entry", 2, "removed-remove") },
  ], /amend.*(?:removed|invalid)|invalid.*amend/i, "amending a removed entry");

  // A real Undo is a new add in the same entry's chain. Reverse the array and
  // skew every timestamp to prove validation/replay follows causal metadata.
  const validRestore = eventBackup([
    { id: "restore-add", ts: 1, day: today, type: "add", entry: importedEntry("restore-entry", "Restored"), causal: causal("restore-entry", 2, "restore-remove") },
    { id: "restore-remove", ts: 10, day: today, type: "remove", target: "restore-entry", causal: causal("restore-entry", 1, "restore-original") },
    { id: "restore-original", ts: 100, day: today, type: "add", entry: importedEntry("restore-entry", "Original"), causal: causal("restore-entry", 0, null) },
  ]);
  await importBackup(window, validRestore);
  const restored = Ledger.entriesFor(today);
  ok(/^Imported$/.test($("#toast").textContent.trim()) && restored.length === 1 && restored[0].name === "Restored",
    "a causally valid re-add after removal imports and restores the entry despite skewed clocks");
  ok(Ledger.allEvents().every((event) => event.causal && Number.isInteger(event.causal.seq)),
    "import normalization preserves explicit causal metadata");
  await importBackup(window, eventFixtureBackup);
  ok(/^Imported$/.test($("#toast").textContent.trim()) && Ledger.entriesFor(today).some((entry) => entry.name === "Baseline"),
    "legacy event history remains import-compatible after causal validation");

  // Exercise rollback after persistence has started, not just detached validation.
  const beforeWriteFailure = storageSnapshot();
  const validForWriteFailure = currentBackup();
  let failPersonalOnce = true;
  storageProto.setItem = function (key, value) {
    if (failPersonalOnce && key === "nd_personal_v1") {
      failPersonalOnce = false;
      throw new window.DOMException("quota", "QuotaExceededError");
    }
    return originalSetItem.call(this, key, value);
  };
  try {
    await importBackup(window, validForWriteFailure);
  } finally {
    storageProto.setItem = originalSetItem;
  }
  ok(/Import failed/i.test($("#toast").textContent), "mid-commit storage failure is surfaced");
  ok(JSON.stringify(storageSnapshot()) === JSON.stringify(beforeWriteFailure),
    "mid-commit storage failure rolls every import key back");
  ok(Ledger.entriesFor(today).some((entry) => entry.name === "Baseline"), "rollback also restores the in-memory ledger cache");

  const policyRestoreBackup = currentBackup();
  const policyValidGoals = {
    kcal: 2200, protein: 140, carbs: 250, fat: 70,
    fiber: 28, sodium: 2300, potassium: 3510,
  };
  const policyLowGoals = { ...policyValidGoals, kcal: 700 };
  const policyMacroGoals = {
    kcal: 2200, protein: 400, carbs: 150, fat: 0,
    fiber: 28, sodium: 2300, potassium: 3510,
  };
  const policyBackup = clone(policyRestoreBackup);
  policyBackup.settings.goals = policyMacroGoals;
  policyBackup.settings.goalsUpdatedAt = 30;
  policyBackup.settings.phases = [{
    id: "import-policy-phase", name: "Maintain v1.2", kind: "maintain",
    versionMajor: 1, versionMinor: 2, startDay: "2020-01-01", endDay: null,
    createdAt: 1, updatedAt: 30, archived: false, revisionTombstones: {}, revisions: [
      { id: "import-policy-valid", effectiveFrom: "2020-01-01", goals: policyValidGoals,
        kind: "maintain", createdAt: 10, updatedAt: 10, version: "1.0", label: "Maintain v1.0" },
      { id: "import-policy-low", effectiveFrom: "2021-01-01", goals: policyLowGoals,
        kind: "maintain", createdAt: 20, updatedAt: 20, version: "1.1", label: "Maintain v1.1" },
      { id: "import-policy-macro", effectiveFrom: "2022-01-01", goals: policyMacroGoals,
        kind: "maintain", createdAt: 30, updatedAt: 30, version: "1.2", label: "Maintain v1.2" },
    ],
  }];
  await importBackup(window, policyBackup);
  const policyImported = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  const policyImportedPhase = policyImported.phases[0];
  ok(/^Imported$/.test($("#toast").textContent.trim()) &&
      policyImported.goals.kcal === policyValidGoals.kcal && policyImported.goals.protein === policyValidGoals.protein &&
      policyImportedPhase.revisions.find((revision) => revision.id === "import-policy-low").auditOnly === true &&
      policyImportedPhase.revisions.find((revision) => revision.id === "import-policy-macro").auditOnly === true,
    "backup import preserves unsafe target versions as audit-only and activates the preceding valid target");
  ok(policyImported.targetReview && policyImported.targetReview.fallback === "preceding-valid" &&
      /Review your nutrition targets/i.test($("#info-banner").textContent) &&
      Phases.goalsForDay(today, policyImported).protein === policyValidGoals.protein,
    "backup target quarantine shows persistent review UX and cannot feed current scoring");
  $("#banner-settings").click();
  $("#btn-phase-history").click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  ok(/nearest earlier valid/i.test($("#target-review-warning").textContent) &&
      $("#phase-revision-list [data-rev-id='import-policy-macro'] .rev-badge").textContent.trim() === "audit only" &&
      /protein.*40%|fat.*20/i.test($("#phase-revision-list [data-rev-id='import-policy-macro']").textContent),
    "Settings and target history explain the audit-only imported revision and active fallback");

  const invalidOnlyBackup = clone(policyBackup);
  invalidOnlyBackup.settings.goals = policyLowGoals;
  invalidOnlyBackup.settings.goalsUpdatedAt = 20;
  invalidOnlyBackup.settings.phases[0].revisions = invalidOnlyBackup.settings.phases[0].revisions
    .filter((revision) => revision.id !== "import-policy-valid");
  await importBackup(window, invalidOnlyBackup);
  const invalidOnlyImported = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  ok(invalidOnlyImported.goals.kcal === Phases.DEFAULT_GOALS.kcal &&
      invalidOnlyImported.phases[0].revisions.every((revision) => revision.auditOnly === true) &&
      invalidOnlyImported.targetReview && invalidOnlyImported.targetReview.fallback === "generic-default" &&
      /generic default/i.test($("#info-banner").textContent),
    "invalid-only backup history uses deterministic generic recovery targets with explicit review UX");
  await importBackup(window, policyRestoreBackup);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "backup target-policy smoke fixture restores the prior state for later import checks");

  const valid = currentBackup();
  valid.version = 2;
  valid.events = valid.events.filter((event) => event.day === producerDay);
  valid.personalFoods = [{
    id: "markup-food",
    name: '<img id="food-xss" src=x onerror="window.__foodXss=1">',
    aliases: ["markup"], cat: "dish",
    // v2 backups predate potassium. Missing K must remain valid and unknown.
    per100: { kcal: "120", p: "4", c: "20", f: "3", fb: "2", na: "50" },
    units: { serving: "100" }, logAs: "grams", countLabel: null,
    batch: { grams: "200", servings: "2", weighed: true },
    recipe: {
      ingredients: [{ text: '<script id="ingredient-xss">window.__foodXss=2</script>' }],
      prep: '<img id="prep-xss" src=x>', notes: "safe as text",
    },
    confidence: "medium", sd: "0.1", version: "2", history: [], raw: "",
    createdAt: "2", updatedAt: "3", lastUsedAt: "4", useCount: "7", source: "personal",
  }, clone(manualBoundary)];
  valid.settings.dayGoals = {
    [today]: { kcal: 2500, protein: 999, sodium: 0, potassium: 9999, updatedAt: 5 },
  };
  valid.settings.theme = "dark";
  valid.settings.profile = {
    dob: "1990-01-02", sex: "male", heightCm: 180, activity: "moderate", notes: "imported", updatedAt: 6,
  };
  delete valid.settings.goals.potassium;
  for (const phase of valid.settings.phases || []) {
    for (const revision of phase.revisions || []) delete revision.goals.potassium;
  }
  await importBackup(window, valid);
  ok(/^Imported$/.test($("#toast").textContent.trim()), "valid legacy backup imports after complete validation");
  const importedSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  const importedGoal = importedSettings.dayGoals[today];
  ok(importedGoal && importedGoal.targetKcal === 2500 && importedGoal.baseKcal === 2200 &&
      importedGoal.protein == null && importedGoal.sodium == null && importedGoal.potassium == null,
    "legacy absolute kcal becomes a frozen calories-only adjustment");
  const effective = Phases.goalsForDay(today, importedSettings);
  ok(effective.kcal === 2500 && effective.protein === 150 && effective.sodium === 2300 && effective.potassium === 3510,
    "legacy day override cannot alter protein or electrolyte targets; a missing K target uses the generic adult reference");
  const importedFood = JSON.parse(window.localStorage.getItem("nd_personal_v1"))[0];
  ok(importedFood.useCount === 7 && importedFood.version === 2 && importedFood.batch.servings === 2,
    "food numeric fields are normalized before entering state");
  ok(importedFood.per100.k === null && importedSettings.goals.potassium === 3510,
    "v2 backups with missing potassium remain valid and preserve unknown food coverage");
  ok(window.document.documentElement.getAttribute("data-theme") === "dark"
      && $("#set-dob").value === "1990-01-02" && $("#set-height").value === "180",
    "import immediately refreshes the live theme and Settings form");

  // A day override below 1200 kcal requires the same clinician-supervision
  // acknowledgement the live UI gate enforces; a hand-edited or replayed
  // backup must not be able to bypass it.
  const beforeVlcStorage = storageSnapshot();
  const vlcUnacknowledged = currentBackup();
  vlcUnacknowledged.settings.dayGoals = {
    [today]: { targetKcal: 1000, baseKcal: 2200, updatedAt: 50 },
  };
  await importBackup(window, vlcUnacknowledged);
  ok(/^Import failed:/i.test($("#toast").textContent) && /veryLowCalorieAcknowledged/i.test($("#toast").textContent),
    "a day override below 1200 kcal without acknowledgement is rejected on import");
  ok(JSON.stringify(storageSnapshot()) === JSON.stringify(beforeVlcStorage),
    "rejected very-low-calorie import leaves storage untouched");

  const vlcAcknowledged = currentBackup();
  vlcAcknowledged.settings.dayGoals = {
    [today]: { targetKcal: 1000, baseKcal: 2200, updatedAt: 50, veryLowCalorieAcknowledged: true },
  };
  await importBackup(window, vlcAcknowledged);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "a day override below 1200 kcal WITH acknowledgement is accepted on import");
  const vlcAcceptedSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  ok(vlcAcceptedSettings.dayGoals[today].targetKcal === 1000 &&
      vlcAcceptedSettings.dayGoals[today].veryLowCalorieAcknowledged === true,
    "acknowledged very-low-calorie override persists with its flag");

  const vlcAboveThreshold = currentBackup();
  vlcAboveThreshold.settings.dayGoals = {
    [today]: { targetKcal: 1500, baseKcal: 2200, updatedAt: 50 },
  };
  await importBackup(window, vlcAboveThreshold);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "a day override at 1500 kcal (above the 1200 gate) is accepted without acknowledgement");

  // Part VIII.1's required round-trip: a declared fast must survive real
  // import through the App's own normalizer, and re-exporting what import
  // just wrote must not throw on the way back in. A day well before `today`
  // is used so this fast declaration cannot bleed into the Today HUD
  // assertions later in this same test run.
  const fastDay = "2026-01-15";
  const fastImport = currentBackup();
  fastImport.settings.dayGoals = {
    ...fastImport.settings.dayGoals,
    [fastDay]: {
      targetKcal: 0, baseKcal: 2200, updatedAt: 50, intent: "fast", fastAcknowledged: true,
    },
  };
  await importBackup(window, fastImport);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "a declared fast (targetKcal 0, intent fast, fastAcknowledged) imports through the real App normalizer");
  const fastImportedSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  const fastImportedGoal = fastImportedSettings.dayGoals[fastDay];
  ok(fastImportedGoal && fastImportedGoal.targetKcal === 0 &&
      fastImportedGoal.intent === "fast" && fastImportedGoal.fastAcknowledged === true,
    "the imported fast record keeps its intent and acknowledgement, not just its zero target");
  ok(Phases.goalsForDay(fastDay, fastImportedSettings).kcal === 0,
    "goalsForDay resolves the imported fast day to kcal 0");
  const fastReexport = currentBackup();
  let fastReimportThrew = false;
  try {
    await importBackup(window, fastReexport);
  } catch (_) { fastReimportThrew = true; }
  ok(!fastReimportThrew && /^Imported$/.test($("#toast").textContent.trim()),
    "re-exporting an imported fast day and importing it again does not throw");
  // Clean up: subsequent tests in this run assert on `today`'s HUD assuming
  // an ordinary day, and dayGoals is keyed by day, so this cannot collide.
  const clearFastDay = currentBackup();
  delete clearFastDay.settings.dayGoals[fastDay];
  await importBackup(window, clearFastDay);
  ok(/^Imported$/.test($("#toast").textContent.trim()), "the fast-day fixture is removed before later tests run");

  // Closeout P1: Sync emits targetKcal-less tombstones; the app.js import
  // normalizer must accept them (delete, export→import, and Drive cap eviction
  // all re-enter through this seam).
  window.confirm = () => true;
  const makeImportPreset = (id, lastUsedAt) => ({
    id,
    label: id,
    intent: "reduced",
    targetKcal: 500,
    veryLowCalorieAcknowledged: true,
    createdAt: 1,
    updatedAt: 10,
    lastUsedAt,
  });
  const syncEmittedPresets = Sync.mergeDayPlanPresets(
    [0, 1, 2, 3, 4].map((i) => makeImportPreset(`imp_a_${i}`, i)),
    [0, 1, 2, 3, 4].map((i) => makeImportPreset(`imp_b_${i}`, 10 + i))
  );
  ok(syncEmittedPresets.some((p) => p.deleted === true && p.targetKcal == null),
    "Sync cap eviction emits tombstones without targetKcal (the app.js P1 shape)");
  // Force the generation default the stamp must correct (import maps missing /
  // omitted epochs to 0). Without stampSettingsGenerations rebasing the array,
  // a marked non-zero reset rejects this list as privacy-invalid.
  const syncEmittedAtEpochZero = syncEmittedPresets.map((p) => ({ ...p, resetEpoch: 0 }));
  ok(syncEmittedAtEpochZero.every((p) => p.resetEpoch === 0),
    "fixture presets carry resetEpoch:0 before import (stamp is load-bearing)");
  const presetCapImport = currentBackup();
  presetCapImport.settings.dayPlanPresets = syncEmittedAtEpochZero;
  await importBackup(window, presetCapImport);
  await new Promise((r) => setTimeout(r, 120));
  ok(/^Imported/.test($("#toast").textContent.trim()),
    "app import accepts Sync-emitted preset tombstones without throwing",
    $("#toast").textContent.trim());
  const presetCapStored = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  const presetImportEpoch = Sync.getResetAt();
  ok(presetImportEpoch > 0,
    "preset import runs under a non-zero privacy epoch (not the unmarked zero that hid fix 2)");
  ok(String(window.localStorage.getItem(Sync.GENERATION_SCHEMA_KEY)) === String(Sync.GENERATION_SCHEMA_VERSION),
    "preset import marks the generation schema so validateDocGenerations is live");
  ok((presetCapStored.dayPlanPresets || []).length > 0 &&
      (presetCapStored.dayPlanPresets || []).every((p) => p.resetEpoch === presetImportEpoch),
    "stampSettingsGenerations rebases every imported preset (actives + tombstones) to the live epoch",
    `epoch=${presetImportEpoch} sample=${JSON.stringify((presetCapStored.dayPlanPresets || []).slice(0, 2))}`);
  ok(Sync.activeDayPlanPresets(presetCapStored.dayPlanPresets || []).length === Sync.DAY_PLAN_PRESET_ACTIVE_CAP,
    "imported cap result keeps exactly five active presets",
    `got ${Sync.activeDayPlanPresets(presetCapStored.dayPlanPresets || []).length}`);
  ok((presetCapStored.dayPlanPresets || []).some((p) => p.deleted === true && p.id.startsWith("imp_")),
    "imported cap losers remain as deleted tombstones");
  ok((presetCapStored.dayPlanPresets || []).filter((p) => p.deleted).every((p) => p.resetEpoch === presetImportEpoch),
    "tombstones are rebased alongside actives (validateDocGenerations does not exempt them)");
  await importBackup(window, currentBackup());
  await new Promise((r) => setTimeout(r, 120));
  ok(/^Imported/.test($("#toast").textContent.trim()),
    "export→import round-trip of presets-with-tombstones does not throw",
    $("#toast").textContent.trim());

  // Delete UI + commit: chip × must persist a tombstone through commitSettingsCandidate.
  const presetSeed = currentBackup();
  presetSeed.settings.dayPlanPresets = [
    {
      id: "dpp_alive", label: "500 kcal", intent: "reduced", targetKcal: 500,
      veryLowCalorieAcknowledged: true, createdAt: 1, updatedAt: 10, lastUsedAt: 5,
    },
  ];
  await importBackup(window, presetSeed);
  await new Promise((r) => setTimeout(r, 120));
  ok(/^Imported/.test($("#toast").textContent.trim()),
    "active preset seed imports before delete UI coverage", $("#toast").textContent.trim());
  $("#btn-day-goals").click();
  ok(!$("#sheet-day-goals").hidden, "day plan sheet opens for preset delete coverage");
  const fastSeg = $("#dg-intent-seg [data-dg-intent='fast']");
  if (fastSeg) fastSeg.click();
  ok($("#dg-presets") && !$("#dg-presets").hidden,
    "#dg-presets is visible on Fast (not nested inside the Reduced panel)");
  const reducedSeg = $("#dg-intent-seg [data-dg-intent='reduced']");
  if (reducedSeg) reducedSeg.click();
  const delBtn = $("#dg-preset-chips [data-preset-delete='dpp_alive']");
  ok(delBtn && delBtn.tagName === "BUTTON",
    "preset delete is a real <button> (keyboard-reachable, not a nested span)",
    delBtn ? delBtn.outerHTML : `chips=${($("#dg-preset-chips") && $("#dg-preset-chips").innerHTML) || "(missing)"}`);
  window.confirm = () => true;
  if (delBtn) delBtn.click();
  await new Promise((r) => setTimeout(r, 80));
  const afterDelete = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  const gone = (afterDelete.dayPlanPresets || []).find((p) => p.id === "dpp_alive");
  ok(gone && gone.deleted === true && gone.targetKcal == null,
    "chip × commits a Sync-shaped deleted tombstone (no silent no-op)",
    gone ? JSON.stringify(gone) : "missing");
  ok(gone && gone.resetEpoch === Sync.getResetAt(),
    "chip × tombstone carries the live privacy epoch (commitSettingsCandidate stamp path)");
  ok(Sync.activeDayPlanPresets(afterDelete.dayPlanPresets || []).every((p) => p.id !== "dpp_alive"),
    "deleted preset is no longer active after commit");
  await importBackup(window, currentBackup());
  await new Promise((r) => setTimeout(r, 120));
  ok(/^Imported/.test($("#toast").textContent.trim()),
    "post-delete settings export→import accepts the tombstone",
    $("#toast").textContent.trim());
  const clearPresets = currentBackup();
  clearPresets.settings.dayPlanPresets = [];
  await importBackup(window, clearPresets);
  await new Promise((r) => setTimeout(r, 80));
  ok(/^Imported/.test($("#toast").textContent.trim()),
    "preset fixtures cleared before later tests run");
  window.eval("UI").closeSheet("sheet-day-goals");
  window.confirm = () => true;

  // Part IX.1: VIII.1 fixed dayGoalLock provenance at getDayGoalLock, the
  // ledger's own validator, migrateDayGoals and healLoggedDayGoals's rebuild
  // of out[day] — but normalizeImportedEvent (the fifth site) still rebuilt
  // out.dayGoalLock from a fixed field list that dropped intent and
  // fastAcknowledged, and still accepted a bare targetKcal 0 with no
  // declaration. Reproduce it through the real chain: declare a fast, log
  // real food against it (which stamps the *event's* own lock via the live
  // getDayGoalLock context, not just settings.dayGoals), export through the
  // app's real exporter, and reimport through the app's real importer.
  const ix1Day = "2026-01-18";
  const ix1Declare = currentBackup();
  ix1Declare.settings.dayGoals = {
    ...ix1Declare.settings.dayGoals,
    [ix1Day]: { targetKcal: 0, baseKcal: 2200, updatedAt: 60, intent: "fast", fastAcknowledged: true },
  };
  await importBackup(window, ix1Declare);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "IX.1 setup: a fast is declared ahead of logging so the root add can stamp its own event lock");

  const ix1RootEvent = Ledger.addEntry(ix1Day, {
    name: "Black coffee", displayQty: "1 cup", grams: 240, meal: "snack",
    macros: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 5, k: 50 }, sd: 0.1,
  });
  ok(ix1RootEvent.dayGoalLock && ix1RootEvent.dayGoalLock.targetKcal === 0 &&
      ix1RootEvent.dayGoalLock.intent === "fast" && ix1RootEvent.dayGoalLock.fastAcknowledged === true,
    "the live logged root stamps a declared-fast event lock with intent intact");

  const ix1Export = currentBackup();
  await importBackup(window, ix1Export);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "IX.1: re-importing the app's own real export of a declared fast is accepted");
  const ix1ReimportedEvent = Ledger.allEvents()
    .find((event) => event.day === ix1Day && event.type === "add" && event.dayGoalLock);
  ok(ix1ReimportedEvent && ix1ReimportedEvent.dayGoalLock.targetKcal === 0,
    "IX.1a: the reimported root event still carries a zero-calorie lock");
  ok(ix1ReimportedEvent && ix1ReimportedEvent.dayGoalLock.intent === "fast" &&
      ix1ReimportedEvent.dayGoalLock.fastAcknowledged === true,
    "IX.1a: normalizeImportedEvent carries intent/fastAcknowledged into the reimported event lock instead of dropping them");

  // IX.1b, chained on the same data: a Drive-style merge (the real
  // Sync.mergeDocs, exactly as a sync round would run it) must not let the
  // event lock's provenance regress even after surviving reimport.
  const ix1LocalDoc = {
    version: Sync.DOC_VERSION,
    generationSchemaVersion: Sync.GENERATION_SCHEMA_VERSION,
    updatedAt: Date.now(),
    resetAt: Sync.getResetAt(),
    events: Ledger.allEvents(),
    personalFoods: App.state.personalFoods,
    dayGoals: App.state.settings.dayGoals,
    dayPlans: App.state.settings.dayPlans,
    gapDrafts: App.state.settings.gapDrafts,
    phases: App.state.settings.phases,
    weights: App.state.settings.weights,
    profile: App.state.settings.profile,
    goals: App.state.settings.goals,
    goalsUpdatedAt: App.state.settings.goalsUpdatedAt,
    goalsResetEpoch: App.state.settings.goalsResetEpoch,
  };
  const ix1Merged = Sync.mergeDocs(ix1LocalDoc, ix1LocalDoc).doc;
  const ix1HealedLock = ix1Merged.dayGoals[ix1Day];
  ok(ix1HealedLock && ix1HealedLock.intent === "fast" && ix1HealedLock.fastAcknowledged === true &&
      ix1HealedLock.targetKcal === 0,
    "IX.1b: healLoggedDayGoals preserves the fast declaration through a real merge");
  const ix1Resolved = Phases.goalsForDay(ix1Day, { ...ix1Merged, dayGoals: ix1Merged.dayGoals });
  ok(ix1Resolved.kcal === 0,
    "IX.1: end to end — Ledger.addEntry -> export -> import -> mergeDocs -> goalsForDay still resolves the " +
    "declared fast to kcal 0, not a full-phase miss");

  // Clean up: later assertions in this run assume today is an ordinary day
  // and this fixture lives on a different day, but leaving it declared could
  // still confuse a later full-backup comparison.
  const ix1Clear = currentBackup();
  delete ix1Clear.settings.dayGoals[ix1Day];
  await importBackup(window, ix1Clear);
  ok(/^Imported$/.test($("#toast").textContent.trim()), "the IX.1 fixture is removed before later tests run");

  // Part X.5 supersedes IX.2 here. IX.2 had App.importedPlannedKcal *reject*
  // intent "fast" paired with a nonzero target for settings.dayGoals — the
  // one validator of the four that hard-failed instead of downgrading.
  // Sync.normalizeDayGoal, Phases.dayPlanForDay and Ledger._normalizedDayGoalLock
  // (and, below, this same import path's event-lock mirror) all already drop
  // the stray "fast" label and keep the record as an ordinary reduced-day
  // plan rather than failing outright — so one hand-edited record was taking
  // an entire backup restore down with it for no reason. This assertion is
  // changed, loudly, to require the same downgrade-and-keep behaviour the
  // other three validators already have, not to weaken what it checks.
  const incoherentFastImport = currentBackup();
  incoherentFastImport.settings.dayGoals = {
    ...incoherentFastImport.settings.dayGoals,
    [ix1Day]: { targetKcal: 1500, baseKcal: 2200, updatedAt: 61, intent: "fast", fastAcknowledged: true },
  };
  await importBackup(window, incoherentFastImport);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "X.5: App.importedPlannedKcal downgrades intent \"fast\" paired with a nonzero target to an ordinary reduced-day plan instead of failing the whole import");
  const incoherentFastSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  const incoherentFastGoal = incoherentFastSettings.dayGoals[ix1Day];
  ok(incoherentFastGoal && incoherentFastGoal.targetKcal === 1500 &&
      incoherentFastGoal.intent === undefined && incoherentFastGoal.fastAcknowledged === undefined,
    "X.5: the downgraded record drops intent/fastAcknowledged and keeps the numeric plan, mirroring Ledger._normalizedDayGoalLock");

  // The same incoherent combination can also arrive on an *event*'s
  // dayGoalLock (normalizeImportedEvent, the site IX.1 fixed) rather than on
  // settings.dayGoals — that reconstruction has to mirror
  // Ledger._normalizedDayGoalLock's own IX.2 fix, or a nonzero-target lock
  // could still come back out the other side carrying intent "fast".
  const incoherentLockImport = currentBackup();
  incoherentLockImport.events = [
    ...incoherentLockImport.events,
    {
      id: "incoherent-lock-event", ts: Date.now(), day: "2026-01-19", type: "add", resetEpoch: 0,
      dayGoalLock: { targetKcal: 1500, baseKcal: 2200, intent: "fast", fastAcknowledged: true },
      entry: {
        id: "incoherent-lock-entry", name: "not a fast", displayQty: "1 item", grams: 100, meal: "snack",
        macros: { kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 20, k: 40 }, sd: 0.1,
      },
    },
  ];
  await importBackup(window, incoherentLockImport);
  ok(/^Imported$/.test($("#toast").textContent.trim()),
    "IX.2 event-lock mirror: a nonzero-target lock with intent \"fast\" imports as an ordinary lock rather than being rejected outright");
  const incoherentLockEvent = Ledger.allEvents().find((event) => event.id === "incoherent-lock-event");
  ok(incoherentLockEvent && incoherentLockEvent.dayGoalLock &&
      incoherentLockEvent.dayGoalLock.targetKcal === 1500 && incoherentLockEvent.dayGoalLock.intent === undefined &&
      incoherentLockEvent.dayGoalLock.fastAcknowledged === undefined,
    "IX.2: normalizeImportedEvent never writes intent \"fast\" alongside a nonzero targetKcal, mirroring Ledger._normalizedDayGoalLock");

  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "foods").click();
  await new Promise((r) => setTimeout(r, 20));
  $("#foods-list .food-item").click();
  await new Promise((r) => setTimeout(r, 20));
  ok(!$("#food-xss") && !$("#ingredient-xss") && !$("#prep-xss") && !window.__foodXss,
    "imported food markup is rendered as text, never DOM");
  ok(/Logged 7 times/.test($("#detail-body").textContent) && /2 servings/.test($("#detail-body").textContent),
    "normalized usage and batch values render safely");
  $("#sheet-detail [data-close='sheet-detail']").click();
  await new Promise((r) => setTimeout(r, 220));

  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  $("#fab-add").click();
  $("#btn-once-food").click();
  $("#once-name").value = '<img id="quick-xss" src=x> Quick';
  $("#once-kcal").value = "500";
  $("#once-qty").value = "1";
  if ($("#once-macros")) $("#once-macros").open = false;
  $("#once-save").click();
  const quick = Ledger.entriesFor(today).slice(-1)[0];
  const totals = Ledger.totalsFor(today);
  ok(quick && quick.source === "quick" && quick.macros.na === null && quick.macros.k === null,
    "quick kcal stores sodium and potassium as unknown");
  ok(totals.naCoverage === 0 && totals.kCoverage === 0, "quick kcal does not claim electrolyte coverage");
  ok(/^0 mg\*$/.test($("#v-sodium").textContent.trim()) &&
      /^0 mg\*$/.test($("#v-potassium").textContent.trim()),
    "Today labels incomplete sodium and potassium with a short marked value, not an inline sentence");
  ok(!$("#v-na").hidden && /Sodium 0% and potassium 0% covered by foods with a known amount\./.test($("#v-na").textContent),
    "the incomplete-coverage explanation moves to a shared footnote instead of wrapping inline");
  $("[data-hud-nutrient='sodium']").click();
  ok(/known subtotal.*not compared with the full limit/i.test($("#today-day-detail").textContent),
    "day detail does not compare incomplete sodium with the full goal");
  ok(!$("#quick-xss") && /<img id="quick-xss"/.test($("#day-log").textContent),
    "quick-entry markup is escaped in the diary");

  // One-off sheet (Step 2): Add entry, kcal-only log, library untouched,
  // edit-prefill amends without opening qty, validation stays open.
  {
    const UI = window.eval("UI");
    const foodsBefore = App.state.personalFoods.length;
    const onceDay = "2019-06-15";
    App.state.viewDay = onceDay;
    // Do not click #day-label here — on a non-today day it jumps to today (see onDayLabelClick).
    $("#fab-add").click();
    ok(!!$("#btn-once-food") && /Log once/.test($("#btn-once-food").textContent || ""),
      "Add sheet exposes Log once entry");
    $("#btn-once-food").click();
    ok(!$("#sheet-once").hidden && UI.topSheetId() === "sheet-once" &&
        /Log once/.test($("#once-title").textContent || ""),
      "Log once opens #sheet-once with matching title");
    // Force-fail validation: blank name
    $("#once-name").value = "";
    $("#once-kcal").value = "700";
    $("#once-qty").value = "1";
    const beforeOnceReject = window.localStorage.getItem("nd_events_v1");
    let onceRejectSyncs = 0;
    const previousSchedulePush = Sync.schedulePush;
    Sync.schedulePush = () => { onceRejectSyncs += 1; };
    $("#once-save").click();
    ok(window.localStorage.getItem("nd_events_v1") === beforeOnceReject && onceRejectSyncs === 0 &&
        !$("#sheet-once").hidden && /Name is required/.test($("#once-errors").textContent),
      "one-off validation keeps the sheet open with no event or sync");
    Sync.schedulePush = previousSchedulePush;

    $("#once-name").value = "Pad thai — Thai House";
    $("#once-kcal").value = "850";
    const portionChip = $("#once-units [data-unit='portion']");
    if (portionChip) portionChip.click();
    $("#once-qty").value = "1";
    // kcal-only: leave macros <details> closed → source:quick (Step 7)
    ok(!$("#once-macros").open, "macros details start collapsed for a new one-off");
    $("#once-save").click();
    const onceEntries = Ledger.entriesFor(onceDay);
    let onceEntry = onceEntries.find((e) => e.name === "Pad thai — Thai House");
    ok(onceEntry && onceEntry.source === "quick" && onceEntry.foodId == null &&
        onceEntry.grams === 0 && onceEntry.unit === "kcal" && onceEntry.qty === 850 &&
        onceEntry.macros.kcal === 850 && onceEntry.macros.p === 0 &&
        onceEntry.macros.na === null && onceEntry.macros.k === null &&
        !Object.prototype.hasOwnProperty.call(onceEntry, "per100") &&
        onceEntry.sd === 0.40,
      "kcal-only (macros closed) lands as source:quick with unit:kcal, sd 0.40, and no per100",
      onceEntry ? JSON.stringify({
        name: onceEntry.name, source: onceEntry.source, sd: onceEntry.sd,
        unit: onceEntry.unit, grams: onceEntry.grams, qty: onceEntry.qty, macros: onceEntry.macros,
        hasPer100: Object.prototype.hasOwnProperty.call(onceEntry, "per100"),
      }) : `missing; day has ${onceEntries.length}: ${onceEntries.map((e) => `${e.source}:${e.name}`).join("|")}`);
    ok(App.state.personalFoods.length === foodsBefore,
      "one-off save does not touch My Foods");
    ok(!!onceEntry, "one-off was saved on the fixture day");

    // Edit-prefill amends macros via the once sheet (Step 3 will route edit taps here).
    if (onceEntry) {
      App.state.editEntryId = onceEntry.id;
      App.state.editEntryDay = onceDay;
      App.state.viewDay = onceDay;
      UI.fillOnceSheet({ from: onceEntry, allowRemove: true, imperial: false });
      UI.openSheet("sheet-once");
      ok(!$("#sheet-once").hidden && !$("#once-remove").hidden,
        "editing a one-off shows Remove on #sheet-once");
      ok($("#once-name").value === "Pad thai — Thai House" && $("#once-kcal").value === "850",
        "edit-prefill restores name and kcal");
      $("#once-macros").open = true;
      $("#once-p").value = "32";
      $("#once-c").value = "90";
      $("#once-f").value = "28";
      $("#once-fb").value = "6";
      $("#once-confidence [data-confidence='estimated']").click();
      $("#once-save").click();
      const amended = Ledger.entriesFor(onceDay).find((e) => e.id === onceEntry.id);
      ok(amended && amended.source === "once" && amended.macros.p === 32 && amended.macros.c === 90 &&
          amended.macros.f === 28 && amended.sd === 0.25 &&
          !Object.prototype.hasOwnProperty.call(amended, "per100"),
        "one-off amend updates portion macros without introducing per100");
      onceEntry = amended || onceEntry;
      ok($("#sheet-qty").hidden, "one-off edit never opens the qty sheet");

      // Step 3 Guard 1: Edit from the day log opens #sheet-once, not qty.
      App.state.viewDay = onceDay;
      UI.closeAllSheets();
      await new Promise((r) => setTimeout(r, 220));
      // Refresh the day log for the fixture day via a no-op toggle after manually painting.
      const dayEntries = Ledger.entriesFor(onceDay);
      UI.renderDayLog(onceDay, dayEntries);
      $(`#day-log [data-action='toggle-entry'][data-id='${onceEntry.id}']`).click();
      $(`#day-log [data-action='edit-entry'][data-id='${onceEntry.id}']`).click();
      ok(!$("#sheet-once").hidden && $("#sheet-qty").hidden && UI.topSheetId() === "sheet-once",
        "day-log Edit on a one-off opens #sheet-once and keeps #sheet-qty closed");
      UI.closeSheet("sheet-once");
      await new Promise((r) => setTimeout(r, 220));

      // Step 3 Guard 1: Repeat yesterday prefilled one-off creates a *new* entry.
      const beforeRepeat = Ledger.entriesFor(today).filter((e) => e.source === "once").length;
      App.state.viewDay = today;
      $("#fab-add").click();
      // openAddSheet overwrites yesterdayKey to the calendar previous day — reseed
      // both the strip and the lookup key so this fixture is reachable.
      App.state.yesterdayKey = onceDay;
      UI.renderPicker(App.state.personalFoods, "", true, {
        yesterday: Ledger.entriesFor(onceDay),
        yesterdayLabel: "Previous day",
      });
      const repeatBtn = $(`#pick-list [data-action='repeat-yesterday'][data-id='${onceEntry.id}']`);
      ok(!!repeatBtn, "yesterday strip lists the one-off for repeat");
      if (repeatBtn) {
        repeatBtn.click();
        ok(!$("#sheet-once").hidden && $("#sheet-qty").hidden,
          "repeat-yesterday on a one-off opens #sheet-once, not qty");
        ok($("#once-name").value === "Pad thai — Thai House",
          "repeat prefill restores the one-off name");
        ok($("#once-remove").hidden, "repeat-yesterday does not enter edit mode");
        ok($("#once-macros").open, "repeat of a macro one-off keeps macros open");
        $("#once-kcal").value = "400";
        $("#once-save").click();
        const afterRepeat = Ledger.entriesFor(today).filter((e) => e.source === "once");
        ok(afterRepeat.length === beforeRepeat + 1 &&
            afterRepeat.some((e) => e.macros.kcal === 400 && e.id !== onceEntry.id),
          "repeat-yesterday save creates a new one-off, does not amend the original");
        const stillOriginal = Ledger.entriesFor(onceDay).find((e) => e.id === onceEntry.id);
        ok(stillOriginal && stillOriginal.macros.p === 32,
          "original fixture-day one-off is unchanged after repeat");
      }

      // Step 3 Guard 2: refuse saveQty against a one-off edit target.
      App.state.editEntryId = onceEntry.id;
      App.state.editEntryDay = onceDay;
      App.state.pickFood = {
        id: null,
        name: onceEntry.name,
        per100: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0, k: 0 },
        units: {},
        sd: 0.25,
        cat: "dish",
        _orphan: true,
        _keptFoodId: null,
      };
      UI.fillQtySheet(App.state.pickFood, false, { qty: 1, unit: "portion", meal: "dinner", allowRemove: true });
      UI.openSheet("sheet-qty");
      const beforeGuard2 = JSON.stringify(Ledger.entriesFor(onceDay));
      let guard2Syncs = 0;
      const prevPush = Sync.schedulePush;
      Sync.schedulePush = () => { guard2Syncs += 1; };
      $("#qty-save").click();
      ok(JSON.stringify(Ledger.entriesFor(onceDay)) === beforeGuard2 && guard2Syncs === 0,
        "saveQty refuses a one-off edit target with no ledger change or sync");
      const guarded = Ledger.entriesFor(onceDay).find((e) => e.id === onceEntry.id);
      ok(guarded && guarded.source === "once" && guarded.macros.kcal === 850,
        "refused qty save leaves source and kcal intact");
      Sync.schedulePush = prevPush;
      UI.closeSheet("sheet-qty");
      await new Promise((r) => setTimeout(r, 220));
      App.state.editEntryId = null;
      App.state.editEntryDay = null;
      App.state.pickFood = null;

      // Regression: legacy quick kcal still opens for edit after #sheet-kcal is gone.
      const quickLegacy = Ledger.entriesFor(today).find((e) => e.source === "quick");
      ok(!!quickLegacy, "smoke fixture still has a quick-kcal entry on today");
      if (quickLegacy) {
        App.state.viewDay = today;
        UI.closeAllSheets();
        await new Promise((r) => setTimeout(r, 220));
        UI.renderDayLog(today, Ledger.entriesFor(today));
        $(`#day-log [data-action='toggle-entry'][data-id='${quickLegacy.id}']`).click();
        $(`#day-log [data-action='edit-entry'][data-id='${quickLegacy.id}']`).click();
        ok(UI.topSheetId() === "sheet-once" && !$("#sheet-once").hidden &&
            (!$("#once-macros") || !$("#once-macros").open),
          "legacy source:quick still opens #sheet-once with macros closed");
        UI.closeSheet("sheet-once");
        await new Promise((r) => setTimeout(r, 220));
      }

      // Step 4 — badges on day log, yesterday strip, and day-detail.
      // S4-1: seed a library entry onto the same day we assert against — do not
      // rely on baseline-entry surviving on today after earlier import/reset tests.
      const libOnOnceDay = {
        id: "once-day-library",
        name: "Library Lentils",
        foodId: "baseline-food",
        displayQty: "100 g",
        grams: 100,
        qty: 100,
        unit: "g",
        meal: "lunch",
        source: "personal",
        cat: "legume",
        macros: { kcal: 120, p: 10, c: 15, f: 2, fb: 5, na: 40, k: 300 },
        sd: 0.1,
      };
      Ledger.addEntry(onceDay, libOnOnceDay);

      App.state.viewDay = onceDay;
      UI.closeAllSheets();
      await new Promise((r) => setTimeout(r, 220));
      UI.renderDayLog(onceDay, Ledger.entriesFor(onceDay));
      const logBadge = $(`#day-log [data-action='toggle-entry'][data-id='${onceEntry.id}'] .src-badge-once`);
      ok(!!logBadge && /One-off/.test(logBadge.textContent),
        "day log shows an One-off badge on a source:once row");
      $(`#day-log [data-action='toggle-entry'][data-id='${onceEntry.id}']`).click();
      const provLine = $("#day-log .r-prov");
      ok(!!provLine && /Not saved to My Foods/.test(provLine.textContent),
        "expanded one-off row shows entryProvenance detail");
      const libraryRow = $(`#day-log [data-action='toggle-entry'][data-id='once-day-library']`);
      ok(!!libraryRow, "fixture: library entry is present on the badge-assertion day");
      ok(!!libraryRow && !libraryRow.querySelector(".src-badge"),
        "library food rows do not get a source badge");

      App.state.viewDay = today;
      App.state.yesterdayKey = onceDay;
      $("#fab-add").click();
      UI.renderPicker(App.state.personalFoods, "", true, {
        yesterday: Ledger.entriesFor(onceDay),
        yesterdayLabel: "Previous day",
      });
      const yBadge = $(`#pick-list [data-action='repeat-yesterday'][data-id='${onceEntry.id}'] .src-badge-once`);
      ok(!!yBadge && /One-off/.test(yBadge.textContent),
        "yesterday strip shows One-off so a guess isn’t mistaken for a library food");
      UI.closeSheet("sheet-add");
      await new Promise((r) => setTimeout(r, 220));

      UI.renderDayDetail(onceDay, {
        metric: "kcal",
        root: "#today-day-detail",
        settings: App.state.settings,
        goals: Phases.goalsForDay(onceDay, App.state.settings),
      });
      const detailBadge = [...window.document.querySelectorAll("#today-day-detail .tf-name .src-badge-once")]
        .find((el) => /Pad thai/.test(el.parentElement.textContent));
      ok(!!detailBadge, "Today contribution badges an aggregated one-off contributor");
      const libraryDetail = [...window.document.querySelectorAll("#today-day-detail .tf-name")]
        .find((el) => el.textContent.trim().startsWith("Library Lentils"));
      ok(!!libraryDetail, "fixture: library contributor appears in Today contribution");
      ok(!!libraryDetail && !libraryDetail.querySelector(".src-badge"),
        "Today contribution library-only contributor has no source badge");

      if (quickLegacy) {
        UI.renderDayLog(today, Ledger.entriesFor(today));
        const qBadge = $(`#day-log [data-action='toggle-entry'][data-id='${quickLegacy.id}'] .src-badge-quick`);
        ok(!!qBadge && /Quick/.test(qBadge.textContent),
          "day log shows a Quick badge on source:quick rows");
      }

      // F3: remove → Undo must not write per100:null onto a one-off.
      const beforeRemove = Ledger.entriesFor(onceDay).find((e) => e.id === onceEntry.id);
      ok(beforeRemove && !Object.prototype.hasOwnProperty.call(beforeRemove, "per100"),
        "F3 fixture: live one-off still has no per100 key before remove");
      App.state.viewDay = onceDay;
      App.state.editEntryId = onceEntry.id;
      App.state.editEntryDay = onceDay;
      UI.fillOnceSheet({ from: beforeRemove, allowRemove: true, imperial: false });
      UI.openSheet("sheet-once");
      $("#once-remove").click();
      ok(!Ledger.entriesFor(onceDay).some((e) => e.id === onceEntry.id),
        "once-remove deletes the live one-off");
      const undoBtn = $("#toast .toast-action");
      ok(!!undoBtn && /Undo/.test(undoBtn.textContent), "remove toast offers Undo");
      if (undoBtn) undoBtn.click();
      // UI.toast defers onClick with setTimeout(0) so a nested "Restored" toast
      // is not cleared immediately — wait one turn before reading the ledger.
      await new Promise((r) => setTimeout(r, 20));
      const restored = Ledger.entriesFor(onceDay).find((e) => e.id === onceEntry.id);
      ok(restored && restored.source === "once" && restored.macros.kcal === 850 &&
          restored.macros.p === 32 &&
          !Object.prototype.hasOwnProperty.call(restored, "per100"),
        "Undo restores the one-off without inventing a per100 key");
    }
    App.state.viewDay = today;
  }

  // Step 8 — Promote a weighed one-off to My Foods without rewriting history or a same-name food.
  {
    const UI = window.eval("UI");
    const Foods = window.eval("Foods");
    const promoteDay = "2019-08-01";
    App.state.viewDay = promoteDay;
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();

    // grams:0 → disabled control.
    Ledger.addEntry(promoteDay, {
      name: "Unknown mass bowl",
      foodId: null, cat: "dish", grams: 0, displayQty: "1 portion", qty: 1, unit: "portion",
      macros: { kcal: 600, p: 20, c: 70, f: 18, fb: 4, na: null, k: null },
      sd: 0.25, meal: "dinner", source: "once",
    });
    const zeroG = Ledger.entriesFor(promoteDay).find((e) => e.name === "Unknown mass bowl");
    UI.renderDayLog(promoteDay, Ledger.entriesFor(promoteDay));
    $(`#day-log [data-action='toggle-entry'][data-id='${zeroG.id}']`).click();
    const disabledBtn = [...$("#day-log").querySelectorAll("button.linkbtn")]
      .find((b) => /Save to My Foods/.test(b.textContent) && b.disabled);
    ok(!$(`#day-log [data-action='promote-once'][data-id='${zeroG.id}']`) && !!disabledBtn,
      "grams:0 one-off shows Save to My Foods disabled (no inventing per100)");

    // Library same-name fixture for the banner path.
    const foodsBeforeLib = App.state.personalFoods.length;
    const padThaiLib = Foods.createFromDraft({
      name: "Pad thai", cat: "dish",
      per100: { kcal: 150, p: 8, c: 20, f: 4, fb: 1, na: 200, k: 100 },
      units: {}, logAs: "grams",
      recipe: { ingredients: [], prep: "", notes: "fixture library pad thai" },
      confidence: "medium", sd: 0.12, raw: "",
    });
    padThaiLib.id = "lib-pad-thai-promote";
    padThaiLib.version = 3;
    padThaiLib.history = [];
    padThaiLib.resetEpoch = Sync.getResetAt();
    App.state.personalFoods = App.state.personalFoods.concat([padThaiLib]);
    window.localStorage.setItem("nd_personal_v1", JSON.stringify(App.state.personalFoods));

    Ledger.addEntry(promoteDay, {
      name: "Pad thai",
      foodId: null, cat: "dish", grams: 250, displayQty: "250 g", qty: 250, unit: "g",
      macros: { kcal: 500, p: 25, c: 60, f: 15, fb: 5, na: null, k: 400 },
      sd: 0.25, meal: "lunch", source: "once",
    });
    const weighed = Ledger.entriesFor(promoteDay).find((e) => e.source === "once" && e.grams === 250 && e.name === "Pad thai");
    const libBefore = JSON.parse(JSON.stringify(App.state.personalFoods.find((f) => f.id === "lib-pad-thai-promote")));
    UI.renderDayLog(promoteDay, Ledger.entriesFor(promoteDay));
    $(`#day-log [data-action='toggle-entry'][data-id='${weighed.id}']`).click();
    $(`#day-log [data-action='promote-once'][data-id='${weighed.id}']`).click();
    ok(App.state.saveAsNew === true && !App.state.updateFoodId,
      "promote arms saveAsNew and clears updateFoodId");
    ok(!$("#review-dup").hidden && !$("#review-dup [data-action='update-dup']"),
      "same-name library food shows a notice without Update that one");
    ok($("#rev-na").value === "" && Number($("#rev-k").value) === 160,
      "unknown sodium stays blank; potassium scales 400→160 per 100 g");

    // Capture length immediately before Save — includes the fixture library food.
    const foodsBeforeSave = App.state.personalFoods.length;
    ok(!$("#btn-review-save").disabled, "promote review is saveable");
    $("#btn-review-save").click();
    await new Promise((r) => setTimeout(r, 40));
    const libAfter = App.state.personalFoods.find((f) => f.id === "lib-pad-thai-promote");
    ok(libAfter && libAfter.version === libBefore.version &&
        JSON.stringify(libAfter.per100) === JSON.stringify(libBefore.per100),
      "promote does not mutate the same-named library food");
    const created = App.state.personalFoods.filter((f) =>
      !f.deleted && f.id !== "lib-pad-thai-promote" &&
      String(f.name || "").toLowerCase() === "pad thai");
    ok(created.length >= 1 && created.some((f) => f.per100 && Math.abs(Number(f.per100.kcal) - 200) < 0.6 && f.per100.na == null),
      "promote creates a scaled Pad thai with unknown sodium kept null",
      `count=${created.length}; toast=${($("#toast") && $("#toast").textContent) || ""}`);
    ok(App.state.personalFoods.length === foodsBeforeSave + 1,
      "promote adds exactly one My Foods row");
    const sourceStill = Ledger.entriesFor(promoteDay).find((e) => e.id === weighed.id);
    ok(sourceStill && sourceStill.foodId == null && sourceStill.source === "once",
      "promotion does not back-link foodId onto the historical entry");

    Ledger.addEntry(promoteDay, {
      name: "Tiny dense bite",
      foodId: null, cat: "snack", grams: 5, displayQty: "5 g", qty: 5, unit: "g",
      macros: { kcal: 80, p: 1, c: 1, f: 8, fb: 0, na: null, k: null },
      sd: 0.25, meal: "snack", source: "once",
    });
    const tiny = Ledger.entriesFor(promoteDay).find((e) => e.name === "Tiny dense bite");
    const foodsMid = App.state.personalFoods.length;
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
    App.state.viewDay = promoteDay;
    UI.closeAllSheets();
    await new Promise((r) => setTimeout(r, 220));
    UI.renderDayLog(promoteDay, Ledger.entriesFor(promoteDay));
    const tinyToggle = $(`#day-log [data-action='toggle-entry'][data-id='${tiny.id}']`);
    ok(!!tinyToggle, "fixture: tiny dense one-off is on the day log");
    if (tinyToggle) tinyToggle.click();
    const tinyPromote = $(`#day-log [data-action='promote-once'][data-id='${tiny.id}']`);
    ok(!!tinyPromote, "fixture: tiny dense one-off exposes Save to My Foods");
    if (tinyPromote) tinyPromote.click();
    ok($("#btn-review-save").disabled && /kcal per 100 g looks impossibly high/i.test($("#review-errors").textContent || ""),
      "derived per100 out of bounds is refused by validateReviewSave");
    ok(App.state.personalFoods.length === foodsMid, "refused promote writes nothing to My Foods");
    UI.closeSheet("sheet-paste");
    App.state.viewDay = today;
    await new Promise((r) => setTimeout(r, 220));
  }

  // H1–H3 — Steps 7–10 review merge-blockers (promote Log once; grams on kcal-only; zero-macro once edit).
  {
    const UI = window.eval("UI");
    const fixDay = "2019-08-02";
    App.state.viewDay = fixDay;
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
    UI.closeAllSheets();
    await new Promise((r) => setTimeout(r, 80));

    // H2: macros-closed + grams keeps mass on source:quick (promote path still possible later).
    $("#fab-add").click();
    $("#btn-once-food").click();
    $("#once-name").value = "Airport bowl 350g";
    $("#once-kcal").value = "700";
    const gChip = $("#once-units [data-unit='g']");
    if (gChip) gChip.click();
    $("#once-qty").value = "350";
    if ($("#once-macros")) $("#once-macros").open = false;
    $("#once-save").click();
    const h2 = Ledger.entriesFor(fixDay).find((e) => e.name === "Airport bowl 350g");
    ok(h2 && h2.source === "quick" && h2.unit === "kcal" && h2.qty === 700 &&
        h2.grams === 350 && /350 g/.test(h2.displayQty || ""),
      "H2: kcal-only with g portion keeps grams on source:quick",
      h2 && JSON.stringify({ source: h2.source, unit: h2.unit, qty: h2.qty, grams: h2.grams, displayQty: h2.displayQty }));

    // H3: no-op edit of weighed once with zero macros must not flip to quick / wipe grams.
    Ledger.addEntry(fixDay, {
      name: "Weighed zero macros",
      foodId: null, cat: "dish", grams: 300, displayQty: "300 g", qty: 300, unit: "g",
      macros: { kcal: 400, p: 0, c: 0, f: 0, fb: 0, na: null, k: null },
      sd: 0.25, meal: "lunch", source: "once",
    });
    const h3 = Ledger.entriesFor(fixDay).find((e) => e.name === "Weighed zero macros");
    App.state.editEntryId = h3.id;
    App.state.editEntryDay = fixDay;
    App.state.viewDay = fixDay;
    UI.fillOnceSheet({ from: h3, allowRemove: true, imperial: false });
    UI.openSheet("sheet-once");
    ok(!!$("#once-macros") && $("#once-macros").open,
      "H3: edit of source:once opens macros so Save stays on the once path");
    $("#once-save").click();
    const h3After = Ledger.entriesFor(fixDay).find((e) => e.id === h3.id);
    ok(h3After && h3After.source === "once" && h3After.grams === 300 && h3After.unit === "g",
      "H3: no-op Save keeps source:once and grams",
      h3After && JSON.stringify({ source: h3After.source, grams: h3After.grams, unit: h3After.unit }));

    // H1: promote clears edit arm; Log once is hidden and cannot rewrite the ledger row.
    Ledger.addEntry(fixDay, {
      name: "Promote guard bowl",
      foodId: null, cat: "dish", grams: 250, displayQty: "250 g", qty: 250, unit: "g",
      macros: { kcal: 500, p: 25, c: 60, f: 15, fb: 5, na: null, k: 400 },
      sd: 0.25, meal: "dinner", source: "once",
    });
    const h1 = Ledger.entriesFor(fixDay).find((e) => e.name === "Promote guard bowl");
    App.state.editEntryId = h1.id;
    App.state.editEntryDay = fixDay;
    App.state.viewDay = fixDay;
    UI.renderDayLog(fixDay, Ledger.entriesFor(fixDay));
    $(`#day-log [data-action='toggle-entry'][data-id='${h1.id}']`).click();
    $(`#day-log [data-action='promote-once'][data-id='${h1.id}']`).click();
    ok(App.state.saveAsNew === true && App.state.promotingOnce === true && !App.state.editEntryId,
      "H1: promote arms saveAsNew/promotingOnce and clears editEntryId");
    const logOnceBtn = $("#btn-review-log-once");
    ok(!!logOnceBtn && logOnceBtn.hidden,
      "H1: Log once is hidden on the Save to My Foods (promote) sheet");
    // Even if a caller forced the button visible, the handler must no-op.
    logOnceBtn.hidden = false;
    logOnceBtn.disabled = false;
    logOnceBtn.click();
    const h1After = Ledger.entriesFor(fixDay).find((e) => e.id === h1.id);
    ok(h1After && h1After.grams === 250 && h1After.macros.kcal === 500 && h1After.source === "once",
      "H1: Log once during promote does not rewrite the historical once entry",
      h1After && JSON.stringify({ grams: h1After.grams, kcal: h1After.macros && h1After.macros.kcal, source: h1After.source }));
    UI.closeSheet("sheet-paste");
    App.state.saveAsNew = false;
    App.state.promotingOnce = false;
    App.state.editEntryId = null;
    App.state.editEntryDay = null;
    App.state.viewDay = today;
    await new Promise((r) => setTimeout(r, 80));
  }

  // Step 9 — onceDays honesty: disclose one-off/quick days in Insights, never drop them.
  {
    const Analytics = window.eval("Analytics");
    const UI = window.eval("UI");
    const onceInsightsDay = "2019-06-15";
    const fixtureEntries = {
      [onceInsightsDay]: [
        {
          name: "Airport sandwich", source: "quick",
          macros: { kcal: 450, p: 0, c: 0, f: 0, fb: 0, na: null, k: null },
        },
        {
          name: "Library lunch", source: "personal",
          macros: { kcal: 550, p: 30, c: 50, f: 20, fb: 5, na: 400, k: 500 },
        },
      ],
    };
    const counted = Analytics.onceDays([onceInsightsDay], (d) => fixtureEntries[d] || []);
    ok(counted.n === 1 && counted.onceKcal === 450 && Math.abs(counted.share - 0.45) < 0.01,
      "onceDays counts quick share on a mixed day",
      JSON.stringify(counted));

    const days = Analytics.buildDays({
      keys: [onceInsightsDay],
      totalsForDay: () => ({
        count: 2,
        kcal: { mean: 1000 }, p: { mean: 30 }, c: { mean: 50 }, f: { mean: 20 },
        fb: { mean: 5 }, na: { mean: 400 },
      }),
      goalsForDay: () => (App.state.settings && App.state.settings.goals) || {},
    });
    const note = Analytics.observations(days, {
      entriesForDay: (d) => fixtureEntries[d] || [],
    }).find((o) => o.id === "once-days");
    ok(!note, "observations no longer emit once-days note for mixed days");
    const onceStats = Analytics.onceDays([onceInsightsDay], (d) => fixtureEntries[d] || []);
    ok(onceStats.n === 1, "onceDays helper still finds the mixed day", JSON.stringify(onceStats));
    const stats = Analytics.summaryStats(days, "kcal");
    ok(stats.n === 1 && Math.round(stats.avg) === 1000,
      "one-off day stays in kcal stats (disclose, never exclude)",
      JSON.stringify(stats));

    // Live Insights panel: a quick entry must not resurrect Overview once-days copy.
    const todayKey = Ledger.todayKey();
    Ledger.addEntry(todayKey, {
      name: "Today quick snack",
      foodId: null, cat: "snack", grams: 0, displayQty: "200 kcal", qty: 200, unit: "kcal",
      macros: { kcal: 200, p: 0, c: 0, f: 0, fb: 0, na: null, k: null },
      sd: 0.25, meal: "snack", source: "quick",
    });
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
    await new Promise((r) => setTimeout(r, 80));
    const live = $('#insight-observations [data-obs-id="once-days"]');
    const obsText = (($("#insight-observations") && $("#insight-observations").textContent) || "");
    ok(!live && !/one-off or quick-kcal/.test(obsText),
      "Insights Overview drops once-days honesty note");

    // Phase 2: Today shows macros as not scored when coverage fails; kcal keeps counting.
    App.state.viewDay = todayKey;
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
    await new Promise((r) => setTimeout(r, 80));
    const pText = ($("#v-p") && $("#v-p").textContent) || "";
    const kcalBig = ($("#v-kcal-big") && $("#v-kcal-big").textContent) || "";
    ok(/not scored today/.test(pText) && /\*/.test(pText),
      "Phase 2: Today marks protein not scored when macro coverage is incomplete",
      pText);
    ok(kcalBig.trim() !== "" && !/not scored/i.test(kcalBig),
      "Phase 2: Today still shows calorie totals when macros are incomplete",
      kcalBig);

    // Phase 3: disclosure note jumps to Today contribution with culprits + Edit.
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
    await new Promise((r) => setTimeout(r, 80));
    const macroObs = $('#insight-observations [data-obs-id="macro-incomplete"]');
    ok(!!macroObs && /without complete macros/.test(macroObs.textContent || "") &&
        macroObs.dataset.jump === "#today-day-detail" && !!macroObs.dataset.jumpDay,
      "Phase 3: Insights shows macro-incomplete honesty note that opens Today contribution",
      macroObs && macroObs.textContent);
    if (macroObs) macroObs.click();
    await new Promise((r) => setTimeout(r, 40));
    const detail = $("#today-day-detail");
    ok(!!detail && /Incomplete macros/.test(detail.textContent || "") &&
        /Today quick snack/.test(detail.textContent || ""),
      "Phase 3: Today contribution lists incomplete-macro culprits",
      detail && detail.textContent);
    const editBtn = detail && detail.querySelector("[data-action='edit-entry']");
    ok(!!editBtn && editBtn.dataset.day && editBtn.dataset.id,
      "Phase 3: culprit exposes Edit with day and entry id");
    if (editBtn) {
      editBtn.click();
      await new Promise((r) => setTimeout(r, 40));
      ok(!$("#sheet-once").hidden && App.state.editEntryId === editBtn.dataset.id,
        "Phase 3: Edit from culprits opens Log once for that entry");
      UI.closeSheet("sheet-once");
    }

    // Phase 4: Mark incomplete — diary stays; averages / TDEE / honesty note update.
    App.state.viewDay = todayKey;
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
    await new Promise((r) => setTimeout(r, 40));
    $("#btn-day-goals").click();
    await new Promise((r) => setTimeout(r, 40));
    ok(!$("#sheet-day-goals").hidden && !!$("#dg-incomplete"),
      "Phase 4: Day plan sheet exposes Mark incomplete");
    $("#dg-incomplete").checked = true;
    $("#dg-incomplete").dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const dgMarked = (JSON.parse(window.localStorage.getItem("nd_settings_v1") || "{}").dayGoals || {})[todayKey];
    ok(dgMarked && dgMarked.incomplete === true && dgMarked.excludeReason === "incomplete",
      "Phase 4: incomplete mark persists on dayGoals",
      JSON.stringify(dgMarked));
    UI.closeSheet("sheet-day-goals");
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
    await new Promise((r) => setTimeout(r, 80));
    const exclObs = $('#insight-observations [data-obs-id="excluded-days"]');
    ok(!!exclObs && /marked incomplete/.test(exclObs.textContent || ""),
      "Phase 4: Insights discloses excluded days",
      exclObs && exclObs.textContent);
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
    await new Promise((r) => setTimeout(r, 40));
    $("#btn-day-goals").click();
    await new Promise((r) => setTimeout(r, 40));
    ok($("#dg-incomplete").checked, "Phase 4: sheet shows incomplete still checked");
    $("#dg-incomplete").checked = false;
    $("#dg-incomplete").dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const dgCleared = (JSON.parse(window.localStorage.getItem("nd_settings_v1") || "{}").dayGoals || {})[todayKey];
    ok(!dgCleared || dgCleared.cleared === true || !dgCleared.incomplete,
      "Phase 4: unmark clears incomplete without requiring a calorie plan",
      JSON.stringify(dgCleared));
    UI.closeSheet("sheet-day-goals");

    App.state.viewDay = today;
    await new Promise((r) => setTimeout(r, 40));
  }

  // Step 5 — Log once from the review sheet (no My Foods write).
  {
    const UI = window.eval("UI");
    const foodsBefore = App.state.personalFoods.length;
    const logOnceDay = "2019-07-01";
    App.state.viewDay = logOnceDay;
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
    $("#fab-add").click();
    $("#btn-paste-new").click();
    $("#btn-manual-food").click();
    ok(!$("#btn-review-log-once").hidden,
      "Log once is visible when creating a new food");
    $("#rev-name").value = "Review Pad Thai";
    $("#rev-kcal").value = "200";
    $("#rev-p").value = "10";
    $("#rev-c").value = "25";
    $("#rev-f").value = "8";
    $("#rev-fb").value = "2";
    $("#rev-na").value = "";
    $("#rev-k").value = "";
    $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
    ok(!$("#btn-review-log-once").disabled && !$("#btn-review-save").disabled,
      "Log once enables alongside Save food when the review is valid");
    $("#btn-review-log-once").click();
    const logged = Ledger.entriesFor(logOnceDay).find((e) => e.source === "once" && e.name === "Review Pad Thai");
    ok(logged && logged.foodId == null && logged.unit === "portion" && logged.qty === 1 &&
        logged.displayQty === "1 portion" && logged.grams === 100 &&
        logged.macros.kcal === 200 && logged.macros.p === 10 &&
        logged.macros.na === null && logged.macros.k === null &&
        !Object.prototype.hasOwnProperty.call(logged, "per100"),
      "Log once writes a 1-portion one-off (100 g mass metadata) with no per100 and unknown minerals");
    ok(App.state.personalFoods.length === foodsBefore,
      "Log once does not add anything to My Foods");

    // Acceptance: Batch mass → Totals as 1 portion (not 100 g of per100 density).
    {
      const batchDay = "2019-06-30";
      App.state.viewDay = batchDay;
      [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
      $("#fab-add").click();
      $("#btn-paste-new").click();
      $("#btn-manual-food").click();
      $("#rev-name").value = "Hot Iron Mongolian Grill Lunch";
      $("#rev-kcal").value = "142";
      $("#rev-p").value = "9.8";
      $("#rev-c").value = "16.1";
      $("#rev-f").value = "4.3";
      $("#rev-fb").value = "1.8";
      $("#rev-na").value = "289";
      $("#rev-k").value = "278";
      $("#rev-batch-g").value = "900";
      $("#rev-batch-s").value = "1";
      $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
      $("#btn-review-log-once").click();
      const batchLogged = Ledger.entriesFor(batchDay).find(
        (e) => e.source === "once" && e.name === "Hot Iron Mongolian Grill Lunch"
      );
      ok(batchLogged && batchLogged.unit === "portion" && batchLogged.qty === 1 &&
          batchLogged.displayQty === "1 portion" && batchLogged.grams === 900 &&
          batchLogged.macros.kcal === 1278 &&
          Math.abs(batchLogged.macros.p - 88.2) < 0.05 &&
          batchLogged.macros.na === 2601 && batchLogged.macros.k === 2502 &&
          !Object.prototype.hasOwnProperty.call(batchLogged, "per100"),
        "Log once with Batch 900 g logs 1 portion at Totals (1278 kcal), not 100 g");
      ok(App.state.personalFoods.length === foodsBefore,
        "Batch Log once still does not add to My Foods");
      App.state.viewDay = logOnceDay;
    }
    // Hidden while updating a library food.
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "foods").click();
    await new Promise((r) => setTimeout(r, 20));
    const libFood = App.state.personalFoods.find((f) => f.id === "baseline-food")
      || App.state.personalFoods[0];
    if (libFood) {
      $(`#foods-list [data-id='${libFood.id}']`).click();
      await new Promise((r) => setTimeout(r, 20));
      const editBtn = $("#detail-body [data-action='edit-food']");
      if (editBtn) {
        editBtn.click();
        ok(!!$("#btn-review-log-once") && $("#btn-review-log-once").hidden,
          "Log once is hidden while updating a library food");
        $("#btn-review-back").click();
      }
      UI.closeSheet("sheet-detail");
      await new Promise((r) => setTimeout(r, 220));
    }

    // N1 / Step 5 F1: Update that one must hide Log once (not leave it clickable/inert).
    const dupFood = App.state.personalFoods.find((f) => f.id === "baseline-food")
      || App.state.personalFoods[0];
    ok(!!dupFood, "fixture: a library food exists for the duplicate-banner path");
    if (dupFood) {
      [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
      $("#fab-add").click();
      $("#btn-paste-new").click();
      $("#btn-manual-food").click();
      App.state.updateFoodId = null;
      App.state.saveAsNew = false;
      UI.showReview(App.state.reviewParsed, {
        forceEnable: true,
        duplicate: dupFood,
        title: "Review food",
      });
      $("#rev-name").value = dupFood.name;
      $("#rev-kcal").value = "100";
      $("#rev-p").value = "5";
      $("#rev-c").value = "10";
      $("#rev-f").value = "2";
      $("#rev-fb").value = "1";
      $("#rev-na").value = "";
      $("#rev-k").value = "";
      $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
      ok(!$("#review-dup").hidden && !$("#btn-review-log-once").hidden,
        "duplicate banner shows with Log once still available before choosing");
      $("#review-dup [data-action='update-dup']").click();
      ok(App.state.updateFoodId === dupFood.id && $("#btn-review-log-once").hidden,
        "Update that one hides Log once via validateReviewSave");
      // Re-arm the banner (update-dup hides it) to exercise save-new-anyway.
      UI.$("#review-dup").hidden = false;
      UI.$("#review-dup").innerHTML = `You already have “Baseline”.
        <div class="row" style="margin-top:8px">
          <button type="button" class="btn ghost" data-action="update-dup" data-id="${dupFood.id}">Update that one</button>
          <button type="button" class="btn ghost" data-action="save-new-anyway">Save as separate</button>
        </div>`;
      $("#review-dup [data-action='save-new-anyway']").click();
      ok(App.state.updateFoodId == null && !$("#btn-review-log-once").hidden,
        "Save as separate clears updateFoodId and restores Log once");
      UI.closeSheet("sheet-paste");
      await new Promise((r) => setTimeout(r, 220));
    }

    App.state.viewDay = today;
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
  }


  // Step 6 — Estimate with AI entry: ESTIMATE_PROMPT + Log once primary.
  {
    const UI = window.eval("UI");
    const NutriParse = window.eval("NutriParse");
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "today").click();
    $("#fab-add").click();
    $("#btn-once-food").click();
    ok(!$("#sheet-once").hidden && !$("#once-estimate-ai").hidden,
      "Estimate with AI lives on the Log once sheet");
    const estBtn = $("#once-estimate-ai");
    const saveBtn = $("#once-save");
    const confEl = $("#once-confidence");
    ok(!!estBtn && !!saveBtn && !!confEl &&
        !!(confEl.compareDocumentPosition(estBtn) & window.Node.DOCUMENT_POSITION_FOLLOWING) &&
        !!(estBtn.compareDocumentPosition(saveBtn) & window.Node.DOCUMENT_POSITION_FOLLOWING) &&
        estBtn.classList.contains("btn") && estBtn.classList.contains("ghost"),
      "Phase 1: Estimate with AI sits below confidence and above Save as a ghost full button");

    $("#once-name").value = "Airport pad thai";
    $("#once-kcal").value = "850";
    const portionG = $("#once-units [data-unit='g']");
    if (portionG) portionG.click();
    $("#once-qty").value = "400";
    $("#once-estimate-ai").click();
    ok(App.state.foodSaveIntent === "estimate" &&
        /Estimate with AI/i.test(($("#paste-title") && $("#paste-title").textContent) || ""),
      "Estimate entry sets estimate intent and paste title");
    ok(/What I ate \(attach/i.test(NutriParse.ESTIMATE_PROMPT),
      "fixture: ESTIMATE_PROMPT is loaded in the page");
    const promptText = NutriParse.ESTIMATE_PROMPT + String(App.state.estimateSeedText || "");
    const ateIdx = promptText.indexOf("What I ate (attach");
    ok(ateIdx >= 0 && /Airport pad thai/.test(promptText.slice(ateIdx)) &&
        /850/.test(promptText.slice(ateIdx)) && /400 g/.test(promptText.slice(ateIdx)),
      "Phase 1: Estimate prompt seeds name, kcal, and portion into the What I ate slot",
      promptText.slice(Math.max(0, ateIdx)));
    $("#sheet-paste [data-close='sheet-paste']").click();
    await new Promise((r) => setTimeout(r, 40));
    ok(!$("#sheet-once").hidden && $("#once-name").value === "Airport pad thai" &&
        $("#once-kcal").value === "850",
      "Phase 1: Cancel paste restores the Log once draft");
    UI.closeSheet("sheet-once");
    App.state.onceDraftPending = null;
    App.state.estimateSeedText = "";
    await new Promise((r) => setTimeout(r, 40));

    $("#fab-add").click();
    $("#btn-once-food").click();
    $("#once-estimate-ai").click();
    ok(App.state.foodSaveIntent === "estimate" &&
        /Estimate with AI/i.test(($("#paste-title") && $("#paste-title").textContent) || ""),
      "Estimate entry sets estimate intent and paste title (empty seed path)");
    ok(/What I ate \(attach/i.test(NutriParse.ESTIMATE_PROMPT),
      "fixture: ESTIMATE_PROMPT is loaded in the page");
    $("#btn-manual-food").click();
    $("#rev-name").value = "Restaurant Bowl";
    $("#rev-kcal").value = "180";
    $("#rev-p").value = "12";
    $("#rev-c").value = "20";
    $("#rev-f").value = "5";
    $("#rev-fb").value = "3";
    $("#rev-na").value = "";
    $("#rev-k").value = "";
    if (App.state.reviewParsed && App.state.reviewParsed.food) {
      App.state.reviewParsed.food.confidence = "low";
    }
    $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
    ok(!$("#btn-review-log-once").disabled &&
        $("#btn-review-log-once").classList.contains("btn") &&
        !$("#btn-review-log-once").classList.contains("ghost") &&
        $("#btn-review-save").classList.contains("ghost"),
      "valid estimate draft makes Log once primary and Save food secondary");
    const estDay = "2019-07-02";
    App.state.viewDay = estDay;
    $("#btn-review-log-once").click();
    const estEntry = Ledger.entriesFor(estDay).find((e) => e.name === "Restaurant Bowl" && e.source === "once");
    ok(estEntry && estEntry.sd === 0.40 && !Object.prototype.hasOwnProperty.call(estEntry, "per100"),
      "Log once from estimate seeds low confidence as rough (sd 0.40) with no per100");
    UI.closeSheet("sheet-paste");
    App.state.viewDay = today;
    await new Promise((r) => setTimeout(r, 220));

    // M2 fix: Confidence: high (label-backed) → weighed sd 0.10 on Log once.
    $("#fab-add").click();
    $("#btn-once-food").click();
    $("#once-estimate-ai").click();
    $("#btn-manual-food").click();
    $("#rev-name").value = "Labeled Burrito";
    $("#rev-kcal").value = "200";
    $("#rev-p").value = "12";
    $("#rev-c").value = "20";
    $("#rev-f").value = "8";
    $("#rev-fb").value = "3";
    $("#rev-na").value = "500";
    $("#rev-k").value = "";
    if (App.state.reviewParsed && App.state.reviewParsed.food) {
      App.state.reviewParsed.food.confidence = "high";
    }
    $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
    const labelDay = "2019-07-03";
    App.state.viewDay = labelDay;
    $("#btn-review-log-once").click();
    const labelEntry = Ledger.entriesFor(labelDay).find((e) => e.name === "Labeled Burrito" && e.source === "once");
    ok(labelEntry && labelEntry.sd === 0.10 && !Object.prototype.hasOwnProperty.call(labelEntry, "per100"),
      "Log once from estimate maps Confidence:high to weighed (sd 0.10) with no per100");
    UI.closeSheet("sheet-paste");
    App.state.viewDay = today;
    await new Promise((r) => setTimeout(r, 220));

    // L2: incomplete estimate draft keeps Log once ghost (not solid-primary while disabled).
    $("#fab-add").click();
    $("#btn-once-food").click();
    $("#once-estimate-ai").click();
    $("#btn-manual-food").click();
    $("#rev-name").value = "";
    $("#rev-kcal").value = "";
    $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
    ok($("#btn-review-log-once").disabled && $("#btn-review-log-once").classList.contains("ghost") &&
        $("#btn-review-save").classList.contains("ghost"),
      "incomplete estimate draft shows both actions ghosted (Log once not solid while disabled)");

    // L3: dismiss paste resets estimate intent.
    $("#sheet-paste [data-close='sheet-paste']").click();
    await new Promise((r) => setTimeout(r, 40));
    ok(App.state.foodSaveIntent === "library",
      "closing paste sheet resets foodSaveIntent away from estimate");
    if (!$("#sheet-once").hidden) UI.closeSheet("sheet-once");
    App.state.onceDraftPending = null;
    App.state.estimateSeedText = "";
    App.state.viewDay = today;
    await new Promise((r) => setTimeout(r, 220));

    // Phase 0.2: Edit Quick → Estimate → Log once amends the same id (no duplicate).
    {
      const repairDay = "2019-07-04";
      App.state.viewDay = repairDay;
      Ledger.addEntry(repairDay, {
        name: "Quick sandwich",
        foodId: null, cat: "meal", grams: 0, displayQty: "500 kcal", qty: 500, unit: "kcal",
        macros: { kcal: 500, p: 0, c: 0, f: 0, fb: 0, na: null, k: null },
        sd: 0.40, meal: "lunch", source: "quick",
      });
      const before = Ledger.entriesFor(repairDay).find((e) => e.name === "Quick sandwich");
      ok(!!before && before.source === "quick", "fixture: quick entry on repair day");
      UI.renderDayLog(repairDay, Ledger.entriesFor(repairDay));
      $(`#day-log [data-action='toggle-entry'][data-id='${before.id}']`).click();
      $(`#day-log [data-action='edit-entry'][data-id='${before.id}']`).click();
      await new Promise((r) => setTimeout(r, 40));
      ok(!$("#sheet-once").hidden && App.state.editEntryId === before.id && !$("#once-estimate-ai").hidden,
        "editing a quick entry keeps Estimate with AI available");
      $("#once-estimate-ai").click();
      ok(App.state.foodSaveIntent === "estimate" && App.state.editEntryId === before.id,
        "Estimate from edit keeps editEntryId armed for amend");
      // Soft cancel restores Log once with edit still armed, then continue repair via Estimate again.
      $("#sheet-paste [data-close='sheet-paste']").click();
      await new Promise((r) => setTimeout(r, 40));
      ok(!$("#sheet-once").hidden && App.state.editEntryId === before.id &&
          /sandwich/i.test($("#once-name").value || ""),
        "Phase 1: Cancel paste after Estimate-from-edit restores once sheet with editEntryId");
      $("#once-estimate-ai").click();
      ok(App.state.foodSaveIntent === "estimate" && App.state.editEntryId === before.id,
        "Estimate from restored edit keeps editEntryId armed for amend");
      $("#btn-manual-food").click();
      $("#rev-name").value = "Repaired sandwich";
      $("#rev-kcal").value = "220";
      $("#rev-p").value = "18";
      $("#rev-c").value = "20";
      $("#rev-f").value = "8";
      $("#rev-fb").value = "2";
      $("#rev-na").value = "";
      $("#rev-k").value = "";
      $("#rev-name").dispatchEvent(new window.Event("input", { bubbles: true }));
      $("#btn-review-log-once").click();
      await new Promise((r) => setTimeout(r, 40));
      const after = Ledger.entriesFor(repairDay);
      const repaired = after.find((e) => e.id === before.id);
      ok(after.filter((e) => /sandwich/i.test(e.name)).length === 1,
        "repair leaves exactly one sandwich entry on the day",
        after.map((e) => `${e.id}:${e.name}:${e.source}`).join(" | "));
      ok(repaired && repaired.source === "once" && repaired.name === "Repaired sandwich" &&
          repaired.meal === "lunch" && repaired.macros.p === 18 &&
          !Object.prototype.hasOwnProperty.call(repaired, "per100"),
        "Log once from estimate amends the quick entry into a full once (same id, meal preserved)");
      ok(!App.state.editEntryId, "editEntryId cleared after amend repair");
    }
    App.state.viewDay = today;
    await new Promise((r) => setTimeout(r, 220));

    $("#fab-add").click();
    $("#btn-paste-new").click();
    $("#btn-manual-food").click();
    ok($("#btn-review-save").classList.contains("btn") &&
        !$("#btn-review-save").classList.contains("ghost") &&
        $("#btn-review-log-once").classList.contains("ghost"),
      "Homemade dish path keeps Save food primary");
    UI.closeSheet("sheet-paste");
    await new Promise((r) => setTimeout(r, 220));
  }


  // Step 6 M1 — Settings estimate-prompt clipboard fallback stays visible in Settings.
  {
    const UI = window.eval("UI");
    const NutriParse = window.eval("NutriParse");
    [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "settings").click();
    await new Promise((r) => setTimeout(r, 20));
    ok($("#sheet-paste").hidden, "fixture: paste sheet is closed while in Settings");
    // jsdom often has no clipboard; absent and rejecting both must open the Settings fallback.
    const desc = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new Error("denied")),
        readText: () => Promise.reject(new Error("denied")),
      },
    });
    $("#btn-settings-copy-prompt").click();
    await new Promise((r) => setTimeout(r, 40));
    const setFb = $("#settings-prompt-fallback");
    const setTa = $("#settings-prompt-fallback-text");
    ok(!!$("#sheet-paste").hidden && setFb && !setFb.hidden && setFb.open &&
        setTa && setTa.value === NutriParse.ESTIMATE_PROMPT,
      "Settings clipboard fallback shows ESTIMATE_PROMPT under Settings, not inside the closed paste sheet");
    ok($("#sheet-paste").hidden,
      "clipboard failure in Settings does not open the paste sheet");
    if (desc) Object.defineProperty(navigator, "clipboard", desc);
    else delete navigator.clipboard;
    if (setFb) { setFb.hidden = true; setFb.open = false; }
    if (setTa) setTa.value = "";
  }

  // Part IX.5: notScored() lacked incompleteMineral's empty-day guard, so a
  // declared fast with nothing logged at all printed "0 mg* · not scored
  // today" plus a spurious "N% covered" footnote — there was no food to
  // cover a percentage of. Call the real UI.updateHUD directly against a
  // genuinely empty day, so this does not depend on Today's current viewDay
  // (which already carries this run's other fixtures).
  const UI = window.eval("UI");
  const emptyFastDay = "2018-03-11";
  ok(Ledger.totalsFor(emptyFastDay).count === 0, "IX.5 fixture sanity: the empty-fast day has no logged entries");
  const emptyFastSettings = {
    ...App.state.settings,
    dayGoals: {
      ...App.state.settings.dayGoals,
      [emptyFastDay]: { targetKcal: 0, baseKcal: 2200, updatedAt: 1, intent: "fast", fastAcknowledged: true },
    },
  };
  const emptyFastGoals = Phases.goalsForDay(emptyFastDay, emptyFastSettings);
  UI.updateHUD(Ledger.totalsFor(emptyFastDay), emptyFastGoals, {
    viewDay: emptyFastDay, todayKey: Ledger.todayKey(),
  });
  ok($("#v-sodium").textContent.trim() === "—" && $("#v-potassium").textContent.trim() === "—",
    "IX.5: a declared fast with nothing logged shows a plain dash, not \"0 mg* · not scored today\"");
  ok($("#v-p").textContent.trim() === "—",
    "IX.5: the same empty-day guard applies to the shared notScored() path used by macros, not just minerals");
  ok($("#v-na").hidden && $("#v-na").textContent.trim() === "",
    "IX.5: no food logged means no coverage footnote either — a \"% covered\" figure would misstate that nothing was measured");
  // Part X.3: one line below the row IX.5 fixed. The unscored.naK branch
  // short-circuited ahead of the ratio == null → hidden branch, so the same
  // empty day that shows a plain dash on every other row read "Na:K — not
  // scored today" here instead.
  ok($("#v-nak").textContent.trim() === "—",
    "X.3: the naK line gets the same empty-day guard — a fast with nothing logged reads a plain dash, not \"Na:K — not scored today\"");

  // Once durable replacement succeeds, a renderer failure must not be called
  // an import failure, and Drive sync must still be scheduled.
  const refreshFailureBackup = currentBackup();
  refreshFailureBackup.settings.theme = refreshFailureBackup.settings.theme === "dark" ? "light" : "dark";
  const expectedCommittedTheme = refreshFailureBackup.settings.theme;
  const rootElement = window.document.documentElement;
  const originalRootSetAttribute = rootElement.setAttribute;
  let throwThemeOnce = true;
  rootElement.setAttribute = function (name, value) {
    if (throwThemeOnce && name === "data-theme") {
      throwThemeOnce = false;
      throw new window.Error("fixture render failure");
    }
    return originalRootSetAttribute.call(this, name, value);
  };
  let postCommitSyncCalls = 0;
  Sync.fullSync = () => { postCommitSyncCalls += 1; return Promise.resolve({ ok: true }); };
  try {
    await importBackup(window, refreshFailureBackup);
  } finally {
    rootElement.setAttribute = originalRootSetAttribute;
    Sync.fullSync = originalFullSync;
  }
  const refreshFailureStored = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  ok(refreshFailureStored.theme === expectedCommittedTheme && /Imported, but the screen could not refresh/.test($("#toast").textContent),
    "post-commit refresh failure reports a successful replacement with reload guidance");
  ok(!/Import failed/.test($("#toast").textContent) && postCommitSyncCalls === 1,
    "post-commit refresh failure never claims rollback and still schedules Drive sync");

  // Exercise the actual exporter and feed its bytes back through the importer
  // at the producer's maximum AI text size and beyond the old 250-weight cap.
  const maxBackup = currentBackup();
  maxBackup.personalFoods[0].raw = "R".repeat(12000);
  maxBackup.settings.weights = {};
  for (let i = 0; i < 300; i++) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    maxBackup.settings.weights[date] = { kg: 80 - i * 0.01, updatedAt: 1000 + i };
  }
  await importBackup(window, maxBackup);
  let roundTripFoods = JSON.parse(window.localStorage.getItem("nd_personal_v1"));
  let roundTripSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  ok(/^Imported$/.test($("#toast").textContent.trim()) && roundTripFoods[0].raw.length === 12000,
    "import accepts the same 12,000-character AI text that the app exports");
  ok(Object.keys(roundTripSettings.weights).length === 300,
    "import accepts a bounded weight history with more than 250 dates");

  let exportedBlob = null;
  window.URL.createObjectURL = (blob) => { exportedBlob = blob; return "blob:nutridaily-test"; };
  window.URL.revokeObjectURL = () => {};
  const originalAnchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {};
  try {
    $("#btn-export").click();
  } finally {
    window.HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
  ok(!!exportedBlob, "real export workflow produces a JSON Blob");
  const exportedText = await new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("could not read export"));
    reader.readAsText(exportedBlob);
  });
  const exportedPayload = JSON.parse(exportedText);
  const exportedCausal = exportedPayload.events
    .filter((event) => event.causal)
    .map((event) => ({ id: event.id, causal: event.causal }));
  ok(exportedCausal.length > 0, "real export includes causal metadata for new ledger mutations");
  await importBackup(window, exportedPayload);
  roundTripFoods = JSON.parse(window.localStorage.getItem("nd_personal_v1"));
  roundTripSettings = JSON.parse(window.localStorage.getItem("nd_settings_v1"));
  ok(/^Imported$/.test($("#toast").textContent.trim()) && roundTripFoods[0].raw.length === 12000 &&
      Object.keys(roundTripSettings.weights).length === 300,
    "a maximum-size app export imports back into the app without mutation or rejection");
  const roundTripCausal = Ledger.allEvents()
    .filter((event) => event.causal)
    .map((event) => ({ id: event.id, causal: event.causal }));
  ok(JSON.stringify(roundTripCausal) === JSON.stringify(exportedCausal),
    "export/import round-trip preserves the causal event schema exactly");
  const roundTripBoundaryFood = roundTripFoods.find((food) => food.name === "M".repeat(160));
  const roundTripEntries = Ledger.entriesFor("2020-01-02");
  ok(roundTripBoundaryFood && roundTripBoundaryFood.aliases.length === 50 &&
      roundTripBoundaryFood.raw.length === 12000 && roundTripBoundaryFood.units.piece === 1e9 &&
      roundTripBoundaryFood.batch.servings === 1e7 && roundTripBoundaryFood.per100.k === 60000 &&
      roundTripEntries.some((entry) => entry.name.length === 160 && entry.qty === 1e9 && entry.macros.kcal === 1e9) &&
      roundTripEntries.some((entry) => entry.grams === 1e9 && entry.macros.kcal === 1e9),
    "trusted quick-kcal, diary, and manual-food producers round-trip through the inbound normalizer at exact boundaries");

  dom.window.close();
}

// --- target-version deletion must preserve immutable logged history --------
async function runRevisionDeletionGuard() {
  console.log("\n[phase revision deletion guard]");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  installPrimaryLock(window);
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} }; };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.confirm = () => true;

  const shift = (day, delta) => {
    const d = new Date(`${day}T12:00:00`);
    d.setDate(d.getDate() + delta);
    return dayKey(d);
  };
  const today = dayKey(new Date());
  const yesterday = shift(today, -1);
  const tomorrow = shift(today, 1);
  const goals = { kcal: 2100, protein: 150, carbs: 240, fat: 70, fiber: 30, sodium: 2300, potassium: 3400 };
  const removedEntry = {
    id: "phase-removed-entry", name: "Removed meal", grams: 100, displayQty: "100 g", meal: "snack",
    macros: { kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 20, k: 40 }, sd: 0.1,
  };
  window.localStorage.setItem("nd_events_v1", JSON.stringify([
    { id: "phase-root", ts: 10, day: today, type: "add", entry: removedEntry },
    { id: "phase-remove", ts: 11, day: today, type: "remove", target: removedEntry.id },
  ]));
  window.localStorage.setItem("nd_personal_v1", "[]");
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals, goalsUpdatedAt: 3, dayGoals: {}, dayPlans: {}, gapDrafts: {}, weights: {}, profile: {},
    weightUnit: "lb", theme: "light", phases: [{
      id: "phase-delete-guard", name: "Maintain v1.2", kind: "maintain",
      versionMajor: 1, versionMinor: 2, startDay: yesterday, endDay: null,
      createdAt: 1, updatedAt: 3, archived: false, revisionTombstones: {}, revisions: [
        { id: "revision-unused", effectiveFrom: yesterday, goals: { ...goals, kcal: 2000 }, createdAt: 1, updatedAt: 1, version: "1.0", label: "Maintain v1.0" },
        { id: "revision-governed", effectiveFrom: today, goals, createdAt: 2, updatedAt: 2, version: "1.1", label: "Maintain v1.1" },
        { id: "revision-future", effectiveFrom: tomorrow, goals: { ...goals, kcal: 2200 }, createdAt: 3, updatedAt: 3, version: "1.2", label: "Maintain v1.2" },
      ],
    }],
  }));
  window.localStorage.setItem("nd_onboarded_v1", "1");
  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  await bootApp(window);
  const $ = (selector) => window.document.querySelector(selector);
  const App = window.eval("App");
  const Ledger = window.eval("Ledger");
  const Phases = window.eval("Phases");
  const Sync = window.eval("Sync");
  [...window.document.querySelectorAll(".tab")].find((tab) => tab.dataset.view === "settings").click();
  $("#btn-phase-history").click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const governedRow = $("#phase-revision-list [data-rev-id='revision-governed']");
  ok(governedRow && !governedRow.querySelector(".rev-del") && /logged history/i.test(governedRow.textContent),
    "UI omits Delete and explains a version protected by immutable logged history");
  const beforeProgrammatic = JSON.stringify(App.state.settings);
  const refused = Phases.deleteRevision(
    App.state.settings, "phase-delete-guard", "revision-governed", today
  );
  ok(!refused.ok && refused.reason === "governed" && JSON.stringify(App.state.settings) === beforeProgrammatic,
    "data-layer deletion refuses a governed version without mutation after its visible entry was removed");

  // Capture a valid button, then introduce an add that makes it stale before
  // activation. The click handler must perform its own fresh guard.
  const staleButton = $("#phase-revision-list [data-rev-id='revision-future'] .rev-del");
  ok(!!staleButton, "an ungoverned future target version initially exposes Delete");
  let syncCalls = 0;
  const originalSchedulePush = Sync.schedulePush;
  Sync.schedulePush = () => { syncCalls += 1; };
  Ledger.addEntry(tomorrow, {
    id: "future-entry", name: "Future fixture", grams: 100, displayQty: "100 g", meal: "snack",
    macros: { kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 20, k: 40 }, sd: 0.1,
  });
  const settingsBeforeStaleClick = window.localStorage.getItem("nd_settings_v1");
  staleButton.click();
  ok(window.localStorage.getItem("nd_settings_v1") === settingsBeforeStaleClick && syncCalls === 0 &&
      !App.state.settings.phases[0].revisionTombstones["revision-future"] && /can.t be deleted/i.test($("#toast").textContent),
    "stale Delete handler rechecks history and refuses without tombstone or sync");

  const unusedButton = $("#phase-revision-list [data-rev-id='revision-unused'] .rev-del");
  unusedButton.click();
  ok(!App.state.settings.phases[0].revisions.some((revision) => revision.id === "revision-unused") && syncCalls === 1,
    "UI still deletes and syncs a version that never governed an immutable add");
  Sync.schedulePush = originalSchedulePush;
  dom.window.close();
}

// --- day-intent release gate: X.2 disclosure/contradiction, X.4 sodium ceiling
async function runDayIntentReleaseGate() {
  console.log("\n[day-intent release gate] Part X.2 / X.4");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="https:\/\/accounts\.google\.com[^"]*"[^>]*><\/script>/, "");
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true });
  const { window } = dom;
  installPrimaryLock(window);
  window.HTMLCanvasElement.prototype.getContext = function () { const c = fakeCtx(); c.canvas = this; return c; };
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get() { return 360; }, configurable: true });
  window.Element.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 360, height: 200, right: 360, bottom: 200, x: 0, y: 0, toJSON() {} }; };
  window.HTMLElement.prototype.scrollIntoView = () => {};

  const today = new Date();
  const k = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return dayKey(d); };

  // 9 ordinary eating days, every target hit exactly, plus 4 declared fasts
  // (logged as black coffee: zero kcal, zero-but-known sodium) at the recent
  // end of the default 14-day range. 13 logged days, matching the numbers
  // measured live in Part X.4/X.2's report.
  const eatingDays = [];
  for (let i = 5; i <= 13; i++) eatingDays.push(k(i));
  const fastDays = [k(1), k(2), k(3), k(4)];

  const events = [];
  for (const day of eatingDays) {
    events.push({
      id: `eat-${day}`, ts: Date.now(), day, type: "add",
      entry: {
        id: `eat-entry-${day}`, name: "Eating day meal", displayQty: "300 g", grams: 300, meal: "lunch",
        macros: { kcal: 2000, p: 150, c: 200, f: 65, fb: 30, na: 1500 }, sd: 0.1,
      },
    });
  }
  for (const day of fastDays) {
    events.push({
      id: `fast-${day}`, ts: Date.now(), day, type: "add",
      entry: {
        id: `fast-entry-${day}`, name: "Black coffee", displayQty: "1 cup", grams: 240, meal: "snack",
        macros: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0 }, sd: 0.1,
      },
    });
  }
  const dayGoals = {};
  for (const day of fastDays) {
    dayGoals[day] = { targetKcal: 0, baseKcal: 2200, updatedAt: 1, intent: "fast", fastAcknowledged: true };
  }

  window.localStorage.setItem("nd_events_v1", JSON.stringify(events));
  window.localStorage.setItem("nd_settings_v1", JSON.stringify({
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300 },
    weights: {}, weightUnit: "kg", phases: [], profile: {}, dayGoals,
  }));

  for (const src of [...window.document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src"))) {
    if (!src || /^https?:/.test(src)) continue;
    inject(window, src);
  }
  await bootApp(window);
  const $ = (s) => window.document.querySelector(s);
  const text = (s) => ($(s) ? $(s).textContent : "");

  const tab = [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights");
  tab.click();
  await new Promise((r) => setTimeout(r, 60));

  // --- X.4: constraint() must exclude exempted days from the sodium ceiling
  // average, not credit them. 9 eating days at 1,500 mg each; 4 declared
  // fasts logged at 0 mg (sodiumCovered true). Pre-fix this blends to
  // (9*1500 + 4*0) / 13 ≈ 1,038 mg across 13 "usable" days.
  const nakText = text("#nak-card");
  ok(/Sodium 1,500 mg\/day across 9 usable days/.test(nakText),
    "X.4: the sodium ceiling average excludes declared-fast days from the denominator, not just credits them at 0",
    nakText);
  ok(!/across 13 usable days/.test(nakText),
    "X.4: fast days do not inflate the usable-day count for the sodium ceiling");

  // --- X.2a: statusFor must not print a band verdict for an exempted cell.
  // Use an untouched honoured fast (fastDays[0]); P1 below mutates a different
  // fast day so these assertions keep a true exempted cell.
  const proteinPill = window.document.querySelector('#insight-nutrient [data-nutrient="protein"]');
  proteinPill.click();
  await new Promise((r) => setTimeout(r, 30));
  const trendDetails = $("#trend-data details");
  trendDetails.open = true;
  const fastBtn = $(`#trend-data button.chart-day-link[data-day="${fastDays[0]}"]`);
  ok(!!fastBtn, "X.2a fixture sanity: the day list exposes a row for the declared-fast day");
  if (fastBtn) {
    const cells = [...fastBtn.closest("tr").querySelectorAll("td")];
    const statusCell = cells[cells.length - 1];
    ok(!/\bshort\b/i.test(statusCell.textContent),
      "X.2a: the day list does not print 'short' for a protein cell the plan exempted",
      statusCell.textContent);
    ok(/not scored/i.test(statusCell.textContent),
      "X.2a: the day list instead discloses the exemption, matching Today's own wording",
      statusCell.textContent);
  }

  // --- X.2a: renderDayDetail must agree with the day list and Today.
  if (fastBtn) {
    const UI = window.eval("UI");
    const App = window.eval("App");
    const Phases = window.eval("Phases");
    UI.renderDayDetail(fastDays[0], {
      metric: "protein",
      root: "#today-day-detail",
      settings: App.state.settings,
      goals: Phases.goalsForDay(fastDays[0], App.state.settings),
    });
    await new Promise((r) => setTimeout(r, 20));
    const detailText = text("#today-day-detail");
    ok(!/\d+\s*g short/i.test(detailText),
      "X.2a: renderDayDetail does not print '150 g short' for the same exempted protein cell",
      detailText);
    ok(/not scored today/i.test(detailText),
      "X.2a: renderDayDetail says not scored today, agreeing with Today and the day list",
      detailText);
  }

  // --- X.2b: the scorecard discloses the exemption instead of dropping the
  // row silently — the label VI.2 step 4 specified, sourced from the same
  // exemptByPlan fact scoreDayTotals already stamps.
  // Run while all four honoured fasts remain (before the P1 mutation).
  const pRow = [...window.document.querySelectorAll("#insight-scorecard .score-tile")]
    .find((li) => /Protein/.test(li.textContent));
  ok(!!pRow && /not scored on 4 planned days/i.test(pRow.textContent),
    "X.2b: the scorecard's protein tile discloses 'not scored on 4 planned days'",
    pRow && pRow.textContent);

  // P1 regression: a declared fast that ate food must ENTER the sodium usable
  // set (effectiveGoals clears _unscored). Mutate one already-in-range
  // honoured fast day (fastDays[3], not the X.2a day) so the Insights window
  // and dayGoals stay put — usable should become 10 at
  // (9*1500 + 5200)/10 = 1870, not stay 9.
  const Ledger = window.eval("Ledger");
  const revertedDay = fastDays[3];
  Ledger.removeEntry(revertedDay, `fast-entry-${revertedDay}`);
  Ledger.addEntry(revertedDay, {
    name: "Reverted fast meal", displayQty: "400 g", grams: 400, meal: "dinner",
    macros: { kcal: 3000, p: 150, c: 300, f: 100, fb: 30, na: 5200 }, sd: 0.1,
  });
  [...window.document.querySelectorAll(".tab")].find((t) => t.dataset.view === "insights").click();
  await new Promise((r) => setTimeout(r, 60));
  const nakReverted = text("#nak-card");
  ok(/across 10 usable days/.test(nakReverted),
    "P1: a declared fast that recorded food re-enters the sodium usable set via effectiveGoals",
    nakReverted);
  ok(/Sodium 1,870 mg\/day across 10 usable days/.test(nakReverted),
    "P1: sodium average includes the reverted fast's 5200 mg rather than dropping the day",
    nakReverted);

  dom.window.close();
}

(async () => {
  await run("main", 90);
  await run("short", 21);
  await runObservationsTriage();
  await runSparse();
  await runEmpty();
  await runActiveTabLock();
  await runGenerationRolloutIntegration();
  await runImportSecurity();
  await runRevisionDeletionGuard();
  await runDayIntentReleaseGate();

  console.log("\n[console errors]");
  const real = errors.filter((e) => !/Could not load|Not implemented|css/i.test(e));
  if (real.length) real.slice(0, 12).forEach((e) => console.error("  !", e));
  ok(real.length === 0, "no runtime errors in any scenario", real.slice(0, 3).join(" | "));

  console.log(`\nsmoke: ${pass} passed, ${fail} failed\n`);
  process.exitCode = fail ? 1 : 0;
})();
