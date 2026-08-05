/* NutriDaily day-intent chain tests — run with: node tests/test-day-intent-chain.js
 *
 * The unit suites cover each module well. This one covers the seam between
 * them, because that is where every expensive defect in this feature has lived:
 * a target that drifts only once heal has written a record, an `intent` that
 * survives its own module but not a merge, a zero that no validator authored.
 * None of those are visible to a test that calls one function.
 *
 * So the shape here is deliberately end to end and deliberately repeated:
 * resolve -> lock -> log -> merge -> resolve -> merge again. Two round trips,
 * not one, because a record that degrades on the second pass looks perfect on
 * the first. Fixtures are small and hand-checkable; every number below can be
 * derived on paper from the phase goals at the top.
 *
 * The one seam this file cannot reach is app.js, which has no module exports
 * (it is an IIFE returning {boot, state}). Its import/export normalizers are
 * covered against the real DOM in tests/smoke-insights.js instead.
 */
const Phases = require("../js/phases.js");
globalThis.Phases = Phases;
const Analytics = require("../js/analytics.js");
globalThis.Analytics = Analytics;
const Ledger = require("../js/ledger.js");
const Sync = require("../js/sync.js");

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}

// ---------------------------------------------------------------- fixtures

const PHASE = {
  kcal: 2000, protein: 150, carbs: 200, fat: 65,
  fiber: 30, sodium: 2300, potassium: 3510,
};
const FLOORS = ["protein", "fiber", "sodium", "potassium"];

function settingsWith(dayGoals) {
  return { goals: { ...PHASE }, phases: [], weights: {}, dayGoals: dayGoals || {} };
}

/** A memory store shaped like localStorage, so Ledger can run under Node. */
function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

/** Mirrors app.js's getDayGoalLock: the snapshot handed to Ledger on first add. */
function dayGoalLockFor(day, settings) {
  const resolved = Phases.goalsForDay(day, settings);
  const bumps = resolved && resolved._bumps;
  if (!bumps || !Number.isFinite(bumps.targetKcal)) return null;
  const out = {
    targetKcal: bumps.targetKcal,
    baseKcal: bumps.baseKcal,
  };
  if (bumps.plannedAt) out.plannedAt = bumps.plannedAt;
  const record = settings.dayGoals[day] || {};
  if (record.veryLowCalorieAcknowledged === true) out.veryLowCalorieAcknowledged = true;
  if (record.intent === "fast" && record.fastAcknowledged === true) {
    out.intent = "fast";
    out.fastAcknowledged = true;
  }
  return out;
}

function docFrom(settings, events) {
  return {
    version: 2, resetAt: 0, events: events || [], personalFoods: [],
    dayGoals: settings.dayGoals, dayPlans: {}, gapDrafts: {},
    weights: settings.weights, goals: settings.goals, phases: settings.phases,
  };
}

/** One full sync round trip: local doc merged against itself, as Drive does. */
function roundTrip(settings, events) {
  const doc = docFrom(settings, events);
  const merged = Sync.mergeDocs(doc, JSON.parse(JSON.stringify(doc)));
  return { ...settings, dayGoals: merged.doc.dayGoals };
}

const FAST_DAY = "2026-08-01";
const REDUCED_DAY = "2026-08-02";
const NORMAL_DAY = "2026-08-03";

// ------------------------------------------------------------------ tests

console.log("\n[1] A no-op locked record resolves to the phase goals, byte for byte");
{
  // heal writes {targetKcal === baseKcal, locked: true} for EVERY logged day,
  // so this is the shape the overwhelming majority of days actually carry. If
  // anything in the plan path runs here, it runs on days nobody planned.
  const settings = settingsWith({
    [NORMAL_DAY]: { targetKcal: 2000, baseKcal: 2000, updatedAt: 1, locked: true, lockedByEventId: "r1" },
  });
  const g = Phases.goalsForDay(NORMAL_DAY, settings);
  const drifted = Object.keys(PHASE).filter((k) => g[k] !== PHASE[k]);
  ok(drifted.length === 0, "no nutrient moves on a locked no-op", `moved: ${drifted.join(",") || "none"}`);
  ok(g._unscored == null, "a no-op plan exempts nothing from scoring");
}

console.log("\n[2] Floors and ceilings never move, under any intent");
{
  const cases = [
    ["reduced 1200", { targetKcal: 1200, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true }],
    ["reduced 500", { targetKcal: 500, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true }],
    ["fast", { targetKcal: 0, baseKcal: 2000, updatedAt: 1, intent: "fast", fastAcknowledged: true }],
  ];
  for (const [label, record] of cases) {
    const g = Phases.goalsForDay(REDUCED_DAY, settingsWith({ [REDUCED_DAY]: record }));
    const moved = FLOORS.filter((k) => g[k] !== PHASE[k]);
    ok(moved.length === 0, `${label}: protein/fiber/sodium/potassium hold`, `moved: ${moved.join(",")}`);
  }
}

console.log("\n[3] A reduced plan's macros agree with its own calories");
{
  const g = Phases.goalsForDay(REDUCED_DAY, settingsWith({
    [REDUCED_DAY]: { targetKcal: 1200, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true },
  }));
  const atwater = g.protein * 4 + g.carbs * 4 + g.fat * 9;
  ok(atwater <= g.kcal && g.kcal - atwater <= 3,
    "carbs and fat are retargeted to the planned energy", `macros ${atwater} vs ${g.kcal}`);
  ok(g._unscored && g._unscored.protein,
    "a 150 g floor is unscored at 1200 kcal (needs 570, policy allows 480)");
  ok(g.protein === PHASE.protein, "the displayed protein target is unchanged");
}

console.log("\n[4] A declared fast survives two full sync round trips");
{
  const store = memoryStore();
  Ledger._setStoreForTests(store);
  Ledger.configureContext({ getDayGoalLock: (day) => dayGoalLockFor(day, settings) });

  const settings = settingsWith({
    [FAST_DAY]: {
      targetKcal: 0, baseKcal: 2000, plannedAt: 90, updatedAt: 100,
      intent: "fast", fastAcknowledged: true,
    },
  });

  // A fast that recorded a zero-calorie coffee: still a fast, and it is the
  // case that puts a dayGoalLock on the event log.
  Ledger.addEntry(FAST_DAY, {
    name: "black coffee", grams: 240, displayQty: "1 cup",
    macros: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0 },
  });
  const events = Ledger.allEvents();
  const root = events.find((e) => e.type === "add");
  ok(root && root.dayGoalLock && root.dayGoalLock.intent === "fast" &&
      root.dayGoalLock.fastAcknowledged === true && root.dayGoalLock.targetKcal === 0,
    "the first add stamps a fast lock into the immutable event log");

  let s = settings;
  for (const pass_ of [1, 2]) {
    s = roundTrip(s, events);
    const rec = s.dayGoals[FAST_DAY];
    ok(rec && rec.intent === "fast" && rec.fastAcknowledged === true && rec.targetKcal === 0,
      `round trip ${pass_}: the declaration survives the merge`,
      JSON.stringify(rec));
    const g = Phases.goalsForDay(FAST_DAY, s);
    ok(g.kcal === 0 && g._unscored && g._unscored.protein && g._unscored.kcal,
      `round trip ${pass_}: it still resolves as a fast, with kcal disclosed`);
  }
  Ledger._resetCacheForTests();
}

console.log("\n[5] A 500 kcal plan reaches the event log too");
{
  const store = memoryStore();
  Ledger._setStoreForTests(store);
  const settings = settingsWith({
    [REDUCED_DAY]: {
      targetKcal: 500, baseKcal: 2000, plannedAt: 90, updatedAt: 100,
      veryLowCalorieAcknowledged: true,
    },
  });
  Ledger.configureContext({ getDayGoalLock: (day) => dayGoalLockFor(day, settings) });
  Ledger.addEntry(REDUCED_DAY, {
    name: "soup", grams: 300, displayQty: "1 bowl",
    macros: { kcal: 480, p: 20, c: 50, f: 18, fb: 6, na: 900 },
  });
  const root = Ledger.allEvents().find((e) => e.type === "add");
  ok(root && root.dayGoalLock && root.dayGoalLock.targetKcal === 500,
    "a 5:2-sized plan is not silently dropped by the lock's range check",
    JSON.stringify(root && root.dayGoalLock));
  Ledger._resetCacheForTests();
}

console.log("\n[6] An undeclared zero never materialises anywhere");
{
  // Every shape that could arithmetically reach 0 without anyone declaring it.
  const shapes = {
    "legacy delta to zero": { bumps: { kcal: -2000 }, updatedAt: 1 },
    "legacy absolute zero": { kcal: 0, updatedAt: 1 },
    "modern zero, no intent": { targetKcal: 0, baseKcal: 2000, updatedAt: 1 },
    "modern zero, unacknowledged": { targetKcal: 0, baseKcal: 2000, updatedAt: 1, intent: "fast" },
    "fast label, nonzero target": {
      targetKcal: 1500, baseKcal: 2000, updatedAt: 1, intent: "fast", fastAcknowledged: true,
    },
  };
  for (const [label, record] of Object.entries(shapes)) {
    const g = Phases.goalsForDay(FAST_DAY, settingsWith({ [FAST_DAY]: record }));
    const unscoredEverything = !!(g._unscored && g._unscored.protein);
    ok(!(g.kcal === 0 && unscoredEverything), `${label}: does not become a fast`,
      `kcal ${g.kcal}, unscored ${JSON.stringify(g._unscored)}`);
  }
  // And the same shapes cannot smuggle one through a merge either.
  for (const [label, record] of Object.entries(shapes)) {
    const merged = roundTrip(settingsWith({ [FAST_DAY]: record }), []);
    const rec = merged.dayGoals[FAST_DAY];
    ok(!(rec && rec.targetKcal === 0 && rec.intent === "fast" && !rec.fastAcknowledged),
      `${label}: no half-declared fast survives a merge`, JSON.stringify(rec));
  }
}

console.log("\n[7] An undeclared zero lock cannot override an intact declaration");
{
  // heal prefers the event lock over the settings candidate, so a bare zero
  // lock is the one input that could silently outrank a real declaration.
  const settings = settingsWith({
    [FAST_DAY]: {
      targetKcal: 0, baseKcal: 2000, plannedAt: 90, updatedAt: 100,
      intent: "fast", fastAcknowledged: true,
    },
  });
  const bareLock = [{
    id: "r1", ts: 1000, day: FAST_DAY, type: "add", resetEpoch: 0,
    causal: { entryId: "e1", seq: 0, parentEventId: null },
    entry: { id: "e1", name: "coffee", grams: 240, macros: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0 } },
    dayGoalLock: { targetKcal: 0, baseKcal: 2000 },
  }];
  const merged = roundTrip(settings, bareLock);
  const g = Phases.goalsForDay(FAST_DAY, merged);
  ok(g.kcal === 0 && g._unscored && g._unscored.protein,
    "the declaration in settings wins over an undeclared zero lock",
    `kcal ${g.kcal}`);
}

console.log("\n[8] Scoring discloses every exemption and never credits one");
{
  const keys = [FAST_DAY, REDUCED_DAY, NORMAL_DAY, "2026-08-04", "2026-08-05"];
  const fasts = new Set([FAST_DAY, REDUCED_DAY]);
  const settings = settingsWith(Object.fromEntries([...fasts].map((d) => [d, {
    targetKcal: 0, baseKcal: 2000, updatedAt: 1, intent: "fast", fastAcknowledged: true,
  }])));
  const totals = (day) => fasts.has(day)
    ? { count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 },
      na: { mean: 0 }, k: { mean: 0 }, naCoverage: 0, kCoverage: 0, naKCoverage: 0 }
    : { count: 4, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 },
      fb: { mean: 30 }, na: { mean: 2000 }, k: { mean: 3600 },
      naCoverage: 1, kCoverage: 1, naKCoverage: 1,
      naKNa: { mean: 2000 }, naKK: { mean: 3600 } };
  const days = Analytics.buildDays({
    keys,
    totalsForDay: totals,
    goalsForDay: (d) => Phases.goalsForDay(d, settings),
    bumpForDay: (d) => settings.dayGoals[d] || null,
  });
  const score = Analytics.nutritionScore(days, Phases.scoreDayTotals, {});
  const row = (k) => score.nutrients.find((n) => n.key === k);
  for (const k of ["kcal", "protein", "carbs", "fat", "fiber"]) {
    ok(row(k) && row(k).exemptN === 2, `${k} discloses both exempt days`,
      row(k) ? `exemptN ${row(k).exemptN}` : "row missing");
  }
  // The exemption must remove the day, never hand it a hit.
  const allHit = Analytics.nutritionScore(
    Analytics.buildDays({ keys, totalsForDay: () => totals(NORMAL_DAY), goalsForDay: () => ({ ...PHASE }) }),
    Phases.scoreDayTotals, {}
  );
  ok(allHit.score >= (score.score ?? 0),
    "an exempt range never outscores the same days genuinely met",
    `exempt ${score.score} vs met ${allHit.score}`);
}

console.log("\n[9] A range with too few scored days reports no score at all");
{
  const keys = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"];
  const settings = settingsWith(Object.fromEntries(keys.map((d) => [d, {
    targetKcal: 0, baseKcal: 2000, updatedAt: 1, intent: "fast", fastAcknowledged: true,
  }])));
  const days = Analytics.buildDays({
    keys,
    totalsForDay: () => ({ count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 },
      f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 }, naCoverage: 0, kCoverage: 0 }),
    goalsForDay: (d) => Phases.goalsForDay(d, settings),
  });
  const score = Analytics.nutritionScore(days, Phases.scoreDayTotals, {});
  ok(score.score == null, "an all-exempt range scores null, not 100", `got ${score.score}`);
  ok(score.parts.targets == null, "and reports no target component");
}

console.log(`\nday-intent chain: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
