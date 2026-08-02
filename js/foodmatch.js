/* NutriChat — deterministic food resolution & nutrition math.
 * Resolution priority: personal foods > curated DB (reference catalog).
 */
const FoodMatch = (() => {
  // Mass units → grams. Volume units are food-specific (see food.units) except liquids fallback.
  const MASS_UNITS = { g: 1, gram: 1, grams: 1, gm: 1, gms: 1, kg: 1000, kilogram: 1000, oz: 28.35, ounce: 28.35, ounces: 28.35, lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6, mg: 0.001 };
  const VOLUME_ML = { ml: 1, milliliter: 1, milliliters: 1, l: 1000, liter: 1000, litre: 1000, cup: 240, cups: 240, tbsp: 15, tablespoon: 15, tablespoons: 15, tsp: 5, teaspoon: 5, teaspoons: 5, glass: 250, shot: 30, pint: 473 };
  // Unit synonyms normalized before lookup in food.units
  const UNIT_SYNONYMS = {
    pc: "piece", pcs: "piece", pieces: "piece", unit: "piece", whole: "piece", count: "piece",
    slices: "slice", scoops: "scoop", servings: "serving", bowls: "bowl", katoris: "katori",
    cans: "can", glasses: "glass", bars: "bar", rolls: "roll", containers: "container",
    handfuls: "handful", fillets: "fillet", ears: "ear", cubes: "cube", squares: "square",
    plates: "plate", bags: "bag", bottles: "bottle", pints: "pint", pats: "pat", blocks: "block",
    batches: "batch", tablespoon: "tbsp", tablespoons: "tbsp", teaspoon: "tsp", teaspoons: "tsp", cups: "cup",
  };
  const DEFAULT_PORTION_G = 100; // last-resort fallback

  // Uncertainty (relative std dev) by how the amount & food were determined.
  const SD = {
    personal_exact: 0.05,  // user's own food, gram amount given
    db_grams: 0.08,        // curated DB food, gram amount given
    db_unit: 0.15,         // curated DB food, household measure (piece/cup/bowl)
    db_guess: 0.25,        // curated DB food, no quantity info (default portion)
    llm_estimate: 0.30,    // macros themselves estimated by LLM
  };

  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s%]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const STOPWORDS = new Set(["of", "the", "a", "an", "some", "my", "with", "and", "cooked", "raw", "fresh", "plain"]);
  function tokens(s) {
    return normalize(s).split(" ").filter((t) => t && !STOPWORDS.has(t));
  }

  // Score a query against a candidate name/alias. Exact alias = 1. Otherwise token overlap (Dice-ish).
  function scoreMatch(query, candidate) {
    const q = normalize(query), c = normalize(candidate);
    if (!q || !c) return 0;
    if (q === c) return 1;
    const qt = new Set(tokens(q)), ct = new Set(tokens(c));
    if (!qt.size || !ct.size) return 0;
    let hit = 0;
    for (const t of qt) {
      if (ct.has(t)) { hit += 1; continue; }
      // singular/plural forgiveness
      for (const u of ct) { if (u === t + "s" || t === u + "s") { hit += 1; break; } }
    }
    const dice = (2 * hit) / (qt.size + ct.size);
    // full containment bonus: every query token found
    return hit === qt.size ? Math.max(dice, 0.75) : dice;
  }

  /** Resolve a food name → { food, source, score } | null.
   *  personalFoods: array of user foods shaped like DB entries (+ source:"personal"). */
  function resolve(name, personalFoods, db) {
    const DB = db || (typeof FOOD_DB !== "undefined" ? FOOD_DB : []);
    let best = null;
    const consider = (food, source) => {
      const names = [food.name, ...(food.aliases || [])];
      for (const n of names) {
        const s = scoreMatch(name, n) * (source === "personal" ? 1.05 : 1); // personal wins ties
        if (!best || s > best.score) best = { food, source, score: s };
      }
    };
    for (const f of personalFoods || []) { if (!f.deleted) consider(f, "personal"); }
    for (const f of DB) consider(f, "db");
    if (best && best.score >= 0.55) return best;
    return null;
  }

  /** Convert (quantity, unit) for a given food → { grams, how } ; llmGrams is the parser's fallback estimate. */
  function toGrams(food, quantity, unit, llmGrams) {
    const qty = Number(quantity) > 0 ? Number(quantity) : 1;
    let u = normalize(unit || "");
    u = UNIT_SYNONYMS[u] || u;

    if (u && MASS_UNITS[u]) return { grams: qty * MASS_UNITS[u], how: "grams" };

    if (u === "batch" && food && food.batch && food.batch.grams) {
      return { grams: qty * food.batch.grams, how: "unit" };
    }

    if (u && food && food.units) {
      const fu = food.units[u];
      if (fu) return { grams: qty * fu, how: "unit" };
    }
    // volume: liquids ≈ 1 g/ml; other foods only if the food defines the measure (handled above)
    if (u && VOLUME_ML[u]) {
      const density = food && food.cat === "bev" ? 1.03 : 1; // close enough for beverages
      if (food && (food.cat === "bev" || u === "ml" || u === "l")) {
        return { grams: qty * VOLUME_ML[u] * density, how: "unit" };
      }
      // generic cup/tbsp of a solid without a food-specific weight → weak estimate
      return { grams: qty * VOLUME_ML[u] * 0.7, how: "guess" };
    }
    if (!u || u === "piece") {
      if (food && food.units && food.units.piece) return { grams: qty * food.units.piece, how: "unit" };
    }
    if (Number(llmGrams) > 0) return { grams: Number(llmGrams), how: "guess" };
    // any single defined unit as proxy, else default
    if (food && food.units) {
      const first = Object.values(food.units)[0];
      if (first) return { grams: qty * first, how: "guess" };
    }
    return { grams: qty * DEFAULT_PORTION_G, how: "guess" };
  }

  /** Deterministic macro computation. per100 × grams / 100, rounded sensibly. */
  function computeMacros(per100, grams) {
    const k = grams / 100;
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      kcal: Math.round((per100.kcal || 0) * k),
      p: r1((per100.p || 0) * k),
      c: r1((per100.c || 0) * k),
      f: r1((per100.f || 0) * k),
      fb: r1((per100.fb || 0) * k),
      na: Math.round((per100.na || 0) * k),
    };
  }

  /** Pick relative SD for an entry. */
  function sdFor(source, how) {
    if (source === "llm") return SD.llm_estimate;
    if (source === "personal") return how === "grams" ? SD.personal_exact : SD.db_unit;
    if (how === "grams") return SD.db_grams;
    if (how === "unit") return SD.db_unit;
    return SD.db_guess;
  }

  // Plausibility limits (grams per single entry) by category.
  const MAX_G = { meat: 600, protein: 500, grain: 600, legume: 700, veg: 800, fruit: 700, dairy: 800, fat: 120, nuts: 250, bev: 1500, snack: 400, dish: 900 };
  const KCAL_PER_G_MAX = 9.2, KCAL_PER_G_MIN = 0;

  /** Rule-based verifier. Returns array of warning strings (empty = plausible). */
  function plausibility(entry) {
    const warns = [];
    const cap = MAX_G[entry.cat] || 800;
    if (entry.grams > cap) warns.push(`${Math.round(entry.grams)} g of ${entry.name} is unusually large — double-check the amount.`);
    if (entry.grams > 0) {
      const kpg = entry.macros.kcal / entry.grams;
      if (kpg > KCAL_PER_G_MAX) warns.push(`${entry.name}: ${kpg.toFixed(1)} kcal/g exceeds the physical max (~9 kcal/g) — the estimate looks wrong.`);
      if (kpg < KCAL_PER_G_MIN) warns.push(`${entry.name}: negative energy? The estimate looks wrong.`);
    }
    return warns;
  }

  /** Human-readable quantity for the receipt card. */
  function displayQty(quantity, unit, grams) {
    const qty = Number(quantity) > 0 ? Number(quantity) : 1;
    const u = normalize(unit || "");
    if (u && !MASS_UNITS[u]) return `${qty} ${u}${qty !== 1 && !u.endsWith("s") ? "s" : ""} (${Math.round(grams)} g)`;
    return `${Math.round(grams)} g`;
  }

  return { normalize, tokens, scoreMatch, resolve, toGrams, computeMacros, sdFor, plausibility, displayQty, SD, MASS_UNITS };
})();

if (typeof module !== "undefined") module.exports = FoodMatch;
