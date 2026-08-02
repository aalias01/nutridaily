/* NutriChat core tests — run with: node tests/test-core.js
 * Covers the deterministic layer: food resolution, unit math, macro math,
 * uncertainty propagation, event-sourced ledger reduction, verifier rules.
 */
globalThis.FOOD_DB = require("../js/data-foods.js");
const FoodMatch = require("../js/foodmatch.js");
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
  ok(r5 === null, "unknown food returns null (use ChatGPT paste / catalog)");

  // personal foods outrank the curated DB on ties
  const personal = [{ id: "pf-1", name: "dal", aliases: ["dal", "my dal"], per100: { kcal: 150, p: 8, c: 18, f: 5, fb: 6, na: 300 }, units: { serving: 250 }, cat: "dish" }];
  const r6 = FoodMatch.resolve("dal", personal);
  ok(r6 && r6.source === "personal", "personal 'dal' beats curated 'dal'");
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

console.log("\n[6] Display formatting");
{
  ok(FoodMatch.displayQty(2, "pieces", 120) === "2 pieces (120 g)", "household qty shows grams too");
  ok(FoodMatch.displayQty(180, "g", 180) === "180 g", "gram qty shown plainly");
}

console.log("\n[7] Cloud sync merge (conflict-free by construction)");
{
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
}

console.log("\n[8] Recipe sharing (untrusted input validation)");
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
  ok(r.food.source === "shared", "provenance is marked");

  ok(Share.unpack("NCR1.deadbeef").ok === false, "corrupted payload is rejected");
  ok(Share.unpack("hello there").ok === false, "non-code text is rejected");

  // tampered nutrition gets bounds-checked
  const evil1 = Share.pack({ name: "magic bar", per100: { kcal: 5000, p: 1, c: 1, f: 1, fb: 0, na: 0 }, units: { serving: 50 } });
  ok(Share.unpack(evil1).ok === false, "impossible kcal density (>9.2 kcal/g) rejected");
  const evil2 = Share.pack({ name: "quantum food", per100: { kcal: 400, p: 60, c: 60, f: 60, fb: 0, na: 0 }, units: { serving: 50 } });
  ok(Share.unpack(evil2).ok === false, "macros >100 g per 100 g rejected");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
