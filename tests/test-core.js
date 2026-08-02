/* NutriDaily core tests — run with: node tests/test-core.js
 * Covers the deterministic layer: food resolution, unit math, macro math,
 * uncertainty propagation, event-sourced ledger reduction, verifier rules.
 */
globalThis.FOOD_DB = require("../js/data-foods.js");
const FoodMatch = require("../js/foodmatch.js");
globalThis.FoodMatch = FoodMatch;
const Foods = require("../js/foods.js");
const Ledger = require("../js/ledger.js");

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
  Ledger.amendEntry(day, target.id, { grams: 200, displayQty: "200 g", macros: FoodMatch.computeMacros(chicken.per100, 200), sd: 0.08 }, "180 g → 200 g");
  t = Ledger.totalsFor(day);
  ok(t.kcal.mean === 435, "amend recomputes totals (330+105)", `got ${t.kcal.mean}`);
  entries = Ledger.entriesFor(day);
  ok(entries.find((e) => e.name === "chicken breast").history.length === 1, "correction history is preserved");

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

  Phases.appendRevision(settings, { ...settings.goals, kcal: 2800, protein: 160 }, "2026-08-01");
  ok(Phases.goalsForDay("2026-07-15", settings).kcal === 2200, "past day unchanged after revision");
  ok(Phases.goalsForDay("2026-08-01", settings).kcal === 2800, "today uses new revision");
  ok(settings.phases[0].revisions.length === 2, "append adds a revision");
  ok(settings.phases[0].name === "Maintain v2.0", "kcal +600 bumps major to Maintain v2.0");

  // same-day second save should replace latest same-day row and bump again
  Phases.appendRevision(settings, { ...settings.goals, kcal: 2850, protein: 160 }, "2026-08-01");
  ok(settings.phases[0].revisions.length === 2, "same-day re-save replaces instead of stacking");
  ok(Phases.goalsForDay("2026-08-01", settings).kcal === 2850, "same-day re-save keeps latest numbers");
  ok(settings.phases[0].name === "Maintain v2.1", "small same-day tweak bumps minor");

  settings.dayGoals["2026-08-01"] = { bumps: { kcal: 200, protein: 20 }, updatedAt: 200 };
  ok(Phases.goalsForDay("2026-08-01", settings).kcal === 3050, "day bump adds to phase kcal (2850+200)");
  ok(Phases.goalsForDay("2026-08-01", settings).protein === 180, "day bump adds to phase protein (160+20)");
  ok(Phases.goalsForDay("2026-08-01", settings)._bumps.kcal === 200, "resolved goals expose _bumps");

  settings.dayGoals["2026-08-02"] = { kcal: 3050, updatedAt: 210 }; // legacy absolute
  // phase for 08-02 still 2850/160 from revision
  ok(Phases.goalsForDay("2026-08-02", settings).kcal === 3050, "legacy absolute dayGoals still resolve");
  ok(Phases.goalsForDay("2026-08-02", settings)._bumps.kcal === 200, "legacy absolute converts to bump vs phase");

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

  Phases.appendRevision(settings, { ...Phases.activePhase(settings.phases).revisions[0].goals, kcal: 3500 }, "2026-08-15", "", { kind: "bulk" });
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

  const scored = Phases.scoreDayTotals(
    { count: 1, kcal: { mean: 2200 }, p: { mean: 100 }, c: { mean: 250 }, f: { mean: 70 }, fb: { mean: 28 }, na: { mean: 2000 } },
    { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300 }
  );
  ok(scored.kcal.status === "hit", "kcal within ±10% is hit");
  ok(scored.protein.status === "under", "protein below floor is under");

  const merged = Phases.mergePhases(
    [{ id: "ph1", updatedAt: 100, startDay: "2026-01-01", endDay: null, revisions: [{ id: "r1", effectiveFrom: "2026-01-01", goals: { kcal: 2000 } }] }],
    [{ id: "ph1", updatedAt: 200, startDay: "2026-01-01", endDay: null, revisions: [{ id: "r1", effectiveFrom: "2026-01-01", goals: { kcal: 2000 } }, { id: "r2", effectiveFrom: "2026-03-01", goals: { kcal: 2500 } }] }]
  );
  ok(merged[0].revisions.length === 2, "mergePhases unions revisions by id");

  const fp1 = require("../js/sync.js").fingerprint({
    resetAt: 0, events: [], personalFoods: [], dayGoals: {}, phases: settings.phases, weights: {}, goals: settings.goals,
  });
  settings.phases[1].updatedAt = Date.now() + 1;
  const fp2 = require("../js/sync.js").fingerprint({
    resetAt: 0, events: [], personalFoods: [], dayGoals: {}, phases: settings.phases, weights: {}, goals: settings.goals,
  });
  ok(fp1 !== fp2, "fingerprint changes when a phase updates");
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

  const dgA = { "2026-08-01": { kcal: 2800, updatedAt: 100 } };
  const dgB = { "2026-08-01": { kcal: 3000, updatedAt: 200 }, "2026-08-02": { protein: 180, updatedAt: 50 } };
  const dg = Sync.mergeDayGoals(dgA, dgB);
  ok(dg["2026-08-01"].kcal === 3000, "dayGoals: newer override wins");
  ok(dg["2026-08-02"].protein === 180, "dayGoals: unique days union");

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
  ok(mergedPh.doc.version === 2, "doc version is 2");
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
  const prompt = PhasePrompt.buildTargetPrompt({
    kind: "recomp",
    age: 36,
    weightKg: 80,
    profile: { sex: "male", heightCm: 175, activity: "moderate", notes: "" },
  });
  ok(/Kind: recomp/.test(prompt) || /Recomp/.test(prompt), "prompt includes recomp goal");
  ok(/not medical advice/i.test(prompt), "prompt includes medical disclaimer");
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
  const parsed = PhasePrompt.parsePhaseBlock(block);
  ok(parsed.ok, "parses PHASE block");
  ok(parsed.kind === "recomp", "parsed kind is recomp");
  ok(parsed.options.length === 3, "three options parsed");
  ok(parsed.options[1].goals.kcal === 2200 && parsed.options[1].label === "Balanced", "option 2 macros and label");
  ok(!PhasePrompt.parsePhaseBlock("hello").ok, "rejects non-PHASE text");
}

console.log("\n[11] GAP AI close-the-gap prompt parse");
{
  globalThis.FoodMatch = require("../js/foodmatch.js");
  const GapPrompt = require("../js/gap-prompt.js");
  const NutriParse = require("../js/parse.js");
  const Sync = require("../js/sync.js");

  const candidates = [
    {
      id: "pf-rice",
      name: "rice (cooked)",
      per100: { kcal: 130, p: 2.7, c: 28, f: 0.3, fb: 0.4, na: 1 },
      portion: { n: 8, median: 120, p25: 100, p75: 140, last: 110 },
      pieceGrams: null,
    },
    {
      id: "pf-chicken",
      name: "chicken breast (cooked)",
      per100: { kcal: 165, p: 31, c: 0, f: 3.6, fb: 0, na: 74 },
      portion: { n: 5, median: 150, p25: 120, p75: 180, last: 160 },
      pieceGrams: null,
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
  ok(/not medical advice/i.test(prompt), "prompt includes medical disclaimer");
  ok(/rice \(cooked\)/.test(prompt) && /preferred 100–140 g/.test(prompt), "prompt includes candidate portion band");
  ok(/banana/.test(prompt) && /Totals so far/.test(prompt), "prompt includes logged foods and totals");
  ok(/Remaining/.test(prompt), "prompt includes remaining macros");

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
  ok(parsed.reachable === false, "Reachable: no preserved");
  ok(/Protein still short/.test(parsed.note || ""), "note preserved");
  ok(parsed.items.length === 2, "only candidate foods kept");
  ok(parsed.items[0].name === "rice (cooked)" && parsed.items[0].grams === 130, "rice qty parsed");
  ok(parsed.items[1].meal === "dinner" && parsed.items[1].foodId === "pf-chicken", "chicken matched to candidate id");
  ok((parsed.warnings || []).some((w) => /mystery smoothie/i.test(w)), "unknown food dropped with warning");
  ok(parsed.projected && parsed.projected.kcal === 900 && parsed.projected.protein === 60, "projected macros parsed");
  ok(!GapPrompt.parseGapBlock("hello").ok, "rejects non-GAP text");

  const reachAnno = `GAP v1
Day: 2026-08-02
Reachable: no — protein still short
Note: try again
Item: rice (cooked) | 120 g | dinner
END`;
  ok(GapPrompt.parseGapBlock(reachAnno, candidates, scorer).reachable === false, "Reachable: no with annotation");

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
  ok(last.reachable === true && /final/.test(last.note || ""), "last block reachable/note win");

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
  ok(nutri.found && nutri.results.length >= 1, "dual paste: NUTRI block found");
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
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
