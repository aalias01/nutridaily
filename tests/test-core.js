/* NutriDaily core tests — run with: node tests/test-core.js
 * Covers the deterministic layer: food resolution, unit math, macro math,
 * uncertainty propagation, event-sourced ledger reduction, verifier rules.
 */
globalThis.FOOD_DB = require("../js/data-foods.js");
const FoodMatch = require("../js/foodmatch.js");
globalThis.FoodMatch = FoodMatch;
const Foods = require("../js/foods.js");
const Ledger = require("../js/ledger.js");
// phases.js reads `Analytics` for retargetForKcal on a reduced day, the same
// defensive way analytics.js reads `Phases` (mirrors test-analytics.js).
// Without this, goalsForDay silently takes the "Analytics absent" fallback
// and every test in this file exercises a code path the browser never runs —
// which is how Part VII.1's bug reached review in the first place (VII.8).
globalThis.Phases = require("../js/phases.js");
globalThis.Analytics = require("../js/analytics.js");

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function approx(a, b, tol, name) { ok(Math.abs(a - b) <= (tol || 0.5), name, `got ${a}, want ~${b}`); }

console.log("\n[1] Food resolution");
{
  const r1 = FoodMatch.resolve("chicken breast", []);
  ok(r1 && r1.food.id === "chicken-breast", "resolves 'chicken breast'");

  const r2 = FoodMatch.resolve("costco chapatis", []);
  ok(r2 && r2.food.id === "chapati", "resolves 'costco chapatis' → chapati (alias + plural)");

  const r3 = FoodMatch.resolve("stir fried vegetables", []);
  ok(r3 && r3.food.id === "stir-fry-veg", "resolves 'stir fried vegetables'");

  const r4 = FoodMatch.resolve("greek yogurt", []);
  ok(r4 && r4.food.id === "greek-yogurt-nonfat", "resolves 'greek yogurt'");

  const r5 = FoodMatch.resolve("xylophone stew", []);
  ok(r5 === null, "unknown food returns null (use AI paste / catalog)");

  // personal foods outrank the curated DB on ties
  const personal = [{ id: "pf-1", name: "dal", aliases: ["dal", "my dal"], per100: { kcal: 150, p: 8, c: 18, f: 5, fb: 6, na: 300 }, units: { serving: 250 }, cat: "dish" }];
  const r6 = FoodMatch.resolve("dal", personal);
  ok(r6 && r6.source === "personal", "personal 'dal' beats curated 'dal'");

  ok(FoodMatch.scoreMatch("ban", "banana") >= 0.55, "prefix 'ban' matches banana");
  ok(FoodMatch.scoreMatch("chick", "chicken breast (cooked)") >= 0.55, "prefix 'chick' matches chicken");
  ok(FoodMatch.scoreMatch("yog", "greek yogurt, nonfat") >= 0.55, "substring 'yog' matches yogurt");
}

console.log("\n[2] Unit → gram conversion");
{
  const chicken = FOOD_DB.find((f) => f.id === "chicken-breast");
  approx(FoodMatch.toGrams(chicken, 180, "g").grams, 180, 0.01, "180 g → 180 g");
  approx(FoodMatch.toGrams(chicken, 1, "lb").grams, 453.6, 0.1, "1 lb → 453.6 g");

  const chapati = FOOD_DB.find((f) => f.id === "chapati");
  approx(FoodMatch.toGrams(chapati, 2, "pieces").grams, 120, 0.01, "2 chapatis → 120 g");

  const rice = FOOD_DB.find((f) => f.id === "brown-rice");
  approx(FoodMatch.toGrams(rice, 1, "cup").grams, 195, 0.01, "1 cup brown rice → 195 g");

  const banana = FOOD_DB.find((f) => f.id === "banana");
  approx(FoodMatch.toGrams(banana, 1, "").grams, 118, 0.01, "1 banana (no unit) → 118 g");

  const milk = FOOD_DB.find((f) => f.id === "milk-whole");
  approx(FoodMatch.toGrams(milk, 1, "glass").grams, 244, 0.01, "1 glass milk → 244 g");

  const ghee = FOOD_DB.find((f) => f.id === "ghee");
  approx(FoodMatch.toGrams(ghee, 3, "tbsp").grams, 39, 0.01, "3 tbsp ghee → 39 g");

  // unknown unit falls back to the LLM's grams estimate
  approx(FoodMatch.toGrams(chicken, 1, "hunk", 137).grams, 137, 0.01, "unknown unit → llm grams fallback");
}

console.log("\n[3] Deterministic macro math");
{
  const chicken = FOOD_DB.find((f) => f.id === "chicken-breast");
  const m = FoodMatch.computeMacros(chicken.per100, 180);
  ok(m.kcal === 297, "180 g chicken = 297 kcal", `got ${m.kcal}`);
  approx(m.p, 55.8, 0.11, "180 g chicken = 55.8 g protein");

  const chapati = FOOD_DB.find((f) => f.id === "chapati");
  const m2 = FoodMatch.computeMacros(chapati.per100, 120);
  ok(m2.kcal === 356, "2 chapatis (120 g) = 356 kcal", `got ${m2.kcal}`);
}

console.log("\n[4] Verifier / plausibility");
{
  const chicken = FOOD_DB.find((f) => f.id === "chicken-breast");
  const big = { name: "chicken breast", grams: 800, cat: "meat", macros: FoodMatch.computeMacros(chicken.per100, 800) };
  ok(FoodMatch.plausibility(big).length === 1, "800 g chicken triggers a warning");

  const fine = { name: "chicken breast", grams: 180, cat: "meat", macros: FoodMatch.computeMacros(chicken.per100, 180) };
  ok(FoodMatch.plausibility(fine).length === 0, "180 g chicken is plausible");

  const impossible = { name: "mystery", grams: 100, cat: "dish", macros: { kcal: 1200, p: 0, c: 0, f: 0, fb: 0, na: 0 } };
  ok(FoodMatch.plausibility(impossible).length >= 1, "12 kcal/g flags as physically impossible");
}

console.log("\n[5] Event-sourced ledger");
{
  Ledger.clearAll();
  const day = "2026-07-16";
  const chicken = FOOD_DB.find((f) => f.id === "chicken-breast");

  const e1 = Ledger.addEntry(day, { name: "chicken breast", displayQty: "180 g", grams: 180, macros: FoodMatch.computeMacros(chicken.per100, 180), sd: 0.08, meal: "dinner", source: "db", cat: "meat", foodId: "chicken-breast" });
  Ledger.addEntry(day, { name: "banana", displayQty: "1 piece (118 g)", grams: 118, macros: { kcal: 105, p: 1.3, c: 26.9, f: 0.4, fb: 3.1, na: 1 }, sd: 0.15, meal: "snack", source: "db", cat: "fruit", foodId: "banana" });

  let entries = Ledger.entriesFor(day);
  ok(entries.length === 2, "two adds → two entries");

  let t = Ledger.totalsFor(day);
  ok(t.kcal.mean === 402, "totals sum correctly (297+105)", `got ${t.kcal.mean}`);

  // uncertainty: sqrt((297*.08)² + (105*.15)²) ≈ 28.5
  approx(t.kcal.sd, 28.5, 1, "kcal uncertainty propagates in quadrature");

  // amend: "actually the chicken was 200 g"
  const target = Ledger.findEntry(day, "chicken", FoodMatch.scoreMatch);
  ok(target && target.id === e1.entry.id, "fuzzy findEntry locates the chicken");
  Ledger.amendEntry(day, target.id, { grams: 200, displayQty: "200 g", macros: FoodMatch.computeMacros(chicken.per100, 200), sd: 0.08 }, "quantity edited");
  t = Ledger.totalsFor(day);
  ok(t.kcal.mean === 435, "amend recomputes totals (330+105)", `got ${t.kcal.mean}`);
  entries = Ledger.entriesFor(day);
  const hist = entries.find((e) => e.name === "chicken breast").history;
  ok(hist.length === 1, "correction history is preserved");
  ok(hist[0].changes.some((c) => c.field === "qty" && c.from === "180 g" && c.to === "200 g"), "amend history records a real qty diff");
  ok(hist[0].changes.some((c) => c.field === "kcal" && c.from === 297 && c.to === 330), "amend history records a kcal diff");

  // "that" targets the most recent entry
  const last = Ledger.findEntry(day, "that", FoodMatch.scoreMatch);
  ok(last && last.name === "banana", "'that' → most recent entry");

  // remove
  Ledger.removeEntry(day, last.id, "removed");
  ok(Ledger.entriesFor(day).length === 1, "remove event drops the entry");
  ok(Ledger.allEvents().length === 4, "events are immutable — 4 events retained (2 add, 1 amend, 1 remove)");

  // multi-day summaries
  Ledger.addEntry("2026-07-15", { name: "egg", displayQty: "2 pieces", grams: 100, macros: { kcal: 148, p: 12.5, c: 1, f: 10, fb: 0, na: 142 }, sd: 0.15, meal: "breakfast", source: "db", cat: "protein", foodId: "egg" });
  const days = Ledger.recentDays(10);
  ok(days.length === 2 && days[0] === "2026-07-16", "recentDays returns day keys, newest first");
  const summary = Ledger.recentSummary(7);
  ok(summary.length === 2 && summary[0].kcal === 330, "recentSummary computes per-day rollups");

  Ledger.clearAll();
}

console.log("\n[5b] portionStats (weigh-first history)");
{
  Ledger.clearAll();
  const day = Ledger.todayKey();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yday = Ledger.todayKey(y);
  const macros = { kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 50 };
  Ledger.addEntry(yday, { name: "dal", displayQty: "200 g", grams: 200, macros, sd: 0.1, meal: "lunch", source: "personal", cat: "dish", foodId: "pf-dal" });
  Ledger.addEntry(day, { name: "dal", displayQty: "240 g", grams: 240, macros, sd: 0.1, meal: "lunch", source: "personal", cat: "dish", foodId: "pf-dal" });
  Ledger.addEntry(day, { name: "dal", displayQty: "220 g", grams: 220, macros, sd: 0.1, meal: "dinner", source: "personal", cat: "dish", foodId: "pf-dal" });
  Ledger.addEntry(day, { name: "rice", displayQty: "150 g", grams: 150, macros, sd: 0.1, meal: "dinner", source: "personal", cat: "grain", foodId: "pf-rice" });

  const s = Ledger.portionStats("pf-dal");
  ok(s.n === 3, "portionStats counts matching foodId logs", `got ${s.n}`);
  ok(s.median === 220, "median of 200/220/240", `got ${s.median}`);
  ok(s.p25 === 210 && s.p75 === 230, "p25–p75 for three samples", `got ${s.p25}–${s.p75}`);
  ok(s.last === 220, "last is most recently added grams", `got ${s.last}`);
  ok(Ledger.portionStats("pf-rice").n === 1 && Ledger.portionStats("pf-rice").median === 150, "single sample median = that grams");
  ok(Ledger.portionStats("missing").n === 0 && Ledger.portionStats("missing").median == null, "unknown foodId is empty");
  ok(Ledger.portionStats("pf-dal", { lookbackDays: 0 }).n <= 3, "lookbackDays option accepted");

  Ledger.clearAll();
}

console.log("\n[5c] Ledger causality, completeness, and durable writes");
{
  const day = "2026-08-03";
  const base = {
    id: "entry-clock-skew", name: "soup", displayQty: "1 bowl", grams: 300,
    macros: { kcal: 200, p: 8, c: 20, f: 9, fb: 3, na: 900, k: 400 },
    sd: 0.1,
  };

  // The remove/amend references establish causality even when the originating
  // device's wall clock is behind the device that created the add.
  Ledger.replaceAll([
    { id: "remove-early-clock", ts: 50, day, type: "remove", target: base.id },
    { id: "add-late-clock", ts: 100, day, type: "add", entry: base },
  ]);
  ok(Ledger.entriesFor(day).length === 0, "clock-skewed remove is replayed after its causal add");

  Ledger.replaceAll([
    { id: "amend-early-clock", ts: 50, day, type: "amend", target: base.id, patch: { grams: 350, displayQty: "350 g" } },
    { id: "add-late-clock", ts: 100, day, type: "add", entry: base },
  ]);
  const skewed = Ledger.entriesFor(day)[0];
  ok(skewed && skewed.grams === 350 && skewed.history.length === 1,
    "clock-skewed amend is not silently discarded");

  const mineralTotals = Ledger.totalsOf([
    { macros: { kcal: 300, na: 600, k: 900 }, sd: 0.1 },
    { macros: { kcal: 100, na: null, k: null }, sd: 0.1 },
  ]);
  ok(mineralTotals.na.mean === 600 && mineralTotals.naItems === 1, "sodium sums only known values");
  approx(mineralTotals.naCoverage, 0.5, 0.001, "sodium coverage conservatively uses the lower of calorie and item share");
  approx(mineralTotals.kCoverage, 0.5, 0.001, "potassium coverage uses the same conservative contract");
  // Design Phase 2: macroCoverage — Quick and blank-macro once are unknown.
  const macroTotals = Ledger.totalsOf([
    { source: "personal", macros: { kcal: 600, p: 40, c: 50, f: 20, fb: 5 }, sd: 0.1 },
    { source: "quick", macros: { kcal: 400, p: 0, c: 0, f: 0, fb: 0 }, sd: 0.4 },
  ]);
  approx(macroTotals.macroCoverage, 0.5, 0.001, "macroCoverage uses calorie share of non-quick entries");
  ok(macroTotals.macroItems === 1, "macroItems counts only macro-known entries");
  const blankOnce = Ledger.totalsOf([
    { source: "once", macros: { kcal: 500, p: 0, c: 0, f: 0, fb: 0 }, sd: 0.25 },
    { source: "once", macros: { kcal: 500, p: 30, c: 40, f: 15, fb: 4 }, sd: 0.25 },
  ]);
  approx(blankOnce.macroCoverage, 0.5, 0.001, "once with kcal but all-zero macros does not count as known");
  const allKnown = Ledger.totalsOf([
    { source: "personal", macros: { kcal: 400, p: 20, c: 30, f: 10, fb: 2 }, sd: 0.1 },
  ]);
  approx(allKnown.macroCoverage, 1, 0.001, "fully known day has macroCoverage 1");
  ok(globalThis.Phases.macrosCovered(allKnown) && !globalThis.Phases.macrosCovered(macroTotals),
    "macrosCovered uses the same 0.8 threshold as minerals");
  const zeroCalUnknown = Ledger.totalsOf([
    { macros: { kcal: 300, na: 600, k: 900 }, sd: 0.1 },
    { macros: { kcal: 0, na: null, k: null }, sd: 0.1 },
  ]);
  approx(zeroCalUnknown.naCoverage, 0.5, 0.001, "a zero-calorie sodium unknown still lowers item coverage");
  approx(zeroCalUnknown.kCoverage, 0.5, 0.001, "a zero-calorie potassium unknown still lowers item coverage");
  const disjointMinerals = Ledger.totalsOf([
    { macros: { kcal: 100, na: 400, k: null }, sd: 0.1 },
    { macros: { kcal: 100, na: null, k: 800 }, sd: 0.1 },
    { macros: { kcal: 100, na: 200, k: 500 }, sd: 0.1 },
  ]);
  ok(disjointMinerals.na.mean === 600 && disjointMinerals.k.mean === 1300,
    "independent mineral totals include their separately known entries");
  ok(disjointMinerals.naKNa.mean === 200 && disjointMinerals.naKK.mean === 500 && disjointMinerals.naKItems === 1,
    "paired ratio totals use only entries where both minerals are known");

  Ledger.replaceAll([{ id: "ever-add", ts: 10, day, type: "add", entry: { ...base, id: "ever-entry" } },
    { id: "ever-remove", ts: 20, day, type: "remove", target: "ever-entry" }]);
  ok(Ledger.entriesFor(day).length === 0 && Ledger.hasEverAdded(day),
    "immutable add history remains after the last visible entry is removed");
  ok(Ledger.firstAddAt(day) === 10, "first-add audit timestamp comes from immutable history");

  // A rejected write must not mutate the in-memory working copy and exposes a
  // stable, actionable error contract to app/sync callers.
  let raw = "[]";
  const readable = {
    getItem: () => raw,
    setItem: (_key, value) => { raw = String(value); },
    removeItem: () => { raw = "[]"; },
  };
  Ledger._setStoreForTests(readable);
  Ledger.replaceAll([{ id: "kept", ts: 1, day, type: "add", entry: { ...base, id: "kept-entry" } }]);
  Ledger._setStoreForTests({
    getItem: () => raw,
    setItem: () => { throw new Error("quota"); },
    removeItem: () => { throw new Error("quota"); },
  });
  let persistenceErr = null;
  try { Ledger.addEntry(day, { ...base, id: "rejected-entry" }); }
  catch (e) { persistenceErr = e; }
  ok(Ledger.isPersistenceError(persistenceErr) && persistenceErr.operation === "save",
    "failed localStorage write throws the ledger persistence contract");
  ok(Ledger.allEvents().length === 1 && Ledger.allEvents()[0].id === "kept",
    "failed localStorage write leaves the working copy unchanged");

  // Restore a functioning isolated store for the remainder of this process.
  let cleanRaw = "[]";
  Ledger._setStoreForTests({
    getItem: () => cleanRaw,
    setItem: (_key, value) => { cleanRaw = String(value); },
    removeItem: () => { cleanRaw = "[]"; },
  });
  Ledger.clearAll();
}

console.log("\n[5d] Causal ledger convergence");
{
  Ledger.clearAll();
  const day = "2026-08-04";
  const base = {
    id: "causal-entry", name: "oats", displayQty: "100 g", grams: 100,
    macros: { kcal: 380, p: 13, c: 68, f: 7, fb: 10, na: 5, k: 360 },
    sd: 0.1, meal: "breakfast",
  };

  const added = Ledger.addEntry(day, base);
  const amended = Ledger.amendEntry(day, base.id, { grams: 110, displayQty: "110 g" }, "quantity edited");
  const removed = Ledger.removeEntry(day, base.id, "removed");
  const immutablePrefix = JSON.stringify(Ledger.allEvents());
  const restored = Ledger.addEntry(day, { ...base, grams: 110, displayQty: "110 g" });
  ok(added.causal.entryId === base.id && added.causal.seq === 0 && added.causal.parentEventId === null,
    "initial add records an explicit seq-0 causal root");
  ok(amended.causal.seq === 1 && amended.causal.parentEventId === added.id,
    "amend links the current per-entry head");
  ok(removed.causal.seq === 2 && removed.causal.parentEventId === amended.id,
    "remove advances the per-entry logical clock");
  ok(restored.causal.seq === 3 && restored.causal.parentEventId === removed.id,
    "undo restore is an add linked to the removed head");
  ok(JSON.stringify(Ledger.allEvents().slice(0, 3)) === immutablePrefix && Ledger.allEvents().length === 4,
    "restore appends without rewriting prior causal history");
  ok(Ledger.validateEvents(Ledger.allEvents()) && Ledger.entriesFor(day)[0].grams === 110,
    "generated causal history validates and restores the same entry identity");
  let duplicateLive = null;
  try { Ledger.addEntry(day, base); } catch (e) { duplicateLive = e; }
  ok(duplicateLive && duplicateLive.code === "ledger-causal-duplicate-live-add",
    "local duplicate add of a live identity fails closed");

  const root = {
    id: "root", ts: 100, day, type: "add",
    causal: { entryId: "forked", seq: 0, parentEventId: null },
    entry: { ...base, id: "forked" },
  };
  const qtyA = {
    id: "fork-a", ts: 100, day, type: "amend", target: "forked",
    causal: { entryId: "forked", seq: 1, parentEventId: "root" },
    patch: { grams: 120, displayQty: "120 g" },
  };
  const mealB = {
    id: "fork-b", ts: 100, day, type: "amend", target: "forked",
    causal: { entryId: "forked", seq: 1, parentEventId: "root" },
    patch: { meal: "lunch" },
  };
  const qtyZ = {
    id: "fork-z", ts: 100, day, type: "amend", target: "forked",
    causal: { entryId: "forked", seq: 1, parentEventId: "root" },
    patch: { grams: 130, displayQty: "130 g" },
  };
  const forkForward = Ledger.replayEvents([root, qtyA, mealB, qtyZ]);
  const forkReverse = Ledger.replayEvents([qtyZ, mealB, qtyA, root]);
  ok(JSON.stringify(forkForward) === JSON.stringify(forkReverse),
    "same-timestamp sibling replay is independent of input order");
  ok(forkForward[0].grams === 130 && forkForward[0].meal === "lunch",
    "compatible sibling amendments merge and same-field conflicts use the canonical winner");
  ok(forkForward[0].history.length === 3,
    "all valid sibling amendments remain visible in correction history");

  const siblingRemove = {
    id: "fork-remove", ts: 1, day, type: "remove", target: "forked",
    causal: { entryId: "forked", seq: 1, parentEventId: "root" },
  };
  const deeperAmend = {
    id: "fork-deeper", ts: 999, day, type: "amend", target: "forked",
    causal: { entryId: "forked", seq: 2, parentEventId: "fork-b" },
    patch: { meal: "dinner" },
  };
  ok(Ledger.replayEvents([deeperAmend, siblingRemove, mealB, root]).length === 0,
    "remove tombstones its generation even against a deeper concurrent amendment branch");

  const laterRestore = {
    id: "fork-restore", ts: 0, day, type: "add",
    causal: { entryId: "forked", seq: 2, parentEventId: "fork-remove" },
    entry: { ...base, id: "forked", meal: "breakfast" },
  };
  const afterRestore = Ledger.replayEvents([deeperAmend, siblingRemove, mealB, laterRestore, root]);
  ok(afterRestore.length === 1 && afterRestore[0].meal === "breakfast" && afterRestore[0].history.length === 0,
    "causally later restore reactivates a fresh generation without leaking old amendments");
  Ledger.replaceAll([laterRestore, siblingRemove, root]);
  ok(Ledger.firstAddAt(day) === 100,
    "clock-skewed restore add cannot move immutable first-log provenance before the seq-0 root");

  function validationCode(events) {
    try { Ledger.validateEvents(events); return null; } catch (e) { return e && e.code; }
  }
  const orphan = {
    ...mealB, id: "orphan", causal: { entryId: "forked", seq: 1, parentEventId: "missing" },
  };
  ok(validationCode([orphan]) === "ledger-causal-orphan",
    "validator distinguishes an orphaned causal parent");
  ok(validationCode([root, { ...mealB, id: "wrong-day", day: "2026-08-05" }]) === "ledger-causal-cross-day",
    "validator distinguishes a cross-day entry reference");
  const duplicateAdd = {
    id: "duplicate-add", ts: 101, day, type: "add",
    causal: { entryId: "forked", seq: 1, parentEventId: "root" },
    entry: { ...base, id: "forked" },
  };
  ok(validationCode([root, duplicateAdd]) === "ledger-causal-duplicate-live-add",
    "validator rejects an add whose parent is still live");
  const removeAgain = {
    id: "remove-again", ts: 102, day, type: "remove", target: "forked",
    causal: { entryId: "forked", seq: 2, parentEventId: "fork-remove" },
  };
  ok(validationCode([root, siblingRemove, removeAgain]) === "ledger-causal-invalid-transition",
    "validator rejects amend/remove transitions from a removed parent");
  ok(Ledger.validateEvents([root, siblingRemove, laterRestore]),
    "validator accepts an add restore whose parent is removed");

  const legacy = [
    { id: "legacy-amend", ts: 10, day, type: "amend", target: "legacy-entry", patch: { grams: 160 } },
    { id: "legacy-add", ts: 100, day, type: "add", entry: { ...base, id: "legacy-entry" } },
  ];
  const legacyRaw = JSON.stringify(legacy);
  const legacyA = Ledger.replayEvents(legacy);
  const legacyB = Ledger.replayEvents(legacy.slice().reverse());
  ok(legacyA[0].grams === 160 && JSON.stringify(legacyA) === JSON.stringify(legacyB),
    "legacy clock-skew fallback is deterministic under reversed input");
  ok(JSON.stringify(legacy) === legacyRaw && legacy.every((event) => event.causal == null),
    "legacy causal fallback is derived without rewriting immutable events");
  const hybrid = {
    id: "hybrid-amend", ts: 1, day, type: "amend", target: "legacy-entry",
    causal: { entryId: "legacy-entry", seq: 2, parentEventId: "legacy-amend" },
    patch: { meal: "snack" },
  };
  ok(Ledger.validateEvents([...legacy, hybrid]) && Ledger.replayEvents([hybrid, ...legacy])[0].meal === "snack",
    "new causal events may safely parent a legacy event's deterministic synthetic sequence");

  Ledger.clearAll();
  Ledger.configureContext({
    getResetEpoch: () => 42,
    getDayGoalLock: () => ({
      targetKcal: 2550, baseKcal: 2200, plannedAt: 40, veryLowCalorieAcknowledged: true,
    }),
  });
  Ledger.addEntry("2026-09-01", { id: "context-first", name: "first" });
  Ledger.addEntry("2026-09-01", { id: "context-second", name: "second" });
  Ledger.amendEntry("2026-09-01", "context-first", { grams: 120 }, "changed");
  Ledger.removeEntry("2026-09-01", "context-first", "removed");
  Ledger.addEntry("2026-09-01", { id: "context-first", name: "restored" });
  const contextEvents = Ledger.allEvents();
  const contextFirstRoot = contextEvents.find((event) => event.type === "add" &&
    event.causal && event.causal.entryId === "context-first" && event.causal.seq === 0);
  const contextSecondRoot = contextEvents.find((event) => event.type === "add" &&
    event.causal && event.causal.entryId === "context-second" && event.causal.seq === 0);
  ok(contextFirstRoot && contextFirstRoot.resetEpoch === 42 &&
      contextFirstRoot.dayGoalLock.targetKcal === 2550 && contextFirstRoot.dayGoalLock.baseKcal === 2200,
    "the ledger producer stamps the reset generation and target/base snapshot on the first root add");
  ok(contextSecondRoot && !contextSecondRoot.dayGoalLock &&
      contextEvents.filter((event) => event.causal && event.causal.entryId === "context-first")
        .every((event) => event.resetEpoch === 42),
    "later roots cannot redefine the day lock and amend/remove/restore inherit the root generation");
  ok(contextEvents.filter((event) => event.type === "add" && event.dayGoalLock).length === 1,
    "a restore cannot create a second immutable day-target snapshot");
  Ledger.configureContext({});
  Ledger.clearAll();

  // Part VII.2: the target side of dayGoalLock widened to {0} ∪ [200, 6000]
  // with the rest of the feature. Without this, a 500 kcal or fast day's
  // first add stamped no dayGoalLock at all, and provenance for exactly the
  // low days this feature exists to serve silently degraded to the mutable
  // candidatesByDay fallback.
  Ledger.clearAll();
  Ledger.configureContext({
    getResetEpoch: () => 0,
    getDayGoalLock: () => ({ targetKcal: 500, baseKcal: 2200, veryLowCalorieAcknowledged: true }),
  });
  Ledger.addEntry("2026-09-02", { id: "low-day-root", name: "low day" });
  const lowDayRoot = Ledger.allEvents().find((event) => event.type === "add" &&
    event.causal && event.causal.entryId === "low-day-root" && event.causal.seq === 0);
  ok(lowDayRoot && lowDayRoot.dayGoalLock &&
      lowDayRoot.dayGoalLock.targetKcal === 500 && lowDayRoot.dayGoalLock.baseKcal === 2200,
    "a 500 kcal day's first add carries a dayGoalLock");
  Ledger.configureContext({});
  Ledger.clearAll();

  // Part VIII.1: a lock at targetKcal 0 is only honoured alongside its own
  // intent/fastAcknowledged — that is the one shape the rest of the system
  // (Sync.normalizeDayGoal, Phases.dayPlanForDay) refuses to score, so writing
  // it undeclared would just move the laundering path into the ledger.
  Ledger.configureContext({
    getResetEpoch: () => 0,
    getDayGoalLock: () => ({
      targetKcal: 0, baseKcal: 2200, intent: "fast", fastAcknowledged: true,
    }),
  });
  Ledger.addEntry("2026-09-03", { id: "fast-day-root", name: "black coffee" });
  const fastDayRoot = Ledger.allEvents().find((event) => event.type === "add" &&
    event.causal && event.causal.entryId === "fast-day-root" && event.causal.seq === 0);
  ok(fastDayRoot && fastDayRoot.dayGoalLock &&
      fastDayRoot.dayGoalLock.targetKcal === 0 && fastDayRoot.dayGoalLock.baseKcal === 2200 &&
      fastDayRoot.dayGoalLock.intent === "fast" && fastDayRoot.dayGoalLock.fastAcknowledged === true,
    "a declared fast's first add carries a dayGoalLock at targetKcal 0 with its declaration");
  Ledger.configureContext({});
  Ledger.clearAll();

  Ledger.configureContext({
    getResetEpoch: () => 0,
    getDayGoalLock: () => ({ targetKcal: 0, baseKcal: 2200 }),
  });
  Ledger.addEntry("2026-09-03b", { id: "undeclared-zero-root", name: "black coffee" });
  const undeclaredZeroRoot = Ledger.allEvents().find((event) => event.type === "add" &&
    event.causal && event.causal.entryId === "undeclared-zero-root" && event.causal.seq === 0);
  ok(undeclaredZeroRoot && !undeclaredZeroRoot.dayGoalLock,
    "a targetKcal 0 lock with no intent/fastAcknowledged is never honoured — an undeclared zero is not a fast");
  Ledger.configureContext({});
  Ledger.clearAll();

  // Part IX.2: intent "fast" must require targetKcal 0, not just its own
  // acknowledgement. Sync.normalizeDayGoal and App.importedPlannedKcal both
  // already reject {intent:"fast", targetKcal:1500} as incoherent — the
  // ledger's own validator writes the immutable event log and must agree,
  // rather than laundering a 1500 kcal day into a fully unscored "fast".
  Ledger.configureContext({
    getResetEpoch: () => 0,
    getDayGoalLock: () => ({
      targetKcal: 1500, baseKcal: 2200, intent: "fast", fastAcknowledged: true,
    }),
  });
  Ledger.addEntry("2026-09-03c", { id: "incoherent-fast-root", name: "not actually a fast" });
  const incoherentFastRoot = Ledger.allEvents().find((event) => event.type === "add" &&
    event.causal && event.causal.entryId === "incoherent-fast-root" && event.causal.seq === 0);
  ok(incoherentFastRoot && incoherentFastRoot.dayGoalLock &&
      incoherentFastRoot.dayGoalLock.targetKcal === 1500 && incoherentFastRoot.dayGoalLock.intent === undefined &&
      incoherentFastRoot.dayGoalLock.fastAcknowledged === undefined,
    "intent \"fast\" with a nonzero target is written as an ordinary planned day, never as an incoherent fast lock");
  Ledger.configureContext({});
  Ledger.clearAll();
}

console.log("\n[6] Display formatting");
{
  ok(FoodMatch.displayQty(2, "pieces", 120) === "2 pieces (120 g)", "household qty shows grams too");
  ok(FoodMatch.displayQty(180, "g", 180) === "180 g", "gram qty shown plainly");
  const rotiLegacy = { name: "Roti Fresh Original Chapati", units: { serving: 57 }, aliases: ["chapati"], logAs: "piece" };
  ok(FoodMatch.pieceGrams(rotiLegacy) === 57, "pieceGrams uses serving only when logAs=piece");
  ok(FoodMatch.pieceGrams({ name: "skillet", units: { serving: 190 } }) == null, "serving alone is not a piece");
  const roti = { name: "Roti Fresh Original Chapati", units: { piece: 57 }, aliases: ["chapati"], logAs: "piece", countLabel: "chapati" };
  approx(FoodMatch.toGrams(roti, 2, "piece").grams, 114, 0.01, "2 chapatis → 114 g");
  ok(FoodMatch.displayQty(2, "piece", 114, roti) === "2 chapatis (114 g)", "display uses chapati noun");
  ok(FoodMatch.displayQty(1, "piece", 57, roti) === "1 chapati (57 g)", "singular chapati label");
  const repaired = Foods.enableCountLogging(
    { name: "Roti Fresh", units: { serving: 57 }, logAs: "grams", version: 1 },
    57,
    "chapati"
  );
  ok(repaired.logAs === "piece" && repaired.units.piece === 57 && repaired.countLabel === "chapati", "enableCountLogging repair");
}

console.log("\n[7] Phases / goalsForDay");
{
  const Phases = require("../js/phases.js");
  const settings = {
    goals: { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300 },
    goalsUpdatedAt: 100,
    dayGoals: {},
    phases: [],
    weights: {},
  };
  Phases.ensureMigrated(settings, "2026-07-01", "2026-08-01");
  ok(settings.phases.length === 1, "migrate synthesizes one phase");
  ok(settings.phases[0].startDay === "2026-07-01", "phase starts at earliest ledger day");
  ok(Phases.goalsForDay("2026-07-15", settings).kcal === 2200, "historical day uses migrated goals");

  const legacyMigrationA = {
    goals: { kcal: 1875, protein: 130, carbs: 210, fat: 58, fiber: 27, sodium: 2200 },
    goalsUpdatedAt: 77, goalsResetEpoch: 75, dayGoals: {}, phases: [], weights: {},
  };
  const legacyMigrationB = {
    goals: { sodium: 2200, fat: 58, kcal: 1875, carbs: 210, fiber: 27, protein: 130 },
    goalsUpdatedAt: 77, goalsResetEpoch: 75, dayGoals: {}, phases: [], weights: {},
  };
  Phases.ensureMigrated(legacyMigrationA, null, "2026-08-01");
  Phases.ensureMigrated(legacyMigrationB, null, "2026-09-17");
  ok(legacyMigrationA.phases[0].id === legacyMigrationB.phases[0].id &&
      legacyMigrationA.phases[0].revisions[0].id === legacyMigrationB.phases[0].revisions[0].id,
    "no-event legacy phase migration ids do not depend on each device's local today");
  ok(legacyMigrationA.phases[0].resetEpoch === 75 &&
      legacyMigrationA.phases[0].revisions[0].resetEpoch === 75,
    "a deterministic goals-only migration inherits the goals privacy generation");
  const eventAnchoredMigration = {
    goals: { kcal: 1875, protein: 130, carbs: 210, fat: 58, fiber: 27, sodium: 2200 },
    goalsUpdatedAt: 77, goalsResetEpoch: 75, dayGoals: {}, phases: [], weights: {},
  };
  Phases.ensureMigrated(eventAnchoredMigration, "2026-06-12", "2026-08-01");
  ok(eventAnchoredMigration.phases[0].id !== legacyMigrationA.phases[0].id &&
      eventAnchoredMigration.phases[0].startDay === "2026-06-12",
    "the earliest immutable event day participates in deterministic legacy identity");
  const migratedOnce = JSON.stringify(legacyMigrationA);
  Phases.ensureMigrated(legacyMigrationA, null, "2026-08-01");
  ok(JSON.stringify(legacyMigrationA) === migratedOnce, "legacy phase migration is idempotent");
  const freshMigration = { goals: { ...Phases.DEFAULT_GOALS }, goalsUpdatedAt: 0, dayGoals: {}, phases: [], weights: {} };
  Phases.ensureMigrated(freshMigration, "2026-06-12", "2026-08-01");
  const migratedLegacyFirst = Phases.mergePhases(
    legacyMigrationA.phases, freshMigration.phases, []
  );
  const migratedFreshFirst = Phases.mergePhases(
    freshMigration.phases, legacyMigrationA.phases, []
  );
  ok(migratedLegacyFirst.length === 1 && migratedFreshFirst.length === 1 &&
      migratedLegacyFirst[0].revisions[0].goals.kcal === 1875 &&
      JSON.stringify(migratedLegacyFirst) === JSON.stringify(migratedFreshFirst),
    "an untouched fresh default cannot override a real deterministic legacy target in either shard order");

  const policyValid = {
    kcal: 2200, protein: 140, carbs: 250, fat: 70,
    fiber: 28, sodium: 2300, potassium: 3510,
  };
  const policyLow = { ...policyValid, kcal: 700 };
  const policyMacroInvalid = {
    kcal: 2200, protein: 400, carbs: 150, fat: 0,
    fiber: 28, sodium: 2300, potassium: 3510,
  };
  ok(!Phases.validatePersistentGoals(policyLow).ok &&
      Phases.validatePersistentGoals(policyLow).errors.some((error) => /1200/.test(error)),
    "persistent target policy rejects a 700 kcal imported target");
  const macroPolicyResult = Phases.validatePersistentGoals(policyMacroInvalid);
  ok(!macroPolicyResult.ok && /protein.*40%/i.test(macroPolicyResult.errors.join(" ")) &&
      /fat.*20.*45%/i.test(macroPolicyResult.errors.join(" ")),
    "persistent target policy rejects 2200 kcal with 400 g protein and zero fat");

  const quarantinedTimeline = {
    goals: policyMacroInvalid, goalsUpdatedAt: 30, dayGoals: {}, weights: {}, profile: {},
    phases: [{
      id: "policy-phase", name: "Maintain v1.2", kind: "maintain",
      startDay: "2026-01-01", endDay: null, createdAt: 1, updatedAt: 30,
      revisionTombstones: {}, revisions: [
        { id: "policy-valid", effectiveFrom: "2026-01-01", goals: policyValid, createdAt: 10, updatedAt: 10 },
        { id: "policy-low", effectiveFrom: "2026-02-01", goals: policyLow, createdAt: 20, updatedAt: 20 },
        { id: "policy-macro", effectiveFrom: "2026-03-01", goals: policyMacroInvalid, createdAt: 30, updatedAt: 30 },
      ],
    }],
  };
  Phases.ensureMigrated(quarantinedTimeline, "2026-01-01", "2026-03-15");
  const quarantinedPhase = quarantinedTimeline.phases[0];
  ok(quarantinedPhase.revisions.find((revision) => revision.id === "policy-low").auditOnly === true &&
      quarantinedPhase.revisions.find((revision) => revision.id === "policy-macro").auditOnly === true &&
      quarantinedTimeline.goals.kcal === 2200 && quarantinedTimeline.goals.protein === 140,
    "invalid imported phase revisions remain audit-only while the nearest preceding valid target is active");
  ok(Phases.goalsForDay("2026-02-15", quarantinedTimeline).kcal === 2200 &&
      Phases.goalsForDay("2026-03-15", quarantinedTimeline).protein === 140 &&
      Phases.revisionHistoryRows(quarantinedPhase, "2026-03-15")
        .filter((row) => row.id !== "policy-valid").every((row) => row.auditOnly && row.validationErrors.length),
    "audit-only targets cannot feed historical scoring and stay visible in target history");
  ok(quarantinedTimeline.targetReview && quarantinedTimeline.targetReview.required &&
      quarantinedTimeline.targetReview.fallback === "preceding-valid" &&
      quarantinedTimeline.targetReview.invalidRevisionIds.join(",") === "policy-macro",
    "a bad current target records deterministic review state and its valid fallback");

  const invalidOnlyTimeline = {
    goals: policyLow, goalsUpdatedAt: 20, dayGoals: {}, weights: {}, profile: {}, phases: [],
  };
  Phases.ensureMigrated(invalidOnlyTimeline, null, "2026-03-15");
  const invalidOnlyAudit = invalidOnlyTimeline.phases[0].revisions[0];
  const invalidOnlyOnce = JSON.stringify(invalidOnlyTimeline);
  Phases.ensureMigrated(invalidOnlyTimeline, null, "2026-03-15");
  ok(invalidOnlyAudit.auditOnly === true && invalidOnlyTimeline.goals.kcal === Phases.DEFAULT_GOALS.kcal &&
      invalidOnlyTimeline.targetReview && invalidOnlyTimeline.targetReview.fallback === "generic-default" &&
      JSON.stringify(invalidOnlyTimeline) === invalidOnlyOnce,
    "invalid-only legacy history gets an idempotent generic fallback and explicit review state");

  const historicalInvalidTimeline = {
    goals: policyValid, goalsUpdatedAt: 20, dayGoals: {}, weights: {}, profile: {}, phases: [{
      id: "historical-policy-phase", kind: "maintain", startDay: "2026-01-01", endDay: null,
      createdAt: 1, updatedAt: 20, revisionTombstones: {}, revisions: [
        { id: "historical-invalid", effectiveFrom: "2026-01-01", goals: policyLow, createdAt: 10, updatedAt: 10 },
        { id: "historical-valid", effectiveFrom: "2026-02-01", goals: policyValid, createdAt: 20, updatedAt: 20 },
      ],
    }],
  };
  Phases.ensureMigrated(historicalInvalidTimeline, "2026-01-01", "2026-03-15");
  ok(historicalInvalidTimeline.phases[0].revisions[0].auditOnly === true &&
      !historicalInvalidTimeline.targetReview &&
      Phases.goalsForDay("2026-03-15", historicalInvalidTimeline).kcal === policyValid.kcal,
    "an invalid historical revision stays audit-only without blocking a later valid current target");

  const producerTimeline = JSON.parse(JSON.stringify(historicalInvalidTimeline));
  const producerBefore = JSON.stringify(producerTimeline);
  let appendPolicyError = null, startPolicyError = null;
  try { Phases.appendRevision(producerTimeline, policyLow, "2026-04-01", ""); }
  catch (error) { appendPolicyError = error; }
  try { Phases.startPhase(producerTimeline, {
    kind: "cut", goals: policyMacroInvalid, startDay: "2026-04-01", copyGoals: false,
  }); } catch (error) { startPolicyError = error; }
  ok(appendPolicyError && appendPolicyError.code === "persistent-target-invalid" &&
      startPolicyError && startPolicyError.code === "persistent-target-invalid" &&
      JSON.stringify(producerTimeline) === producerBefore,
    "phase producers reject unsafe persistent targets without mutating the timeline");

  const kindTimeline = {
    goals: { ...Phases.DEFAULT_GOALS }, goalsUpdatedAt: 10, dayGoals: {}, phases: [], weights: {},
  };
  Phases.ensureMigrated(kindTimeline, "2026-08-01", "2026-08-01");
  const kindPhase = kindTimeline.phases[0];
  const governedBeforeKindChange = Phases.governedRevisionUsage(kindTimeline.phases, [{
    id: "kind-root", ts: 20, day: "2026-08-01", type: "add", entry: { id: "kind-entry" },
  }]);
  const beforeUndatedKind = JSON.stringify(kindTimeline);
  ok(governedBeforeKindChange.length === 1 &&
      Phases.updatePhaseMeta(kindTimeline, { kind: "cut" }) === false &&
      JSON.stringify(kindTimeline) === beforeUndatedKind,
    "an undated kind-only update is refused without rewriting logged history");
  const datedKindChange = Phases.updatePhaseMeta(kindTimeline, {
    kind: "cut", effectiveFrom: "2026-08-02",
  });
  ok(datedKindChange && kindPhase.revisions.length === 2 &&
      kindPhase.revisions.every((revision) => revision.kind) &&
      kindPhase.kind === "maintain" && !/Cut/i.test(kindPhase.name),
    "a kind-only change creates a dated target revision");
  ok(Phases.kindForDay(kindPhase, "2026-08-01") === "maintain" &&
      Phases.kindForDay(kindPhase, "2026-08-02") === "cut" &&
      /Maintain/i.test(Phases.labelForDay(kindPhase, "2026-08-01")) &&
      /Cut/i.test(Phases.labelForDay(kindPhase, "2026-08-02")) &&
      Phases.goalsForDay("2026-08-01", kindTimeline).kcal === Phases.DEFAULT_GOALS.kcal,
    "revision-dated kind changes leave the previously logged day stable and begin tomorrow");
  const kindRowsToday = Phases.revisionHistoryRows(kindPhase, "2026-08-01");
  const kindRowsTomorrow = Phases.revisionHistoryRows(kindPhase, "2026-08-02");
  ok(kindRowsToday.find((row) => row.current).kind === "maintain" &&
      kindRowsTomorrow.find((row) => row.current).kind === "cut",
    "target history marks the revision effective on the viewed day, not a future revision");
  ok(/^Cut\b/.test(Phases.revisionLabel(
    { name: "Maintain v1.0", kind: "maintain" },
    { effectiveFrom: "2026-08-02", kind: "cut", goals: Phases.DEFAULT_GOALS }
  )), "legacy dated revisions without label/version still display their own kind");
  const scheduledPhases = [
    {
      id: "scheduled-current", name: "Maintain v1.0", kind: "maintain",
      startDay: "2026-08-01", endDay: "2026-08-01", revisions: [{
        id: "scheduled-current-rev", effectiveFrom: "2026-08-01", kind: "maintain",
        goals: Phases.DEFAULT_GOALS, version: "1.0", label: "Maintain v1.0",
      }],
    },
    {
      id: "scheduled-future", name: "Cut v1.0", kind: "cut",
      startDay: "2026-08-02", endDay: null, revisions: [{
        id: "scheduled-future-rev", effectiveFrom: "2026-08-02", kind: "cut",
        goals: { ...Phases.DEFAULT_GOALS, kcal: 1900 }, version: "1.0", label: "Cut v1.0",
      }],
    },
  ];
  const scheduledRows = Phases.phaseHistoryRows(
    { phases: scheduledPhases, weights: {} }, "2026-08-01", () => ({ count: 0 })
  );
  ok(Phases.phaseForDay(scheduledPhases, "2026-08-01").id === "scheduled-current" &&
      scheduledRows.find((row) => row.active).id === "scheduled-current" &&
      /Maintain/.test(Phases.phaseContext({ phases: scheduledPhases }, "2026-08-01")),
    "a tomorrow-scheduled phase cannot become today's displayed phase early");

  Phases.appendRevision(settings, { ...settings.goals, kcal: 2800, protein: 160 }, "2026-08-01");
  ok(Phases.goalsForDay("2026-07-15", settings).kcal === 2200, "past day unchanged after revision");
  ok(Phases.goalsForDay("2026-08-01", settings).kcal === 2800, "today uses new revision");
  ok(settings.phases[0].revisions.length === 2, "append adds a revision");
  ok(settings.phases[0].name === "Maintain v2.0", "kcal +600 bumps major to Maintain v2.0");

  // same-day second save should replace latest same-day row and bump again
  Phases.appendRevision(settings, { ...settings.goals, kcal: 2850, protein: 160, carbs: 260 }, "2026-08-01");
  ok(settings.phases[0].revisions.length === 2, "same-day re-save replaces instead of stacking");
  ok(Phases.goalsForDay("2026-08-01", settings).kcal === 2850, "same-day re-save keeps latest numbers");
  ok(settings.phases[0].name === "Maintain v2.1", "small same-day tweak bumps minor");

  settings.dayGoals["2026-08-01"] = { bumps: { kcal: 200, protein: 20 }, updatedAt: 200 };
  ok(Phases.goalsForDay("2026-08-01", settings).kcal === 3050, "day bump adds to phase kcal (2850+200)");
  ok(Phases.goalsForDay("2026-08-01", settings).protein === 160, "legacy day bump cannot move the protein floor");
  ok(Phases.goalsForDay("2026-08-01", settings)._dayPlan.kcal === 200, "resolved goals expose _dayPlan");
  ok(Phases.goalsForDay("2026-08-01", settings)._dayPlan.protein == null, "resolved one-day bump contains calories only");

  settings.dayGoals["2026-08-02"] = { kcal: 3050, protein: 999, sodium: 9999, updatedAt: 210 }; // legacy absolute
  // phase for 08-02 still 2850/160 from revision
  ok(Phases.goalsForDay("2026-08-02", settings).kcal === 3050, "legacy absolute dayGoals still resolve");
  ok(Phases.goalsForDay("2026-08-02", settings)._dayPlan.kcal === 200, "legacy absolute converts to bump vs phase");
  ok(Phases.goalsForDay("2026-08-02", settings).protein === 160 && Phases.goalsForDay("2026-08-02", settings).sodium === 2300,
    "legacy absolute dayGoals cannot move floor or safety targets");

  const frozenSettings = JSON.parse(JSON.stringify(settings));
  frozenSettings.dayGoals["2026-08-03"] = {
    targetKcal: 3100, baseKcal: 2850, plannedAt: 220, updatedAt: 220,
  };
  Phases.appendRevision(frozenSettings, {
    ...Phases.goalsForDay("2026-08-03", { ...frozenSettings, dayGoals: {} }), kcal: 2600,
  }, "2026-08-03");
  const frozen = Phases.goalsForDay("2026-08-03", frozenSettings);
  ok(frozen.kcal === 3100 && frozen._phase.kcal === 2850 && frozen._dayPlan.kcal === 250,
    "absolute day plan and its baseline stay frozen across a same-day phase revision");
  ok(Phases.DEFAULT_GOALS.potassium === 3510,
    "new installs use the generic WHO adult potassium reference, not a personal prescription");

  Phases.startPhase(settings, {
    kind: "bulk",
    startDay: "2026-08-10",
    copyGoals: true,
  });
  ok(settings.phases.length === 2, "startPhase adds a phase");
  ok(settings.phases[0].endDay === "2026-08-09", "previous phase ends day before");
  ok(Phases.activePhase(settings.phases).name === "Bulk v1.0", "new phase is Bulk v1.0");
  ok(Phases.goalsForDay("2026-08-05", settings).kcal === 2850, "days in old phase keep old revision");

  const ended = settings.phases[0];
  const endedKeys = Phases.phaseDayKeys(ended, "2026-08-15");
  ok(endedKeys[0] === ended.startDay, "phaseDayKeys starts at startDay");
  ok(endedKeys[endedKeys.length - 1] === ended.endDay, "phaseDayKeys stops at endDay for completed phase");
  ok(!endedKeys.includes("2026-08-10"), "completed phase keys exclude later active phase days");
  const hist = Phases.phaseHistoryRows(settings, "2026-08-15", () => ({ count: 0 }));
  ok(hist.length === 2, "phaseHistoryRows lists both phases");
  ok(hist[0].active === true && hist[0].name === "Bulk v1.0", "history lists active phase first among newest");

  const revRows = Phases.revisionHistoryRows(Phases.activePhase(settings.phases));
  ok(revRows.length === 1 && revRows[0].current, "new phase has one current target version");
  delete settings.dayGoals["2026-08-01"];
  const oldRevId = settings.phases[0].revisions[1].id;
  const del = Phases.deleteRevision(settings, settings.phases[0].id, oldRevId, "2026-08-15");
  ok(del.ok, "can delete a past target version");
  ok(settings.phases[0].revisions.length === 1, "deleteRevision removes one");
  ok(Phases.goalsForDay("2026-08-01", settings).kcal === 2200, "after delete, day falls back to earlier revision");

  const guardSettings = {
    goals: { ...settings.goals }, goalsUpdatedAt: 300, dayGoals: {}, weights: {},
    phases: [{
      id: "guard-phase", name: "Maintain v1.2", kind: "maintain",
      startDay: "2026-01-01", endDay: null, createdAt: 1, updatedAt: 30,
      revisionTombstones: {}, revisions: [
        { id: "guard-unused", effectiveFrom: "2026-01-01", goals: { ...settings.goals, kcal: 1900, carbs: 150 }, createdAt: 1, updatedAt: 1 },
        { id: "guard-history", effectiveFrom: "2026-02-01", goals: { ...settings.goals, kcal: 2000, carbs: 175 }, createdAt: 2, updatedAt: 2 },
        { id: "guard-current", effectiveFrom: "2026-03-01", goals: { ...settings.goals, kcal: 2100, carbs: 200 }, createdAt: 3, updatedAt: 3 },
      ],
    }],
  };
  const currentAdd = { id: "guard-add-current", ts: 10, day: "2026-03-10", type: "add", entry: { id: "guard-current-entry" } };
  const removedAdd = { id: "guard-add-removed", ts: 11, day: "2026-02-10", type: "add", entry: { id: "guard-removed-entry" } };
  const removed = { id: "guard-remove", ts: 12, day: "2026-02-10", type: "remove", target: "guard-removed-entry" };
  const guardEvents = [currentAdd, removedAdd, removed];
  const beforeCurrentDelete = JSON.stringify(guardSettings);
  const currentDelete = Phases.deleteRevision(
    guardSettings, "guard-phase", "guard-current", "2026-03-10", guardEvents
  );
  ok(!currentDelete.ok && currentDelete.reason === "governed" && JSON.stringify(guardSettings) === beforeCurrentDelete,
    "current target version cannot be deleted after its first immutable add");
  const beforeHistoricalDelete = JSON.stringify(guardSettings);
  const historicalDelete = Phases.deleteRevision(
    guardSettings, "guard-phase", "guard-history", "2026-03-10", guardEvents
  );
  ok(!historicalDelete.ok && historicalDelete.reason === "governed" && JSON.stringify(guardSettings) === beforeHistoricalDelete,
    "historical target version that governed a logged day cannot be deleted");
  const removedOnly = Phases.revisionDeletionStatus(
    guardSettings, "guard-phase", "guard-history", [removedAdd, removed]
  );
  ok(!removedOnly.ok && removedOnly.reason === "governed",
    "deleting the last visible entry does not unlock its governing target version");
  const unusedDelete = Phases.deleteRevision(
    guardSettings, "guard-phase", "guard-unused", "2026-03-10", guardEvents
  );
  ok(unusedDelete.ok && !guardSettings.phases[0].revisions.some((r) => r.id === "guard-unused"),
    "a target version that never governed an immutable add remains deletable");

  Phases.appendRevision(settings, { ...Phases.activePhase(settings.phases).revisions[0].goals, kcal: 3500, carbs: 400, fat: 80 }, "2026-08-15", "", { kind: "bulk" });
  ok(Phases.activePhase(settings.phases).name === "Bulk v2.0", "large kcal change forces major version");

  ok(Phases.normalizeKind("recomp") === "recomp", "recomp is a valid kind");
  ok(Phases.formatPhaseName("recomp", 1, 0) === "Recomp v1.0", "recomp formats as Recomp v1.0");
  ok(Phases.ageFromDob("1990-08-02", "2026-08-01") === 35, "ageFromDob before birthday");
  ok(Phases.ageFromDob("1990-08-02", "2026-08-02") === 36, "ageFromDob on birthday");
  settings.profile = Phases.normalizeProfile({
    dob: "1990-01-01", sex: "male", heightCm: 175, activity: "moderate", updatedAt: 1,
  });
  settings.weights["2026-08-15"] = { kg: 80, updatedAt: 1 };
  let ready = Phases.profileReadyForAi(settings, { todayKey: "2026-08-15" });
  ok(ready.ok && ready.age === 36 && ready.weightKg === 80, "profileReadyForAi when complete");
  ready = Phases.profileReadyForAi({ profile: {}, weights: {} }, { todayKey: "2026-08-15" });
  ok(!ready.ok && ready.missing.length >= 4, "profileReadyForAi lists missing fields");
  ready = Phases.profileReadyForAi({
    profile: { dob: "2010-01-01", sex: "female", heightCm: 160, activity: "moderate" },
    weights: { "2026-08-15": { kg: 55 } },
  }, { todayKey: "2026-08-15" });
  ok(!ready.ok && ready.under18, "automated AI targets are blocked for users under 18");
  const incompleteEligibility = Phases.automatedTargetEligibility(
    { profile: { dob: "1990-01-01" }, weights: {} }, { todayKey: "2026-08-15" }
  );
  ok(incompleteEligibility.status === "review" && !incompleteEligibility.canApply &&
      /For review only/i.test(incompleteEligibility.message),
    "incomplete profiles are centralized as review-only with a clear automated-target message");
  const highRiskEligibility = Phases.automatedTargetEligibility({
    profile: {
      dob: "1990-01-01", sex: "female", heightCm: 168, activity: "moderate",
      notes: "Kidney disease monitored by my clinician",
    },
    weights: { "2026-08-15": { kg: 62 } },
  }, { todayKey: "2026-08-15" });
  ok(highRiskEligibility.status === "review" && !highRiskEligibility.canApply &&
      /professional guidance/i.test(highRiskEligibility.message),
    "high-risk profile notes use the same review-only eligibility gate for TDEE and AI targets");

  const scored = Phases.scoreDayTotals(
    { count: 1, kcal: { mean: 2200 }, p: { mean: 100 }, c: { mean: 250 }, f: { mean: 70 }, fb: { mean: 28 }, na: { mean: 2000 } },
    { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300 }
  );
  ok(scored.kcal.status === "hit", "kcal within ±10% is hit");
  ok(scored.protein.status === "under", "protein below floor is under");

  // classify dirs: Today HUD warns only on "over"; floor overshoot must stay hit
  ok(Phases.classify(160, 140, Phases.BANDS.protein) === "hit", "floor: protein over target is hit");
  ok(Phases.classify(2500, 2300, Phases.BANDS.sodium) === "over", "ceiling: sodium over target is over");
  ok(Phases.classify(1800, 2200, Phases.BANDS.kcal) === "under", "range: kcal below band is under");
  ok(Phases.classify(2500, 2200, Phases.BANDS.kcal) === "over", "range: kcal above band is over");

  // HUD bar warn: past printed goal for ceiling/range; floors never warn high
  ok(Phases.hudBarOver(2035, 2000, Phases.BANDS.sodium) === true, "HUD: sodium past ceiling warns");
  ok(Phases.hudBarOver(2000, 2000, Phases.BANDS.sodium) === false, "HUD: sodium at ceiling not over");
  ok(Phases.hudBarOver(2050, 2000, Phases.BANDS.sodium) === true, "HUD: sodium in scoring band still warns");
  ok(Phases.hudBarOver(2500, 2200, Phases.BANDS.kcal) === true, "HUD: kcal past goal warns");
  ok(Phases.hudBarOver(2300, 2200, Phases.BANDS.kcal) === true, "HUD: kcal slightly over goal warns");
  ok(Phases.hudBarOver(2200, 2200, Phases.BANDS.kcal) === false, "HUD: kcal at goal not over");
  ok(Phases.hudBarOver(160, 140, Phases.BANDS.protein) === false, "HUD: protein over floor does not warn");
  ok(Phases.hudBarOver(40, 30, Phases.BANDS.fiber) === false, "HUD: fiber over floor does not warn");

  const merged = Phases.mergePhases(
    [{ id: "ph1", updatedAt: 100, startDay: "2026-01-01", endDay: null, revisions: [{ id: "r1", effectiveFrom: "2026-01-01", goals: { kcal: 2000 } }] }],
    [{ id: "ph1", updatedAt: 200, startDay: "2026-01-01", endDay: null, revisions: [{ id: "r1", effectiveFrom: "2026-01-01", goals: { kcal: 2000 } }, { id: "r2", effectiveFrom: "2026-03-01", goals: { kcal: 2500 } }] }]
  );
  ok(merged[0].revisions.length === 2, "mergePhases unions revisions by id");

  const tombstoned = Phases.mergePhases(
    [{ id: "ph-del", updatedAt: 300, startDay: "2026-01-01", revisions: [
      { id: "keep", effectiveFrom: "2026-01-01", goals: { kcal: 2000 }, createdAt: 100, updatedAt: 100 },
      { id: "deleted", effectiveFrom: "2026-02-01", goals: { kcal: 2200 }, createdAt: 200, updatedAt: 200 },
    ] }],
    [{ id: "ph-del", updatedAt: 500, startDay: "2026-01-01", revisionTombstones: { deleted: 500 }, revisions: [
      { id: "keep", effectiveFrom: "2026-01-01", goals: { kcal: 2000 }, createdAt: 100, updatedAt: 100 },
    ] }]
  );
  ok(tombstoned[0].revisions.length === 1 && tombstoned[0].revisions[0].id === "keep",
    "phase revision tombstone prevents stale revision resurrection");

  const revised = Phases.mergePhases(
    [{ id: "ph-edit", updatedAt: 100, startDay: "2026-01-01", revisions: [
      { id: "same", effectiveFrom: "2026-01-01", goals: { kcal: 2000 }, createdAt: 50, updatedAt: 100 },
    ] }],
    [{ id: "ph-edit", updatedAt: 200, startDay: "2026-01-01", revisions: [
      { id: "same", effectiveFrom: "2026-01-01", goals: { kcal: 2300 }, createdAt: 50, updatedAt: 200 },
    ] }]
  );
  ok(revised[0].revisions[0].goals.kcal === 2300,
    "same-id phase revision resolves by revision updatedAt");

  const fp1 = require("../js/sync.js").fingerprint({
    resetAt: 0, events: [], personalFoods: [], dayGoals: {}, phases: settings.phases, weights: {}, goals: settings.goals,
  });
  settings.phases[1].updatedAt = Date.now() + 1;
  const fp2 = require("../js/sync.js").fingerprint({
    resetAt: 0, events: [], personalFoods: [], dayGoals: {}, phases: settings.phases, weights: {}, goals: settings.goals,
  });
  ok(fp1 !== fp2, "fingerprint changes when a phase updates");
  const fpSafetyA = require("../js/sync.js").fingerprint({
    version: 3, events: [], personalFoods: [], dayGoals: { "2026-08-03": { bumps: { protein: 20, potassium: 0 }, updatedAt: 1 } },
    phases: [], weights: {}, profile: { notes: "a" }, goals: {},
  });
  const fpSafetyB = require("../js/sync.js").fingerprint({
    version: 3, events: [], personalFoods: [], dayGoals: { "2026-08-03": { bumps: { protein: 200, potassium: 500 }, updatedAt: 1 } },
    phases: [], weights: {}, profile: { notes: "a" }, goals: {},
  });
  ok(fpSafetyA !== fpSafetyB, "fingerprint detects forbidden day bump fields so Drive cleanup is written");
  const fpCalories = require("../js/sync.js").fingerprint({
    version: 3, events: [], personalFoods: [], dayGoals: { "2026-08-03": { bumps: { kcal: 500, protein: 200 }, updatedAt: 1 } },
    phases: [], weights: {}, profile: { notes: "a" }, goals: {},
  });
  ok(fpSafetyB !== fpCalories, "fingerprint covers the allowed calorie day bump");
  const fpProfile = require("../js/sync.js").fingerprint({
    version: 3, events: [], personalFoods: [], dayGoals: { "2026-08-03": { bumps: { kcal: 500 }, updatedAt: 1 } },
    phases: [], weights: {}, profile: { notes: "b" }, goals: {},
  });
  ok(fpCalories !== fpProfile, "fingerprint covers complete profile fields");
}

console.log("\n[8] Cloud sync merge (conflict-free by construction)");
{
  globalThis.Phases = require("../js/phases.js");
  const Sync = require("../js/sync.js");

  // two devices logged different meals offline → union, ordered by time
  const evA = [{ id: "e1", ts: 100, day: "2026-07-16", type: "add", entry: { id: "x1", name: "eggs" } }];
  const evB = [
    { id: "e1", ts: 100, day: "2026-07-16", type: "add", entry: { id: "x1", name: "eggs" } }, // shared history
    { id: "e2", ts: 200, day: "2026-07-16", type: "add", entry: { id: "x2", name: "banana" } },
  ];
  const evC = [{ id: "e3", ts: 150, day: "2026-07-16", type: "amend", target: "x1", patch: { grams: 120 } }];
  const merged = Sync.mergeEvents([...evA, ...evC], evB);
  ok(merged.length === 3, "event union dedupes shared history");
  ok(merged[0].id === "e1" && merged[1].id === "e3" && merged[2].id === "e2", "merged events re-sort by timestamp (amend lands between adds)");

  const protectedRevision = {
    id: "sync-governed", effectiveFrom: "2026-02-01",
    goals: { kcal: 2100, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300, potassium: 3510 },
    createdAt: 20, updatedAt: 20,
  };
  const baseRevision = {
    id: "sync-base", effectiveFrom: "2026-01-01",
    goals: { ...protectedRevision.goals, kcal: 2000 }, createdAt: 10, updatedAt: 10,
  };
  const livePhase = {
    id: "sync-phase-guard", name: "Maintain v1.1", kind: "maintain",
    startDay: "2026-01-01", endDay: null, createdAt: 1, updatedAt: 20,
    revisionTombstones: {}, revisions: [baseRevision, protectedRevision],
  };
  const deletingPhase = {
    ...livePhase, updatedAt: 500, revisionTombstones: { "sync-governed": 500 },
    revisions: [baseRevision],
  };
  const protectedAdd = {
    id: "sync-phase-add", ts: 100, day: "2026-02-10", type: "add",
    entry: { id: "sync-phase-entry", name: "logged under protected revision" },
  };
  const phaseDoc = (events, phases) => ({
    version: 4, resetAt: 0, events, personalFoods: [], dayGoals: {}, dayPlans: {},
    phases, weights: {}, profile: {}, goals: protectedRevision.goals, goalsUpdatedAt: 20,
  });
  const eventShard = phaseDoc([protectedAdd], [livePhase]);
  const tombstoneShard = phaseDoc([], [deletingPhase]);
  const guardedForward = Sync.mergeDocs(eventShard, tombstoneShard).doc;
  const guardedReverse = Sync.mergeDocs(tombstoneShard, eventShard).doc;
  const guardedPhase = guardedForward.phases[0];
  ok(guardedPhase.revisions.some((r) => r.id === "sync-governed") &&
      guardedPhase.revisionTombstones["sync-governed"] == null,
    "merged immutable add defeats a remote tombstone for its governing target version");
  ok(Sync.fingerprint(guardedForward) === Sync.fingerprint(guardedReverse),
    "governing-revision protection converges in both shard orders");
  const guardedAgain = Sync.mergeDocs(guardedForward, tombstoneShard).doc;
  ok(Sync.fingerprint(guardedAgain) === Sync.fingerprint(guardedForward),
    "governing-revision tombstone healing is idempotent and avoids write loops");

  // personal foods: newest wins, tombstones propagate deletes
  const pfA = [{ id: "pf1", name: "dal", updatedAt: 100 }, { id: "pf2", name: "smoothie", updatedAt: 500, deleted: true }];
  const pfB = [{ id: "pf1", name: "dal (improved)", updatedAt: 300 }, { id: "pf2", name: "smoothie", updatedAt: 200 }];
  const pf = Sync.mergePersonal(pfA, pfB);
  ok(pf.find((f) => f.id === "pf1").name === "dal (improved)", "newer edit of a recipe wins");
  ok(pf.find((f) => f.id === "pf2").deleted === true, "tombstone delete beats older copy (no resurrection)");

  // full doc merge: goals latest-wins + change flags
  const local = { version: 1, events: evA, personalFoods: pfA, goals: { protein: 140 }, goalsUpdatedAt: 100 };
  const remote = { version: 1, events: evB, personalFoods: pfB, goals: { protein: 160 }, goalsUpdatedAt: 900 };
  const r = Sync.mergeDocs(local, remote);
  ok(r.doc.goals.protein === 160, "goals: latest update wins");
  ok(r.differsFromLocal === true, "merge detects local needs updating");
  ok(r.differsFromRemote === true, "merge detects remote needs updating");

  const same = Sync.mergeDocs(r.doc, r.doc);
  ok(same.differsFromRemote === false, "idempotent: merging a doc with itself changes nothing");

  const syncPolicyValid = {
    kcal: 2200, protein: 140, carbs: 250, fat: 70,
    fiber: 28, sodium: 2300, potassium: 3510,
  };
  const syncPolicyLow = { ...syncPolicyValid, kcal: 700 };
  const syncPolicyMacroInvalid = {
    kcal: 2200, protein: 400, carbs: 150, fat: 0,
    fiber: 28, sodium: 2300, potassium: 3510,
  };
  const policyShard = (revisions, goals, goalsUpdatedAt, updatedAt) => ({
    version: 4, resetAt: 0, events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {},
    phases: [{
      id: "sync-policy-phase", name: "Maintain", kind: "maintain", startDay: "2026-01-01",
      endDay: null, createdAt: 1, updatedAt, revisionTombstones: {}, revisions,
    }],
    weights: {}, profile: {}, goals, goalsUpdatedAt,
  });
  const validPolicyShard = policyShard([{
    id: "sync-policy-valid", effectiveFrom: "2026-01-01", goals: syncPolicyValid,
    createdAt: 10, updatedAt: 10,
  }], syncPolicyValid, 10, 10);
  const invalidPolicyShard = policyShard([{
    id: "sync-policy-low", effectiveFrom: "2026-02-01", goals: syncPolicyLow,
    createdAt: 20, updatedAt: 20,
  }, {
    id: "sync-policy-macro", effectiveFrom: "2026-03-01", goals: syncPolicyMacroInvalid,
    createdAt: 30, updatedAt: 30,
  }], syncPolicyMacroInvalid, 30, 30);
  const policyForward = Sync.mergeDocs(validPolicyShard, invalidPolicyShard).doc;
  const policyReverse = Sync.mergeDocs(invalidPolicyShard, validPolicyShard).doc;
  const policyMergedPhase = policyForward.phases[0];
  ok(Sync.fingerprint(policyForward) === Sync.fingerprint(policyReverse) &&
      policyForward.goals.kcal === syncPolicyValid.kcal && policyForward.goals.protein === syncPolicyValid.protein,
    "Drive merge quarantines unsafe targets and converges on the preceding valid target in either shard order");
  ok(policyMergedPhase.revisions.find((revision) => revision.id === "sync-policy-low").auditOnly === true &&
      policyMergedPhase.revisions.find((revision) => revision.id === "sync-policy-macro").auditOnly === true &&
      Phases.revisionForDay(policyMergedPhase, "2026-04-01").id === "sync-policy-valid",
    "Drive-retained unsafe revisions are audit-only and cannot become active");
  ok(Sync.fingerprint(Sync.mergeDocs(policyForward, invalidPolicyShard).doc) === Sync.fingerprint(policyForward),
    "quarantined Drive target history is idempotent and does not create a write loop");
  const invalidOnlyForward = Sync.mergeDocs(
    policyShard([{ id: "only-low", effectiveFrom: "2026-01-01", goals: syncPolicyLow, createdAt: 10, updatedAt: 10 }], syncPolicyLow, 10, 10),
    policyShard([{ id: "only-macro", effectiveFrom: "2026-02-01", goals: syncPolicyMacroInvalid, createdAt: 20, updatedAt: 20 }], syncPolicyMacroInvalid, 20, 20)
  ).doc;
  const invalidOnlyReverse = Sync.mergeDocs(
    policyShard([{ id: "only-macro", effectiveFrom: "2026-02-01", goals: syncPolicyMacroInvalid, createdAt: 20, updatedAt: 20 }], syncPolicyMacroInvalid, 20, 20),
    policyShard([{ id: "only-low", effectiveFrom: "2026-01-01", goals: syncPolicyLow, createdAt: 10, updatedAt: 10 }], syncPolicyLow, 10, 10)
  ).doc;
  ok(Sync.fingerprint(invalidOnlyForward) === Sync.fingerprint(invalidOnlyReverse) &&
      invalidOnlyForward.goals.kcal === Phases.DEFAULT_GOALS.kcal &&
      invalidOnlyForward.phases[0].revisions.every((revision) => revision.auditOnly === true),
    "invalid-only Drive history converges on the deterministic generic fallback in both shard orders");

  // Clear-all resetAt must not resurrect remote history
  const wiped = {
    version: 1,
    resetAt: 1000,
    events: [],
    personalFoods: [],
    goals: { protein: 140 },
    goalsUpdatedAt: 100,
  };
  const cloud = {
    version: 1,
    resetAt: 0,
    events: evB,
    personalFoods: pfB,
    goals: { protein: 160 },
    goalsUpdatedAt: 900,
  };
  const afterClear = Sync.mergeDocs(wiped, cloud);
  ok(afterClear.doc.events.length === 0, "newer resetAt drops pre-reset remote events");
  ok(afterClear.doc.personalFoods.length === 0, "newer resetAt drops pre-reset remote foods");
  ok(afterClear.doc.resetAt === 1000, "resetAt carries forward");

  const privateCloud = {
    ...cloud,
    profile: { dob: "1980-01-01", sex: "female", notes: "private", updatedAt: 900 },
    goals: { protein: 190 },
    goalsUpdatedAt: 900,
  };
  const privateWipe = {
    ...wiped,
    profile: { resetEpoch: 1000 },
    goals: { protein: 140 },
    goalsUpdatedAt: 1001,
    goalsResetEpoch: 1000,
  };
  const afterPrivateClear = Sync.mergeDocs(privateWipe, privateCloud);
  ok(!afterPrivateClear.doc.profile.notes && !afterPrivateClear.doc.profile.dob,
    "newer reset does not resurrect a stale remote profile");
  ok(afterPrivateClear.doc.goals.protein === 140,
    "newer reset keeps reset-era goals instead of stale remote goals");
  const remotePrivateClear = Sync.mergeDocs(privateCloud, privateWipe);
  ok(!remotePrivateClear.doc.profile.notes && remotePrivateClear.doc.goals.protein === 140,
    "remote reset privacy boundary is symmetric");

  const generationGoals = { ...Phases.DEFAULT_GOALS, kcal: 2400, protein: 155 };
  const oldGenerationRoot = {
    id: "old-generation-root", ts: 10, day: "2026-07-10", type: "add", resetEpoch: 0,
    causal: { entryId: "old-generation-entry", seq: 0, parentEventId: null },
    entry: { id: "old-generation-entry", name: "private old entry", grams: 100 },
  };
  const oldGenerationChild = {
    id: "old-generation-child", ts: 20, day: "2026-07-10", type: "amend", resetEpoch: 0,
    causal: { entryId: "old-generation-entry", seq: 1, parentEventId: "old-generation-root" },
    target: "old-generation-entry", patch: { grams: 120 },
  };
  const newGenerationRoot = {
    id: "new-generation-root", ts: 110, day: "2026-08-10", type: "add", resetEpoch: 100,
    causal: { entryId: "new-generation-entry", seq: 0, parentEventId: null },
    dayGoalLock: { targetKcal: 2450, baseKcal: 2400, plannedAt: 105 },
    entry: { id: "new-generation-entry", name: "new entry", grams: 100 },
  };
  const newGenerationChild = {
    id: "new-generation-child", ts: 120, day: "2026-08-10", type: "amend", resetEpoch: 0,
    causal: { entryId: "new-generation-entry", seq: 1, parentEventId: "new-generation-root" },
    target: "new-generation-entry", patch: { grams: 130 },
  };
  const staleGenerationDoc = {
    version: 4, resetAt: 0,
    events: [oldGenerationRoot, oldGenerationChild],
    personalFoods: [{ id: "food-old", name: "old food", updatedAt: 20 }],
    dayGoals: { "2026-07-11": { kcal: 2500, updatedAt: 20 } },
    dayPlans: { "2026-07-12": { items: [{ id: "old-plan" }], updatedAt: 20 } },
    gapDrafts: { "2026-07-13": { selected: [{ name: "old draft" }], updatedAt: 20 } },
    phases: [{
      id: "phase-old", kind: "maintain", startDay: "2026-07-01", endDay: null,
      createdAt: 10, updatedAt: 20, revisionTombstones: { "old-tomb": 20 },
      revisions: [{ id: "revision-old", effectiveFrom: "2026-07-01", goals: generationGoals, updatedAt: 20 }],
    }],
    weights: { "2026-07-14": { kg: 80, updatedAt: 20 } },
    profile: { sex: "female", notes: "old private profile", updatedAt: 20 },
    goals: { ...generationGoals, kcal: 1900 }, goalsUpdatedAt: 20,
  };
  const currentGenerationDoc = {
    version: 4, resetAt: 100,
    events: [newGenerationRoot, newGenerationChild],
    personalFoods: [{ id: "food-new", name: "new food", updatedAt: 130, resetEpoch: 100 }],
    dayGoals: { "2026-08-11": { targetKcal: 2500, baseKcal: 2400, updatedAt: 130, resetEpoch: 100 } },
    dayPlans: { "2026-08-12": { items: [{ id: "new-plan" }], updatedAt: 130, resetEpoch: 100 } },
    gapDrafts: { "2026-08-13": { selected: [{ name: "new draft" }], updatedAt: 130, resetEpoch: 100 } },
    phases: [{
      id: "phase-new", kind: "maintain", startDay: "2026-08-01", endDay: null,
      createdAt: 100, updatedAt: 140, resetEpoch: 100,
      revisionTombstones: { "stale-tomb": 90, "current-tomb": 140 },
      revisionTombstoneEpochs: { "stale-tomb": 0, "current-tomb": 100 },
      revisions: [
        { id: "revision-stale", effectiveFrom: "2026-08-01", goals: { ...generationGoals, kcal: 2300 }, updatedAt: 90, resetEpoch: 0 },
        { id: "revision-new", effectiveFrom: "2026-08-01", goals: generationGoals, kind: "maintain", updatedAt: 140, resetEpoch: 100 },
      ],
    }],
    weights: { "2026-08-14": { kg: 79, updatedAt: 130, resetEpoch: 100 } },
    profile: { sex: "male", notes: "new profile", updatedAt: 130, resetEpoch: 100 },
    goals: generationGoals, goalsUpdatedAt: 140, goalsResetEpoch: 100,
  };
  const generationForward = Sync.mergeDocs(currentGenerationDoc, staleGenerationDoc).doc;
  const generationReverse = Sync.mergeDocs(staleGenerationDoc, currentGenerationDoc).doc;
  ok(generationForward.events.map((event) => event.id).sort().join(",") ===
      "new-generation-child,new-generation-root" &&
      !generationForward.events.some((event) => event.id === "old-generation-child"),
    "reset filtering drops an entire old-root causal component even when its child claims the new generation");
  ok(generationForward.events.some((event) => event.id === "new-generation-child"),
    "a new-root causal component survives as a whole even when a descendant carries stale metadata");
  ok(generationForward.personalFoods.map((food) => food.id).join(",") === "food-new" &&
      !generationForward.dayGoals["2026-07-11"] && generationForward.dayGoals["2026-08-11"] &&
      !generationForward.dayPlans["2026-07-12"] && generationForward.dayPlans["2026-08-12"] &&
      !generationForward.gapDrafts["2026-07-13"] && generationForward.gapDrafts["2026-08-13"] &&
      !generationForward.weights["2026-07-14"] && generationForward.weights["2026-08-14"],
    "reset generation filtering covers foods, day goals, plans, GAP drafts, and weights");
  ok(generationForward.phases.length === 1 && generationForward.phases[0].id === "phase-new" &&
      generationForward.phases[0].revisions.length === 1 &&
      generationForward.phases[0].revisions[0].id === "revision-new" &&
      !generationForward.phases[0].revisionTombstones["stale-tomb"] &&
      generationForward.phases[0].revisionTombstones["current-tomb"] === 140,
    "reset generation filtering covers phases, revisions, and revision tombstones",
    JSON.stringify(generationForward.phases));
  ok(generationForward.profile.notes === "new profile" && generationForward.goals.kcal === 2400 &&
      generationForward.goalsResetEpoch === 100,
    "reset generation filtering covers profile and goals singletons",
    JSON.stringify({ profile: generationForward.profile, goals: generationForward.goals,
      goalsResetEpoch: generationForward.goalsResetEpoch }));
  ok(Sync.fingerprint(generationForward) === Sync.fingerprint(generationReverse) &&
      Sync.fingerprint(Sync.mergeDocs(generationForward, generationForward).doc) === Sync.fingerprint(generationForward) &&
      Sync.fingerprint(Sync.mergeDocs(generationForward, staleGenerationDoc).doc) === Sync.fingerprint(generationForward),
    "generation filtering converges in either shard order and is idempotent",
    JSON.stringify({ forward: Sync.fingerprint(generationForward), reverse: Sync.fingerprint(generationReverse),
      self: Sync.fingerprint(Sync.mergeDocs(generationForward, generationForward).doc),
      stale: Sync.fingerprint(Sync.mergeDocs(generationForward, staleGenerationDoc).doc) }));
  const legacyBeforeReset = Sync.mergeDocs(staleGenerationDoc, staleGenerationDoc).doc;
  ok(legacyBeforeReset.events.length === 2 && legacyBeforeReset.personalFoods.length === 1 &&
      legacyBeforeReset.profile.notes === "old private profile",
    "missing generation metadata remains usable only in legacy generation zero before the first reset");

  const upgradeRoot = {
    id: "upgrade-current-root", ts: 110, day: "2026-08-15", type: "add",
    causal: { entryId: "upgrade-current-entry", seq: 0, parentEventId: null },
    entry: { id: "upgrade-current-entry", name: "post-reset meal" },
  };
  const upgradeChild = {
    id: "upgrade-current-child", ts: 120, day: "2026-08-15", type: "amend",
    causal: { entryId: "upgrade-current-entry", seq: 1, parentEventId: "upgrade-current-root" },
    target: "upgrade-current-entry", patch: { grams: 125 },
  };
  const upgradeStaleRoot = {
    id: "upgrade-stale-root", ts: 90, day: "2026-07-15", type: "add",
    causal: { entryId: "upgrade-stale-entry", seq: 0, parentEventId: null },
    entry: { id: "upgrade-stale-entry", name: "provably pre-reset meal" },
  };
  const upgradeStaleChild = {
    id: "upgrade-stale-child", ts: 130, day: "2026-07-15", type: "amend",
    causal: { entryId: "upgrade-stale-entry", seq: 1, parentEventId: "upgrade-stale-root" },
    target: "upgrade-stale-entry", patch: { grams: 999 },
  };
  const legacyUpgradeDoc = {
    version: 4, resetAt: 100,
    events: [upgradeStaleChild, upgradeRoot, upgradeStaleRoot, upgradeChild],
    personalFoods: [
      { id: "upgrade-food-current", name: "current", updatedAt: 110 },
      { id: "upgrade-food-stale", name: "stale", updatedAt: 90 },
    ],
    dayGoals: {
      "2026-08-16": { targetKcal: 2400, baseKcal: 2200, updatedAt: 110 },
      "2026-07-16": { targetKcal: 2600, baseKcal: 2200, updatedAt: 90 },
    },
    dayPlans: {
      "2026-08-17": { items: [{ id: "current" }], updatedAt: 110 },
      "2026-07-17": { items: [{ id: "stale" }], updatedAt: 90 },
    },
    gapDrafts: { "2026-08-18": { selected: [{ name: "current" }], updatedAt: 110 } },
    phases: [
      {
        id: "upgrade-phase-current", kind: "maintain", startDay: "2026-08-01",
        createdAt: 100, updatedAt: 120, revisionTombstones: { gone: 125 },
        revisions: [{
          id: "upgrade-revision-current", effectiveFrom: "2026-08-01",
          goals: generationGoals, createdAt: 105, updatedAt: 105,
        }],
      },
      {
        id: "upgrade-phase-stale", kind: "maintain", startDay: "2026-07-01",
        createdAt: 90, updatedAt: 130,
        revisions: [{
          id: "upgrade-revision-stale", effectiveFrom: "2026-07-01",
          goals: { ...generationGoals, kcal: 1800 }, createdAt: 90, updatedAt: 130,
        }],
      },
    ],
    weights: {
      "2026-08-19": { kg: 78, updatedAt: 110 },
      "2026-07-19": { kg: 88, updatedAt: 90 },
    },
    profile: { sex: "male", notes: "current profile", updatedAt: 110 },
    goals: generationGoals, goalsUpdatedAt: 110,
  };
  const resetZeroStaleShard = {
    ...staleGenerationDoc,
    events: [oldGenerationRoot, oldGenerationChild],
  };
  const upgradedForward = Sync.mergeDocs(legacyUpgradeDoc, resetZeroStaleShard).doc;
  const upgradedReverse = Sync.mergeDocs(resetZeroStaleShard, legacyUpgradeDoc).doc;
  const upgradedAgain = Sync.mergeDocs(upgradedForward, legacyUpgradeDoc).doc;
  ok(upgradedForward.generationSchemaVersion === Sync.GENERATION_SCHEMA_VERSION &&
      upgradedForward.events.map((event) => event.id).sort().join(",") ===
        "upgrade-current-child,upgrade-current-root" &&
      upgradedForward.events.every((event) => event.resetEpoch === 100) &&
      upgradedForward.personalFoods.map((food) => food.id).join(",") === "upgrade-food-current" &&
      upgradedForward.dayGoals["2026-08-16"].resetEpoch === 100 &&
      !upgradedForward.dayGoals["2026-07-16"] &&
      upgradedForward.dayPlans["2026-08-17"].resetEpoch === 100 &&
      !upgradedForward.dayPlans["2026-07-17"] &&
      upgradedForward.gapDrafts["2026-08-18"].resetEpoch === 100 &&
      upgradedForward.weights["2026-08-19"].resetEpoch === 100 &&
      !upgradedForward.weights["2026-07-19"] &&
      upgradedForward.phases.length === 1 &&
      upgradedForward.phases[0].id === "upgrade-phase-current" &&
      upgradedForward.phases[0].resetEpoch === 100 &&
      upgradedForward.phases[0].revisions[0].resetEpoch === 100 &&
      upgradedForward.phases[0].revisionTombstoneEpochs.gone === 100 &&
      upgradedForward.profile.resetEpoch === 100 &&
      upgradedForward.goalsResetEpoch === 100 &&
      upgradedForward.goals.kcal === generationGoals.kcal,
    "a legacy post-reset v4 snapshot is stamped before filtering while provably pre-reset components stay private");
  ok(Sync.fingerprint(upgradedForward) === Sync.fingerprint(upgradedReverse) &&
      Sync.fingerprint(upgradedForward) === Sync.fingerprint(upgradedAgain),
    "generation rollout migration converges in either order and remains stable on the second sync");

  // legacyUpgradeDoc's phase revision goals happen to equal generationGoals too,
  // so upgradedForward.goals content alone cannot prove the raw goals singleton
  // (as opposed to the phase-revision fallback at js/sync.js ~820-835) actually
  // survived the migration. Use a phase-free legacy doc so the singleton's
  // content is the only source and is genuinely exercised.
  const legacyGoalsOnlyDoc = {
    version: 4, resetAt: 100,
    events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {},
    phases: [], weights: {},
    profile: { sex: "male", notes: "goals-only profile", updatedAt: 110 },
    goals: generationGoals, goalsUpdatedAt: 110,
  };
  const legacyGoalsOnlyStaleShard = {
    version: 4, resetAt: 0,
    events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {},
    phases: [], weights: {}, profile: null, goals: null, goalsUpdatedAt: 0,
  };
  const upgradedGoalsOnly = Sync.mergeDocs(legacyGoalsOnlyDoc, legacyGoalsOnlyStaleShard).doc;
  ok(upgradedGoalsOnly.goals.kcal === generationGoals.kcal &&
      upgradedGoalsOnly.goals.protein === generationGoals.protein &&
      upgradedGoalsOnly.goalsResetEpoch === 100,
    "a legacy post-reset goals singleton with no active phase survives the generation rollout migration unmasked",
    JSON.stringify({ goals: upgradedGoalsOnly.goals, goalsResetEpoch: upgradedGoalsOnly.goalsResetEpoch }));

  let futureGenerationError = null, missingGenerationError = null;
  try {
    Sync.mergeDocs({
      version: 4,
      generationSchemaVersion: 1,
      resetAt: 0,
      events: [], personalFoods: [{ id: "impossible", updatedAt: 1, resetEpoch: 100 }],
      dayGoals: {}, dayPlans: {}, gapDrafts: {}, phases: [], weights: {},
      profile: { resetEpoch: 0 }, goals: generationGoals, goalsResetEpoch: 0,
    }, {});
  } catch (error) { futureGenerationError = error; }
  try {
    Sync.validateDocGenerations({
      version: 4, generationSchemaVersion: 1, resetAt: 100,
      events: [], personalFoods: [{ id: "missing", updatedAt: 110 }],
      dayGoals: {}, dayPlans: {}, gapDrafts: {}, phases: [], weights: {},
      profile: { resetEpoch: 100 }, goals: generationGoals, goalsResetEpoch: 100,
    });
  } catch (error) { missingGenerationError = error; }
  ok(futureGenerationError && futureGenerationError.code === "sync-generation-invalid" &&
      missingGenerationError && missingGenerationError.code === "sync-generation-invalid",
    "marked documents reject future or missing record generations before merge");

  let missingProfileGenerationError = null;
  try {
    Sync.validateDocGenerations({
      version: 4, generationSchemaVersion: 1, resetAt: 100,
      events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {}, phases: [], weights: {},
      profile: { sex: "male", updatedAt: 110 }, goals: generationGoals, goalsResetEpoch: 100,
    });
  } catch (error) { missingProfileGenerationError = error; }
  ok(missingProfileGenerationError && missingProfileGenerationError.code === "sync-generation-invalid" &&
      missingProfileGenerationError.path === "profile.resetEpoch",
    "a marked document with a profile singleton missing resetEpoch fails closed at profile.resetEpoch",
    JSON.stringify({
      message: missingProfileGenerationError && missingProfileGenerationError.message,
      path: missingProfileGenerationError && missingProfileGenerationError.path,
    }));

  // Legacy (unmarked) migration must also fail closed on internally
  // inconsistent explicit nonzero generation claims, rather than silently
  // reinterpreting them as trustworthy. See js/sync.js ~513-518 (profile,
  // via the shared legacyRecordGeneration guard) and ~649-651 (phase
  // revision tombstone epochs).
  let profileNonzeroMismatchError = null;
  try {
    Sync.migrateLegacyGenerationDoc({
      version: 4, resetAt: 100,
      events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {},
      phases: [], weights: {},
      profile: { sex: "male", updatedAt: 110, resetEpoch: 55 },
      goals: generationGoals, goalsUpdatedAt: 110,
    });
  } catch (error) { profileNonzeroMismatchError = error; }
  ok(profileNonzeroMismatchError && profileNonzeroMismatchError.code === "sync-generation-invalid",
    "an unmarked legacy doc with an explicit nonzero profile.resetEpoch that mismatches its own resetAt fails closed",
    JSON.stringify({ message: profileNonzeroMismatchError && profileNonzeroMismatchError.message }));

  let tombstoneNonzeroMismatchError = null;
  try {
    Sync.migrateLegacyGenerationDoc({
      version: 4, resetAt: 100,
      events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {},
      phases: [{
        id: "legacy-tomb-phase", kind: "maintain", startDay: "2026-08-01", endDay: null,
        createdAt: 100, updatedAt: 100,
        revisionTombstones: { someKey: 100 },
        revisionTombstoneEpochs: { someKey: 55 },
        revisions: [],
      }],
      weights: {},
      profile: { sex: "male", updatedAt: 110 },
      goals: generationGoals, goalsUpdatedAt: 110,
    });
  } catch (error) { tombstoneNonzeroMismatchError = error; }
  ok(tombstoneNonzeroMismatchError && tombstoneNonzeroMismatchError.code === "sync-generation-invalid",
    "an unmarked legacy doc with an explicit nonzero revisionTombstoneEpochs claim that mismatches its own resetAt fails closed",
    JSON.stringify({ message: tombstoneNonzeroMismatchError && tombstoneNonzeroMismatchError.message }));

  const lockGoals = { ...Phases.DEFAULT_GOALS, kcal: 2200 };
  const lockDoc = (extra) => ({
    version: 4, resetAt: 0, events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {},
    phases: [], weights: {}, profile: {}, goals: lockGoals, goalsUpdatedAt: 1, goalsResetEpoch: 0,
    ...(extra || {}),
  });
  const lockedRoot = {
    id: "locked-root", ts: 100, day: "2026-08-20", type: "add", resetEpoch: 0,
    causal: { entryId: "locked-entry", seq: 0, parentEventId: null },
    dayGoalLock: {
      targetKcal: 2500, baseKcal: 2200, plannedAt: 90, veryLowCalorieAcknowledged: true,
    },
    entry: { id: "locked-entry", name: "logged then removed" },
  };
  const lockedRemove = {
    id: "locked-remove", ts: 110, day: "2026-08-20", type: "remove", target: "locked-entry", resetEpoch: 0,
    causal: { entryId: "locked-entry", seq: 1, parentEventId: "locked-root" },
  };
  const staleChangedPlan = lockDoc({
    dayGoals: { "2026-08-20": { targetKcal: 3100, baseKcal: 2200, plannedAt: 900, updatedAt: 900 } },
  });
  const lockSource = lockDoc({ events: [lockedRoot, lockedRemove] });
  const lockedForward = Sync.mergeDocs(lockSource, staleChangedPlan).doc;
  const lockedReverse = Sync.mergeDocs(staleChangedPlan, lockSource).doc;
  const lockedDay = lockedForward.dayGoals["2026-08-20"];
  ok(lockedDay.targetKcal === 2500 && lockedDay.baseKcal === 2200 && lockedDay.locked &&
      lockedDay.lockedByEventId === "locked-root" && lockedDay.veryLowCalorieAcknowledged &&
      Ledger.replayEvents(lockedForward.events).length === 0,
    "the first immutable add snapshot survives stale plan changes and removal of the last visible entry");
  ok(Sync.fingerprint(lockedForward) === Sync.fingerprint(lockedReverse),
    "logged-day target healing converges under reversed shard order");
  const staleClear = lockDoc({ dayGoals: { "2026-08-20": { cleared: true, updatedAt: 1000 } } });
  const lockedRoundTrip = JSON.parse(JSON.stringify(lockedForward));
  const afterStaleClear = Sync.mergeDocs(lockedRoundTrip, staleClear).doc;
  ok(afterStaleClear.dayGoals["2026-08-20"].targetKcal === 2500 &&
      afterStaleClear.dayGoals["2026-08-20"].lockedByEventId === "locked-root",
    "a JSON export/import round-trip and later clear tombstone cannot alter a logged-day lock");

  // Part VIII.1: a declared fast that recorded food must carry intent and
  // fastAcknowledged through a merge exactly the way targetKcal/baseKcal do —
  // dropping them regresses to the shape VII.3 taught the rest of the system
  // to refuse (an undeclared zero), silently turning a fast into a total miss.
  const fastRoot = {
    id: "fast-locked-root", ts: 100, day: "2026-08-21", type: "add", resetEpoch: 0,
    causal: { entryId: "fast-locked-entry", seq: 0, parentEventId: null },
    dayGoalLock: {
      targetKcal: 0, baseKcal: 2200, plannedAt: 90, intent: "fast", fastAcknowledged: true,
    },
    entry: { id: "fast-locked-entry", name: "black coffee" },
  };
  const fastSource = lockDoc({ events: [fastRoot] });
  const staleForFastDay = lockDoc({
    dayGoals: { "2026-08-21": { targetKcal: 1800, baseKcal: 2200, updatedAt: 900 } },
  });
  const fastForward = Sync.mergeDocs(fastSource, staleForFastDay).doc;
  const fastReverse = Sync.mergeDocs(staleForFastDay, fastSource).doc;
  const fastMergedDay = fastForward.dayGoals["2026-08-21"];
  ok(fastMergedDay && fastMergedDay.targetKcal === 0 && fastMergedDay.baseKcal === 2200 &&
      fastMergedDay.intent === "fast" && fastMergedDay.fastAcknowledged === true && fastMergedDay.locked,
    "a declared fast's dayGoalLock survives mergeDocs with intent and fastAcknowledged intact");
  ok(Sync.fingerprint(fastForward) === Sync.fingerprint(fastReverse),
    "the healed fast record converges under reversed shard order");
  const fastResolved = Phases.goalsForDay("2026-08-21", { ...fastForward, dayGoals: fastForward.dayGoals });
  ok(fastResolved.kcal === 0 && fastResolved._unscored &&
      fastResolved._unscored.protein && fastResolved._unscored.carbs && fastResolved._unscored.fat &&
      fastResolved._unscored.fiber && fastResolved._unscored.sodium && fastResolved._unscored.potassium,
    "goalsForDay on the merged doc still returns kcal 0 with _unscored intact for a healed fast");

  // Part IX.1(b): an *undeclared* zero lock — targetKcal 0 with no intent or
  // fastAcknowledged, exactly the shape a pre-fix normalizeImportedEvent (or
  // any other buggy producer) could still write — must not be honoured as a
  // lock at all. The eventLock gate has to demand the same declaration
  // Ledger._normalizedDayGoalLock does, so healing falls through to the
  // candidate path and recovers the still-intact declaration sitting in
  // dayGoals, instead of letting the bare zero win and silently overwrite it
  // with a full-miss-against-phase-target record ("eventLock wins over
  // selected").
  const undeclaredZeroRoot = {
    id: "undeclared-zero-root", ts: 100, day: "2026-08-22", type: "add", resetEpoch: 0,
    causal: { entryId: "undeclared-zero-entry", seq: 0, parentEventId: null },
    dayGoalLock: { targetKcal: 0, baseKcal: 2200, plannedAt: 90 },
    entry: { id: "undeclared-zero-entry", name: "undeclared zero" },
  };
  const undeclaredZeroSource = lockDoc({
    events: [undeclaredZeroRoot],
    dayGoals: {
      "2026-08-22": { targetKcal: 0, baseKcal: 2200, updatedAt: 50, intent: "fast", fastAcknowledged: true },
    },
  });
  const undeclaredZeroHealed = Sync.mergeDocs(undeclaredZeroSource, undeclaredZeroSource).doc;
  const undeclaredZeroDay = undeclaredZeroHealed.dayGoals["2026-08-22"];
  ok(undeclaredZeroDay && undeclaredZeroDay.intent === "fast" && undeclaredZeroDay.fastAcknowledged === true &&
      undeclaredZeroDay.targetKcal === 0,
    "an undeclared zero dayGoalLock is refused as a lock, so healing recovers the declared fast from dayGoals instead of overriding it");
  const undeclaredZeroResolved = Phases.goalsForDay(
    "2026-08-22", { ...undeclaredZeroHealed, dayGoals: undeclaredZeroHealed.dayGoals }
  );
  ok(undeclaredZeroResolved.kcal === 0,
    "goalsForDay on the healed doc resolves the recovered fast to kcal 0, not a full-miss against the phase target");

  const mixedLegacyRoot = {
    id: "mixed-legacy-root", ts: 100, day: "2026-08-23", type: "add", resetEpoch: 0,
    causal: { entryId: "mixed-legacy-entry", seq: 0, parentEventId: null },
    entry: { id: "mixed-legacy-entry", name: "legacy first meal" },
  };
  const mixedLegacyRemove = {
    id: "mixed-legacy-remove", ts: 180, day: "2026-08-23", type: "remove",
    target: "mixed-legacy-entry", resetEpoch: 0,
    causal: { entryId: "mixed-legacy-entry", seq: 1, parentEventId: "mixed-legacy-root" },
  };
  const mixedModernRoot = {
    id: "mixed-modern-root", ts: 200, day: "2026-08-23", type: "add", resetEpoch: 0,
    causal: { entryId: "mixed-modern-entry", seq: 0, parentEventId: null },
    dayGoalLock: { targetKcal: 3000, baseKcal: 2800 },
    entry: { id: "mixed-modern-entry", name: "later offline meal" },
  };
  const mixedModernRemove = {
    id: "mixed-modern-remove", ts: 220, day: "2026-08-23", type: "remove",
    target: "mixed-modern-entry", resetEpoch: 0,
    causal: { entryId: "mixed-modern-entry", seq: 1, parentEventId: "mixed-modern-root" },
  };
  const historicalLockPhase = {
    id: "mixed-lock-phase", kind: "maintain", startDay: "2026-08-01", endDay: null,
    createdAt: 50, updatedAt: 150, resetEpoch: 0, revisionTombstones: {},
    revisions: [
      {
        id: "mixed-lock-early", effectiveFrom: "2026-08-01",
        goals: { ...lockGoals, kcal: 2300 }, createdAt: 50, updatedAt: 50, resetEpoch: 0,
      },
      {
        id: "mixed-lock-late", effectiveFrom: "2026-08-01",
        goals: { ...lockGoals, kcal: 2800 }, createdAt: 150, updatedAt: 150, resetEpoch: 0,
      },
    ],
  };
  const mixedLegacyShard = lockDoc({
    events: [mixedLegacyRoot, mixedLegacyRemove], phases: [historicalLockPhase],
  });
  const mixedModernShard = lockDoc({ events: [mixedModernRoot, mixedModernRemove] });
  const mixedForward = Sync.mergeDocs(mixedLegacyShard, mixedModernShard).doc;
  const mixedReverse = Sync.mergeDocs(mixedModernShard, mixedLegacyShard).doc;
  const mixedAgain = Sync.mergeDocs(mixedForward, mixedModernShard).doc;
  ok(mixedForward.dayGoals["2026-08-23"].lockedByEventId === "mixed-legacy-root" &&
      mixedForward.dayGoals["2026-08-23"].targetKcal === 2300 &&
      mixedForward.dayGoals["2026-08-23"].targetKcal !== 3000 &&
      Ledger.replayEvents(mixedForward.events).length === 0,
    "a later new-client snapshot cannot replace the removed canonical legacy first root or its historical target");
  ok(Sync.fingerprint(mixedForward) === Sync.fingerprint(mixedReverse) &&
      Sync.fingerprint(mixedForward) === Sync.fingerprint(mixedAgain),
    "mixed-version first-root healing converges in both shard orders and is idempotent");

  const tieLegacyRoot = {
    id: "a-tie-legacy-root", ts: 300, day: "2026-08-24", type: "add", resetEpoch: 0,
    causal: { entryId: "tie-legacy-entry", seq: 0, parentEventId: null },
    entry: { id: "tie-legacy-entry", name: "canonical tie meal" },
  };
  const tieLegacyRemove = {
    id: "tie-legacy-remove", ts: 330, day: "2026-08-24", type: "remove",
    target: "tie-legacy-entry", resetEpoch: 0,
    causal: { entryId: "tie-legacy-entry", seq: 1, parentEventId: "a-tie-legacy-root" },
  };
  const tieModernRoot = {
    id: "z-tie-modern-root", ts: 300, day: "2026-08-24", type: "add", resetEpoch: 0,
    causal: { entryId: "tie-modern-entry", seq: 0, parentEventId: null },
    dayGoalLock: { targetKcal: 3000, baseKcal: 2800 },
    entry: { id: "tie-modern-entry", name: "later canonical tie" },
  };
  const tieModernRemove = {
    id: "tie-modern-remove", ts: 340, day: "2026-08-24", type: "remove",
    target: "tie-modern-entry", resetEpoch: 0,
    causal: { entryId: "tie-modern-entry", seq: 1, parentEventId: "z-tie-modern-root" },
  };
  const tieLegacyShard = lockDoc({
    events: [tieLegacyRemove, tieLegacyRoot],
    dayGoals: {
      "2026-08-24": { targetKcal: 2500, baseKcal: 2200, plannedAt: 299, updatedAt: 299 },
    },
  });
  const tieModernShard = lockDoc({ events: [tieModernRemove, tieModernRoot] });
  const tieForward = Sync.mergeDocs(tieLegacyShard, tieModernShard).doc;
  const tieReverse = Sync.mergeDocs(tieModernShard, tieLegacyShard).doc;
  ok(tieForward.dayGoals["2026-08-24"].lockedByEventId === "a-tie-legacy-root" &&
      tieForward.dayGoals["2026-08-24"].targetKcal === 2500 &&
      tieForward.dayGoals["2026-08-24"].targetKcal !== 3000 &&
      Sync.fingerprint(tieForward) === Sync.fingerprint(tieReverse),
    "equal-clock roots use deterministic id ordering before snapshot inspection and retain the pre-log plan");

  const skewedFirst = {
    id: "skewed-first", ts: 50, day: "2026-08-21", type: "add", resetEpoch: 0,
    causal: { entryId: "skewed-entry", seq: 0, parentEventId: null },
    dayGoalLock: { targetKcal: 2600, baseKcal: 2200 },
    entry: { id: "skewed-entry", name: "skewed" },
  };
  const otherFirst = {
    id: "other-first", ts: 100, day: "2026-08-21", type: "add", resetEpoch: 0,
    causal: { entryId: "other-entry", seq: 0, parentEventId: null },
    dayGoalLock: { targetKcal: 2400, baseKcal: 2200 },
    entry: { id: "other-entry", name: "other" },
  };
  const skewAB = Sync.mergeDocs(lockDoc({ events: [otherFirst] }), lockDoc({ events: [skewedFirst] })).doc;
  const skewBA = Sync.mergeDocs(lockDoc({ events: [skewedFirst] }), lockDoc({ events: [otherFirst] })).doc;
  ok(skewAB.dayGoals["2026-08-21"].targetKcal === 2600 &&
      Sync.fingerprint(skewAB) === Sync.fingerprint(skewBA),
    "competing first-add snapshots resolve deterministically despite clock skew and shard order");

  const legacyRoot = {
    id: "legacy-lock-root", ts: 100, day: "2026-08-22", type: "add", resetEpoch: 0,
    causal: { entryId: "legacy-lock-entry", seq: 0, parentEventId: null },
    entry: { id: "legacy-lock-entry", name: "legacy logged day" },
  };
  const legacyPlan = lockDoc({
    events: [legacyRoot], dayGoals: { "2026-08-22": { kcal: 2500, plannedAt: 90, updatedAt: 90 } },
  });
  const legacyLateClear = lockDoc({ dayGoals: { "2026-08-22": { cleared: true, updatedAt: 200 } } });
  const legacyLocked = Sync.mergeDocs(legacyPlan, legacyLateClear).doc;
  ok(legacyLocked.dayGoals["2026-08-22"].targetKcal === 2500 &&
      legacyLocked.dayGoals["2026-08-22"].baseKcal === 2200 &&
      legacyLocked.dayGoals["2026-08-22"].locked,
    "a valid pre-log legacy absolute target freezes before a stale post-log clear is considered");
  const changedBase = Sync.mergeDocs(legacyLocked, lockDoc({
    goals: { ...lockGoals, kcal: 2800 }, goalsUpdatedAt: 500,
  })).doc;
  ok(changedBase.dayGoals["2026-08-22"].targetKcal === 2500 &&
      changedBase.dayGoals["2026-08-22"].baseKcal === 2200,
    "a healed legacy absolute target stays frozen when the later phase baseline changes");
  // Day-intent widening: a legacy absolute target is a planned day, not a
  // phase target, so its floor moves from 800 down to 200 — it can still
  // never be exactly 0, that shape predates the fast concept.
  ok(!Sync.normalizeDayGoal({ kcal: 1200, updatedAt: 1 }).cleared &&
      !Sync.normalizeDayGoal({ kcal: 6000, updatedAt: 1 }).cleared &&
      Sync.normalizeDayGoal({ kcal: 199, updatedAt: 1 }).cleared &&
      Sync.normalizeDayGoal({ kcal: 6001, updatedAt: 1 }).cleared &&
      Sync.normalizeDayGoal({ kcal: 0, updatedAt: 1 }).cleared,
    "legacy absolute overrides accept exactly 200–6000 kcal, reject values outside it, and can never be 0");
  // Part VIII.2: sync must not be strictly weaker than the import path — a
  // legacy record does not always originate from a compliant client, so a
  // below-1200 absolute target needs the same acknowledgement import already
  // requires, or it is a live very-low plan nobody ever confirmed.
  ok(Sync.normalizeDayGoal({ kcal: 200, updatedAt: 1 }).cleared,
    "a legacy absolute target below 1200 kcal without acknowledgement is tombstoned");
  ok(!Sync.normalizeDayGoal({
    kcal: 200, updatedAt: 1, veryLowCalorieAcknowledged: true,
  }).cleared,
    "a legacy absolute target below 1200 kcal WITH acknowledgement is accepted");

  // Mark incomplete — additive logging-coverage flag on dayGoals.
  const incompleteOnly = Sync.normalizeDayGoal({ incomplete: true, updatedAt: 50 });
  ok(incompleteOnly && incompleteOnly.incomplete === true && incompleteOnly.excludeReason === "incomplete"
      && !incompleteOnly.cleared && incompleteOnly.targetKcal == null,
    "incomplete-only dayGoal normalizes without a calorie plan");
  const incompletePlan = Sync.normalizeDayGoal({
    targetKcal: 1800, baseKcal: 2200, updatedAt: 60, incomplete: true,
  });
  ok(incompletePlan && incompletePlan.targetKcal === 1800 && incompletePlan.incomplete === true
      && incompletePlan.excludeReason === "incomplete" && !incompletePlan.cleared,
    "incomplete rides along on a reduced plan without clearing it");
  ok(Sync.normalizeDayGoal({ incomplete: true, cleared: true, updatedAt: 70 }).cleared === true
      && !Sync.normalizeDayGoal({ incomplete: true, cleared: true, updatedAt: 70 }).incomplete,
    "a cleared tombstone drops incomplete (clear-preserving must write incomplete-only, not cleared)");
  const failedFastKeepIncomplete = Sync.normalizeDayGoal({
    intent: "fast", targetKcal: 0, baseKcal: 2200, updatedAt: 80, incomplete: true,
  });
  ok(failedFastKeepIncomplete && failedFastKeepIncomplete.incomplete === true
      && failedFastKeepIncomplete.targetKcal == null && !failedFastKeepIncomplete.cleared,
    "a failed fast declaration with incomplete becomes incomplete-only instead of a cleared tombstone");

  const dgA = { "2026-08-01": { kcal: 2800, protein: 180, updatedAt: 100 } };
  const dgB = {
    "2026-08-01": { bumps: { kcal: 200, protein: 20, sodium: 500 }, updatedAt: 200 },
    "2026-08-02": { bumps: { protein: 180, potassium: 500 }, updatedAt: 50 },
    "2026-08-03": { kcal: 3000, sodium: 9000, updatedAt: 75 },
  };
  const dg = Sync.mergeDayGoals(dgA, dgB);
  ok(dg["2026-08-01"].bumps.kcal === 200 && Object.keys(dg["2026-08-01"].bumps).length === 1,
    "dayGoals: newer calorie bump wins and non-calorie fields are stripped");
  ok(dg["2026-08-02"].cleared === true && dg["2026-08-02"].protein == null,
    "dayGoals: non-calorie-only legacy bump becomes a clear tombstone");
  ok(dg["2026-08-03"].kcal === 3000 && dg["2026-08-03"].sodium == null,
    "dayGoals: legacy absolute kcal is preserved but safety targets are stripped");
  const activeDg = Sync.activeDayGoals(dg);
  ok(activeDg["2026-08-01"].bumps.kcal === 200 && !activeDg["2026-08-02"],
    "active dayGoals expose only non-cleared calorie overrides");
  const frozenPlan = Sync.normalizeDayGoal({
    targetKcal: 2500, baseKcal: 2200, plannedAt: 10, updatedAt: 11,
    protein: 999, sodium: 9999, privateNote: "drop me",
  });
  ok(frozenPlan.targetKcal === 2500 && frozenPlan.baseKcal === 2200 && frozenPlan.plannedAt === 10 &&
      Object.keys(frozenPlan).sort().join(",") === "baseKcal,plannedAt,targetKcal,updatedAt",
    "sync preserves only safe frozen calorie-plan fields");
  // 700 no longer rejects on range alone — {0} ∪ [200, 6000] is a real 5:2/ADF
  // plan now — so the boundary probe moves below the widened floor.
  ok(Sync.normalizeDayGoal({ targetKcal: 150, baseKcal: 2200, updatedAt: 12 }).cleared,
    "sync rejects an out-of-range frozen calorie target");
  // 700 sits below LOW_KCAL_ACK_KCAL (1200), so the §7 ladder now requires
  // veryLowCalorieAcknowledged — a record that never asked the question is
  // no more trustworthy than one outside the range (Part VII.4).
  ok(!Sync.normalizeDayGoal({
    targetKcal: 700, baseKcal: 2200, updatedAt: 12, veryLowCalorieAcknowledged: true,
  }).cleared,
    "sync accepts a reduced-day frozen target between 200 and 1200 kcal");
  ok(Sync.normalizeDayGoal({ targetKcal: 700, baseKcal: 2200, updatedAt: 12 }).cleared,
    "sync tombstones a very-low frozen target that was never acknowledged");

  const unsafeDoc = {
    version: 2, resetAt: 0, events: [], personalFoods: [],
    dayGoals: { "2026-08-04": { bumps: { kcal: 150, protein: 50, sodium: -1000 }, updatedAt: 80 } },
    phases: [], weights: {}, profile: {}, goals: { kcal: 2200 }, goalsUpdatedAt: 1,
  };
  const cleanup = Sync.mergeDocs(unsafeDoc, unsafeDoc);
  ok(cleanup.doc.version === 4 && cleanup.doc.dayGoals["2026-08-04"].bumps.kcal === 150 &&
    Object.keys(cleanup.doc.dayGoals["2026-08-04"].bumps).length === 1,
  "v2 sync document migrates to the calorie-only v4 schema");
  ok(cleanup.differsFromRemote === true,
    "unsafe remote dayGoal fields force a sanitized Drive write");

  const clearedLocal = { "2026-08-01": { cleared: true, updatedAt: 500 } };
  const stillOnDrive = { "2026-08-01": { kcal: 2800, updatedAt: 100 } };
  const dgCleared = Sync.mergeDayGoals(clearedLocal, stillOnDrive);
  ok(dgCleared["2026-08-01"].cleared === true, "dayGoals: clear tombstone beats older override");

  // phases + weights survive doc merge
  const localPh = {
    version: 2, events: [], personalFoods: [], dayGoals: {},
    phases: [{ id: "phA", updatedAt: 100, startDay: "2026-01-01", endDay: null, revisions: [{ id: "rA", effectiveFrom: "2026-01-01", goals: { kcal: 2000 } }] }],
    weights: { "2026-08-01": { kg: 80, updatedAt: 100 } },
    goals: { kcal: 2000 }, goalsUpdatedAt: 100,
  };
  const remotePh = {
    version: 2, events: [], personalFoods: [], dayGoals: {},
    phases: [{ id: "phA", updatedAt: 200, startDay: "2026-01-01", endDay: null, revisions: [
      { id: "rA", effectiveFrom: "2026-01-01", goals: { kcal: 2000 } },
      { id: "rB", effectiveFrom: "2026-06-01", goals: { kcal: 2400 } },
    ] }],
    weights: { "2026-08-01": { kg: 79.5, updatedAt: 200 } },
    goals: { kcal: 2400 }, goalsUpdatedAt: 200,
  };
  const mergedPh = Sync.mergeDocs(localPh, remotePh);
  ok(mergedPh.doc.phases[0].revisions.length === 2, "doc merge unions phase revisions");
  ok(mergedPh.doc.weights["2026-08-01"].kg === 79.5, "doc merge: newer weight wins");
  ok(mergedPh.doc.version === 4, "doc version is 4");
}

console.log("\n[9] Recipe sharing (untrusted input validation)");
{
  const Share = require("../js/share.js");
  const dal = {
    id: "pf-1", name: "mom's dal", per100: { kcal: 132, p: 7.1, c: 18, f: 3.4, fb: 6, na: 340 },
    units: { serving: 240 }, cat: "dish",
    recipe: { servings: 6, ingredients: ["red lentils (400 g)", "onion (110 g)", "ghee (39 g)"], totalGrams: 1440 },
  };

  const code = Share.pack(dal);
  ok(code.startsWith("NCR1."), "pack produces a NCR1. code");
  ok(Share.looksLikeCode(`hey! try my dal: https://x.io/app#recipe=${code} :)`), "code detected inside a chat message");

  const r = Share.unpack(`check this out https://x.io/app#recipe=${code}`);
  ok(r.ok, "unpack succeeds from a full shared link");
  ok(r.food.name === "mom's dal", "name round-trips");
  ok(r.food.per100.kcal === 132 && r.food.per100.p === 7.1, "macros round-trip exactly");
  ok(r.food.units.serving === 240, "serving size round-trips");
  ok(r.food.recipe.servings === 6 && r.food.recipe.ingredients.length === 3, "ingredient list round-trips");
  ok(r.food.recipe.ingredients[0].text === "red lentils (400 g)", "ingredients unpack as { text }");
  ok(r.food.source === "shared", "provenance is marked");

  const sd = Share.shareData(dal);
  ok(sd.url && !/#recipe=/.test(sd.url), "share url is clean app home (for icon preview)");
  ok(/NCR1\./.test(sd.text), "share text carries the code");
  const st = Share.shareText(dal);
  ok(st.includes(sd.url) && st.includes(code), "clipboard message has site url + code");

  const withObjIngs = Share.pack({
    name: "obj dal",
    per100: { kcal: 132, p: 7.1, c: 18, f: 3.2, fb: 4, na: 200 },
    units: { serving: 240 },
    recipe: { servings: 2, ingredients: [{ text: "lentils (100 g)" }, { text: "onion" }] },
  });
  const rObj = Share.unpack(withObjIngs);
  ok(rObj.ok && rObj.food.recipe.ingredients[0].text === "lentils (100 g)", "pack accepts { text } ingredients");

  const exact = {
    name: "shared dumplings",
    per100: { kcal: 212.3, p: 8.2, c: 31.4, f: 6.1, fb: 2.7, na: null, k: null },
    units: { serving: 187.25, piece: 42.75, bowl: 311.5 },
    logAs: "piece",
    countLabel: "dumpling",
    batch: { grams: 987.65, servings: 13.5, weighed: true },
    recipe: { ingredients: ["flour", "vegetables"] },
  };
  const exactResult = Share.unpack(Share.pack(exact));
  ok(exactResult.ok && exactResult.food.per100.na === null && exactResult.food.per100.k === null,
    "share v4 preserves unknown sodium and potassium");
  ok(exactResult.food.units.serving === 187.25 && exactResult.food.units.piece === 42.75 && exactResult.food.units.bowl === 311.5,
    "share v4 preserves exact serving-unit weights");
  ok(exactResult.food.logAs === "piece" && exactResult.food.countLabel === "dumpling",
    "share v4 preserves count logging semantics");
  ok(exactResult.food.batch.grams === 987.65 && exactResult.food.batch.servings === 13.5 && exactResult.food.batch.weighed === true,
    "share v4 preserves exact batch semantics");

  const encodePayload = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const legacyV3 = `NCR1.${encodePayload({
    v: 3, n: "legacy soup", m: [80, 3, 9, 2, 1, 340, null], g: 180,
    u: { s: 180 }, l: "grams", c: "ignored",
  })}`;
  const legacyResult = Share.unpack(legacyV3);
  ok(legacyResult.ok && legacyResult.food.units.serving === 180 && legacyResult.food.per100.k === null,
    "legacy v3 share codes remain readable");

  ok(!Share.unpack(`NCR1.${"a".repeat(16385)}`).ok, "oversized encoded share payload is rejected before decoding");
  const nullRequired = `NCR1.${encodePayload({ v: 4, n: "bad", m: [null, 1, 1, 1, 1, null, null], g: 100 })}`;
  ok(!Share.unpack(nullRequired).ok, "v4 rejects null required nutrition values");
  const hugeMineral = `NCR1.${encodePayload({ v: 4, n: "salt", m: [0, 0, 0, 0, 0, 100001, null], g: 100 })}`;
  ok(!Share.unpack(hugeMineral).ok, "v4 rejects implausible mineral values");
  const nonFiniteJson = `NCR1.${Buffer.from('{"v":4,"n":"bad","m":[1e309,0,0,0,0,null,null],"g":100}', "utf8").toString("base64url")}`;
  ok(!Share.unpack(nonFiniteJson).ok, "v4 rejects non-finite JSON number results");
  const invalidPackedMineral = Share.pack({
    name: "bad mineral", per100: { kcal: 1, p: 0, c: 0, f: 0, fb: 0, na: Infinity, k: null }, units: {},
  });
  ok(!Share.unpack(invalidPackedMineral).ok, "v4 does not turn a non-finite mineral into unknown");
  const invalidPackedBatch = Share.pack({
    name: "bad batch", per100: { kcal: 1, p: 0, c: 0, f: 0, fb: 0, na: null, k: null }, units: {},
    batch: { grams: Infinity, servings: 1, weighed: true },
  });
  ok(!Share.unpack(invalidPackedBatch).ok, "v4 rejects a non-finite shared batch instead of dropping it");

  ok(Share.unpack("NCR1.deadbeef").ok === false, "corrupted payload is rejected");
  ok(Share.unpack("hello there").ok === false, "non-code text is rejected");

  // tampered nutrition gets bounds-checked
  const evil1 = Share.pack({ name: "magic bar", per100: { kcal: 5000, p: 1, c: 1, f: 1, fb: 0, na: 0 }, units: { serving: 50 } });
  ok(Share.unpack(evil1).ok === false, "impossible kcal density (>9.2 kcal/g) rejected");
  const evil2 = Share.pack({ name: "quantum food", per100: { kcal: 400, p: 60, c: 60, f: 60, fb: 0, na: 0 }, units: { serving: 50 } });
  ok(Share.unpack(evil2).ok === false, "macros >100 g per 100 g rejected");
}

console.log("\n[10] PHASE AI target prompt parse");
{
  globalThis.Phases = require("../js/phases.js");
  const PhasePrompt = require("../js/phase-prompt.js");
  const currentPhaseGoals = { fiber: 29, sodium: 2200, potassium: 3400 };
  const prompt = PhasePrompt.buildTargetPrompt({
    kind: "recomp",
    age: 36,
    weightKg: 80,
    profile: { sex: "male", heightCm: 175, activity: "moderate", notes: "" },
  });
  ok(/Kind: recomp/.test(prompt) || /Recomp/.test(prompt), "prompt includes recomp goal");
  ok(!/not medical advice/i.test(prompt), "prompt omits medical disclaimer (token savings)");
  ok(/Do not infer pregnancy, kidney\/renal status, or medication use/.test(prompt) &&
      /clinician\/dietitian review/.test(prompt),
    "prompt explicitly warns about medical context without pretending the app detects it");
  ok(/PHASE v1/.test(prompt), "prompt asks for PHASE v1 format");

  const block = `PHASE v1
Kind: recomp
Option: 1 | Conservative
Kcal: 2100
Protein: 160
Carbs: 180
Fat: 65
Fiber: 30
Sodium: 2300
Reason: Near maintenance with high protein for recomp.
Sources: Mifflin-St Jeor; ISSN protein position stand
Option: 2 | Balanced
Kcal: 2200
Protein: 170
Carbs: 200
Fat: 70
Fiber: 30
Sodium: 2300
Reason: Slightly higher carbs for training.
Sources: ISSN; ACSM
Option: 3 | Aggressive
Kcal: 2000
Protein: 180
Carbs: 160
Fat: 60
Fiber: 32
Sodium: 2200
Reason: Mild deficit with elevated protein.
Sources: ISSN
END`;
  ok(!PhasePrompt.parsePhaseBlock(block).ok,
    "an omitted safety target fails when no current target is available");
  const parsed = PhasePrompt.parsePhaseBlock(block, currentPhaseGoals);
  ok(parsed.ok, "parses PHASE block");
  ok(parsed.kind === "recomp", "parsed kind is recomp");
  ok(parsed.options.length === 3, "three options parsed");
  ok(parsed.options[1].goals.kcal === 2200 && parsed.options[1].label === "Balanced", "option 2 macros and label");
  ok(parsed.options.every((o) => o.goals.potassium === currentPhaseGoals.potassium),
    "omitted potassium preserves the current target instead of becoming zero");
  ok(!PhasePrompt.parsePhaseBlock("hello").ok, "rejects non-PHASE text");

  const commaBlock = `PHASE v1
Kind: maintain
Option: 1 | Conservative
Kcal: 2,100
Protein: 160
Carbs: 180
Fat: 65
Fiber: 30
Sodium: 2,300
Reason: ok
Sources: ISSN
END`;
  const commaParsed = PhasePrompt.parsePhaseBlock(commaBlock, currentPhaseGoals);
  ok(commaParsed.ok && commaParsed.options[0].goals.kcal === 2100, "comma thousands in Kcal parse to 2100");
  ok(commaParsed.options[0].goals.sodium === 2300, "comma thousands in Sodium parse to 2300");

  const echo = PhasePrompt.buildTargetPrompt({
    kind: "cut",
    age: 36,
    weightKg: 80,
    profile: { sex: "male", heightCm: 175, activity: "moderate" },
  }) + "\n\n" + block;
  const echoParsed = PhasePrompt.parsePhaseBlock(echo, currentPhaseGoals);
  ok(echoParsed.ok && echoParsed.options.length === 3 && echoParsed.kind === "recomp", "prompt echo prefers last complete PHASE reply");

  const noKind = `PHASE v1
Option: 1 | Balanced
Kcal: 2200
Protein: 160
Carbs: 200
Fat: 70
Fiber: 30
Sodium: 2300
Reason: ok
Sources: ISSN
END`;
  const nk = PhasePrompt.parsePhaseBlock(noKind, currentPhaseGoals);
  ok(nk.ok && nk.kind == null, "missing Kind: leaves kind null");

  const dropOpt = `PHASE v1
Kind: cut
Option: 1 | Broken
Kcal: 2100
Protein: n/a
Carbs: 180
Fat: 65
Fiber: 30
Sodium: 2300
Reason: bad
Sources: x
Option: 2 | Good
Kcal: 2200
Protein: 170
Carbs: 200
Fat: 70
Fiber: 30
Sodium: 2300
Reason: ok
Sources: ISSN
END`;
  const dropped = PhasePrompt.parsePhaseBlock(dropOpt, currentPhaseGoals);
  ok(dropped.ok && dropped.options.length === 1 && dropped.options[0].label === "Good", "keeps complete options only");
  ok((dropped.warnings || []).some((w) => /Dropped Option 1/i.test(w) && /protein/i.test(w)), "warns about dropped incomplete option");

  const outOfRange = `PHASE v1
Kind: cut
Option: 1 | Wild
Kcal: 200
Protein: 900
Carbs: 50
Fat: 20
Fiber: 10
Sodium: 2300
Reason: no
Sources: x
END`;
  ok(!PhasePrompt.parsePhaseBlock(outOfRange).ok, "rejects out-of-range PHASE goals");

  const omittedSafety = `PHASE v1
Kind: maintain
Option: 1 | Preserve
Kcal: 2200
Protein: 160
Carbs: 220
Fat: 70
Reason: keep safety targets
Sources: ISSN
END`;
  const preserved = PhasePrompt.parsePhaseBlock(omittedSafety, currentPhaseGoals);
  ok(preserved.ok && preserved.options[0].goals.fiber === 29 &&
      preserved.options[0].goals.sodium === 2200 && preserved.options[0].goals.potassium === 3400,
    "omitted fiber, sodium, and potassium all preserve current values");
  ok((preserved.warnings || []).filter((w) => /kept current target/i.test(w)).length === 3,
    "preserved PHASE fields are disclosed in warnings");

  const explicitZero = `PHASE v1
Kind: maintain
Option: 1 | Disable optional scoring
Kcal: 2200
Protein: 160
Carbs: 220
Fat: 70
Fiber: 0
Sodium: 0
Potassium: 0
Reason: explicit
Sources: user choice
END`;
  const zeroParsed = PhasePrompt.parsePhaseBlock(explicitZero, currentPhaseGoals);
  ok(zeroParsed.ok && zeroParsed.options[0].goals.fiber === 0 &&
      zeroParsed.options[0].goals.sodium === 0 && zeroParsed.options[0].goals.potassium === 0,
    "explicit zero remains an intentional zero rather than being overwritten");
  const zeroScore = Phases.scoreDayTotals({
    count: 1,
    kcal: { mean: 2200 }, p: { mean: 160 }, c: { mean: 220 }, f: { mean: 70 }, fb: { mean: 0 },
    na: { mean: 0 }, naCoverage: 1, k: { mean: 0 }, kCoverage: 1,
  }, zeroParsed.options[0].goals);
  ok(zeroScore.fiber.status === "skip" && zeroScore.sodium.status === "skip" && zeroScore.potassium.status === "skip",
    "explicit zero is consistent with disabled nutrient scoring");

  const boundedBlock = (overrides) => {
    const fields = Object.assign({
      option: "Option: 1 | Safe",
      kcal: "2200", protein: "160", carbs: "220", fat: "70",
      fiber: "29", sodium: "2200", potassium: "3400",
      reason: "bounded reason", sources: "bounded source",
    }, overrides || {});
    return [
      "PHASE v1", "Kind: maintain", fields.option,
      "Kcal: " + fields.kcal, "Protein: " + fields.protein,
      "Carbs: " + fields.carbs, "Fat: " + fields.fat,
      "Fiber: " + fields.fiber, "Sodium: " + fields.sodium,
      "Potassium: " + fields.potassium, "Reason: " + fields.reason,
      "Sources: " + fields.sources, "END",
    ].join("\n");
  };
  const truncatedPhase = boundedBlock().replace(/\nEND$/, "");
  const truncatedResult = PhasePrompt.parsePhaseBlock(truncatedPhase, currentPhaseGoals);
  ok(!truncatedResult.ok && truncatedResult.complete === false && /standalone END/i.test(truncatedResult.error),
    "truncated PHASE block fails closed without a standalone END");
  const borrowedEnd = truncatedPhase + "\nGAP v1\nOption: 1 | unrelated\nEND";
  ok(!PhasePrompt.parsePhaseBlock(borrowedEnd, currentPhaseGoals).ok,
    "a later protocol block cannot lend END to a truncated PHASE block");

  ok(PhasePrompt.LIMITS.rawChars === 12000 && PhasePrompt.LIMITS.bodyChars === 12000 &&
      PhasePrompt.LIMITS.lines === 200 && PhasePrompt.LIMITS.lineChars === 2000 &&
      PhasePrompt.LIMITS.options === 10 && PhasePrompt.LIMITS.labelChars === 160 &&
      PhasePrompt.LIMITS.reasonChars === 1000 && PhasePrompt.LIMITS.sourceChars === 1000,
    "PHASE parser exports its storage-aligned structural limits");
  ok(PhasePrompt.BOUNDS.kcal[0] === 1200 && PhasePrompt.BOUNDS.kcal[1] === 6000 &&
      PhasePrompt.BOUNDS.protein[1] === 400 && PhasePrompt.BOUNDS.sodium[1] === 10000,
    "PHASE parser exports its canonical nutrient bounds");
  ok(PhasePrompt.ENERGY_POLICY.atwaterTolerance === 0.20 &&
      PhasePrompt.ENERGY_POLICY.maxProteinShare === 0.40 &&
      PhasePrompt.ENERGY_POLICY.minFatShare === 0.20 &&
      PhasePrompt.ENERGY_POLICY.maxFatShare === 0.45,
    "PHASE parser exports the persistent-target energy policy");
  ok(!PhasePrompt.parsePhaseBlock("X".repeat(PhasePrompt.LIMITS.rawChars + 1)).ok,
    "PHASE parser rejects an oversized raw paste");
  const tooManyLines = "PHASE v1\n" + Array(PhasePrompt.LIMITS.lines + 1).fill("Note").join("\n") + "\nEND";
  const tooManyLinesResult = PhasePrompt.parsePhaseBlock(tooManyLines, currentPhaseGoals);
  ok(!tooManyLinesResult.ok && /lines/i.test(tooManyLinesResult.error),
    "PHASE parser rejects too many physical lines");
  const longLine = boundedBlock({ reason: "r".repeat(PhasePrompt.LIMITS.lineChars + 1) });
  const longLineResult = PhasePrompt.parsePhaseBlock(longLine, currentPhaseGoals);
  ok(!longLineResult.ok && /line exceeds/i.test(longLineResult.error),
    "PHASE parser rejects an oversized physical line");

  const optionText = (i) => boundedBlock({ option: "Option: " + i + " | Safe " + i })
    .replace(/^PHASE v1\nKind: maintain\n/, "").replace(/\nEND$/, "");
  const tooManyOptions = "PHASE v1\nKind: maintain\n" +
    Array.from({ length: 11 }, (_, i) => optionText((i % 10) + 1)).join("\n") + "\nEND";
  const tooManyOptionsResult = PhasePrompt.parsePhaseBlock(tooManyOptions, currentPhaseGoals);
  ok(!tooManyOptionsResult.ok && /options/i.test(tooManyOptionsResult.error),
    "PHASE parser rejects more than ten options");
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({ option: "Option: 1 | " + "L".repeat(161) }), currentPhaseGoals).ok,
    "PHASE parser rejects an option label beyond the stored label limit");
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({ reason: "R".repeat(1001) }), currentPhaseGoals).ok,
    "PHASE parser rejects a reason beyond the stored note-like limit");
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({ sources: "S".repeat(1001) }), currentPhaseGoals).ok,
    "PHASE parser rejects sources beyond the stored note-like limit");
  const maxTextFields = PhasePrompt.parsePhaseBlock(boundedBlock({
    option: "Option: 1 | " + "L".repeat(160),
    reason: "R".repeat(1000),
    sources: "S".repeat(1000),
  }), currentPhaseGoals);
  ok(maxTextFields.ok && maxTextFields.options[0].label.length === 160 &&
      maxTextFields.options[0].reason.length === 1000 && maxTextFields.options[0].sources.length === 1000,
    "PHASE parser accepts label, reason, and sources exactly at their limits");

  for (const pair of [
    ["160 grams", "numeric suffix"], ["160-180", "numeric range"],
    ["1e309", "non-finite exponent"], ["NaN", "NaN"],
  ]) {
    ok(!PhasePrompt.parsePhaseBlock(boundedBlock({ protein: pair[0] }), currentPhaseGoals).ok,
      "PHASE parser rejects " + pair[1]);
  }
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({
    kcal: "1100", protein: "80", carbs: "130", fat: "30",
  }), currentPhaseGoals).ok, "PHASE parser rejects a persistent target below 1200 kcal");
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({ carbs: "20" }), currentPhaseGoals).ok,
    "PHASE parser rejects macros whose Atwater energy contradicts stated calories");
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({
    kcal: "2000", protein: "210", carbs: "155", fat: "60",
  }), currentPhaseGoals).ok, "PHASE parser rejects protein above 40% of stated calories");
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({
    kcal: "2000", protein: "150", carbs: "260", fat: "40",
  }), currentPhaseGoals).ok, "PHASE parser rejects fat below 20% of stated calories");
  ok(!PhasePrompt.parsePhaseBlock(boundedBlock({
    kcal: "2000", protein: "100", carbs: "143", fat: "115",
  }), currentPhaseGoals).ok, "PHASE parser rejects fat above 45% of stated calories");
  const boundaryGoals = {
    kcal: 1800, protein: 180, carbs: 180, fat: 40,
    fiber: 29, sodium: 2200, potassium: 3400,
  };
  const boundaryValidation = PhasePrompt.validateGoals(boundaryGoals);
  ok(boundaryValidation.ok && boundaryValidation.macroKcal === 1800 &&
      boundaryValidation.proteinShare === 0.4 && boundaryValidation.fatShare === 0.2,
    "shared PHASE validator accepts exact Atwater and protein/fat boundaries");
  ok(!PhasePrompt.validateGoals({ ...boundaryGoals, protein: null }).ok &&
      !PhasePrompt.validateGoals({ ...boundaryGoals, fat: "" }).ok,
    "shared PHASE validator rejects null or blank persistent nutrients instead of coercing them to zero");
}

console.log("\n[11] GAP AI close-the-gap prompt parse");
{
  globalThis.FoodMatch = require("../js/foodmatch.js");
  const GapPrompt = require("../js/gap-prompt.js");
  const PhasesGap = require("../js/phases.js");
  globalThis.Phases = PhasesGap;
  const NutriParse = require("../js/parse.js");
  const Sync = require("../js/sync.js");

  // H8: a declared fast must not ask for P150 inside 0 kcal of headroom.
  const fastGoals = PhasesGap.goalsForDay("2026-08-02", {
    goals: { kcal: 2200, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2300 },
    phases: [],
    dayGoals: {
      "2026-08-02": { targetKcal: 0, baseKcal: 2200, intent: "fast", fastAcknowledged: true, updatedAt: 1 },
    },
  });
  const fastRem = GapPrompt.remainingFrom(
    { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0 },
    fastGoals,
    { count: 0 }
  );
  ok(fastRem.protein === 0 && fastRem.kcal === 0 && fastRem.carbs === 0,
    "remainingFrom zeroes every unscored key on a declared empty fast",
    JSON.stringify(fastRem));
  const ateFastTotals = {
    count: 1, kcal: { mean: 1800 }, p: { mean: 100 }, c: { mean: 150 }, f: { mean: 50 }, fb: { mean: 20 }, na: { mean: 1500 },
  };
  const ateFastRem = GapPrompt.remainingFrom(
    GapPrompt.totalsMeans(ateFastTotals),
    fastGoals,
    ateFastTotals
  );
  ok(ateFastRem.protein === 50,
    "remainingFrom restores protein headroom after a declared fast records food",
    `got ${ateFastRem.protein}`);

  const candidates = [
    {
      id: "pf-rice",
      name: "rice (cooked)",
      per100: { kcal: 130, p: 2.7, c: 28, f: 0.3, fb: 0.4, na: 1, k: 35 },
      portion: { n: 8, median: 120, p25: 100, p75: 140, last: 110 },
      pieceGrams: null,
      provenance: "ref",
    },
    {
      id: "pf-chicken",
      name: "chicken breast (cooked)",
      per100: { kcal: 165, p: 31, c: 0, f: 3.6, fb: 0, na: 74, k: 256 },
      portion: { n: 5, median: 150, p25: 120, p75: 180, last: 160 },
      pieceGrams: null,
      provenance: "yours",
    },
  ];

  const prompt = GapPrompt.buildGapPrompt({
    day: "2026-08-02",
    logged: [{ name: "banana", displayQty: "1 piece", grams: 118, meal: "breakfast", macros: { kcal: 105, p: 1.3, c: 27, f: 0.4, fb: 3.1, na: 1 } }],
    means: { kcal: 105, protein: 1.3, carbs: 27, fat: 0.4, fiber: 3.1, sodium: 1 },
    goals: { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300 },
    candidates,
  });
  ok(/GAP v1/.test(prompt), "prompt asks for GAP v1 format");
  ok(!/not medical advice/i.test(prompt), "prompt omits medical disclaimer (token savings)");
  ok(!/NUTRI v1/i.test(prompt), "gap prompt does not ask for NUTRI blocks");
  ok(!/brand-new|new dishes/i.test(prompt), "gap prompt does not invite new dishes");
  ok(/Do not emit any other block type/i.test(prompt), "gap prompt forbids other block types");
  ok(/ONLY assign quantities to these exact names/i.test(prompt), "gap prompt restricts items to candidates");
  ok(/Reference · USDA-style avg/.test(prompt), "ref candidate labeled USDA avg");
  ok(!/may refine/i.test(prompt), "ref label does not invite NUTRI refine");
  ok(/rice \(cooked\)/.test(prompt) && /preferred 100–140 g/.test(prompt), "prompt includes candidate portion band");
  ok(/banana/.test(prompt) && /Totals so far/.test(prompt), "prompt includes logged foods and totals");
  ok(/Gap \/ status|Remaining/.test(prompt), "prompt includes gap/status macros");
  ok(/positive = still to add/i.test(prompt), "prompt explains remaining sign");
  ok(/report only/i.test(prompt), "fiber is report-only, not a hit target");
  ok(/lower is better/i.test(prompt), "sodium lower is better");
  ok(/warn.*ceiling|over ceiling/i.test(prompt), "sodium overshoot must be warned");
  ok(/WHOLE day|already logged.*PLUS/i.test(prompt), "Projected is end-of-day totals");
  ok(/protein meets the floor AND projected sodium/i.test(prompt), "Reachable tied to protein + sodium only");
  ok(/Option: 1/.test(prompt) && /3 plan OPTIONS/i.test(prompt), "prompt asks for multiple options");
  ok(/All selected/i.test(prompt) && /EVERY candidate/i.test(prompt), "option 1 must include every selected food");
  ok(/Protect protein/i.test(prompt) && /Lowest sodium/i.test(prompt), "option labels prioritize protein / lowest sodium");
  ok(/Options 2–3 MAY omit|may omit foods/i.test(prompt), "options 2–3 may omit foods");

  const incompleteNaPrompt = GapPrompt.buildGapPrompt({
    day: "2026-08-02",
    totals: {
      count: 2,
      kcal: { mean: 1000 }, p: { mean: 80 }, c: { mean: 100 }, f: { mean: 30 }, fb: { mean: 10 },
      na: { mean: 500 }, naCoverage: 0.5,
      k: { mean: 1800 }, kCoverage: 1,
    },
    goals: { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300, potassium: 3510 },
    candidates,
  });
  ok(/sodium 500 mg known subtotal; coverage is 50%/i.test(incompleteNaPrompt),
    "incomplete sodium is labeled as a known subtotal");
  ok(!/sodium headroom \+/i.test(incompleteNaPrompt) && /Do NOT calculate sodium headroom or overshoot/i.test(incompleteNaPrompt),
    "GAP does not calculate sodium headroom from insufficient coverage");
  ok(/Reachable: yes means projected protein meets the floor\./i.test(incompleteNaPrompt) &&
      /use sodium to decide Reachable/i.test(incompleteNaPrompt),
    "GAP excludes incomplete sodium from reachability");

  const block = `GAP v1
Day: 2026-08-02
Reachable: no
Note: Protein still short within preferred ranges; add Greek yogurt next or raise chicken.
Item: rice (cooked) | 130 g | dinner
Item: chicken breast (cooked) | 180 g | dinner
Item: mystery smoothie | 300 g | snack
Projected: 900 kcal | P 60 | C 120 | F 20 | Fiber 8 | Sodium 400
END`;

  const scorer = (q, name) => FoodMatch.scoreMatch(q, name);
  const parsed = GapPrompt.parseGapBlock(block, candidates, scorer);
  ok(parsed.ok, "parses GAP block");
  ok(parsed.options && parsed.options.length === 1, "legacy single plan becomes one option");
  ok(parsed.aiReachable === false, "reported Reachable: no is retained separately");
  ok(/Protein still short/.test(parsed.note || ""), "note preserved");
  ok(parsed.items.length === 2, "only candidate foods kept");
  ok(parsed.items[0].name === "rice (cooked)" && parsed.items[0].grams === 130, "rice qty parsed");
  ok(parsed.items[1].meal === "dinner" && parsed.items[1].foodId === "pf-chicken", "chicken matched to candidate id");
  ok((parsed.warnings || []).some((w) => /mystery smoothie/i.test(w)), "unknown food dropped with warning");
  ok(parsed.aiProjected && parsed.aiProjected.kcal === 900 && parsed.aiProjected.protein === 60,
    "reported Projected macros are retained as untrusted data");
  ok(parsed.projected === null && parsed.autoApply === false,
    "without trusted logged totals, AI projection cannot become an actionable local projection");
  ok(!GapPrompt.parseGapBlock("hello").ok, "rejects non-GAP text");

  const multi = `GAP v1
Day: 2026-08-02
Option: 1 | Balanced
Reachable: no
Note: Sodium caps protein.
Item: rice (cooked) | 120 g | dinner
Item: chicken breast (cooked) | 150 g | dinner
Projected: 800 kcal | P 55 | C 100 | F 18 | Fiber 5 | Sodium 500
Option: 2 | Protect floors
Reachable: no
Note: Hits protein; sodium over.
Item: chicken breast (cooked) | 220 g | dinner
Projected: 360 kcal | P 68 | C 0 | F 8 | Fiber 0 | Sodium 160
Option: 3 | Respect ceilings
Reachable: yes
Note: Under sodium; protein short.
Item: rice (cooked) | 100 g | dinner
Projected: 130 kcal | P 3 | C 28 | F 0 | Fiber 0 | Sodium 1
END`;
  const multiParsed = GapPrompt.parseGapBlock(multi, candidates, scorer);
  ok(multiParsed.ok && multiParsed.options.length === 3, "parses three options");
  ok(multiParsed.options[0].label === "Balanced" && multiParsed.options[0].aiReachable === false,
    "option 1 label + reported reachable");
  ok(multiParsed.options[1].items[0].foodId === "pf-chicken" && multiParsed.options[1].items[0].grams === 220, "option 2 items");
  ok(multiParsed.options[2].aiReachable === true && multiParsed.options[2].reachable === false &&
      multiParsed.options[2].items.length === 1,
    "reported Reachable cannot bypass missing local context");

  const reachAnno = `GAP v1
Day: 2026-08-02
Reachable: no — protein still short
Note: try again
Item: rice (cooked) | 120 g | dinner
END`;
  ok(GapPrompt.parseGapBlock(reachAnno, candidates, scorer).aiReachable === false, "Reachable: no with annotation");

  const twoBlocks = `GAP v1
Day: 2026-08-02
Reachable: no
Note: draft
Item: rice (cooked) | 300 g | dinner
END

GAP v1
Day: 2026-08-02
Reachable: yes
Note: final
Item: rice (cooked) | 120 g | dinner
Item: chicken breast (cooked) | 150 g | dinner
END`;
  const last = GapPrompt.parseGapBlock(twoBlocks, candidates, scorer);
  ok(last.ok && last.items.length === 2 && last.items[0].grams === 120, "uses last GAP block, not draft");
  ok(last.aiReachable === true && /final/.test(last.note || ""), "last block reported reachable/note win");

  const fuzzy = `GAP v1
Day: 2026-08-02
Reachable: yes
Note: ok
Item: brown rice | 110 g | dinner
END`;
  const fuzzyParsed = GapPrompt.parseGapBlock(fuzzy, candidates, scorer);
  ok(fuzzyParsed.ok && fuzzyParsed.items[0].name === "rice (cooked)", "fuzzy match maps to candidate");
  ok((fuzzyParsed.warnings || []).some((w) => /Matched "brown rice"/i.test(w)), "fuzzy match emits warning");

  const emptyCand = GapPrompt.parseGapBlock(block, [], scorer);
  ok(!emptyCand.ok, "empty candidates reject invented foods");

  const dual = `Here you go:

NUTRI v1
Name: Cottage Bowl
Batch: 400 g total, 2 servings
Totals: 320 kcal | P 28 | C 24 | F 10 | Fiber 4 | Sodium 480
Per 100 g: 80 kcal | P 7 | C 6 | F 2.5 | Fiber 1 | Sodium 120
Log as: grams
Ingredients:
- cottage cheese - 200
Prep: mix
Notes: test
Confidence: medium
END

GAP v1
Day: 2026-08-02
Reachable: yes
Note: Close enough.
Item: rice (cooked) | 100 g | lunch
END`;
  const nutri = NutriParse.parse(dual);
  ok(nutri.found && nutri.results.length >= 1, "dual paste: NUTRI still parseable alongside GAP");
  const gap2 = GapPrompt.parseGapBlock(dual, candidates, scorer);
  ok(gap2.ok && gap2.items[0].grams === 100, "dual paste: GAP block still parses");

  const dp = Sync.mergeDayPlans(
    { "2026-08-01": { updatedAt: 100, items: [{ id: "a", status: "pending" }] } },
    { "2026-08-01": { updatedAt: 200, items: [{ id: "b", status: "logged" }] }, "2026-08-02": { updatedAt: 50, items: [] } }
  );
  ok(dp["2026-08-01"].items[0].id === "b", "dayPlans: newer plan wins");
  ok(dp["2026-08-02"], "dayPlans: unique days union");

  const localDoc = {
    version: 2, resetAt: 0, events: [], personalFoods: [], dayGoals: {},
    dayPlans: { "2026-08-02": { updatedAt: 9, items: [{ id: "x", status: "pending" }] } },
    phases: [], weights: {}, profile: {}, goals: { kcal: 2200 }, goalsUpdatedAt: 1,
  };
  const remoteOld = {
    version: 2, resetAt: 0, events: [], personalFoods: [], dayGoals: {},
    phases: [], weights: {}, profile: {}, goals: { kcal: 2200 }, goalsUpdatedAt: 1,
  };
  const mergedOmit = Sync.mergeDocs(localDoc, remoteOld);
  ok(mergedOmit.doc.dayPlans && mergedOmit.doc.dayPlans["2026-08-02"], "mergeDocs keeps local dayPlans when remote omits them");

  const loggedTotals = {
    count: 1,
    kcal: { mean: 1000, sd: 50 },
    p: { mean: 60, sd: 5 },
    c: { mean: 100, sd: 5 },
    f: { mean: 30, sd: 2 },
    fb: { mean: 8, sd: 1 },
    na: { mean: 900, sd: 50 },
  };
  const loggedMeans = GapPrompt.totalsMeans(loggedTotals);
  const pendingMacros = GapPrompt.macroMeans(FoodMatch.computeMacros(candidates[1].per100, 180));
  const proj = GapPrompt.projectTotals(loggedMeans, [pendingMacros]);
  ok(proj.kcal === 1297, "projectTotals: logged 1000 + 180 g chicken (297) = 1297", `got ${proj.kcal}`);
  approx(proj.protein, 115.8, 0.11, "projectTotals adds pending protein");
  ok(GapPrompt.projectTotals(loggedMeans, []).sodium === 900, "projectTotals with no pending items = logged totals");
  ok(GapPrompt.macroMeans({}).kcal === 0, "macroMeans defaults missing keys to 0");

  const commaGap = `GAP v1
Day: 2026-08-02
Reachable: yes
Note: ok
Item: rice (cooked) | 1,000 g | dinner
Projected: 2,100 kcal | P 60 | C 120 | F 20 | Fiber 8 | Sodium 400
END`;
  const cg = GapPrompt.parseGapBlock(commaGap, candidates, scorer);
  ok(cg.ok && cg.items[0].grams === 1000, "comma thousands in Item qty → 1000 g");
  ok(cg.aiProjected && cg.aiProjected.kcal === 2100, "comma thousands in reported Projected kcal → 2100");

  const reachMaybe = `GAP v1
Day: 2026-08-02
Reachable: maybe
Note: unsure
Item: rice (cooked) | 120 g | dinner
END`;
  const maybeParsed = GapPrompt.parseGapBlock(reachMaybe, candidates, scorer);
  ok(!maybeParsed.ok && (maybeParsed.flags || []).includes("unrecognized-reachable"),
    "Reachable: maybe fails the explicit yes/no protocol");

  const reachBold = `GAP v1
Day: 2026-08-02
Reachable: **yes**
Note: ok
Item: rice (cooked) | 120 g | dinner
END`;
  ok(GapPrompt.parseGapBlock(reachBold, candidates, scorer).aiReachable === true,
    "Reachable: **yes** strips markdown while remaining a reported field");

  const dashOpt = `GAP v1
Day: 2026-08-02
Option: 1 - All selected
Reachable: yes
Note: ok
Item: rice (cooked) | 120 g | dinner
Item: chicken breast (cooked) | 150 g | dinner
END`;
  const dashParsed = GapPrompt.parseGapBlock(dashOpt, candidates, scorer);
  ok(dashParsed.ok && dashParsed.options[0].label === "All selected", "Option: 1 - Label parses");

  const preamble = `GAP v1
Day: 2026-08-02
Note: Here are three options.
Option: 1 | All selected
Reachable: yes
Note: real
Item: rice (cooked) | 120 g | dinner
Item: chicken breast (cooked) | 150 g | dinner
Projected: 800 kcal | P 50 | C 90 | F 15 | Fiber 4 | Sodium 200
END`;
  const pre = GapPrompt.parseGapBlock(preamble, candidates, scorer);
  ok(pre.ok && pre.options.length === 1 && pre.options[0].label === "All selected", "preamble Note does not create phantom option");
  ok(!(pre.warnings || []).some((w) => /\(Plan\)/.test(w)), "no phantom Plan option warning");

  const skipOpt1 = `GAP v1
Day: 2026-08-02
Option: 1 | All selected
Reachable: yes
Note: incomplete
Item: rice (cooked) | 120 g | dinner
Projected: 130 kcal | P 3 | C 28 | F 0 | Fiber 0 | Sodium 1
END`;
  const sk = GapPrompt.parseGapBlock(skipOpt1, candidates, scorer);
  ok((sk.warnings || []).some((w) => /Option 1 skipped:.*chicken/i.test(w)), "Option 1 missing candidate warns");

  const eggCand = [{
    id: "pf-egg",
    name: "boiled egg",
    per100: { kcal: 155, p: 13, c: 1.1, f: 11, fb: 0, na: 124 },
    portion: { n: 3, median: 50, p25: 50, p75: 50, last: 50 },
    pieceGrams: 50,
    logAs: "piece",
  }];
  const barePiece = `GAP v1
Day: 2026-08-02
Reachable: yes
Note: ok
Item: boiled egg | 2 | breakfast
END`;
  const bp = GapPrompt.parseGapBlock(barePiece, eggCand, scorer);
  ok(bp.ok && bp.items[0].unit === "piece" && bp.items[0].grams === 100, "bare qty on piece food → 2 piece");
  ok((bp.warnings || []).some((w) => /Assumed 2 piece/i.test(w)), "warns when assuming piece unit");

  const trustedTotals = {
    count: 1,
    kcal: { mean: 1000 }, p: { mean: 90 }, c: { mean: 100 }, f: { mean: 35 }, fb: { mean: 10 },
    na: { mean: 500 }, k: { mean: 1500 }, naCoverage: 1, kCoverage: 1,
  };
  const trustedCtx = {
    totals: trustedTotals,
    goals: { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300, potassium: 3510 },
  };
  const dishonestSafe = `GAP v1
Day: 2026-08-02
Option: 1 | All selected
Reachable: no
Respects: nothing; unsafe
Note: Deliberately dishonest report fields.
Item: rice (cooked) | 100 g | dinner
Item: chicken breast (cooked) | 160 g | dinner
Projected: 9999 kcal | P 1 | C 999 | F 999 | Fiber 0 | Sodium 9999 | Potassium 0
END`;
  const locallySafe = GapPrompt.parseGapBlock(dishonestSafe, candidates, scorer, trustedCtx);
  const safeOpt = locallySafe.options && locallySafe.options[0];
  ok(locallySafe.ok && locallySafe.autoApply && safeOpt.complete && safeOpt.safe,
    "complete option can auto-apply only after trusted local verification");
  ok(safeOpt.reachable === true && safeOpt.aiReachable === false,
    "local reachability ignores the AI Reachable claim");
  ok(safeOpt.projected.kcal === 1394 && Math.abs(safeOpt.projected.protein - 142.3) < 0.01 &&
      safeOpt.projected.sodium === 619,
    "end-of-day projection is recalculated from logged totals plus selected foods");
  ok(safeOpt.aiProjected.kcal === 9999 && safeOpt.projected.kcal !== safeOpt.aiProjected.kcal,
    "dishonest AI Projected values remain quarantined in aiProjected");
  ok(safeOpt.items.every((item) => GapPrompt.GOAL_KEYS.every((key) => item.nutrients[key] != null)),
    "every applied item has all seven nutrients calculated locally");

  const highNa = GapPrompt.parseGapBlock(dishonestSafe, candidates, scorer, {
    totals: trustedTotals,
    goals: { protein: 140, sodium: 600 },
  });
  ok(highNa.ok && !highNa.options[0].safe && !highNa.options[0].autoApply &&
      highNa.options[0].flags.includes("high-sodium"),
    "locally high sodium forces manual confirmation despite AI claims");

  const lowProtein = GapPrompt.parseGapBlock(dishonestSafe, candidates, scorer, {
    totals: trustedTotals,
    goals: { protein: 180, sodium: 2300 },
  });
  ok(!lowProtein.options[0].reachable && lowProtein.options[0].flags.includes("low-protein") &&
      lowProtein.options[0].requiresManualConfirm,
    "local protein shortfall is unreachable and never auto-applies");

  const lowMinerals = GapPrompt.parseGapBlock(dishonestSafe, candidates, scorer, {
    totals: { ...trustedTotals, kCoverage: 0.2 },
    goals: { protein: 140, sodium: 2300 },
  });
  ok(lowMinerals.options[0].flags.includes("low-mineral-coverage") &&
      !lowMinerals.options[0].complete && !lowMinerals.options[0].autoApply,
    "low local mineral coverage is explicitly manual-confirm only");

  const unresolvedText = dishonestSafe.replace(
    "Item: chicken breast (cooked) | 160 g | dinner",
    "Item: chicken breast (cooked) | 160 g | dinner\nItem: invented powder | 1 g | snack"
  );
  const unresolved = GapPrompt.parseGapBlock(unresolvedText, candidates, scorer, trustedCtx);
  ok(unresolved.ok && unresolved.options[0].flags.includes("unresolved-food") &&
      !unresolved.options[0].autoApply,
    "an unresolved food cannot disappear into an otherwise auto-applicable option");

  const unsupportedUnit = `GAP v1
Day: 2026-08-02
Reachable: yes
Note: unsupported
Item: rice (cooked) | 1 serving | dinner
Projected: 130 kcal | P 3 | C 28 | F 0 | Fiber 0 | Sodium 1 | Potassium 35
END`;
  const unsupported = GapPrompt.parseGapBlock(unsupportedUnit, candidates, scorer, trustedCtx);
  ok(!unsupported.ok && (unsupported.flags || []).includes("unsupported-unit"),
    "serving is rejected when the selected food has no serving conversion");

  const partiallyRejected = GapPrompt.parseGapBlock(
    dishonestSafe.replace("\nEND", `
Option: 2 | Unsupported
Reachable: yes
Note: cannot resolve
Item: rice (cooked) | 1 serving | dinner
Projected: 130 kcal | P 3 | C 28 | F 0 | Fiber 0 | Sodium 1 | Potassium 35
END`),
    candidates,
    scorer,
    trustedCtx
  );
  ok(partiallyRejected.ok && partiallyRejected.options.length === 1 &&
      partiallyRejected.rejectedOptions.length === 1 && !partiallyRejected.autoApply &&
      partiallyRejected.flags.includes("unsupported-unit"),
    "a rejected sibling option keeps the whole reply out of the automatic path");

  const riceByCup = [{ ...candidates[0], units: { cup: 195 } }];
  const supportedUnit = `GAP v1
Day: 2026-08-02
Reachable: yes
Note: candidate-defined unit
Item: rice (cooked) | 1 cup | dinner
Projected: 254 kcal | P 5 | C 55 | F 1 | Fiber 1 | Sodium 2 | Potassium 68
END`;
  const cupParsed = GapPrompt.parseGapBlock(supportedUnit, riceByCup, scorer, {
    totals: {
      count: 0, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 },
      na: { mean: 0 }, k: { mean: 0 }, naCoverage: 1, kCoverage: 1,
    },
    goals: { sodium: 2300 },
  });
  ok(cupParsed.ok && cupParsed.items[0].grams === 195 && cupParsed.options[0].autoApply,
    "candidate-defined units resolve to local grams and nutrients");

  const truncated = GapPrompt.parseGapBlock(dishonestSafe.replace(/\nEND$/, ""), candidates, scorer, trustedCtx);
  ok(!truncated.ok && truncated.flags.includes("truncated") && !truncated.autoApply,
    "truncated GAP block requires END and fails closed");
  const borrowedEnd = GapPrompt.parseGapBlock(`GAP v1
Day: 2026-08-02
Reachable: yes
Item: rice (cooked) | 100 g | dinner
NUTRI v1
Name: unrelated
END`, candidates, scorer, trustedCtx);
  ok(!borrowedEnd.ok && borrowedEnd.flags.includes("truncated"),
    "a later protocol block cannot lend its END to a truncated GAP block");

  const missingReachable = GapPrompt.parseGapBlock(
    dishonestSafe.replace("Reachable: no\n", ""), candidates, scorer, trustedCtx
  );
  ok(!missingReachable.ok && missingReachable.flags.includes("missing-reachable"),
    "missing explicit Reachable rejects the GAP protocol");

  const missingProjected = GapPrompt.parseGapBlock(
    dishonestSafe.replace(/^Projected:.*\n?/m, ""), candidates, scorer, trustedCtx
  );
  ok(missingProjected.ok && missingProjected.options[0].flags.includes("missing-projected") &&
      !missingProjected.options[0].autoApply,
    "incomplete option fields remain visible but cannot auto-apply");

  const zeroCandidate = [{
    id: "gap-zero",
    name: "z".repeat(GapPrompt.LIMITS.nameChars),
    per100: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0, k: 0 },
    units: {}, logAs: "grams",
  }];
  const boundedGap = ({ label, note, qty, name, options } = {}) => {
    const rows = ["GAP v1", "Day: 2026-08-02"];
    const count = options || 1;
    for (let i = 1; i <= count; i++) {
      rows.push(`Option: ${i} | ${label == null ? "Safe" : label}`);
      rows.push("Reachable: yes");
      rows.push(`Note: ${note == null ? "bounded" : note}`);
      rows.push(`Item: ${name == null ? zeroCandidate[0].name : name} | ${qty == null ? 100 : qty} g | snack`);
      rows.push("Projected: 0 kcal | P 0 | C 0 | F 0 | Fiber 0 | Sodium 0 | Potassium 0");
    }
    rows.push("END");
    return rows.join("\n");
  };
  const gapBoundary = GapPrompt.parseGapBlock(boundedGap({
    label: "L".repeat(GapPrompt.LIMITS.labelChars),
    note: "N".repeat(GapPrompt.LIMITS.noteChars),
    qty: GapPrompt.LIMITS.quantity,
  }), zeroCandidate, scorer, {
    means: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0 },
    goals: {},
  });
  ok(gapBoundary.ok && gapBoundary.items[0].qty === 1e9 && gapBoundary.items[0].grams === 1e9 &&
      gapBoundary.options[0].label.length === 160 && gapBoundary.options[0].note.length === 2000,
    "GAP accepts exact persisted label, note, name, quantity, and gram boundaries");
  ok(!GapPrompt.parseGapBlock(boundedGap({ label: "L".repeat(161) }), zeroCandidate, scorer).ok &&
      !GapPrompt.parseGapBlock(boundedGap({ note: "N".repeat(2001) }), zeroCandidate, scorer).ok &&
      !GapPrompt.parseGapBlock(boundedGap({ qty: 1000000001 }), zeroCandidate, scorer).ok,
    "GAP rejects fields one unit beyond persisted label, note, and amount bounds");
  ok(!GapPrompt.parseGapBlock(boundedGap({ name: "z".repeat(161) }), zeroCandidate, scorer).ok &&
      !GapPrompt.parseGapBlock(boundedGap({ qty: "1e6" }), zeroCandidate, scorer).ok,
    "GAP rejects overlong names and non-protocol quantity syntax instead of coercing them");
  const aggregateGapText = `GAP v1
Day: 2026-08-02
Option: 1 | Aggregate boundary
Reachable: yes
Note: locally summed
Item: aggregate one | 100 g | snack
Item: aggregate two | 100 g | snack
Projected: 0 kcal | P 0 | C 0 | F 0 | Fiber 0 | Sodium 0 | Potassium 0
END`;
  const aggregateCandidate = (id, name, sodium) => ({
    id, name, per100: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: sodium, k: 0 },
    units: {}, logAs: "grams",
  });
  const exactAggregateGap = GapPrompt.parseGapBlock(aggregateGapText, [
    aggregateCandidate("aggregate-one", "aggregate one", 500000000),
    aggregateCandidate("aggregate-two", "aggregate two", 500000000),
  ], scorer, {
    means: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0 },
    goals: {},
  });
  const overAggregateGap = GapPrompt.parseGapBlock(aggregateGapText, [
    aggregateCandidate("aggregate-one", "aggregate one", 500000000),
    aggregateCandidate("aggregate-two", "aggregate two", 500000001),
  ], scorer, {
    means: { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0 },
    goals: {},
  });
  ok(exactAggregateGap.ok && exactAggregateGap.options[0].localProjected.sodium === 1e9 &&
      !exactAggregateGap.options[0].flags.includes("aggregate-out-of-range"),
    "GAP local projection accepts the exact persisted aggregate nutrient boundary");
  ok(overAggregateGap.ok &&
      overAggregateGap.options[0].flags.includes("aggregate-out-of-range") &&
      overAggregateGap.options[0].localProjected == null &&
      !overAggregateGap.options[0].autoApply,
    "GAP rejects a locally summed nutrient one unit above the persisted boundary and omits the derived projection");
  ok(GapPrompt.parseGapBlock(boundedGap({ options: 10 }), zeroCandidate, scorer).ok &&
      !GapPrompt.parseGapBlock(boundedGap({ options: 11 }), zeroCandidate, scorer).ok,
    "GAP accepts ten options and rejects eleven");
  const paddedGap = (target) => {
    const marker = "\nEND";
    let base = boundedGap().slice(0, -marker.length);
    let remaining = target - base.length - marker.length;
    const padding = [];
    while (remaining > 0) {
      if (remaining === 1 && padding.length) {
        padding[padding.length - 1] += "x";
        remaining = 0;
      } else {
        const size = Math.min(4000, remaining - 1);
        padding.push("x".repeat(size));
        remaining -= size + 1;
      }
    }
    return base + padding.map((line) => `\n${line}`).join("") + marker;
  };
  ok(paddedGap(12000).length === 12000 &&
      GapPrompt.parseGapBlock(paddedGap(12000), zeroCandidate, scorer).ok &&
      !GapPrompt.parseGapBlock(paddedGap(12001), zeroCandidate, scorer).ok,
    "GAP accepts the exact raw-size boundary and rejects one character beyond it");

  const zeroGoalsPrompt = GapPrompt.buildGapPrompt({
    day: "2026-08-02",
    means: { kcal: 500, protein: 20, carbs: 40, fat: 10, fiber: 5, sodium: 400 },
    goals: {},
    candidates,
  });
  ok(/no target set/i.test(zeroGoalsPrompt), "gap prompt avoids fake overshoot when no targets");
}

// Async sync-cycle regressions live last so the legacy synchronous test file
// can keep its simple counter/reporting structure.
(async () => {
  console.log("\n[12] Sharded Drive sync");
  const Sync = require("../js/sync.js");
  globalThis.Ledger = Ledger;
  const localStore = new Map();
  globalThis.localStorage = {
    getItem: (key) => localStore.has(key) ? localStore.get(key) : null,
    setItem: (key, value) => localStore.set(key, String(value)),
    removeItem: (key) => localStore.delete(key),
  };

  const localEvent = { id: "local", ts: 100, day: "2026-08-03", type: "add", resetEpoch: 0, entry: { id: "local-entry", name: "local" } };
  const remoteEvent = { id: "remote", ts: 110, day: "2026-08-03", type: "add", resetEpoch: 0, entry: { id: "remote-entry", name: "remote" } };
  const racedEvent = { id: "raced", ts: 120, day: "2026-08-03", type: "add", resetEpoch: 0, entry: { id: "raced-entry", name: "raced" } };
  Ledger.replaceAll([localEvent]);
  let personal = [], goals = { protein: 140 }, goalAt = 1;
  Sync.init({
    getPersonal: () => personal,
    setPersonal: (x) => { personal = x; },
    getGoals: () => goals,
    getGoalsUpdatedAt: () => goalAt,
    setGoals: (x, at) => { goals = x; goalAt = at; },
    getDayGoals: () => ({}), setDayGoals: () => {},
    getDayPlans: () => ({}), setDayPlans: () => {},
    getPhases: () => [], setPhases: () => {},
    getWeights: () => ({}), setWeights: () => {},
    getProfile: () => ({ resetEpoch: 0 }), setProfile: () => {},
  });
  const doc = (events, version = 4) => ({
    version, resetAt: 0, events, personalFoods: [], dayGoals: {}, dayPlans: {},
    phases: [], weights: {}, profile: {}, goals: { protein: 140 }, goalsUpdatedAt: 1,
  });
  const shardDocs = new Map();
  let currentWriter = "writer-a", lockDepth = 0, lockCalls = 0;
  globalThis.GDrive = {
    NEEDS_AUTH: "needs-auth",
    withWriterLock: async (callback) => {
      lockCalls += 1; lockDepth += 1;
      try { return await callback(currentWriter); } finally { lockDepth -= 1; }
    },
    readShards: async () => ({
      docs: [...shardDocs.entries()].map(([id, value]) => ({ id, name: id, doc: value })),
      ownFileId: shardDocs.has(currentWriter) ? currentWriter : null,
    }),
    writeOwnShard: async (_own, next) => {
      ok(lockDepth === 1, "same-writer lock spans read, merge, and write");
      shardDocs.set(currentWriter, next);
    },
  };
  shardDocs.clear();
  Ledger.replaceAll([localEvent]);
  const first = await Sync.fullSync(false);
  currentWriter = "writer-b";
  Ledger.replaceAll([remoteEvent]); // device B's stale local view
  const second = await Sync.fullSync(false);
  ok(first.ok && second.ok && shardDocs.has("writer-a") && shardDocs.has("writer-b"),
    "two devices create distinct writer shard file ids");
  currentWriter = "writer-a";
  Ledger.replaceAll([]);
  const aggregate = await Sync.fullSync(false);
  ok(aggregate.ok && Ledger.allEvents().map((e) => e.id).sort().join(",") === "local,remote",
    "aggregate merge recovers both events after concurrent stale reads");
  ok(lockCalls === 3, "every sync cycle uses the writer lock");

  const clearedPlan = { cleared: true, updatedAt: 20 };
  const stalePlan = { items: [{ id: "old" }], updatedAt: 10 };
  const planMerge = Sync.mergeDayPlans({ "2026-08-01": clearedPlan }, { "2026-08-01": stalePlan });
  ok(planMerge["2026-08-01"].cleared, "day-plan tombstone prevents stale shard resurrection");

  const equalA = { updatedAt: 50, items: [{ id: "a" }] };
  const equalB = { updatedAt: 50, items: [{ id: "b" }] };
  ok(JSON.stringify(Sync.mergeDayPlans({ d: equalA }, { d: equalB })) ===
     JSON.stringify(Sync.mergeDayPlans({ d: equalB }, { d: equalA })),
    "equal-clock LWW merge has a deterministic tie-break");
  const collisionA = { id: "same", ts: 1, type: "remove", target: "a", day: "2026-08-01" };
  const collisionB = { id: "same", ts: 1, type: "remove", target: "b", day: "2026-08-01" };
  ok(JSON.stringify(Sync.mergeEvents([collisionA], [collisionB])) ===
     JSON.stringify(Sync.mergeEvents([collisionB], [collisionA])),
    "duplicate event-id payloads converge deterministically");
  const causalMergeLeft = [{
    id: "merge-root", ts: 50, day: "2026-08-06", type: "add",
    causal: { entryId: "merge-entry", seq: 0, parentEventId: null },
    entry: { id: "merge-entry", name: "root", grams: 100, meal: "breakfast" },
  }, {
    id: "merge-a", ts: 50, day: "2026-08-06", type: "amend", target: "merge-entry",
    causal: { entryId: "merge-entry", seq: 1, parentEventId: "merge-root" },
    patch: { grams: 120 },
  }];
  const causalMergeRight = [{
    patch: { meal: "lunch" }, target: "merge-entry", type: "amend", day: "2026-08-06", ts: 50,
    id: "merge-b", causal: { seq: 1, parentEventId: "merge-root", entryId: "merge-entry" },
  }, { ...causalMergeLeft[0] }];
  const causalAB = Sync.mergeEvents(causalMergeLeft, causalMergeRight);
  const causalBA = Sync.mergeEvents(causalMergeRight, causalMergeLeft);
  ok(JSON.stringify(causalAB) === JSON.stringify(causalBA) &&
      JSON.stringify(Sync.mergeEvents(causalAB, causalAB)) === JSON.stringify(causalAB),
    "causal event union is commutative and idempotent under reversed shard order");
  const causalMergedEntry = Ledger.replayEvents(causalAB)[0];
  ok(causalMergedEntry.grams === 120 && causalMergedEntry.meal === "lunch" &&
      causalAB.every((event) => event.causal && event.causal.entryId === "merge-entry"),
    "merge preserves causal metadata and compatible sibling edits");
  const profileA = { updatedAt: 5, sex: "female" }, profileB = { updatedAt: 5, sex: "male" };
  ok(JSON.stringify(Sync.mergeProfiles(profileA, profileB)) === JSON.stringify(Sync.mergeProfiles(profileB, profileA)),
    "real phase profile merge is commutative at equal clocks");

  const invalidRootA = {
    id: "invalid-root-a", ts: 1, day: "2026-08-01", type: "add",
    causal: { entryId: "same-entry", seq: 0, parentEventId: null },
    entry: { id: "same-entry", name: "A" },
  };
  const invalidRootB = {
    id: "invalid-root-b", ts: 2, day: "2026-08-02", type: "add",
    causal: { entryId: "same-entry", seq: 0, parentEventId: null },
    entry: { id: "same-entry", name: "B" },
  };
  let invalidAggregateWrites = 0, invalidAggregateApplies = 0;
  const beforeInvalidAggregate = JSON.stringify(Ledger.allEvents());
  globalThis.GDrive.readShards = async () => ({
    docs: [{ id: "invalid-a", doc: doc([invalidRootA]) }, { id: "invalid-b", doc: doc([invalidRootB]) }],
    ownFileId: null,
  });
  globalThis.GDrive.writeOwnShard = async () => { invalidAggregateWrites += 1; };
  Sync.init({
    normalizeRemoteDoc: (value) => value,
    getPersonal: () => personal, setPersonal: () => { invalidAggregateApplies += 1; },
    getGoals: () => goals, getGoalsUpdatedAt: () => goalAt,
    setGoals: () => { invalidAggregateApplies += 1; },
  });
  const invalidAggregate = await Sync.fullSync(false);
  ok(!invalidAggregate.ok && invalidAggregate.error &&
      invalidAggregate.error.code === "ledger-causal-cross-day" &&
      invalidAggregateWrites === 0 && invalidAggregateApplies === 0 &&
      JSON.stringify(Ledger.allEvents()) === beforeInvalidAggregate,
    "invalid cross-shard causal aggregate causes zero local mutation and zero Drive writes");

  let detachedApplied = 0, detachedWrites = 0;
  const beforeDetached = Ledger.allEvents().map((e) => e.id).join(",");
  globalThis.GDrive.readShards = async () => ({ docs: [{ id: "bad", doc: doc([racedEvent]) }], ownFileId: null });
  globalThis.GDrive.writeOwnShard = async () => { detachedWrites += 1; };
  Sync.init({
    normalizeRemoteDoc: () => { throw new Error("invalid later field"); },
    getPersonal: () => personal, setPersonal: () => { detachedApplied += 1; },
    getGoals: () => goals, getGoalsUpdatedAt: () => goalAt, setGoals: () => { detachedApplied += 1; },
  });
  const detached = await Sync.fullSync(false);
  ok(!detached.ok && detachedApplied === 0 && detachedWrites === 0 &&
     Ledger.allEvents().map((e) => e.id).join(",") === beforeDetached,
    "detached remote normalization failure causes zero local mutation and zero Drive writes");

  const resetDoc = { ...doc([racedEvent]), resetAt: 999 };
  let resetFailureWrites = 0;
  localStore.delete("nd_reset_at");
  globalThis.GDrive.readShards = async () => ({ docs: [{ id: "reset", doc: resetDoc }], ownFileId: null });
  globalThis.GDrive.writeOwnShard = async () => { resetFailureWrites += 1; };
  Sync.init({
    normalizeRemoteDoc: (value) => value,
    getPersonal: () => personal,
    setPersonal: () => { throw new Error("quota"); },
    getGoals: () => goals,
    getGoalsUpdatedAt: () => goalAt,
    setGoals: () => {},
  });
  const resetFailure = await Sync.fullSync(false);
  ok(!resetFailure.ok && !localStore.has("nd_reset_at") && resetFailureWrites === 0,
    "failed state apply cannot commit a newer reset epoch or write a shard");
  Ledger.replaceAll(beforeDetached.split(",").filter(Boolean).map((id) =>
    id === "local" ? localEvent : id === "remote" ? remoteEvent : racedEvent
  ));

  // Every apply stage can mutate the shared in-memory settings object before
  // its durable write fails. The transaction adapter must restore both views,
  // retain the old privacy epoch, and prevent the subsequent Drive write.
  const savedAtomicLocalStorage = globalThis.localStorage;
  const savedAtomicGDrive = globalThis.GDrive;
  const savedAtomicEvents = Ledger.allEvents();
  const cloneAtomic = (value) => JSON.parse(JSON.stringify(value));
  const atomicStages = ["ledger", "personal", "goals", "dayGoals", "dayPlans", "gapDrafts", "phases", "weights", "profile", "generationSchema", "reset"];
  for (const failureStage of atomicStages) {
    const baseEvents = [{ id: "atomic-local", ts: 20, day: "2026-08-01", type: "add", entry: { id: "atomic-local-entry", name: "local" } }];
    const remoteEvents = [{ id: "atomic-remote", ts: 200, day: "2026-08-02", type: "add", entry: { id: "atomic-remote-entry", name: "remote" } }];
    let memory = {
      personalFoods: [{ id: "food-local", updatedAt: 20, name: "local" }],
      settings: {
        goals: { kcal: 2100, protein: 120 }, goalsUpdatedAt: 20,
        dayGoals: { "2026-08-01": { bumps: { kcal: 100 }, updatedAt: 20 } },
        dayPlans: { "2026-08-01": { items: [{ id: "local" }], updatedAt: 20 } },
        gapDrafts: { "2026-08-01": { selected: [{ name: "local" }], updatedAt: 20 } },
        phases: [{
          id: "phase-local", startDay: "2026-08-01", createdAt: 20, updatedAt: 20,
          revisions: [{ id: "rev-local", effectiveFrom: "2026-08-01", createdAt: 20, goals: { kcal: 2100, protein: 120 } }],
        }],
        weights: { "2026-08-01": { kg: 80, updatedAt: 20 } },
        profile: { sex: "female", updatedAt: 20 },
      },
    };
    const initialMemory = cloneAtomic(memory);
    const durable = new Map([
      ["nd_reset_at", "10"],
      ["app-settings", JSON.stringify(memory.settings)],
      ["app-personal", JSON.stringify(memory.personalFoods)],
    ]);
    let ledgerRaw = JSON.stringify(baseEvents);
    let injectionArmed = false;
    let injected = false;
    const maybeFail = (stage) => {
      if (injectionArmed && !injected && stage === failureStage) {
        injected = true;
        throw new Error(`injected ${stage} failure`);
      }
    };
    const ledgerStore = {
      getItem: () => ledgerRaw,
      setItem: (_key, value) => { maybeFail("ledger"); ledgerRaw = String(value); },
      removeItem: () => { maybeFail("ledger"); ledgerRaw = null; },
    };
    Ledger._setStoreForTests(ledgerStore);
    Ledger.allEvents();
    globalThis.localStorage = {
      getItem: (key) => durable.has(key) ? durable.get(key) : null,
      setItem: (key, value) => {
        if (key === "nd_generation_schema_version") maybeFail("generationSchema");
        if (key === "nd_reset_at") maybeFail("reset");
        durable.set(key, String(value));
      },
      removeItem: (key) => durable.delete(key),
    };
    const persistSettings = (stage) => {
      maybeFail(stage);
      durable.set("app-settings", JSON.stringify(memory.settings));
    };
    const persistPersonal = () => {
      maybeFail("personal");
      durable.set("app-personal", JSON.stringify(memory.personalFoods));
    };
    let driveWrites = 0;
    globalThis.GDrive = {
      NEEDS_AUTH: "needs-auth",
      withWriterLock: async (callback) => callback(),
      readShards: async () => ({
        docs: [{ id: "atomic-remote-shard", doc: {
          version: 4, resetAt: 100, events: remoteEvents,
          personalFoods: [{ id: "food-remote", updatedAt: 200, name: "remote" }],
          goals: { kcal: 2400, protein: 160 }, goalsUpdatedAt: 200,
          dayGoals: { "2026-08-02": { bumps: { kcal: 300 }, updatedAt: 200 } },
          dayPlans: { "2026-08-02": { items: [{ id: "remote" }], updatedAt: 200 } },
          gapDrafts: { "2026-08-02": { selected: [{ name: "remote" }], updatedAt: 200 } },
          phases: [{
            id: "phase-remote", startDay: "2026-08-02", createdAt: 200, updatedAt: 200,
            revisions: [{ id: "rev-remote", effectiveFrom: "2026-08-02", createdAt: 200, goals: { kcal: 2400, protein: 160 } }],
          }],
          weights: { "2026-08-02": { kg: 79, updatedAt: 200 } },
          profile: { sex: "male", updatedAt: 200 },
        } }],
        ownFileId: null,
      }),
      writeOwnShard: async () => { driveWrites += 1; },
    };
    Sync.init({
      normalizeRemoteDoc: (value) => value,
      beginApplyTransaction: () => {
        const beforeMemory = cloneAtomic(memory);
        const beforeDurable = new Map(durable);
        const beforeLedgerRaw = ledgerRaw;
        return {
          commit() {},
          rollback() {
            memory = cloneAtomic(beforeMemory);
            durable.clear();
            for (const [key, value] of beforeDurable) durable.set(key, value);
            ledgerRaw = beforeLedgerRaw;
            Ledger._resetCacheForTests();
          },
        };
      },
      getPersonal: () => memory.personalFoods,
      setPersonal: (value) => { memory.personalFoods = value; persistPersonal(); },
      getGoals: () => memory.settings.goals,
      getGoalsUpdatedAt: () => memory.settings.goalsUpdatedAt,
      setGoals: (value, at) => {
        memory.settings.goals = value; memory.settings.goalsUpdatedAt = at; persistSettings("goals");
      },
      getDayGoals: () => memory.settings.dayGoals,
      setDayGoals: (value) => { memory.settings.dayGoals = value; persistSettings("dayGoals"); },
      getDayPlans: () => memory.settings.dayPlans,
      setDayPlans: (value) => { memory.settings.dayPlans = value; persistSettings("dayPlans"); },
      getGapDrafts: () => memory.settings.gapDrafts,
      setGapDrafts: (value) => { memory.settings.gapDrafts = value; persistSettings("gapDrafts"); },
      getPhases: () => memory.settings.phases,
      setPhases: (value) => { memory.settings.phases = value; persistSettings("phases"); },
      getWeights: () => memory.settings.weights,
      setWeights: (value) => { memory.settings.weights = value; persistSettings("weights"); },
      getProfile: () => memory.settings.profile,
      setProfile: (value) => { memory.settings.profile = value; persistSettings("profile"); },
    });
    const initialDurable = JSON.stringify([...durable]);
    const initialLedgerRaw = ledgerRaw;
    injectionArmed = true;
    const atomicResult = await Sync.fullSync(false);
    ok(!atomicResult.ok && injected && driveWrites === 0
      && JSON.stringify(memory) === JSON.stringify(initialMemory)
      && JSON.stringify([...durable]) === initialDurable
      && ledgerRaw === initialLedgerRaw
      && JSON.stringify(Ledger.allEvents()) === JSON.stringify(baseEvents),
    `applyDoc ${failureStage} failure rolls memory and durable state back before Drive write`);
  }
  globalThis.localStorage = savedAtomicLocalStorage;
  globalThis.GDrive = savedAtomicGDrive;
  let restoredAtomicRaw = JSON.stringify(savedAtomicEvents);
  Ledger._setStoreForTests({
    getItem: () => restoredAtomicRaw,
    setItem: (_key, value) => { restoredAtomicRaw = String(value); },
    removeItem: () => { restoredAtomicRaw = "[]"; },
  });

  let malformedGenerationWrites = 0, malformedGenerationApplies = 0;
  globalThis.GDrive.readShards = async () => ({
    docs: [{ id: "malformed-generation", doc: {
      ...doc([]),
      generationSchemaVersion: 1,
      personalFoods: [{ id: "future-generation", updatedAt: 1, resetEpoch: 100 }],
      profile: { resetEpoch: 0 },
      goalsResetEpoch: 0,
    } }],
    ownFileId: null,
  });
  globalThis.GDrive.writeOwnShard = async () => { malformedGenerationWrites += 1; };
  Sync.init({
    normalizeRemoteDoc: (value) => value,
    getPersonal: () => personal,
    setPersonal: () => { malformedGenerationApplies += 1; },
    getGoals: () => goals,
    getGoalsUpdatedAt: () => goalAt,
    setGoals: () => { malformedGenerationApplies += 1; },
  });
  const malformedGeneration = await Sync.fullSync(false);
  ok(!malformedGeneration.ok && malformedGeneration.error &&
      malformedGeneration.error.code === "sync-generation-invalid" &&
      malformedGenerationWrites === 0 && malformedGenerationApplies === 0,
    "a shard that claims a future record generation is rejected before local apply or Drive write");

  const fixedClockNow = Date.now();
  let exactSkewAccepted = false, futureResetError = null, futureRecordError = null;
  try {
    exactSkewAccepted = Sync.validateDocClocks(
      { resetAt: fixedClockNow + Sync.MAX_FUTURE_SKEW_MS }, { now: fixedClockNow }
    );
  } catch (error) { exactSkewAccepted = false; }
  try {
    Sync.validateDocClocks(
      { resetAt: fixedClockNow + Sync.MAX_FUTURE_SKEW_MS + 1 }, { now: fixedClockNow }
    );
  } catch (error) { futureResetError = error; }
  try {
    Sync.validateDocClocks({
      resetAt: 100,
      personalFoods: [{ id: "future-record", resetEpoch: 0, updatedAt: fixedClockNow + Sync.MAX_FUTURE_SKEW_MS + 1 }],
    }, { now: fixedClockNow });
  } catch (error) { futureRecordError = error; }
  ok(exactSkewAccepted === true && futureResetError && futureResetError.code === "sync-future-clock" &&
      futureRecordError && futureRecordError.code === "sync-future-clock",
    "sync accepts the exact skew allowance and rejects reset or per-record clocks one millisecond beyond it");

  const beforeClockReject = JSON.stringify(Ledger.allEvents());
  let clockRejectWrites = 0, clockRejectApplies = 0;
  const futureStamp = Date.now() + Sync.MAX_FUTURE_SKEW_MS + 60000;
  localStore.set("nd_reset_at", "100");
  globalThis.GDrive.readShards = async () => ({
    docs: [{ id: "future-record-shard", doc: {
      ...doc([]), resetAt: 0,
      // This old-generation record would be discarded by the winning local
      // reset. The clock guard must still reject it before filtering can hide it.
      personalFoods: [{ id: "hidden-future", name: "hidden", resetEpoch: 0, updatedAt: futureStamp }],
    } }],
    ownFileId: null,
  });
  globalThis.GDrive.writeOwnShard = async () => { clockRejectWrites += 1; };
  Sync.init({
    normalizeRemoteDoc: (value) => value,
    getPersonal: () => personal,
    setPersonal: () => { clockRejectApplies += 1; },
    getGoals: () => goals,
    getGoalsUpdatedAt: () => goalAt,
    setGoals: () => { clockRejectApplies += 1; },
  });
  const rejectedFutureRecord = await Sync.fullSync(false);
  ok(!rejectedFutureRecord.ok && rejectedFutureRecord.error &&
      rejectedFutureRecord.error.code === "sync-future-clock" &&
      clockRejectWrites === 0 && clockRejectApplies === 0 &&
      JSON.stringify(Ledger.allEvents()) === beforeClockReject && Sync.state().status === "error",
    "a far-future clock hidden in a discardable generation pauses sync with zero mutations and zero writes");

  globalThis.GDrive.readShards = async () => ({
    docs: [{ id: "future-reset-shard", doc: { ...doc([]), resetAt: futureStamp } }],
    ownFileId: null,
  });
  const rejectedFutureReset = await Sync.fullSync(false);
  ok(!rejectedFutureReset.ok && rejectedFutureReset.error &&
      rejectedFutureReset.error.code === "sync-future-clock" &&
      clockRejectWrites === 0 && clockRejectApplies === 0 &&
      JSON.stringify(Ledger.allEvents()) === beforeClockReject && Sync.state().status === "error" &&
      /date and time/i.test(Sync.state().detail),
    "a far-future reset clock is rejected pre-apply/pre-write and leaves the writer visibly paused");

  let corruptOutboundWrites = 0, corruptOutboundApplies = 0;
  localStore.delete("nd_generation_schema_version");
  const corruptLocalDayGoals = {
    // This is a current post-reset candidate; generation rollout must stamp it
    // and still let the strict inbound normalizer reject its bad target. 150
    // is below both the planned-day floor (200) and the mock's own legacy
    // 800 threshold below — 700 would now be a genuinely valid planned day
    // and would no longer exercise this rejection path (Part VIII.6).
    "2026-08-24": { targetKcal: 150, baseKcal: 2200, updatedAt: 101, resetEpoch: 100 },
  };
  globalThis.GDrive.readShards = async () => ({ docs: [], ownFileId: null });
  globalThis.GDrive.writeOwnShard = async () => { corruptOutboundWrites += 1; };
  Sync.init({
    normalizeRemoteDoc: (value) => {
      for (const record of Object.values(value.dayGoals || {})) {
        if (record && record.targetKcal != null &&
            (Number(record.targetKcal) < 800 || Number(record.targetKcal) > 6000)) {
          const error = new Error("day goal target must be 800–6000 kcal");
          error.code = "sync-schema-invalid";
          throw error;
        }
      }
      return value;
    },
    getPersonal: () => personal,
    setPersonal: () => { corruptOutboundApplies += 1; },
    getGoals: () => goals,
    getGoalsUpdatedAt: () => goalAt,
    setGoals: () => { corruptOutboundApplies += 1; },
    getDayGoals: () => corruptLocalDayGoals,
    setDayGoals: () => { corruptOutboundApplies += 1; },
  });
  const corruptOutbound = await Sync.fullSync(false);
  ok(!corruptOutbound.ok && corruptOutbound.error &&
      corruptOutbound.error.code === "sync-schema-invalid" &&
      corruptOutboundWrites === 0 && corruptOutboundApplies === 0 &&
      JSON.stringify(Ledger.allEvents()) === beforeClockReject,
    "corrupt local outbound state must pass the inbound range normalizer and causes zero apply/write",
    JSON.stringify({ corruptOutbound, corruptOutboundWrites, corruptOutboundApplies }));

  let aggregateRejectWrites = 0, aggregateRejectApplies = 0;
  localStore.set("nd_reset_at", "0");
  const aggregateLocalFood = {
    id: "aggregate-local", name: "local half", updatedAt: 110, resetEpoch: 0,
  };
  const aggregateRemoteFood = {
    id: "aggregate-remote", name: "remote half", updatedAt: 120, resetEpoch: 0,
  };
  globalThis.GDrive.readShards = async () => ({
    docs: [{ id: "aggregate-shard", doc: {
      ...doc([]), resetAt: 0, personalFoods: [aggregateRemoteFood],
    } }],
    ownFileId: null,
  });
  globalThis.GDrive.writeOwnShard = async () => { aggregateRejectWrites += 1; };
  Sync.init({
    normalizeRemoteDoc: (value) => {
      const ids = new Set((value.personalFoods || []).map((food) => food.id));
      if (ids.has("aggregate-local") && ids.has("aggregate-remote")) {
        const error = new Error("invalid aggregate food set");
        error.code = "sync-schema-invalid";
        throw error;
      }
      return value;
    },
    getPersonal: () => [aggregateLocalFood],
    setPersonal: () => { aggregateRejectApplies += 1; },
    getGoals: () => goals,
    getGoalsUpdatedAt: () => goalAt,
    setGoals: () => { aggregateRejectApplies += 1; },
  });
  const aggregateReject = await Sync.fullSync(false);
  ok(!aggregateReject.ok && aggregateReject.error &&
      aggregateReject.error.code === "sync-schema-invalid" &&
      aggregateRejectWrites === 0 && aggregateRejectApplies === 0 &&
      JSON.stringify(Ledger.allEvents()) === beforeClockReject,
    "the merged aggregate is normalized again before apply or write");
  localStore.delete("nd_reset_at");

  // A future schema must not be applied to or mark clean this older build.
  const beforeFuture = Ledger.allEvents().map((e) => e.id).join(",");
  let futureWrites = 0, futureApplied = false;
  globalThis.GDrive.readShards = async () => {
    const err = new Error("newer"); err.code = "drive-newer-schema"; throw err;
  };
  globalThis.GDrive.writeOwnShard = async () => { futureWrites += 1; };
  Sync.init({
    getPersonal: () => personal, setPersonal: () => { futureApplied = true; },
    getGoals: () => goals, getGoalsUpdatedAt: () => goalAt, setGoals: () => { futureApplied = true; },
  });
  const future = await Sync.fullSync(false);
  ok(future.ok && future.upgrade && future.preservedLocal,
    "newer remote schema returns an explicit preserved-local upgrade result");
  ok(!futureApplied && futureWrites === 0 && Ledger.allEvents().map((e) => e.id).join(",") === beforeFuture,
    "newer remote schema neither applies nor overwrites local data");
  ok(Sync.state().status === "warn", "newer remote schema remains visibly unsynced");

  const savedDisconnectDrive = globalThis.GDrive;
  const savedDisconnectStorage = globalThis.localStorage;
  let credentialsClearedFirst = false;
  globalThis.GDrive = {
    signOut: async () => { credentialsClearedFirst = true; return true; },
  };
  globalThis.localStorage = {
    getItem: (key) => localStore.has(key) ? localStore.get(key) : null,
    setItem: (key, value) => {
      if (key === "nd_sync_enabled") throw new Error("blocked preference write");
      localStore.set(key, String(value));
    },
    removeItem: (key) => localStore.delete(key),
  };
  const failedPreferenceDisconnect = await Sync.disconnect();
  ok(credentialsClearedFirst && failedPreferenceDisconnect.serverCleared === true &&
      failedPreferenceDisconnect.localCleared === false,
    "disconnect clears credentials even when the local disabled preference cannot be written");
  globalThis.GDrive = savedDisconnectDrive;
  globalThis.localStorage = savedDisconnectStorage;

  console.log("\n[13] Direct sharded Drive boundary");
  const savedFetch = globalThis.fetch;
  const savedSessionStorage = globalThis.sessionStorage;
  const tokenStore = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => tokenStore.has(key) ? tokenStore.get(key) : null,
    setItem: (key, value) => tokenStore.set(key, String(value)),
    removeItem: (key) => tokenStore.delete(key),
  };
  tokenStore.set("nd_gtoken_v1", JSON.stringify({ token: "browser-token", exp: Date.now() + 60000 }));
  const savedNavigator = globalThis.navigator;
  const savedCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name, options, callback) => {
      ok(options.mode === "exclusive", "writer lock requests exclusive mode");
      return callback();
    } } },
  });
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
  });
  const RealGDrive = require("../js/gdrive.js");
  const writerName = "nutridaily-shard-v4-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";
  const meta = (id, name, writer) => ({
    id, name, mimeType: "application/json", trashed: false, size: "100",
    parents: ["folder-1"], isAppAuthorized: true,
    appProperties: writer ? { nutridailySchema: "4", nutridailyWriter: writer } : undefined,
  });
  let calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    ok(String(url).startsWith("https://www.googleapis.com/"), "shard data uses the direct Google Drive API");
    ok(opts.headers && opts.headers.Authorization === "Bearer browser-token",
      "direct Drive requests keep the access token in the Authorization header");
    if (String(url).includes("pageToken=p2")) {
      return new Response(JSON.stringify({ files: [
        meta("shard-a", writerName, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      ] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).includes("/files?q=")) {
      return new Response(JSON.stringify({
        nextPageToken: "p2",
        files: [
          meta("legacy-id", "nutridaily-data.json"),
          meta("ignored-id", "nutridaily-shard-v4-not-allowlisted.json"),
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).includes("legacy-id") && String(url).includes("alt=media")) {
      return new Response(JSON.stringify(doc([remoteEvent], 3)), { status: 200 });
    }
    if (String(url).includes("shard-a") && String(url).includes("alt=media")) {
      return new Response(JSON.stringify(doc([localEvent], 4)), { status: 200 });
    }
    throw new Error("unexpected Drive request " + url);
  };
  const snapshot = await RealGDrive.readShards(false);
  ok(snapshot.docs.length === 2 && snapshot.docs[0].name === "nutridaily-data.json" &&
     snapshot.docs[1].name === writerName, "pagination, exact filename allowlist, and deterministic sort work");
  ok(snapshot.ownFileId === "shard-a" && !calls.some((call) => call.url.includes("/api/drive-sync")),
    "static/GIS mode has full direct read support with no data endpoint dependency");

  let patchedIds = [], storedDoc = doc([localEvent, remoteEvent], 4);
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("uploadType=media")) {
      patchedIds.push(String(url));
      return new Response(JSON.stringify({ id: "shard-a" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).includes("alt=media")) {
      return new Response(JSON.stringify(storedDoc), { status: 200 });
    }
    if (String(url).includes("/files/shard-a?fields=")) {
      return new Response(JSON.stringify(meta("shard-a", writerName, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("unexpected write request " + url);
  };
  await RealGDrive.writeOwnShard(snapshot.docs[1], storedDoc, false);
  ok(patchedIds.length === 1 && patchedIds[0].includes("shard-a") && !patchedIds[0].includes("legacy-id"),
    "only the current writer shard is updated; legacy input is never PATCHed");
  ok(calls.find((call) => call.url.includes("uploadType=media")).opts.method === "PATCH",
    "static/GIS mode has full direct write support for the owned shard");

  const assertReadFails = async (label, listBody, mediaText, expectedCode) => {
    let writes = 0;
    globalThis.fetch = async (url, opts = {}) => {
      if (opts.method === "PATCH" || opts.method === "POST") writes += 1;
      if (String(url).includes("/files?q=")) {
        return new Response(JSON.stringify(listBody), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(url).includes("alt=media")) return new Response(mediaText, { status: 200 });
      throw new Error("unexpected malformed request " + url);
    };
    let err = null;
    try { await RealGDrive.readShards(false); } catch (e) { err = e; }
    ok(err && err.code === expectedCode && writes === 0, label);
  };
  await assertReadFails(
    "malformed shards fail closed before any write",
    { files: [meta("bad-id", writerName, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] },
    '{"version":4,"resetAt":1e309,"events":[],"personalFoods":[],"dayGoals":{},"dayPlans":{},"phases":[],"weights":{},"profile":{},"goals":{}}',
    "drive-malformed-shard"
  );
  await assertReadFails(
    "dangerous object keys fail closed before merge",
    { files: [meta("bad-id", writerName, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] },
    '{"version":4,"events":[],"profile":{"__proto__":{"polluted":true}}}',
    "drive-malformed-shard"
  );
  await assertReadFails(
    "newer shard schemas fail closed before any write",
    { files: [meta("future-id", writerName, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] },
    JSON.stringify(doc([], 99)),
    "drive-newer-schema"
  );
  await assertReadFails(
    "incomplete Drive searches fail closed",
    { incompleteSearch: true, files: [] },
    "{}",
    "drive-incomplete-search"
  );
  const oversized = meta("large-id", writerName, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  oversized.size = String(RealGDrive._internals.MAX_DOC_BYTES + 1);
  await assertReadFails(
    "per-document byte cap rejects before buffering",
    { files: [oversized] },
    "{}",
    "drive-document-too-large"
  );
  const tooMany = Array.from({ length: RealGDrive._internals.MAX_SHARDS + 1 }, (_, i) => {
    const id = i.toString(16).padStart(32, "0");
    return meta(`many-${i}`, `nutridaily-shard-v4-${id}.json`, id);
  });
  await assertReadFails(
    "shard-count cap fails closed before reading documents",
    { files: tooMany },
    "{}",
    "drive-shard-limit"
  );

  let pageReads = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/files?q=")) {
      pageReads += 1;
      return new Response(JSON.stringify({ nextPageToken: `page-${pageReads}`, files: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("unexpected pagination-cap request");
  };
  let pageErr = null;
  try { await RealGDrive.readShards(false); } catch (e) { pageErr = e; }
  ok(pageErr && pageErr.code === "drive-shard-limit" && pageReads === RealGDrive._internals.MAX_LIST_PAGES,
    "pagination-page cap fails closed");

  const aggregateFiles = Array.from({ length: 5 }, (_, i) => {
    const id = (i + 100).toString(16).padStart(32, "0");
    return meta(`aggregate-${i}`, `nutridaily-shard-v4-${id}.json`, id);
  });
  const paddedDoc = JSON.stringify({ ...doc([], 4), padding: "x".repeat(2600000) });
  await assertReadFails(
    "aggregate byte cap fails closed across individually valid shards",
    { files: aggregateFiles },
    paddedDoc,
    "drive-document-too-large"
  );

  globalThis.fetch = async (url) => {
    if (String(url) === "/api/auth/logout") throw new Error("offline");
    throw new Error("unexpected logout request");
  };
  const offlineLogout = await RealGDrive.signOut();
  ok(offlineLogout === false && RealGDrive.logoutPending() && !RealGDrive.cachedToken(),
    "offline sign-out clears cached credentials and records a durable server-logout retry");

  // A stale enabled preference can survive an offline logout (for example if
  // its local write was blocked). Resume and the app's online sequence
  // (retryPendingLogout followed immediately by schedulePush) must not race a
  // silent token refresh or Drive cycle while the cookie logout is unresolved.
  const driveBeforeLogoutRace = globalThis.GDrive;
  const enabledBeforeLogoutRace = localStore.has("nd_sync_enabled")
    ? localStore.get("nd_sync_enabled") : null;
  const originalSilentBoot = RealGDrive.silentBoot;
  const originalReadShards = RealGDrive.readShards;
  const originalWriteOwnShard = RealGDrive.writeOwnShard;
  let logoutRaceSilentBoots = 0;
  let logoutRaceReads = 0;
  let logoutRaceWrites = 0;
  RealGDrive.silentBoot = async () => {
    logoutRaceSilentBoots += 1;
    throw new Error(RealGDrive.NEEDS_AUTH);
  };
  RealGDrive.readShards = async () => {
    logoutRaceReads += 1;
    return { docs: [], ownFileId: null };
  };
  RealGDrive.writeOwnShard = async () => { logoutRaceWrites += 1; };
  globalThis.GDrive = RealGDrive;
  localStore.set("nd_sync_enabled", "1");

  await Sync.resume(); // offline retry fails and the durable marker remains.
  ok(RealGDrive.logoutPending() && logoutRaceSilentBoots === 0 &&
      logoutRaceReads === 0 && logoutRaceWrites === 0,
    "pending offline logout makes background resume stop before silent refresh or sync");

  let logoutRetries = 0;
  let finishLogoutRetry = null;
  globalThis.fetch = (url, opts) => {
    if (String(url) === "/api/auth/logout" && opts && opts.method === "POST") {
      logoutRetries += 1;
      return new Promise((resolve) => {
        finishLogoutRetry = () => resolve(new Response(null, { status: 204 }));
      });
    }
    return Promise.reject(new Error("unexpected logout retry request"));
  };
  const onlineLogoutRetry = RealGDrive.retryPendingLogout();
  Sync.schedulePush(); // mirrors App's online listener before retry resolves.
  await new Promise((resolve) => setImmediate(resolve));
  const onlineRaceBlocked = RealGDrive.logoutPending() && logoutRaceSilentBoots === 0 &&
    logoutRaceReads === 0 && logoutRaceWrites === 0;
  finishLogoutRetry();
  const retriedLogout = await onlineLogoutRetry;
  ok(onlineRaceBlocked && retriedLogout === true && logoutRetries === 1 &&
      !RealGDrive.logoutPending(),
    "online logout retry blocks schedulePush refresh/sync until /api/auth/logout succeeds",
    `silent=${logoutRaceSilentBoots}, reads=${logoutRaceReads}, writes=${logoutRaceWrites}`);

  const silentBeforeSuccessfulLogout = logoutRaceSilentBoots;
  Sync.schedulePush();
  await new Promise((resolve) => setImmediate(resolve));
  ok(logoutRaceSilentBoots === silentBeforeSuccessfulLogout + 1 &&
      logoutRaceReads === 0 && logoutRaceWrites === 0,
    "background authentication may be attempted again only after the logout retry succeeds");

  RealGDrive.silentBoot = originalSilentBoot;
  RealGDrive.readShards = originalReadShards;
  RealGDrive.writeOwnShard = originalWriteOwnShard;
  globalThis.GDrive = driveBeforeLogoutRace;
  if (enabledBeforeLogoutRace == null) localStore.delete("nd_sync_enabled");
  else localStore.set("nd_sync_enabled", enabledBeforeLogoutRace);

  globalThis.fetch = savedFetch;
  globalThis.sessionStorage = savedSessionStorage;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: savedNavigator });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: savedCrypto });

  console.log("\n[14] Day-intent constants and the 800/200 asymmetry");
  {
    const Phases14 = require("../js/phases.js");
    const Sync14 = require("../js/sync.js");

    ok(Phases14.MIN_PLANNED_KCAL === 200 && Phases14.FAST_KCAL === 0 && Phases14.LOW_KCAL_ACK_KCAL === 1200 &&
        Phases14.MAX_DAY_TARGET_KCAL === 6000,
      "day-intent constants match the spec");
    ok(JSON.stringify(Phases14.DAY_INTENTS) === JSON.stringify(["reduced", "fast"]), "DAY_INTENTS lists both intents");
    ok(typeof Phases14.MIN_DAY_TARGET_KCAL === "undefined", "MIN_DAY_TARGET_KCAL is removed, not aliased");

    ok(Phases14.isPlannedKcal(0) && Phases14.isPlannedKcal(200) && Phases14.isPlannedKcal(6000),
      "isPlannedKcal accepts the fast value and the full planned-day range");
    ok(!Phases14.isPlannedKcal(1) && !Phases14.isPlannedKcal(199) && !Phases14.isPlannedKcal(6001) && !Phases14.isPlannedKcal(-1),
      "isPlannedKcal rejects the dead zone between 1 and 199, and anything past the ceiling");

    // Part VIII.5 / Slice 6: FAST_DECLARATION_COPY is the single source for the
    // Fast panel copy. It states that the >0 threshold in
    // effectiveGoals/scoreDayTotals is a hard cliff (5 kcal of milk ends a
    // declared fast), not a fuzzy allowance.
    ok(typeof Phases14.FAST_DECLARATION_COPY === "string" && /0 kcal/.test(Phases14.FAST_DECLARATION_COPY) &&
        /ends the fast/i.test(Phases14.FAST_DECLARATION_COPY),
      "FAST_DECLARATION_COPY states plainly that any calorie ends the fast");

    const dayGoalsFor = (day, ov) => ({
      goals: { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 },
      phases: [], dayGoals: { [day]: ov },
    });

    // baseKcal is a phase target and keeps its own 800 floor no matter how far
    // the target side widens — the asymmetry is the whole point of this slice.
    ok(Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      targetKcal: 500, baseKcal: 799, updatedAt: 1,
    }), { kcal: 799 }) === null, "baseKcal below 800 is still rejected on the modern shape");
    ok(Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      kcal: 500, updatedAt: 1,
    }), { kcal: 799 }) === null, "baseKcal below 800 is still rejected on the legacy absolute shape");

    // 1–199 is a dead zone on every shape that carries an explicit target.
    ok(Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      targetKcal: 199, baseKcal: 2000, updatedAt: 1,
    }), { kcal: 2000 }) === null, "the modern shape rejects 199 kcal");
    ok(Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      kcal: 199, updatedAt: 1,
    }), { kcal: 2000 }) === null, "the legacy absolute shape rejects 199 kcal");
    ok(Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      bumps: { kcal: -1801 }, updatedAt: 1,
    }), { kcal: 2000 }) === null, "the delta-bump shape rejects a resolved target inside the 1-199 dead zone");

    // A planned day of 500 (5:2 / ADF territory) is now expressible.
    const fiveTwo = Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      targetKcal: 500, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true,
    }), { kcal: 2000 });
    ok(fiveTwo && fiveTwo.targetKcal === 500 && fiveTwo.intent === "reduced",
      "a 500 kcal planned day round-trips through dayPlanForDay as a reduced day");

    // Part VIII.2's exact scenario: a legacy {bumps:{kcal:-800}} record was
    // written while the phase stood at 2200 kcal. Nobody acknowledged
    // anything at the time — there was nothing to acknowledge yet, since the
    // resolved target was a normal 1400 kcal. The phase is later cut to 1200,
    // and the same stale bump now resolves to a live 400 kcal plan no one
    // ever confirmed. The scoring layer must catch this itself rather than
    // trust that an ack was enforced somewhere upstream.
    const staleBumpLaundered = Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      bumps: { kcal: -800 }, updatedAt: 1,
    }), { kcal: 1200 });
    ok(staleBumpLaundered === null,
      "a stale delta bump that resolves below 1200 kcal after a phase cut is rejected without acknowledgement");
    const staleBumpAcknowledged = Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      bumps: { kcal: -800 }, updatedAt: 1, veryLowCalorieAcknowledged: true,
    }), { kcal: 1200 });
    ok(staleBumpAcknowledged && staleBumpAcknowledged.kcal === -800,
      "the same stale delta bump resolves once acknowledgement is present");
    // Before the cut, the same record needed no ack at all — 2200 - 800 =
    // 1400 sits above the ladder threshold.
    const staleBumpBeforeCut = Phases14.dayPlanForDay("2026-08-01", dayGoalsFor("2026-08-01", {
      bumps: { kcal: -800 }, updatedAt: 1,
    }), { kcal: 2200 });
    ok(staleBumpBeforeCut && staleBumpBeforeCut.kcal === -800,
      "the same record needs no acknowledgement while the phase still resolves it above 1200 kcal");

    // Sync.normalizeDayGoal — target side widens, base side does not. 500 is
    // below LOW_KCAL_ACK_KCAL, so the §7 ladder requires the ack (Part VII.4).
    ok(!Sync14.normalizeDayGoal({
      targetKcal: 500, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true,
    }).cleared,
      "sync accepts a 500 kcal reduced-day target");
    ok(Sync14.normalizeDayGoal({ targetKcal: 500, baseKcal: 2000, updatedAt: 1 }).cleared,
      "sync tombstones a 500 kcal reduced-day target with no acknowledgement");
    ok(Sync14.normalizeDayGoal({ targetKcal: 500, baseKcal: 799, updatedAt: 1 }).cleared,
      "sync still rejects a sub-800 baseKcal even when the target is in the widened range");
    ok(Sync14.normalizeDayGoal({ targetKcal: 199, baseKcal: 2000, updatedAt: 1 }).cleared,
      "sync rejects a targetKcal of 199");

    // goalsForDay resolves every legacy dayGoals generation exactly as before:
    // only kcal moves, floors and ceilings are untouched. Analytics is loaded
    // in this file (see line 16), so carbs/fat are genuinely retargeted here
    // via the real Analytics.retargetForKcal — this block just doesn't assert
    // their values; the retargeted-carbs/fat case has its own dedicated
    // assertions in test-analytics.js.
    const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300, potassium: 3510 };
    const genSettings = (day, dayGoal) => ({ goals: phaseGoals, phases: [], dayGoals: { [day]: dayGoal } });
    const gday = "2026-08-01";
    const modernGoals = Phases14.goalsForDay(gday, genSettings(gday, { targetKcal: 2500, baseKcal: 2000, updatedAt: 1 }));
    const deltaGoals = Phases14.goalsForDay(gday, genSettings(gday, { bumps: { kcal: 500 }, updatedAt: 1 }));
    const legacyGoals = Phases14.goalsForDay(gday, genSettings(gday, { kcal: 2500, updatedAt: 1 }));
    const tombstoneGoals = Phases14.goalsForDay(gday, genSettings(gday, { cleared: true, updatedAt: 1 }));
    for (const g of [modernGoals, deltaGoals, legacyGoals]) {
      ok(g.kcal === 2500 && g.protein === 150 && g.fiber === 30 && g.sodium === 2300 && g.potassium === 3510,
        "every legacy dayGoals generation still resolves kcal-only; floors and ceilings are untouched");
    }
    ok(tombstoneGoals.kcal === 2000 && tombstoneGoals._dayPlan === null && tombstoneGoals._unscored === null,
      "a cleared tombstone resolves to the phase target with no plan and no exemptions");
  }

  console.log("\n[15] Day-intent plumbing — fast declarations");
  {
    const Phases15 = require("../js/phases.js");
    const Sync15 = require("../js/sync.js");

    // Absent on every record generation that predates this feature; migration
    // is read-time defaulting, so the stored record itself never gains a
    // written-out "reduced" intent.
    const reducedNoIntent = Sync15.normalizeDayGoal({ targetKcal: 1500, baseKcal: 2000, updatedAt: 1 });
    ok(reducedNoIntent.intent === undefined, "absent intent is not rewritten to \"reduced\" on disk");

    ok(Sync15.normalizeDayGoal({
      targetKcal: 0, baseKcal: 2000, intent: "fast", updatedAt: 1,
    }).cleared, "a fast without fastAcknowledged is rejected, not silently accepted");
    const fast = Sync15.normalizeDayGoal({
      targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, plannedAt: 5, updatedAt: 1,
    });
    ok(fast && !fast.cleared && fast.targetKcal === 0 && fast.intent === "fast" && fast.fastAcknowledged === true,
      "a fully acknowledged fast is accepted and keeps its intent");

    ok(Sync15.normalizeDayGoal({ targetKcal: 0, baseKcal: 2000, updatedAt: 1 }).cleared,
      "targetKcal 0 without intent \"fast\" is rejected");
    ok(Sync15.normalizeDayGoal({
      targetKcal: 500, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1,
    }).cleared, "intent \"fast\" with a nonzero target is an incoherent record, not a plan to preserve");

    // A fast only ever takes the frozen modern shape — legacy shapes cannot
    // express a zero-calorie day explicitly, so intent never rides along.
    ok(Sync15.normalizeDayGoal({
      bumps: { kcal: 500 }, intent: "fast", fastAcknowledged: true, updatedAt: 1,
    }).intent === undefined, "intent does not survive through the legacy delta-bump shape");

    // Phases.dayPlanForDay carries intent through to the resolved record.
    const fastSettings = {
      goals: { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 },
      phases: [],
      dayGoals: { "2026-08-01": { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 } },
    };
    const fastBumps = Phases15.dayPlanForDay("2026-08-01", fastSettings, fastSettings.goals);
    ok(fastBumps && fastBumps.intent === "fast" && fastBumps.targetKcal === 0,
      "dayPlanForDay carries a declared fast through to its resolved record");
    const reducedSettings = { ...fastSettings, dayGoals: { "2026-08-01": { targetKcal: 1500, baseKcal: 2000, updatedAt: 1 } } };
    const reducedBumps = Phases15.dayPlanForDay("2026-08-01", reducedSettings, reducedSettings.goals);
    ok(reducedBumps && reducedBumps.intent === "reduced", "dayPlanForDay defaults intent to reduced when absent");

    // Part IX.2: intent "fast" with a nonzero target is honoured by neither
    // Sync.normalizeDayGoal (asserted above) nor App.importedPlannedKcal
    // (asserted in the real-import smoke suite) — dayPlanForDay, which decides
    // the grade, and Ledger._normalizedDayGoalLock (asserted in [5c]), which
    // writes the immutable event log, must agree with both. Eating 1500 kcal
    // and having every other target waved off is the laundering path this
    // closes.
    const incoherentFastSettings = {
      ...fastSettings,
      dayGoals: {
        "2026-08-01": { targetKcal: 1500, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 },
      },
    };
    const incoherentFastBumps = Phases15.dayPlanForDay(
      "2026-08-01", incoherentFastSettings, incoherentFastSettings.goals
    );
    ok(incoherentFastBumps && incoherentFastBumps.intent === "reduced" && incoherentFastBumps.targetKcal === 1500,
      "dayPlanForDay never honours intent \"fast\" unless the resolved target is exactly 0 kcal");
    const incoherentFastGoals = Phases15.goalsForDay("2026-08-01", incoherentFastSettings);
    ok(incoherentFastGoals.kcal === 1500 && incoherentFastGoals._unscored === null,
      "goalsForDay scores every target on the incoherent record instead of unscoring seven cells for free");

    // goalsForDay: a declared fast keeps phase values visible but unscores
    // every non-kcal target, including fiber/sodium/potassium — unlike a
    // reduced day, where those never move into _unscored (Q5/Q8).
    const fastGoals = Phases15.goalsForDay("2026-08-01", fastSettings);
    ok(fastGoals.kcal === 0 && fastGoals.protein === 150, "a declared fast keeps kcal at 0 and protein at its phase value");
    for (const key of ["protein", "carbs", "fat", "fiber", "sodium", "naK"]) {
      ok(fastGoals._unscored && fastGoals._unscored[key] === "declared fast", `fast day marks ${key} unscored`);
    }

    // mergeDayGoals LWW across fast and reduced records, in both directions.
    const day = "2026-08-01";
    const reducedRecord = { targetKcal: 1500, baseKcal: 2000, updatedAt: 10 };
    const fastRecord = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 20 };
    const newerFastWins = Sync15.mergeDayGoals({ [day]: reducedRecord }, { [day]: fastRecord });
    ok(newerFastWins[day].intent === "fast" && newerFastWins[day].targetKcal === 0,
      "a newer declared fast beats an older reduced-day plan on merge");
    const newerReducedWins = Sync15.mergeDayGoals({ [day]: fastRecord }, { [day]: { ...reducedRecord, updatedAt: 30 } });
    ok(newerReducedWins[day].intent === undefined && newerReducedWins[day].targetKcal === 1500,
      "a newer reduced-day plan beats an older declared fast on merge, in the other direction");

    // Old-client simulation: an older client that has not shipped this feature
    // runs the pre-widening [800, 6000] rule and would normalize a 500 kcal
    // plan straight to a tombstone. That tombstone must not defeat a newer
    // valid record on the way back — mergeDayGoals picks by updatedAt, so an
    // older stamp loses even when it is a clear. (This simulates the old
    // client's *output*, not its code, since only the current validator is
    // under test here.)
    const newerPlan = { targetKcal: 500, baseKcal: 2000, updatedAt: 100, veryLowCalorieAcknowledged: true };
    const oldClientTombstone = { cleared: true, updatedAt: 50 };
    const survivesOldClient = Sync15.mergeDayGoals({ [day]: newerPlan }, { [day]: oldClientTombstone });
    ok(survivesOldClient[day].targetKcal === 500 && !survivesOldClient[day].cleared,
      "a newer 5:2-range plan survives merge against an older client's stale pre-widening tombstone");
    const newerClearStillWins = Sync15.mergeDayGoals({ [day]: newerPlan }, { [day]: { cleared: true, updatedAt: 200 } });
    ok(newerClearStillWins[day].cleared === true,
      "a genuinely newer clear still wins — ordinary LWW, not special-cased for the widened range");

    // declaredAfterDay: modern-branch boolean only; survives normalize + bumps;
    // never a stampMap clock key.
    const lateFast = Sync15.normalizeDayGoal({
      targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true,
      plannedAt: 1, updatedAt: 1, declaredAfterDay: true,
    });
    ok(lateFast && lateFast.declaredAfterDay === true,
      "normalizeDayGoal keeps declaredAfterDay on a modern fast record");
    ok(Sync15.normalizeDayGoal({
      targetKcal: 1500, baseKcal: 2000, updatedAt: 1, declaredAfterDay: true,
    }).declaredAfterDay === undefined,
      "declaredAfterDay never rides on a non-fast (reduced) record");
    const lateSettings = {
      goals: fastSettings.goals, phases: [],
      dayGoals: { "2026-08-01": lateFast },
    };
    const lateBumps = Phases15.dayPlanForDay("2026-08-01", lateSettings, lateSettings.goals);
    ok(lateBumps && lateBumps.declaredAfterDay === true,
      "dayPlanForDay carries declaredAfterDay onto the resolved bump");

    // §10 declaration window.
    ok(Phases15.dayIntentWindow("2026-08-02", { todayKey: "2026-08-01", intent: "reduced" }).ok,
      "reduced: previous day may plan ahead");
    ok(Phases15.dayIntentWindow("2026-08-02", { todayKey: "2026-08-02", intent: "reduced" }).ok,
      "reduced: same day is allowed before the first add");
    ok(!Phases15.dayIntentWindow("2026-08-02", {
      todayKey: "2026-08-02", intent: "reduced", hasEverAdded: true,
    }).ok, "reduced: first food add closes the window");
    ok(!Phases15.dayIntentWindow("2026-08-02", { todayKey: "2026-08-03", intent: "reduced" }).ok,
      "reduced: the day after the target is closed");
    ok(Phases15.dayIntentWindow("2026-08-02", { todayKey: "2026-08-03", intent: "fast" }).ok,
      "fast: grace through the day after is open");
    ok(!Phases15.dayIntentWindow("2026-08-02", { todayKey: "2026-08-04", intent: "fast" }).ok,
      "fast: two days later is refused");
    const endMs = Phases15.endOfLocalDayMs("2026-08-02");
    ok(Phases15.isDeclaredAfterDay("2026-08-02", endMs + 1) === true,
      "isDeclaredAfterDay is true after local midnight of the target day");
    ok(Phases15.dayIntentWindow("2026-08-02", {
      todayKey: "2026-08-03", intent: "fast", plannedAt: endMs + 1,
    }).declaredAfterDay === true,
      "dayIntentWindow stamps declaredAfterDay for a late fast save");

    // Slice 6 §12 — dayPlanPresets LWW by id with deleted tombstones, max 5 active.
    const pA = Sync15.normalizeDayPlanPreset({
      id: "p1", label: "5:2", intent: "reduced", targetKcal: 500,
      veryLowCalorieAcknowledged: true, createdAt: 1, updatedAt: 10,
    });
    const pB = Sync15.normalizeDayPlanPreset({
      id: "p1", label: "5:2 revised", intent: "reduced", targetKcal: 600,
      veryLowCalorieAcknowledged: true, createdAt: 1, updatedAt: 20,
    });
    const pFast = Sync15.normalizeDayPlanPreset({
      id: "p2", label: "Fast", intent: "fast", targetKcal: 0,
      fastAcknowledged: true, createdAt: 1, updatedAt: 5,
    });
    const mergedPresets = Sync15.mergeDayPlanPresets([pA, pFast], [pB]);
    ok(mergedPresets.find((p) => p.id === "p1").targetKcal === 600,
      "dayPlanPresets LWW keeps the newer same-id record");
    ok(mergedPresets.find((p) => p.id === "p2").intent === "fast",
      "dayPlanPresets merge retains a Fast preset from the other side");
    const tombstoned = Sync15.mergeDayPlanPresets(
      [pB, pFast],
      [{ id: "p2", deleted: true, updatedAt: 50, createdAt: 1 }]
    );
    ok(tombstoned.find((p) => p.id === "p2").deleted === true,
      "dayPlanPresets accept a deleted tombstone when it is newer");
    ok(Sync15.activeDayPlanPresets(tombstoned).every((p) => p.id !== "p2"),
      "activeDayPlanPresets excludes tombstones");
    ok(Sync15.normalizeDayPlanPreset({
      id: "bad", intent: "fast", targetKcal: 0, createdAt: 1, updatedAt: 1,
    }) === null, "a Fast preset without fastAcknowledged is rejected");

    // Cap of 5 must be enforced at merge time — two devices at the legal
    // maximum must not brick Drive by throwing on canonicalize.
    const makePreset = (id, updatedAt, lastUsedAt) => Sync15.normalizeDayPlanPreset({
      id, label: id, intent: "reduced", targetKcal: 500,
      veryLowCalorieAcknowledged: true, createdAt: 1, updatedAt, lastUsedAt,
    });
    const sideA = [0, 1, 2, 3, 4].map((i) => makePreset(`dpp_a_${i}`, 10, 10 + i));
    const sideB = [0, 1, 2, 3, 4].map((i) => makePreset(`dpp_b_${i}`, 10, 20 + i));
    const capped = Sync15.mergeDayPlanPresets(sideA, sideB, 100);
    ok(Sync15.activeDayPlanPresets(capped).length === Sync15.DAY_PLAN_PRESET_ACTIVE_CAP,
      "mergeDayPlanPresets enforces the active cap of 5 across two full sides");
    ok(capped.filter((p) => p.deleted).length === 5,
      "cap losers become deleted tombstones so a later merge cannot reinstate them");
    ok(Sync15.activeDayPlanPresets(capped).every((p) => String(p.id).startsWith("dpp_b_")),
      "cap keeps the most recently used presets (side B lastUsedAt dominates)");
    const mergedDoc = Sync15.mergeDocs(
      { version: 3, events: [], personalFoods: [], dayPlanPresets: sideA, dayGoals: {}, dayPlans: {}, gapDrafts: {}, phases: [], weights: {}, profile: null, goals: null, resetAt: 0 },
      { version: 3, events: [], personalFoods: [], dayPlanPresets: sideB, dayGoals: {}, dayPlans: {}, gapDrafts: {}, phases: [], weights: {}, profile: null, goals: null, resetAt: 0 }
    );
    ok(Sync15.activeDayPlanPresets(mergedDoc.doc.dayPlanPresets).length <= Sync15.DAY_PLAN_PRESET_ACTIVE_CAP,
      "mergeDocs itself never emits more than 5 active presets");

    // R1: lastUsedAt must merge as max independently of the updatedAt LWW pick.
    // stableText tie-break is lexical — without the max pass, lastUsedAt:500
    // beats lastUsedAt:1754300000000 and the fresh apply is discarded.
    const usedLocal = Sync15.normalizeDayPlanPreset({
      id: "dpp_used", label: "Used", intent: "reduced", targetKcal: 500,
      veryLowCalorieAcknowledged: true, createdAt: 1, updatedAt: 1000,
      lastUsedAt: 1754300000000,
    });
    const usedRemote = Sync15.normalizeDayPlanPreset({
      id: "dpp_used", label: "Used", intent: "reduced", targetKcal: 500,
      veryLowCalorieAcknowledged: true, createdAt: 1, updatedAt: 1000,
      lastUsedAt: 500,
    });
    const usedMerged = Sync15.mergeDayPlanPresets([usedLocal], [usedRemote]);
    ok(usedMerged.length === 1 && usedMerged[0].lastUsedAt === 1754300000000,
      "mergeDayPlanPresets keeps max(lastUsedAt) across an updatedAt tie");
    const usedFlip = Sync15.mergeDayPlanPresets([usedRemote], [usedLocal]);
    ok(usedFlip[0].lastUsedAt === 1754300000000,
      "max(lastUsedAt) is order-independent");

    // Cap stamps without an explicit `now` are derived from input clocks.
    const run1 = Sync15.mergeDayPlanPresets(sideA, sideB);
    const run2 = Sync15.mergeDayPlanPresets(sideA, sideB);
    ok(JSON.stringify(run1) === JSON.stringify(run2),
      "mergeDayPlanPresets without `now` is a pure function of its inputs");

    // Cap output (actives + tombstones) must be a fixed point under merge and
    // under Sync normalize — the same bytes Drive would re-feed after eviction.
    const cappedRound = Sync15.mergeDayPlanPresets(capped, capped);
    ok(JSON.stringify(cappedRound) === JSON.stringify(capped),
      "re-merging a capped list with tombstones is a fixed point");
    ok(Sync15.normalizeDayPlanPresets(capped).filter((p) => p.deleted).length === 5,
      "normalizeDayPlanPresets keeps cap-loser tombstones (no targetKcal required)");
    ok(capped.filter((p) => p.deleted).every((p) => p.targetKcal == null && p.intent == null),
      "cap-loser tombstones are Sync-shaped (id/deleted/clocks only)");
  }

  console.log("\n[16] Day-intent: goalsForDay's standalone fallback (no Analytics global)");
  {
    // VII.8 fixed this file to load globalThis.Analytics up top so goalsForDay's
    // real retargetForKcal path gets exercised by every other test here — but
    // that means nothing in this file was left exercising the fallback branch
    // itself (phases.js loaded without analytics.js at all). Simulate that by
    // removing the global for the duration of this block only.
    const Phases16 = require("../js/phases.js");
    const savedAnalytics = globalThis.Analytics;
    const hadAnalytics = Object.prototype.hasOwnProperty.call(globalThis, "Analytics");
    delete globalThis.Analytics;
    try {
      const phaseGoals16 = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300, potassium: 3510 };
      const settings16 = {
        goals: phaseGoals16, phases: [],
        dayGoals: { "2026-08-01": { targetKcal: 1500, baseKcal: 2000, updatedAt: 1 } },
      };
      const reduced16 = Phases16.goalsForDay("2026-08-01", settings16);
      ok(reduced16.carbs === phaseGoals16.carbs && reduced16.fat === phaseGoals16.fat,
        "without Analytics, carbs/fat hold at their phase values instead of drifting to an un-retargeted guess");
      ok(reduced16._unscored && reduced16._unscored.carbs === "energy too low to retarget carbs and fat coherently" &&
          reduced16._unscored.fat === "energy too low to retarget carbs and fat coherently",
        "without Analytics, carbs and fat drop out of scoring instead of silently contradicting the day's calorie plan");
    } finally {
      if (hadAnalytics) globalThis.Analytics = savedAnalytics;
      else delete globalThis.Analytics;
    }
    ok(typeof globalThis.Analytics !== "undefined" && typeof globalThis.Analytics.retargetForKcal === "function",
      "the real Analytics global is restored for every test after this block");
  }

  console.log("\n[one-off] Step 0 — implausible entry.per100 must not brick sync (§3.1)");
  {
    // Forces the §3.1 / §5.2 decision: a one-off whose per100 was derived as
    // totals*100/grams from a 1 g fat-finger must either never enter the ledger
    // or round-trip through import normalize. Today Ledger.accepts and import
    // throws on per100.kcal>920 — bricking the next settings save / Drive sync.
    const day = "2026-08-05-once-landmine";
    const macros = { kcal: 700, p: 40, c: 50, f: 30, fb: 5, na: 800, k: 600 };
    const onceLandmine = {
      id: "once-landmine",
      name: "Dinner at Priya's",
      displayQty: "1 g",
      grams: 1,
      qty: 1,
      unit: "g",
      meal: "dinner",
      source: "once",
      foodId: null,
      macros,
      // totals * 100 / grams — the exact derivation a save path would invent.
      per100: {
        kcal: macros.kcal * 100,
        p: macros.p * 100,
        c: macros.c * 100,
        f: macros.f * 100,
        fb: macros.fb * 100,
        na: macros.na * 100,
        k: macros.k * 100,
      },
      sd: 0.2,
    };
    ok(onceLandmine.per100.kcal === 70000,
      "fixture models the §3.1 landmine (700 kcal on 1 g → per100.kcal 70000)");

    let acceptedByLedger = false;
    try {
      Ledger.addEntry(day, onceLandmine);
      acceptedByLedger = Ledger.entriesFor(day).some((e) => e && e.id === "once-landmine");
    } catch (e) {
      acceptedByLedger = false;
    }

    // Same absolute bounds App.normalizeImportedNutrition applies when
    // per100: true (js/app.js normalizeImportedEntry → per100 path).
    let survivesImportNormalize = false;
    try {
      const p = onceLandmine.per100;
      if (!(p && Number.isFinite(p.kcal) && Number.isFinite(p.p) && Number.isFinite(p.c) &&
          Number.isFinite(p.f) && Number.isFinite(p.fb))) {
        throw new Error("per100 incomplete");
      }
      if (p.kcal > 920) throw new Error("per100.kcal is out of range");
      if ((p.p + p.c + p.f) > 105) throw new Error("per100.p+c+f is out of range");
      if (p.na != null && p.na > 40000) throw new Error("per100.na is out of range");
      if (p.k != null && p.k > 60000) throw new Error("per100.k is out of range");
      survivesImportNormalize = true;
    } catch (e) {
      survivesImportNormalize = false;
    }

    ok(!acceptedByLedger || survivesImportNormalize,
      "one-off with implausible per100 never reaches the ledger, or survives import normalize (§3.1 / §5.2)",
      acceptedByLedger
        ? "ledger accepted the landmine; import normalize would throw and brick sync"
        : "ledger rejected (ok) but import normalize also refused — unexpected");
  }

  console.log("\n[one-off] F1 — amendEntry per100 guard merges live source by id");
  {
    const day = "2026-08-05-once-amend-guard";
    const base = Foods.entryFromOnceDraft({
      name: "Dinner at Priya's",
      macros: { kcal: 700, p: 40, c: 50, f: 30, fb: 5, na: null, k: null },
      confidence: "estimated",
      macrosOpened: true,
    }, 1, "portion", "dinner");
    base.id = "once-x";
    Ledger.addEntry(day, base);
    const before = Ledger.entriesFor(day).find((e) => e.id === "once-x");
    ok(before && before.source === "once" && !Object.prototype.hasOwnProperty.call(before, "per100"),
      "F1 fixture: live one-off has source once and no per100 key");

    let threw = false;
    let code = "";
    try {
      // Patch carries per100 and deliberately omits source — the old findEntry
      // path always saw live=null and let this write through.
      Ledger.amendEntry(day, "once-x", {
        per100: { kcal: 70000, p: 1, c: 1, f: 1, fb: 1 },
      }, "sneak");
    } catch (e) {
      threw = true;
      code = e && e.code;
    }
    ok(threw && code === "ledger-once-per100",
      "amendEntry rejects per100 on a live one-off even when the patch omits source",
      `threw=${threw} code=${code}`);

    const after = Ledger.entriesFor(day).find((e) => e.id === "once-x");
    ok(after && after.source === "once" && after.macros.kcal === 700 &&
        !Object.prototype.hasOwnProperty.call(after, "per100"),
      "rejected amend leaves the one-off unchanged (still no per100)");
  }

  console.log("\n[one-off] Step 1 — entryFromOnceDraft + provenance");
  {
    const expectedKeys = [
      "name", "foodId", "cat", "grams", "displayQty", "qty", "unit",
      "macros", "sd", "meal", "source",
    ].sort();
    const once = Foods.entryFromOnceDraft({
      name: "Pad thai",
      macros: { kcal: 700, p: 30, c: 80, f: 25, fb: 4, na: null, k: null },
      confidence: "estimated",
      macrosOpened: true,
    }, 1, "portion", "dinner");
    ok(JSON.stringify(Object.keys(once).sort()) === JSON.stringify(expectedKeys),
      "entryFromOnceDraft returns the full one-off key set (no per100)",
      Object.keys(once).sort().join(","));
    ok(!Object.prototype.hasOwnProperty.call(once, "per100") && once.source === "once" && once.foodId === null,
      "one-off has source once, foodId null, and no per100 key");
    ok(once.macros.na === null && once.macros.k === null,
      "blank sodium/potassium stay null (unknown), never coerced to 0");
    ok(once.grams === 0 && once.unit === "portion" && once.displayQty === "1 portion",
      "unknown portion uses grams:0 and displayQty '1 portion'");
    ok(FoodMatch.plausibility(once).length === 0,
      "grams:0 portion one-off is clean under FoodMatch.plausibility");

    const weighed = Foods.entryFromOnceDraft({
      name: "Yogurt cup", macros: { kcal: 150, p: 15, c: 10, f: 2, fb: 0, na: 50, k: 200 },
      confidence: "weighed", macrosOpened: true,
    }, 170, "g", "snack");
    ok(weighed.sd === 0.10, "weighed/label chip writes sd 0.10");
    const rough = Foods.entryFromOnceDraft({
      name: "Guess dinner", macros: { kcal: 800, p: 40, c: 70, f: 35, fb: 8 },
      confidence: "rough", macrosOpened: true,
    }, 1, "portion");
    ok(rough.sd === 0.40, "rough-guess chip writes sd 0.40");
    const estimated = Foods.entryFromOnceDraft({
      name: "Normal plate", macros: { kcal: 600, p: 35, c: 50, f: 20, fb: 5 },
      confidence: "estimated", macrosOpened: true,
    }, 1, "portion");
    ok(estimated.sd === 0.25, "estimated chip writes sd 0.25");
    const kcalOnly = Foods.entryFromOnceDraft({
      name: "Kcal only", macros: { kcal: 500 },
      confidence: "weighed", macrosOpened: false,
    }, 1, "portion");
    ok(kcalOnly.sd === 0.40, "kcal-only (macros never opened) forces sd 0.40 even if weighed chip");
    const lowFloor = Foods.entryFromOnceDraft({
      name: "Soft", macros: { kcal: 400 },
      confidence: "estimated", macrosOpened: true,
    }, 1, "portion");
    ok(lowFloor.sd >= 0.20, "non-weighed confidence never writes sd below 0.20");

    const day = "2026-08-06-once";
    const a = Foods.entryFromOnceDraft({
      name: "A", macros: { kcal: 500, p: 20, c: 40, f: 20, fb: 2, na: null, k: null },
      confidence: "estimated", macrosOpened: true,
    }, 1, "portion");
    const b = Foods.entryFromOnceDraft({
      name: "B", macros: { kcal: 500, p: 20, c: 40, f: 20, fb: 2, na: null, k: null },
      confidence: "estimated", macrosOpened: true,
    }, 1, "portion");
    a.id = "once-a"; b.id = "once-b";
    Ledger.addEntry(day, a);
    Ledger.addEntry(day, b);
    const onceTotals = Ledger.totalsOf(Ledger.entriesFor(day));
    const libDay = "2026-08-06-lib";
    const chicken = FOOD_DB.find((f) => f.id === "chicken-breast");
    const libEntry = Foods.entryFromQty(chicken, 180, "g", "dinner");
    libEntry.id = "lib-a";
    const libEntry2 = Foods.entryFromQty(chicken, 180, "g", "dinner");
    libEntry2.id = "lib-b";
    Ledger.addEntry(libDay, libEntry);
    Ledger.addEntry(libDay, libEntry2);
    const libTotals = Ledger.totalsOf(Ledger.entriesFor(libDay));
    ok(Number.isFinite(onceTotals.kcal.sd) && Number.isFinite(libTotals.kcal.sd) &&
        onceTotals.kcal.sd > libTotals.kcal.sd,
      "two one-offs widen kcal σ versus the same macros logged as library foods",
      `once σ=${onceTotals.kcal.sd} lib σ=${libTotals.kcal.sd}`);

    const prov = Foods.entryProvenance(once);
    ok(prov.label === "One-off · your estimate" && /Not saved to My Foods/i.test(prov.detail || ""),
      "entryProvenance names a one-off as not saved to My Foods");

    // Import-shaped: without per100, macros alone are accepted by the
    // non-per100 normalizeImportedNutrition path (kcal may exceed 920 as
    // absolute portion totals). Proven by ledger accept + round-trip key check.
    const logged = Ledger.entriesFor(day).find((e) => e.id === "once-a");
    ok(logged && logged.source === "once" && !Object.prototype.hasOwnProperty.call(logged, "per100"),
      "ledger round-trip keeps source once and still has no per100 key");
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  fail += 1;
  console.error("  ✗ async sync regression crashed — " + (err && err.stack || err));
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
});
