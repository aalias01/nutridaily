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
  ok(!p.food.units.serving, "batch servings do not invent units.serving", `got ${p.food.units.serving}`);
  ok(!p.food.units.piece, "skillet has no piece without Log as: piece");
  ok(p.food.logAs === "grams", "default logAs is grams", `got ${p.food.logAs}`);
  ok(p.food.batch && p.food.batch.grams === 760, "batch grams");
  ok(p.food.recipe.ingredients.length >= 2, "ingredients");
  ok(p.food.sd === 0.05, "sd high+weighed", `got ${p.food.sd}`);
  ok(p.food.derivedFromTotals, "derived from totals");
}

console.log("\n[parse] piece + log as (countable food)");
{
  const text = `NUTRI v1
Name: Roti Fresh Original Chapati
Aliases: chapati, roti
Category: grain
Batch: 567 g total, 10 servings
Totals: 1600 kcal | P 40 | C 250 | F 50 | Fiber 20 | Sodium 2000
Per 100 g: 282 kcal | P 7.1 | C 44.1 | F 8.8 | Fiber 3.5 | Sodium 353
Piece: 57
Log as: piece
Count as: chapati
Confidence: high
END`;
  const p = NutriParse.parse(text).results[0];
  ok(p.canSave, "chapati can save", (p.rejects || []).join("; "));
  ok(p.food.units.piece === 57, "piece grams parsed", `got ${p.food.units.piece}`);
  ok(!p.food.units.serving, "piece does not invent serving", `got ${p.food.units.serving}`);
  ok(p.food.logAs === "piece", "logAs piece persisted");
  ok(p.food.countLabel === "chapati", "countLabel persisted", `got ${p.food.countLabel}`);
  const saved = Foods.createFromDraft({ ...p.food, raw: text });
  ok(saved.logAs === "piece" && saved.countLabel === "chapati", "createFromDraft keeps logAs/countLabel");
  const entry = Foods.entryFromQty(saved, 2, "piece", "breakfast");
  approx(entry.grams, 114, 0.1, "2 pieces → 114 g");
  ok(/2 chapatis/.test(entry.displayQty), "display uses chapati count", entry.displayQty);
  ok(FoodMatch.prefersPieceLog(saved), "prefers piece log");
  ok(!FoodMatch.prefersPieceLog(NutriParse.parse(SHRIMP).results[0].food), "skillet prefers grams");
}

console.log("\n[parse] log as piece infers piece from batch count");
{
  const text = `NUTRI v1
Name: Store egg
Category: protein
Batch: 500 g total, 10 servings
Totals: 740 kcal | P 62.5 | C 5 | F 50 | Fiber 0 | Sodium 710
Log as: piece
Confidence: medium
END`;
  const p = NutriParse.parse(text).results[0];
  ok(!p.food.units.serving, "no serving from batch alone");
  ok(p.food.units.piece === 50, "piece inferred from batch÷count when Log as: piece", `got ${p.food.units.piece}`);
  ok(p.food.countLabel === "egg", "countLabel inferred from name", `got ${p.food.countLabel}`);
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

console.log("\n[provenance]");
{
  const chicken = FOOD_DB.find((f) => f.id === "chicken-breast");
  const ref = Foods.fromCatalog(chicken);
  ok(Foods.provenance(ref).kind === "ref", "catalog copy → Reference");
  const edited = Foods.applyUpdate(ref, { ...ref, per100: { ...ref.per100, p: 40 } });
  ok(Foods.provenance(edited).kind === "edit", "edited catalog → Yours · edited");
  const ai = Foods.createFromDraft({
    name: "test stew",
    per100: { kcal: 100, p: 5, c: 10, f: 3, fb: 1, na: 100 },
    units: {},
    raw: "NUTRI v1\nEND",
  });
  ok(Foods.provenance(ai).kind === "ai", "paste with raw → AI estimate");
}

console.log("\n[parse] catalog refine prompt");
{
  globalThis.Foods = Foods;
  const almonds = FOOD_DB.find((f) => f.id === "almonds");
  const food = Foods.fromCatalog(almonds);
  const text = NutriParse.foodUpdatePrompt(food);
  ok(/NUTRI v1/.test(text), "refine prompt asks for NUTRI v1");
  ok(/almonds/i.test(text), "refine prompt includes food name");
  ok(/USDA|reference catalog/i.test(text), "refine prompt marks reference source");
  ok(/579/.test(text) || /Per 100 g/.test(text), "refine prompt includes current per100");
  const withRaw = { ...food, raw: "NUTRI v1\nName: almonds\nEND" };
  ok(NutriParse.foodUpdatePrompt(withRaw).includes("current saved version"), "uses updatePrompt when raw exists");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
