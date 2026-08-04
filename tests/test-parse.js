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
  const pieceFood = {
    ...food,
    logAs: "piece",
    units: { ...(food.units || {}), piece: 28 },
    countLabel: "almond",
    raw: "",
  };
  ok(/Log as|Piece/i.test(NutriParse.foodUpdatePrompt(pieceFood)), "refine prompt carries countable units");
  ok(!NutriParse.foodUpdatePrompt({ ...food, raw: "" }).includes("current saved version"), "empty raw falls back to field-based refine");

  // Polluted raw: GAP day-plan + sibling NUTRI blocks must not poison Improve with AI
  const polluted = `GAP v1
Day: 2026-08-02
Option: 1 | All selected
Item: almonds | 15 g | snack
Item: raisins | 80 g | snack
Projected: 2583 kcal | P 150.9 | C 319.7 | F 88.7 | Fiber 47.6 | Sodium 2756 mg
END

NUTRI v1
Name: almonds
Aliases: raw almonds
Category: nuts
Batch: 100 g total, 1 servings
Totals: 579 kcal | P 21.2 | C 21.6 | F 49.9 | Fiber 12.5 | Sodium 1
Per 100 g: 579 kcal | P 21.2 | C 21.6 | F 49.9 | Fiber 12.5 | Sodium 1
Confidence: high
END

NUTRI v1
Name: raisins
Aliases: seedless raisins
Category: fruit
Batch: 100 g total, 1 servings
Totals: 299 kcal | P 3.1 | C 79.2 | F 0.5 | Fiber 3.7 | Sodium 11
Per 100 g: 299 kcal | P 3.1 | C 79.2 | F 0.5 | Fiber 3.7 | Sodium 11
Confidence: high
END`;
  const pollutedPrompt = NutriParse.foodUpdatePrompt({ ...food, name: "almonds", raw: polluted });
  ok(pollutedPrompt.includes("current saved version"), "polluted raw still uses update path");
  ok(/Name:\s*almonds/i.test(pollutedPrompt), "polluted raw keeps matching almond block");
  ok(!/GAP v1/i.test(pollutedPrompt), "polluted raw drops GAP day-plan from refine prompt");
  ok(!/Name:\s*raisins/i.test(pollutedPrompt), "polluted raw drops sibling NUTRI blocks");
  ok(!/Option:\s*1/i.test(pollutedPrompt), "polluted raw drops GAP option lines");

  const gapOnly = NutriParse.foodUpdatePrompt({
    ...food,
    name: "almonds",
    raw: "GAP v1\nDay: 2026-08-02\nOption: 1 | junk\nEND",
  });
  ok(!/GAP v1/i.test(gapOnly), "GAP-only raw falls back instead of echoing GAP");
  ok(/Current saved values/i.test(gapOnly), "GAP-only raw uses field-based refine");
  ok(NutriParse.sanitizeFoodRaw(polluted, "raisins").includes("Name: raisins"), "sanitize picks named sibling block");
  ok(!NutriParse.sanitizeFoodRaw(polluted, "raisins").includes("GAP v1"), "sanitize strips GAP from named block");
}

console.log("\n[parse] stored raw is single block");
{
  const multi = `prompt echo junk
NUTRI v1
Name: First
Per 100 g: 100 kcal | P 1 | C 2 | F 3 | Fiber 0 | Sodium 0
Confidence: high
END

NUTRI v1
Name: Second
Per 100 g: 200 kcal | P 4 | C 5 | F 6 | Fiber 1 | Sodium 10
Confidence: high
END`;
  const multiParsed = NutriParse.parse(multi);
  ok(multiParsed.results.length === 2, "multi paste yields two results");
  ok(/^NUTRI v1/i.test(multiParsed.results[0].raw.trim()), "result.raw starts at NUTRI");
  ok(!multiParsed.results[1].raw.includes("Name: First"), "second result.raw excludes first block");
  ok(multiParsed.results[1].raw.includes("Name: Second"), "second result.raw is its own block");
  ok(!multiParsed.results[1].raw.includes("prompt echo"), "result.raw excludes clipboard preamble");
}

console.log("\n[parse] robustness regressions");
{
  // Partial Totals must not wipe Per 100 g macros
  const partialTotals = `NUTRI v1
Name: Partial totals bowl
Batch: 400 g total, 2 servings
Totals: 800 kcal
Per 100 g: 200 kcal | P 10 | C 15 | F 7.5 | Fiber 1.2 | Sodium 150
Confidence: medium
END`;
  const pt = NutriParse.parse(partialTotals).results[0];
  ok(pt.canSave, "partial totals can save");
  approx(pt.food.per100.p, 10, 0.2, "kept protein from Per 100 g when Totals omitted it");
  ok((pt.warnings || []).some((w) => /incomplete|Per 100 g/i.test(w)), "warns about incomplete Totals merge");

  // Missing required macro is not savable
  const noProtein = `NUTRI v1
Name: No protein
Per 100 g: 250 kcal | C 30 | F 10 | Fiber 2 | Sodium 100
END`;
  const np = NutriParse.parse(noProtein).results[0];
  ok(!np.canSave, "rejects missing protein");
  ok((np.rejects || []).some((r) => /protein missing/i.test(r)), "reject names missing protein");

  // Prompt echo: prefer last complete savable block
  const echo = NutriParse.PROMPT + `
NUTRI v1
Name: Real dish
Batch: 200 g total, 1 servings
Totals: 260 kcal | P 5.4 | C 56 | F 0.6 | Fiber 0.8 | Sodium 2
Per 100 g: 130 kcal | P 2.7 | C 28 | F 0.3 | Fiber 0.4 | Sodium 1
Confidence: high
END`;
  const er = NutriParse.parse(echo);
  ok(er.results.length >= 2, "prompt echo yields multiple blocks");
  const lastSave = [...er.results].reverse().find((r) => r.canSave);
  ok(lastSave && lastSave.food.name === "Real dish", "last savable block is the reply");

  // Draft without END must not merge into next block
  const draftLeak = `NUTRI v1
Name: Draft chapati
Piece: 57
Log as: piece

NUTRI v1
Name: Chapati corrected
Batch: 567 g total, 10 servings
Totals: 1600 kcal | P 40 | C 250 | F 50 | Fiber 20 | Sodium 2000
Per 100 g: 282 kcal | P 7.1 | C 44.1 | F 8.8 | Fiber 3.5 | Sodium 353
Log as: grams
Confidence: high
END`;
  const dl = NutriParse.parse(draftLeak);
  ok(dl.results.length === 2, "draft without END is a separate truncated block");
  const corrected = dl.results[1];
  ok(corrected.food.name === "Chapati corrected", "second block is corrected name");
  ok(corrected.food.logAs === "grams", "corrected logAs is grams");
  ok(!corrected.food.units.piece, "Piece from draft does not leak into corrected block");

  // ~ batch weight is estimated
  const tilde = `NUTRI v1
Name: Estimated stew
Batch: ~760 g total, 4 servings
Totals: 1153 kcal | P 139.2 | C 15.6 | F 56.4 | Fiber 1.2 | Sodium 2555
Per 100 g: 151.7 kcal | P 18.3 | C 2.1 | F 7.4 | Fiber 0.2 | Sodium 336
Confidence: high
END`;
  const td = NutriParse.parse(tilde).results[0];
  ok(td.food.batch && td.food.batch.weighed === false, "~ batch marks weighed false");
  ok(td.food.sd >= 0.1, "estimated batch does not get high weighed sd");

  // Tilde on macros must still parse (not become "approx 139")
  const tildeMacros = `NUTRI v1
Name: Approx macros
Batch: 400 g total, 2 servings
Totals: ~800 kcal | P ~40 | C ~60 | F ~20 | Fiber ~4 | Sodium ~200
Per 100 g: ~200 kcal | P ~10 | C ~15 | F ~5 | Fiber ~1 | Sodium ~50
Confidence: medium
END`;
  const tm = NutriParse.parse(tildeMacros).results[0];
  ok(tm.canSave, "tilde-marked macros still savable");
  approx(tm.food.per100.p, 10, 0.2, "P ~40 survives preprocess");

  // "N g each" must not become servings via pack-count fallback
  const eachLine = `NUTRI v1
Name: Each line pack
Batch: 567 g total, 56.7 g each
Totals: 1600 kcal | P 40 | C 250 | F 50 | Fiber 20 | Sodium 2000
Log as: piece
Confidence: high
END`;
  const el = NutriParse.parse(eachLine).results[0];
  ok(el.food.batch && el.food.batch.grams === 567, "g each does not inflate batch grams");
  ok(el.food.units.piece == null || el.food.units.piece !== 5, "g each does not invent tiny piece size");

  // Log as: pieces (plural)
  const pieces = `NUTRI v1
Name: Store egg
Category: protein
Batch: 500 g total, 10 servings
Totals: 740 kcal | P 62.5 | C 5 | F 50 | Fiber 0 | Sodium 710
Log as: pieces
Confidence: medium
END`;
  const pc = NutriParse.parse(pieces).results[0];
  ok(pc.food.logAs === "piece", "Log as: pieces → piece");
  ok(pc.food.units.piece === 50, "piece inferred for plural log as");

  // Pack count noun
  const pack = `NUTRI v1
Name: Pack chapati
Batch: 567 g total, 10 chapatis
Totals: 1600 kcal | P 40 | C 250 | F 50 | Fiber 20 | Sodium 2000
Log as: piece
Confidence: high
END`;
  const pk = NutriParse.parse(pack).results[0];
  ok(pk.food.units.piece === 57, "pack count noun yields piece grams", `got ${pk.food.units.piece}`);

  // END. trailing punctuation
  const endDot = `NUTRI v1
Name: Dot end
Per 100 g: 100 kcal | P 5 | C 10 | F 3 | Fiber 1 | Sodium 50
END.`;
  const ed = NutriParse.parse(endDot).results[0];
  ok(ed.canSave && !ed.truncated, "END. is accepted as terminator");
}

console.log("\n[parse] nullable sodium and nutrient plausibility");
{
  const missingNa = `NUTRI v1
Name: Unsalted unknown
Per 100 g: 100 kcal | P 5 | C 10 | F 3 | Fiber 1 | Potassium 400
END`;
  const parsed = NutriParse.parse(missingNa).results[0];
  ok(parsed.canSave, "food can save when sodium is genuinely unknown");
  ok(parsed.food.per100.na === null, "missing sodium remains null rather than becoming zero");
  ok((parsed.warnings || []).some((w) => /Sodium not given|left blank/i.test(w)), "missing sodium is explained to the user");

  const explicitZero = NutriParse.parse(`NUTRI v1
Name: Known zero sodium
Per 100 g: 100 kcal | P 5 | C 10 | F 3 | Fiber 1 | Sodium 0 | Potassium 400
END`).results[0];
  ok(explicitZero.food.per100.na === 0, "an explicit sodium zero remains a known zero");

  const unknownEntry = FoodMatch.computeMacros({ kcal: 100, p: 5, c: 10, f: 3, fb: 1, k: 400 }, 100);
  ok(unknownEntry.na === null, "unknown sodium propagates into ledger entry macros");
  const zeroEntry = FoodMatch.computeMacros({ kcal: 100, p: 5, c: 10, f: 3, fb: 1, na: 0, k: 400 }, 100);
  ok(zeroEntry.na === 0, "known zero sodium survives macro computation");

  const warnings = FoodMatch.plausibility({
    name: "Unit-slip food", cat: "dish", grams: 100,
    macros: { kcal: 100, na: 6000, k: 4000 },
  });
  ok(warnings.some((w) => /sodium exceeds 5000 mg/i.test(w)), "entry plausibility checks sodium units");
  ok(warnings.some((w) => /potassium exceeds 3000 mg/i.test(w)), "entry plausibility checks potassium units");
}

console.log("\n[foods] untouched catalog migration");
{
  const banana = FOOD_DB.find((f) => f.id === "banana");
  const oldCopy = Foods.fromCatalog(banana);
  oldCopy.per100 = { ...oldCopy.per100 };
  delete oldCopy.per100.k;
  oldCopy.id = "saved-banana";
  oldCopy.updatedAt = 1;
  oldCopy.lastUsedAt = 123;
  oldCopy.useCount = 7;

  const migrated = Foods.migrateCatalogCopies([oldCopy], FOOD_DB);
  ok(migrated.changed, "pre-potassium reference copy is migrated");
  ok(migrated.foods[0].per100.k === banana.per100.k, "migration fills the catalog potassium value");
  ok(migrated.foods[0].id === "saved-banana" && migrated.foods[0].useCount === 7 && migrated.foods[0].lastUsedAt === 123,
    "migration preserves identity and usage history");

  const edited = { ...oldCopy, per100: { ...oldCopy.per100, p: oldCopy.per100.p + 5 } };
  const kept = Foods.migrateCatalogCopies([edited], FOOD_DB);
  ok(!kept.changed && kept.foods[0] === edited, "a version-1 copy whose values were edited is not overwritten");

  const versioned = { ...oldCopy, version: 2, history: [{ version: 1 }] };
  const keptVersioned = Foods.migrateCatalogCopies([versioned], FOOD_DB);
  ok(!keptVersioned.changed && keptVersioned.foods[0] === versioned, "versioned/history-bearing catalog edits are preserved");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
