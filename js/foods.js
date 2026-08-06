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
    const name = String(draft.name || "").trim().slice(0, 160);
    const food = {
      id: (opts && opts.id) || uid(),
      name,
      aliases: Array.isArray(draft.aliases) && draft.aliases.length
        ? draft.aliases.map((a) => String(a).toLowerCase().slice(0, 160)).slice(0, 50)
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

    const name = String(draft.name || existing.name || "").trim().slice(0, 160);
    return {
      ...existing,
      name,
      aliases: Array.isArray(draft.aliases) && draft.aliases.length
        ? draft.aliases.map((a) => String(a).toLowerCase().slice(0, 160)).slice(0, 50)
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

  /**
   * One-off (source:"once") ledger snapshot from a portion-first draft.
   * Never writes `per100` — see ONE-OFF-FOODS-PLAN §5.2 / Ledger once-per100 guard.
   *
   * @param {object} draft { name, cat?, macros:{kcal,p,c,f,fb,na?,k?}, confidence?, macrosOpened? }
   * @param {number} qty
   * @param {"g"|"oz"|"portion"} unit
   * @param {string} [meal]
   */
  function entryFromOnceDraft(draft, qty, unit, meal) {
    const d = draft || {};
    const name = String(d.name || "").trim();
    const u = unit === "oz" || unit === "portion" ? unit : "g";
    const q = Number(qty);
    const qtyN = Number.isFinite(q) && q > 0 ? q : (u === "portion" ? 1 : 0);
    let grams = 0;
    if (u === "g") grams = Math.round(qtyN);
    else if (u === "oz") grams = Math.round(qtyN * 28.35);
    // portion → grams 0 (unknown mass); Quick kcal already uses this shape.

    const m = d.macros || {};
    const macros = {
      kcal: Number(m.kcal) || 0,
      p: Number(m.p) || 0,
      c: Number(m.c) || 0,
      f: Number(m.f) || 0,
      fb: Number(m.fb) || 0,
      na: (m.na == null || m.na === "") ? null : Number(m.na),
      k: (m.k == null || m.k === "") ? null : Number(m.k),
    };
    if (macros.na != null && !Number.isFinite(macros.na)) macros.na = null;
    if (macros.k != null && !Number.isFinite(macros.k)) macros.k = null;

    // §5.5 floors: never below 0.10; never below 0.20 unless weighed/label.
    // §5.7: kcal-only (macros block never opened) always 0.40.
    let sd = 0.25;
    const conf = d.confidence;
    if (conf === "weighed") sd = 0.10;
    else if (conf === "rough") sd = 0.40;
    else if (conf === "estimated") sd = 0.25;
    if (d.macrosOpened === false) sd = 0.40;
    if (conf !== "weighed") sd = Math.max(sd, 0.20);
    sd = Math.max(sd, 0.10);

    let displayQty;
    if (u === "portion") displayQty = `${qtyN === 1 ? "1" : qtyN} portion`;
    else if (u === "oz") displayQty = `${qtyN} oz`;
    else displayQty = `${grams} g`;

    return {
      name,
      foodId: null,
      cat: d.cat || "dish",
      grams,
      displayQty,
      qty: qtyN,
      unit: u,
      macros,
      sd,
      meal: meal || inferMeal(),
      source: "once",
    };
  }

  /**
   * Provenance for a *ledger entry* (sibling of provenance(food)).
   * Do not feed entries to Foods.provenance — different input shape.
   */
  function entryProvenance(entry) {
    if (!entry) return { kind: "custom", label: "Yours · custom" };
    if (entry.source === "once") {
      return {
        kind: "once",
        label: "One-off · your estimate",
        detail: "Logged once from your own estimate. Not saved to My Foods.",
      };
    }
    if (entry.source === "quick") {
      return {
        kind: "quick",
        label: "Quick kcal",
        detail: "Calories only; protein and other macros are logged as zero.",
      };
    }
    return { kind: "custom", label: "Yours · custom" };
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
    const keys = ["kcal", "p", "c", "f", "fb", "na", "k"];
    return keys.every((k) => {
      const av = a[k], bv = b[k];
      if (av == null || bv == null) return av == null && bv == null;
      return Number.isFinite(Number(av)) && Number.isFinite(Number(bv)) &&
        Math.abs(Number(av) - Number(bv)) < 0.15;
    });
  }

  /**
   * Refresh reference-catalog copies created before the catalog gained new
   * nutrient fields. Only an untouched version-1 copy is eligible: edits,
   * history, AI pastes and tombstones are never rewritten. Missing fields are
   * allowed when deciding whether the old copy still matches, which is what
   * lets a pre-potassium copy receive the catalog's potassium value.
   *
   * The food id and usage metadata are preserved, so ledger snapshots remain
   * immutable and existing picker history keeps working. This correction is a
   * pure function of catalogId + the shipped FOOD_DB, so every device
   * converges on the exact same per100 values independently and
   * deterministically. `updatedAt` is intentionally left untouched: bumping
   * it would make a purely local, self-corrective rewrite look like a real
   * edit and let it win a last-write-wins sync merge against a genuine,
   * more recent remote edit that hasn't been pulled yet. Because every
   * device recomputes the same result on its own, there is nothing to
   * propagate through sync.
   *
   * @returns {{foods:Array, changed:boolean}}
   */
  function migrateCatalogCopies(list, catalog) {
    const db = Array.isArray(catalog)
      ? catalog
      : (typeof FOOD_DB !== "undefined" && Array.isArray(FOOD_DB) ? FOOD_DB : []);
    const byId = new Map(db.filter((f) => f && f.id).map((f) => [f.id, f]));
    let changed = false;
    const foods = (Array.isArray(list) ? list : []).map((food) => {
      const ref = food && food.catalogId ? byId.get(food.catalogId) : null;
      const history = food && Array.isArray(food.history) ? food.history : [];
      if (!food || !ref || food.deleted || (food.version || 1) !== 1 || history.length ||
          (food.raw && String(food.raw).trim())) return food;

      const saved = food.per100 || {};
      const current = ref.per100 || {};
      const nutrientKeys = ["kcal", "p", "c", "f", "fb", "na", "k"];
      const stillReference = nutrientKeys.every((key) => {
        // A field absent from an older catalog copy is unknown provenance, not
        // a user edit. A present field must still equal the current reference.
        if (!(key in saved) || saved[key] == null) return true;
        if (!(key in current) || current[key] == null) return false;
        return Math.abs(Number(saved[key]) - Number(current[key])) < 0.15;
      });
      if (!stillReference) return food;

      const nextPer100 = { ...current };
      if (per100Close(saved, nextPer100)) return food;
      changed = true;
      return {
        ...food,
        per100: nextPer100,
      };
    });
    return { foods, changed };
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
    fromCatalog, entryFromQty, entryFromOnceDraft, entryProvenance, inferMeal, sortForPicker, recent, frequent, provenance,
    migrateCatalogCopies,
  };
})();

if (typeof module !== "undefined") module.exports = Foods;
