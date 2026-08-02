/* NUTRI v1 parser tests — run: node tests/test-parse.js */
const NutriParse = require("../js/parse.js");
const Foods = require("../js/foods.js");
globalThis.FOOD_DB = require("../js/data-foods.js");
const FoodMatch = require("../js/foodmatch.js");
globalThis.FoodMatch = FoodMatch;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function approx(a, b, tol, name) { ok(Math.abs(a - b) <= (tol || 0.6), name, `got ${a}, want ~${b}`); }

const SHRIMP = `
Sure! Here's the breakdown:

\`\`\`
NUTRI v1
Name: Garlic shrimp skillet
Aliases: garlic shrimp, shrimp skillet
Category: dish
Batch: 760 g total, 4 servings
Totals: 1153 kcal | P 139.2 | C 15.6 | F 56.4 | Fiber 1.2 | Sodium 2555
Per 100 g: 151.7 kcal | P 18.3 | C 2.1 | F 7.4 | Fiber 0.2 | Sodium 336
Ingredients:
- shrimp, raw, peeled and deveined - 680 g
- olive oil - 30 g (2 tbsp)
- butter - 28 g (2 tbsp)
Prep: Seared in olive oil over high heat.
Notes: USDA values for raw shrimp.
Confidence: high
END
\`\`\`

Let me know if you need anything else!
`;

console.log("\n[parse] shrimp skillet happy path");
{
  const r = NutriParse.parse(SHRIMP);
  ok(r.found && r.results.length === 1, "finds one block");
  const p = r.results[0];
  ok(p.canSave, "can save", (p.rejects || []).join("; "));
  ok(p.food.name === "Garlic shrimp skillet", "name");
  approx(p.food.per100.kcal, 151.7, 0.2, "per100 kcal from totals");
  approx(p.food.per100.p, 18.3, 0.2, "per100 protein");
  ok(p.food.units.serving === 190, "serving = 760/4", `got ${p.food.units.serving}`);
  ok(p.food.batch && p.food.batch.grams === 760, "batch grams");
  ok(p.food.recipe.ingredients.length >= 2, "ingredients");
  ok(p.food.sd === 0.05, "sd high+weighed", `got ${p.food.sd}`);
  ok(p.food.derivedFromTotals, "derived from totals");
}

console.log("\n[parse] no sentinel");
{
  const r = NutriParse.parse("chicken 200g protein 40");
  ok(!r.found, "not found");
}

console.log("\n[parse] totals only (no per 100 line)");
{
  const text = `NUTRI v1
Name: Simple rice
Batch: 200 g total, 1 servings
Totals: 260 kcal | P 5.4 | C 56 | F 0.6 | Fiber 0.8 | Sodium 2
END`;
  const p = NutriParse.parse(text).results[0];
  ok(p.canSave, "can save without Per 100 g");
  approx(p.food.per100.kcal, 130, 0.5, "derived 130 kcal/100g");
}

console.log("\n[parse] reject impossible macros");
{
  const text = `NUTRI v1
Name: Bad
Per 100 g: 100 kcal | P 50 | C 50 | F 50 | Fiber 0 | Sodium 0
END`;
  const p = NutriParse.parse(text).results[0];
  ok(!p.canSave, "rejects p+c+f > 105");
}

console.log("\n[foods] create + log qty");
{
  const draft = NutriParse.parse(SHRIMP).results[0].food;
  draft.raw = SHRIMP;
  const food = Foods.createFromDraft(draft);
  ok(food.id.startsWith("pf-"), "id");
  const entry = Foods.entryFromQty(food, 240, "g", "dinner");
  approx(entry.macros.kcal, 364, 2, "240 g → ~364 kcal");
  approx(entry.grams, 240, 0.1, "grams");
  const batchEntry = Foods.entryFromQty(food, 1, "batch", "dinner");
  approx(batchEntry.grams, 760, 0.1, "1 batch → 760 g");
  const updated = Foods.applyUpdate(food, { ...draft, per100: { ...draft.per100, p: 20 } });
  ok(updated.version === 2, "version bump");
  ok(updated.history.length === 1, "history snapshot");
  ok(updated.id === food.id, "same id");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
