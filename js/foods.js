/* NutriDaily — personal food library (CRUD + copy-on-write versioning). */
const Foods = (() => {
  const HISTORY_CAP = 5;

  function uid() {
    return "pf-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function snapshot(food) {
    return {
      version: food.version || 1,
      per100: { ...(food.per100 || {}) },
      units: { ...(food.units || {}) },
      batch: food.batch ? { ...food.batch } : null,
      ts: food.updatedAt || Date.now(),
      raw: food.raw || "",
    };
  }

  /** Build a new personal food from a parsed review draft. */
  function createFromDraft(draft, opts) {
    const now = Date.now();
    const name = String(draft.name || "").trim().slice(0, 80);
    const food = {
      id: (opts && opts.id) || uid(),
      name,
      aliases: Array.isArray(draft.aliases) && draft.aliases.length
        ? draft.aliases.map((a) => String(a).toLowerCase()).slice(0, 20)
        : [name.toLowerCase()],
      cat: draft.cat || "dish",
      per100: { ...draft.per100 },
      units: { ...(draft.units || {}) },
      logAs: draft.logAs === "piece" ? "piece" : "grams",
      countLabel: draft.logAs === "piece" && draft.countLabel
        ? String(draft.countLabel).trim().toLowerCase().slice(0, 32)
        : null,
      batch: draft.batch ? { ...draft.batch } : null,
      recipe: {
        ingredients: (draft.recipe && draft.recipe.ingredients) || [],
        prep: (draft.recipe && draft.recipe.prep) || "",
        notes: (draft.recipe && draft.recipe.notes) || "",
      },
      confidence: draft.confidence || "medium",
      sd: typeof draft.sd === "number" ? draft.sd : 0.12,
      version: 1,
      history: [],
      raw: draft.raw || "",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: 0,
      useCount: 0,
      source: "personal",
    };
    return food;
  }

  /** Update existing food in place (same id), push previous onto history. */
  function applyUpdate(existing, draft) {
    const hist = Array.isArray(existing.history) ? [...existing.history] : [];
    hist.unshift(snapshot(existing));
    while (hist.length > HISTORY_CAP) hist.pop();

    const name = String(draft.name || existing.name || "").trim().slice(0, 80);
    return {
      ...existing,
      name,
      aliases: Array.isArray(draft.aliases) && draft.aliases.length
        ? draft.aliases.map((a) => String(a).toLowerCase()).slice(0, 20)
        : existing.aliases,
      cat: draft.cat || existing.cat || "dish",
      per100: { ...draft.per100 },
      units: { ...(draft.units || {}) },
      logAs: draft.logAs === "piece" ? "piece" : (draft.logAs === "grams" ? "grams" : (existing.logAs === "piece" ? "piece" : "grams")),
      countLabel: (draft.logAs === "piece" || (!draft.logAs && existing.logAs === "piece"))
        ? (draft.countLabel != null && String(draft.countLabel).trim()
          ? String(draft.countLabel).trim().toLowerCase().slice(0, 32)
          : (existing.countLabel || null))
        : null,
      batch: draft.batch ? { ...draft.batch } : null,
      recipe: {
        ingredients: (draft.recipe && draft.recipe.ingredients) || [],
        prep: (draft.recipe && draft.recipe.prep) || "",
        notes: (draft.recipe && draft.recipe.notes) || "",
      },
      confidence: draft.confidence || existing.confidence || "medium",
      sd: typeof draft.sd === "number" ? draft.sd : existing.sd || 0.12,
      version: (existing.version || 1) + 1,
      history: hist,
      raw: draft.raw != null ? draft.raw : existing.raw,
      updatedAt: Date.now(),
      deleted: false,
    };
  }

  /** One-tap repair: treat serving (or given grams) as one countable piece. */
  function enableCountLogging(food, pieceGrams, label) {
    const g = Math.round(+pieceGrams);
    if (!food || !Number.isFinite(g) || g <= 0) return food;
    const noun = String(label || (typeof FoodMatch !== "undefined" && FoodMatch.countNoun
      ? FoodMatch.countNoun(food)
      : "piece")).trim().toLowerCase().slice(0, 32) || "piece";
    return {
      ...food,
      logAs: "piece",
      countLabel: noun,
      units: { ...(food.units || {}), piece: g },
      updatedAt: Date.now(),
      version: (food.version || 1) + 1,
    };
  }

  function tombstone(food) {
    return { ...food, deleted: true, updatedAt: Date.now() };
  }

  function touchUse(food, when) {
    return {
      ...food,
      lastUsedAt: when || Date.now(),
      useCount: (food.useCount || 0) + 1,
      updatedAt: food.updatedAt || Date.now(),
    };
  }

  function findByName(list, name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return null;
    return (list || []).find((f) => !f.deleted && (f.name || "").toLowerCase() === n) || null;
  }

  function active(list) {
    return (list || []).filter((f) => !f.deleted);
  }

  /** Copy a curated DB food into personal library shape. */
  function fromCatalog(dbFood) {
    const now = Date.now();
    return {
      id: uid(),
      name: dbFood.name,
      aliases: [...(dbFood.aliases || [])],
      cat: dbFood.cat || "dish",
      per100: { ...dbFood.per100 },
      units: { ...(dbFood.units || {}) },
      logAs: dbFood.units && +dbFood.units.piece > 0 ? "piece" : "grams",
      countLabel: dbFood.units && +dbFood.units.piece > 0
        ? (typeof FoodMatch !== "undefined" && FoodMatch.countNoun ? FoodMatch.countNoun(dbFood) : "piece")
        : null,
      batch: null,
      recipe: { ingredients: [], prep: "", notes: "From reference catalog" },
      confidence: "high",
      sd: 0.08,
      version: 1,
      history: [],
      raw: "",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: 0,
      useCount: 0,
      source: "personal",
      catalogId: dbFood.id,
    };
  }

  /** Build a ledger entry from food + quantity. */
  function entryFromQty(food, quantity, unit, meal) {
    const qty = Number(quantity) > 0 ? Number(quantity) : 1;
    const u = String(unit || "g").toLowerCase();
    let grams;
    let how = "grams";
    if (u === "batch" && food.batch && food.batch.grams) {
      grams = qty * food.batch.grams;
      how = "unit";
    } else {
      const conv = FoodMatch.toGrams(food, qty, u);
      grams = conv.grams;
      how = conv.how;
    }
    grams = Math.round(grams);
    let sd = typeof food.sd === "number" ? food.sd : 0.12;
    if (how !== "grams") sd = Math.max(sd, 0.15);
    const macros = FoodMatch.computeMacros(food.per100, grams);
    return {
      name: food.name,
      foodId: food.id,
      foodVersion: food.version || 1,
      per100: { ...food.per100 },
      cat: food.cat || "dish",
      grams,
      displayQty: FoodMatch.displayQty(qty, u === "g" || u === "grams" ? "g" : u, grams, food),
      macros,
      sd,
      meal: meal || inferMeal(),
      source: "personal",
      qty,
      unit: u,
    };
  }

  function inferMeal(explicit) {
    if (explicit) return explicit;
    const h = new Date().getHours();
    if (h < 11) return "breakfast";
    if (h < 15) return "lunch";
    if (h < 18) return "snack";
    return "dinner";
  }

  function sortForPicker(list) {
    return active(list).slice().sort((a, b) => {
      const lu = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
      if (lu) return lu;
      return (a.name || "").localeCompare(b.name || "");
    });
  }

  function recent(list, n) {
    return active(list)
      .filter((f) => f.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
      .slice(0, n || 8);
  }

  function frequent(list, n, excludeIds) {
    const ex = new Set(excludeIds || []);
    return active(list)
      .filter((f) => (f.useCount || 0) > 0 && !ex.has(f.id))
      .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
      .slice(0, n || 8);
  }

  function per100Close(a, b) {
    if (!a || !b) return false;
    const keys = ["kcal", "p", "c", "f", "fb", "na"];
    return keys.every((k) => Math.abs(Number(a[k] || 0) - Number(b[k] || 0)) < 0.15);
  }

  /**
   * Quiet provenance for qty sheet / detail.
   * Prefer "AI" over "LLM" or a single vendor name in labels.
   */
  function provenance(food) {
    if (!food) return { kind: "custom", label: "Yours · custom" };
    const hasRaw = !!(food.raw && String(food.raw).trim());
    if (food.catalogId) {
      const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
      const db = DB.find((f) => f.id === food.catalogId);
      const untouched = db && per100Close(food.per100, db.per100) && (food.version || 1) === 1 && !hasRaw;
      if (untouched) {
        return {
          kind: "ref",
          label: "Reference · USDA-style avg",
          detail: "Curated averages for diary use, not brand-specific lab values.",
        };
      }
      if (hasRaw) {
        return { kind: "ai", label: "Yours · AI estimate", detail: "Updated from an AI paste; you can edit anytime." };
      }
      return { kind: "edit", label: "Yours · edited", detail: "Started from the reference catalog; numbers are yours now." };
    }
    if (food.source === "shared") {
      return { kind: "shared", label: "Yours · shared", detail: "Imported from a NutriDaily share link or code." };
    }
    if (hasRaw) {
      return { kind: "ai", label: "Yours · AI estimate", detail: "From an AI paste (ChatGPT, Claude, etc.); review before trusting." };
    }
    return { kind: "custom", label: "Yours · custom", detail: "Entered or edited by you." };
  }

  return {
    uid, createFromDraft, applyUpdate, enableCountLogging, tombstone, touchUse, findByName, active,
    fromCatalog, entryFromQty, inferMeal, sortForPicker, recent, frequent, provenance,
  };
})();

if (typeof module !== "undefined") module.exports = Foods;
