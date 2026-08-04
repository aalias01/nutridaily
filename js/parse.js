/* NutriDaily — NUTRI v1 paste parser.
 * Deterministic only. ChatGPT lives outside the app; this module owns numbers.
 */
const NutriParse = (() => {
  const CATS = new Set(["dish", "meat", "protein", "grain", "legume", "veg", "fruit", "dairy", "fat", "nuts", "bev", "snack"]);

  const PROMPT =
    "You are a nutrition data formatter. I will describe a dish or packaged food. Reply with ONE fenced code\n" +
    "block and nothing else, in exactly this format:\n\n" +
    "NUTRI v1\n" +
    "Name: <short dish name>\n" +
    "Aliases: <other names I might search for, comma separated>\n" +
    "Category: <one of: dish, meat, protein, grain, legume, veg, fruit, dairy, fat, nuts, bev, snack>\n" +
    "Batch: <finished weight in grams> g total, <number> servings\n" +
    "Totals: <kcal> kcal | P <g> | C <g> | F <g> | Fiber <g> | Sodium <mg> | Potassium <mg>\n" +
    "Per 100 g: <kcal> kcal | P <g> | C <g> | F <g> | Fiber <g> | Sodium <mg> | Potassium <mg>\n" +
    "Piece: <grams per ONE countable item, or omit>\n" +
    "Log as: <piece | grams>\n" +
    "Count as: <singular noun I would say, e.g. chapati, egg — omit if Log as: grams>\n" +
    "Serving: <optional grams; only if different from Piece>\n" +
    "Ingredients:\n" +
    "- <ingredient> - <amount in grams>\n" +
    "Prep: <one or two lines: cooking method, oil used, anything that changes the numbers>\n" +
    "Notes: <assumptions you made>\n" +
    "Confidence: <high | medium | low>\n" +
    "END\n\n" +
    "Rules:\n" +
    "- Plain numbers only. No ranges, no \"approx\", no units inside the number fields.\n" +
    "- Totals are for the FINISHED dish, after cooking.\n" +
    "- If I told you the finished weight, use it. If I did not, estimate it and write \"(estimated)\"\n" +
    "  after the number, like: Batch: 760 g total (estimated), 4 servings.\n" +
    "- Per 100 g must equal Totals divided by Batch grams, times 100. Do that arithmetic and check it.\n" +
    "- Batch \"servings\" is recipe math only (how many portions the batch divides into).\n" +
    "  It is NOT how I log day to day.\n" +
    "- Log as / Piece (how humans actually log):\n" +
    "  * Log as: piece — when someone would say a count: \"2 chapatis\", \"3 eggs\", \"1 bar\",\n" +
    "    \"1 idli\". Then Piece MUST be the grams for exactly ONE of those items.\n" +
    "  * Log as: grams — when someone weighs a scoop/bowl every time (dal, rice, curry, salad).\n" +
    "    Omit Piece, or leave it blank.\n" +
    "- For a pack of identical items (e.g. 10 chapatis, 567 g pack): Batch is the pack weight and\n" +
    "  write the count as `N servings` (e.g. Batch: 567 g total, 10 servings). Piece is pack grams ÷ count.\n" +
    "  Log as: piece.\n" +
    "- Plain numbers only. No thousands separators (write 1153 not 1,153).\n" +
    "- Prefer Piece over Serving for countable foods. Use Serving only if it means something else\n" +
    "  (e.g. label \"serving\" that is not one piece).\n" +
    "- Count as is the word I type in the diary (\"2 chapatis\" → Count as: chapati).\n" +
    "- Use USDA-style values. Account for oil absorbed and water lost in cooking.\n" +
    "- Sodium and potassium in milligrams. Everything else in grams.\n" +
    "- If you are not reasonably confident about potassium, write Potassium unknown rather than guessing a number.\n" +
    "- Before you reply, check your own numbers:\n" +
    "  * Atwater check: 4×protein + 4×carbs + 9×fat (all in grams) should land within about 10% of the\n" +
    "    kcal you wrote for the same basis (Totals or Per 100 g). If it does not, recompute — don't report\n" +
    "    a kcal figure that disagrees with your own macros.\n" +
    "  * Per 100 g of food this high should make you double-check the units or decimal point: kcal above\n" +
    "    ~900, protein+carbs+fat above 100 g, or potassium above ~3000 mg (a few real foods — dried herbs,\n" +
    "    instant coffee, cream of tartar, salt substitutes — genuinely do run that high). If after checking\n" +
    "    it's still correct, keep it and say so in Notes; only fix it if you actually find a units/decimal\n" +
    "    error.\n" +
    "- No commentary before or after the code block.\n\n" +
    "My dish:\n";

  function updatePrompt(raw) {
    return PROMPT + "\nThis is my current saved version. Return a corrected block in the same format:\n" + String(raw || "");
  }

  /**
   * Prompt for refining a saved food (catalog/reference or personal) when no prior NUTRI paste exists.
   * Prefer this over updatePrompt("") for default/catalog foods.
   */
  function foodUpdatePrompt(food) {
    const f = food || {};
    const raw = f.raw && String(f.raw).trim();
    if (raw) return updatePrompt(raw);
    const p = f.per100 || {};
    const units = f.units || {};
    const unitBits = Object.keys(units)
      .filter((k) => Number(units[k]) > 0)
      .map((k) => `${k}=${units[k]}g`)
      .join(", ");
    const prov = (typeof Foods !== "undefined" && Foods.provenance)
      ? Foods.provenance(f)
      : null;
    const sourceLine = prov && prov.kind === "ref"
      ? "Source: reference catalog (USDA-style averages — please refine from reliable nutrition data).\n"
      : "Source: my saved food (no prior AI paste on file).\n";
    return (
      PROMPT +
      "\n" +
      "Refine this existing food for my NutriDaily library. Keep the Name recognizable (same or clearer).\n" +
      "Return a corrected NUTRI v1 block with updated Per 100 g / Totals math, Piece/Log as if countable,\n" +
      "and Notes listing sources or assumptions. Prefer USDA FoodData Central or similar; no fake URLs.\n\n" +
      sourceLine +
      "Current saved values:\n" +
      `Name: ${f.name || ""}\n` +
      (Array.isArray(f.aliases) && f.aliases.length ? `Aliases: ${f.aliases.join(", ")}\n` : "") +
      `Category: ${f.cat || "dish"}\n` +
      `Per 100 g: ${Math.round(p.kcal || 0)} kcal | P ${p.p ?? 0} | C ${p.c ?? 0} | F ${p.f ?? 0} | Fiber ${p.fb ?? 0} | Sodium ${p.na ?? 0} | Potassium ${p.k ?? "unknown"}\n` +
      (f.logAs ? `Log as: ${f.logAs}\n` : "") +
      (units.piece ? `Piece: ${units.piece}\n` : "") +
      (unitBits ? `Known units: ${unitBits}\n` : "") +
      (f.countLabel ? `Count as: ${f.countLabel}\n` : "") +
      "\nMy dish:\n" +
      String(f.name || "") + "\n"
    );
  }

  function preprocess(text) {
    let s = String(text || "");
    s = s.replace(/\u00a0/g, " ");
    s = s.replace(/[\u2013\u2014\u2212]/g, "-");
    s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
    // Only rewrite estimate markers on Batch lines — tilde on macros must stay strip-only
    // so `P ~18` still parses as protein 18.
    s = s.replace(/^(Batch:\s*)([^\n]*)$/gim, (_, key, rest) => {
      const marked = rest.replace(/([≈~])\s*(?=\d)/g, "approx ");
      return key + marked.replace(/[≈~]/g, "");
    });
    s = s.replace(/[≈~]/g, "");
    s = s.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    s = s.replace(/(\d),(\d{3})\b/g, "$1$2");
    return s;
  }

  function extractBlocks(text) {
    const src = preprocess(text);
    const blocks = [];
    const re = /NUTRI\s*v?1\b/gi;
    let m;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length;
      const rest = src.slice(start);
      const nextSent = rest.search(/NUTRI\s*v?1\b/i);
      const endMatch = rest.match(/\n\s*END\s*[.!?]?(?:\n|$)/i);
      let endAt = rest.length;
      let truncated = true;
      let advanceTo = start + rest.length;
      if (endMatch && (nextSent < 0 || endMatch.index <= nextSent)) {
        endAt = endMatch.index;
        truncated = false;
        advanceTo = start + endMatch.index + endMatch[0].length;
      } else if (nextSent >= 0) {
        endAt = nextSent;
        truncated = true;
        advanceTo = start + nextSent;
      }
      const body = rest.slice(0, endAt);
      blocks.push({
        body: body.replace(/^\s*\n/, ""),
        truncated,
        rawBlock: src.slice(m.index, advanceTo),
      });
      re.lastIndex = advanceTo;
      if (truncated && nextSent < 0) break;
    }
    return blocks;
  }

  const KEY_MAP = {
    name: "name", dish: "name", food: "name",
    aliases: "aliases",
    category: "category", cat: "category",
    batch: "batch",
    totals: "totals", total: "totals", "whole batch": "totals",
    "per 100 g": "per100", per100: "per100", "per 100g": "per100", "per 100 grams": "per100",
    serving: "serving", "serving size": "serving",
    piece: "piece", each: "piece", "per piece": "piece", "piece size": "piece",
    "unit weight": "piece", "each weighs": "piece",
    "log as": "logAs", "default unit": "logAs", "eaten as": "logAs", "log with": "logAs",
    "count as": "countAs", "count noun": "countAs", "unit name": "countAs",
    ingredients: "ingredients",
    prep: "prep", preparation: "prep", method: "prep",
    notes: "notes",
    confidence: "confidence",
  };

  /** @returns {"piece"|"grams"|null} */
  function parseLogAs(value) {
    const s = String(value || "").trim().toLowerCase();
    if (!s) return null;
    if (/\b(pieces?|counts?|each|units?|items?|chapati|roti|egg|bar)\b/.test(s)) return "piece";
    if (/\b(g|gram|grams|oz|ounce|weigh|scale|scoop|bowl|serving|servings)\b/.test(s)) return "grams";
    if (s === "piece" || s === "grams") return s;
    return null;
  }

  function inferCountLabel(name, aliases) {
    if (typeof FoodMatch !== "undefined" && FoodMatch.countNoun) {
      return FoodMatch.countNoun({ name, aliases, countLabel: "" });
    }
    return "piece";
  }

  function parseGramsField(value) {
    const n = Number(String(value || "").match(/-?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function keyOf(line) {
    const m = line.match(/^\s*(?:#|>|\*|\u2022)?\s*\**([A-Za-z0-9][A-Za-z0-9\s]*?)\**\s*:\s*(.*)$/);
    if (!m) return null;
    const k = m[1].trim().toLowerCase().replace(/\s+/g, " ");
    const canon = KEY_MAP[k];
    if (!canon) return { unknown: true, key: m[1].trim(), value: m[2] };
    return { key: canon, value: m[2], rawKey: m[1].trim() };
  }

  function parseMacros(line) {
    const out = {};
    const present = {};
    const s = String(line || "");
    const patterns = [
      { k: "kcal", re: /(?:^|[\s|;,])(?:kcal|cal|calories)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i },
      { k: "kcal", re: /(-?\d+(?:\.\d+)?)\s*(?:kcal|cal|calories)\b/i },
      { k: "p", re: /(?:^|[\s|;,])(?:p|protein)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i },
      { k: "c", re: /(?:^|[\s|;,])(?:c|carb|carbs|carbohydrate|carbohydrates)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i },
      { k: "f", re: /(?:^|[\s|;,])(?:f|fat)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i },
      { k: "fb", re: /(?:^|[\s|;,])(?:fb|fiber|fibre)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i },
      { k: "na", re: /(?:^|[\s|;,])(?:na|sodium)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i },
      { k: "k", re: /(?:^|[\s|;,])(?:k|potassium)\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i },
    ];
    for (const { k, re } of patterns) {
      if (out[k] !== undefined) continue;
      const m = s.match(re);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) { out[k] = n; present[k] = true; }
      }
    }
    return { macros: out, present };
  }

  function parseBatch(line) {
    const s = String(line || "");
    const estimated = /\(estimated\)|\bapprox\b|\bapproximately\b/i.test(s);
    let grams = null, servings = null;
    const gTotal = s.match(/(-?\d+(?:\.\d+)?)\s*g(?:rams?)?\s*total/i);
    if (gTotal) grams = Number(gTotal[1]);
    const each = s.match(/(-?\d+(?:\.\d+)?)\s*g(?:rams?)?\s*each/i);
    const servN = s.match(/(-?\d+(?:\.\d+)?)\s*(?:servings?|pieces?|items?|count)\b/i)
      || s.match(/\bmakes\s+(-?\d+(?:\.\d+)?)/i)
      // Pack counts often look like: "567 g total, 10 chapatis" (not "56.7 g each").
      || s.match(/,\s*(-?\d+(?:\.\d+)?)\s+(?!g(?:rams?)?\b|oz\b|mg\b|each\b|per\b)[a-z][a-z-]*\b/i);
    if (servN) servings = Number(servN[1]);
    if (each && servings) grams = Number(each[1]) * servings;
    if (grams == null) {
      const bare = s.match(/(-?\d+(?:\.\d+)?)\s*g(?:rams?)?\b/i);
      if (bare) grams = Number(bare[1]);
    }
    return {
      grams: Number.isFinite(grams) ? grams : null,
      servings: Number.isFinite(servings) && servings > 0 ? servings : null,
      weighed: !estimated,
    };
  }

  function parseIngredientLine(line) {
    const cleaned = line.replace(/^\s*(?:[-*\u2022]|\d+\.)\s*/, "").trim();
    if (!cleaned) return null;
    // Prefer explicit grams; also accept a bare trailing number (ChatGPT often omits "g").
    const gm = cleaned.match(/(-?\d+(?:\.\d+)?)\s*g(?:rams?)?\b/i)
      || cleaned.match(/\s[-–—]?\s*(-?\d+(?:\.\d+)?)\s*$/);
    return { text: cleaned.slice(0, 200), grams: gm ? Number(gm[1]) : null };
  }

  function round1(x) { return Math.round(x * 10) / 10; }
  function scaleMacros(m, factor) {
    return {
      kcal: Math.round((m.kcal || 0) * factor * 10) / 10,
      p: round1((m.p || 0) * factor),
      c: round1((m.c || 0) * factor),
      f: round1((m.f || 0) * factor),
      fb: round1((m.fb || 0) * factor),
      // Sodium and potassium are nullable: null means "not recorded", while a
      // numeric zero means a known zero. Coverage is derived downstream from
      // that distinction, so scaling must preserve it.
      na: m.na == null ? null : Math.round(m.na * factor),
      // Scaling an unknown must stay unknown, not become 0.
      k: m.k == null ? null : Math.round(m.k * factor),
    };
  }

  function sdFor(confidence, weighed, hasIngredients) {
    const c = confidence || "medium";
    if (!hasIngredients || c === "low") return 0.2;
    if (weighed && c === "high") return 0.05;
    if (weighed || c === "high") return 0.1;
    return 0.12;
  }

  function parseBlock(block, originalPaste) {
    const warnings = [];
    const rejects = [];
    const unknownLines = [];
    const fields = {};
    let mode = null; // ingredients | prep | notes
    const ingredientLines = [];
    const prepParts = [];
    const notesParts = [];

    const lines = block.body.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.replace(/\*\*/g, "").replace(/__/g, "");
      if (!line.trim()) continue;

      if (mode === "ingredients") {
        if (/^\s*(?:[-*\u2022]|\d+\.)\s+/.test(line) || (!keyOf(line) && line.trim())) {
          if (/^\s*(?:[-*\u2022]|\d+\.)\s+/.test(line)) {
            const ing = parseIngredientLine(line);
            if (ing) ingredientLines.push(ing);
            continue;
          }
        }
      }
      if (mode === "prep" || mode === "notes") {
        const k = keyOf(line);
        // Stay in notes/prep for unknown "Key: value" continuation lines (e.g. "Oil used: 2 tbsp").
        if (!k || k.unknown) {
          (mode === "prep" ? prepParts : notesParts).push(line.trim());
          continue;
        }
        mode = null;
      }

      const k = keyOf(line);
      if (!k) {
        if (mode === "ingredients" && /^\s*(?:[-*\u2022]|\d+\.)\s+/.test(line)) {
          const ing = parseIngredientLine(line);
          if (ing) ingredientLines.push(ing);
        }
        continue;
      }
      if (k.unknown) {
        unknownLines.push(`${k.key}: ${k.value}`);
        mode = null;
        continue;
      }

      mode = null;
      if (k.key === "ingredients") {
        mode = "ingredients";
        if (k.value.trim()) {
          const ing = parseIngredientLine("- " + k.value.trim());
          if (ing) ingredientLines.push(ing);
        }
        continue;
      }
      if (k.key === "prep") { mode = "prep"; if (k.value.trim()) prepParts.push(k.value.trim()); continue; }
      if (k.key === "notes") { mode = "notes"; if (k.value.trim()) notesParts.push(k.value.trim()); continue; }
      fields[k.key] = k.value.trim();
    }

    let name = String(fields.name || "").trim().slice(0, 80);
    if (!name) rejects.push("Name is missing.");

    const aliases = String(fields.aliases || "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);

    let cat = String(fields.category || "dish").trim().toLowerCase();
    if (!CATS.has(cat)) cat = "dish";

    const confidence = /^(high|medium|low)$/i.test(fields.confidence || "")
      ? fields.confidence.toLowerCase()
      : "medium";

    const batch = fields.batch ? parseBatch(fields.batch) : { grams: null, servings: null, weighed: true };
    const totalsParsed = fields.totals ? parseMacros(fields.totals) : { macros: {}, present: {} };
    const per100Parsed = fields.per100 ? parseMacros(fields.per100) : { macros: {}, present: {} };

    let chatgptPer100 = null;
    if (per100Parsed.present.kcal || per100Parsed.present.p || per100Parsed.present.c || per100Parsed.present.f) {
      chatgptPer100 = {
        kcal: per100Parsed.macros.kcal || 0,
        p: per100Parsed.macros.p || 0,
        c: per100Parsed.macros.c || 0,
        f: per100Parsed.macros.f || 0,
        fb: per100Parsed.macros.fb || 0,
        na: per100Parsed.present.na ? per100Parsed.macros.na : null,
        // Nullable: absent means unrecorded, not zero.
        k: per100Parsed.present.k ? per100Parsed.macros.k : null,
      };
    }

    let per100 = null;
    let derivedFromTotals = false;
    const factor = (batch.grams && batch.grams >= 10) ? (100 / batch.grams) : null;
    if (totalsParsed.present.kcal && factor != null) {
      // Per-key merge: use totals-derived when that key was present; else keep Per 100 g.
      const fromTotals = scaleMacros({
        kcal: totalsParsed.macros.kcal || 0,
        p: totalsParsed.macros.p || 0,
        c: totalsParsed.macros.c || 0,
        f: totalsParsed.macros.f || 0,
        fb: totalsParsed.macros.fb || 0,
        na: totalsParsed.present.na ? totalsParsed.macros.na : null,
        k: totalsParsed.present.k ? totalsParsed.macros.k : null,
      }, factor);
      per100 = {
        kcal: fromTotals.kcal,
        p: totalsParsed.present.p ? fromTotals.p : (per100Parsed.present.p ? per100Parsed.macros.p : 0),
        c: totalsParsed.present.c ? fromTotals.c : (per100Parsed.present.c ? per100Parsed.macros.c : 0),
        f: totalsParsed.present.f ? fromTotals.f : (per100Parsed.present.f ? per100Parsed.macros.f : 0),
        fb: totalsParsed.present.fb ? fromTotals.fb : (per100Parsed.present.fb ? per100Parsed.macros.fb : 0),
        na: totalsParsed.present.na ? fromTotals.na : (per100Parsed.present.na ? per100Parsed.macros.na : null),
        k: totalsParsed.present.k
          ? fromTotals.k
          : (per100Parsed.present.k ? per100Parsed.macros.k : null),
      };
      derivedFromTotals = true;
      const mixed = ["p", "c", "f", "fb", "na"].filter((k) => !totalsParsed.present[k] && per100Parsed.present[k]);
      if (mixed.length) {
        warnings.push(`Totals line incomplete — kept Per 100 g for ${mixed.map((k) => ({ p: "protein", c: "carbs", f: "fat", fb: "fiber", na: "sodium" }[k])).join(", ")}.`);
      }
    } else if (chatgptPer100) {
      per100 = { ...chatgptPer100 };
    }

    if (!per100) {
      rejects.push("Need macros: provide Per 100 g, or Totals plus Batch weight.");
      per100 = { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: null, k: null };
    }

    const requiredPresent = (k) => !!(totalsParsed.present[k] || per100Parsed.present[k]);
    for (const [k, label] of [["kcal", "kcal"], ["p", "protein"], ["c", "carbs"], ["f", "fat"]]) {
      if (!requiredPresent(k)) rejects.push(`${label} missing from the macro line.`);
    }
    if (!per100Parsed.present.fb && !totalsParsed.present.fb) {
      warnings.push("Fiber missing — defaulting to 0 (you can edit).");
      per100.fb = per100.fb || 0;
    }
    if (!per100Parsed.present.na && !totalsParsed.present.na) {
      per100.na = null;
      warnings.push("Sodium not given — left blank, not zero. Sodium and Na:K scoring wait for enough known data.");
    }
    // Potassium stays null when absent. Defaulting it to 0 the way the other
    // fields do would make an unrecorded food look potassium-free, which drags
    // the Na:K ratio upward and would report a worse ratio than reality.
    if (!per100Parsed.present.k && !totalsParsed.present.k) {
      per100.k = null;
      warnings.push("Potassium not given — left blank, not zero. The Na:K ratio skips foods without it.");
    }

    if (chatgptPer100 && derivedFromTotals) {
      const disagree = [];
      for (const [k, label] of [["kcal", "kcal"], ["p", "protein"], ["c", "carbs"], ["f", "fat"]]) {
        if (!per100Parsed.present[k] || !totalsParsed.present[k]) continue;
        const a = chatgptPer100[k];
        const b = per100[k];
        const diff = Math.abs(a - b);
        const pct = b ? (diff / Math.abs(b)) * 100 : 0;
        const thresh = k === "kcal" ? 5 : 1;
        if (pct > 8 && diff > thresh) disagree.push(`${label} ${a} vs ${b}`);
      }
      if (disagree.length) {
        warnings.push(
          `Per 100 g doesn't match Totals for ${disagree.join(", ")}. Using totals-based values where present.`
        );
      }
    }

    for (const [k, label] of [["kcal", "kcal"], ["p", "protein"], ["c", "carbs"], ["f", "fat"], ["fb", "fiber"]]) {
      const v = per100[k];
      if (!Number.isFinite(v) || v < 0) rejects.push(`${label} must be a non-negative number.`);
    }
    if (per100.na != null) {
      if (!Number.isFinite(per100.na) || per100.na < 0) {
        rejects.push("sodium must be a non-negative number, or left out.");
      } else if (per100.na > 40000) {
        // Beyond the practical ceiling of pure table salt (~39,300 mg Na/100 g); that is a unit slip.
        rejects.push("sodium per 100 g looks impossibly high (over 40000 mg) — check the units.");
      }
    }
    if (per100.k != null) {
      if (!Number.isFinite(per100.k) || per100.k < 0) {
        rejects.push("potassium must be a non-negative number, or left out.");
      } else if (per100.k > 60000) {
        // Beyond the practical ceiling even for concentrated potassium-chloride salt substitutes
        // (~52,400 mg K/100 g at the pure-compound extreme); that is a unit slip.
        rejects.push("potassium per 100 g looks impossibly high (over 60000 mg) — check the units.");
      } else if (per100.k > 3000) {
        // Real foods (dried herbs, instant coffee, cream of tartar, salt substitutes) can
        // legitimately exceed 3000 mg; warn instead of blocking so the value can still be saved.
        warnings.push("Potassium per 100 g is above the common range (over 3000 mg) — double-check the units before saving.");
      }
    }
    if (per100.kcal > 920) rejects.push("kcal per 100 g exceeds the physical max (~920).");
    if (per100.p + per100.c + per100.f > 105) rejects.push("Protein + carbs + fat exceed 100 g of food.");
    if (per100.kcal === 0 && (per100.p + per100.c + per100.f) > 0) rejects.push("kcal is 0 but macros are not.");
    if (batch.grams != null && (batch.grams < 10 || batch.grams > 20000)) rejects.push("Batch weight must be between 10 g and 20 kg.");
    if (batch.servings != null && (batch.servings < 1 || batch.servings > 100)) rejects.push("Servings must be between 1 and 100.");

    const atwater = 4 * per100.p + 4 * per100.c + 9 * per100.f;
    const atwaterDiff = Math.abs(per100.kcal - atwater);
    if (atwaterDiff > Math.max(25, 0.2 * Math.max(per100.kcal, 1))) {
      warnings.push(`Energy check: ${round1(atwater)} kcal from macros vs ${per100.kcal} listed (difference ${round1(atwaterDiff)}).`);
    }
    if (per100.fb > per100.c + 2) warnings.push("Fiber is higher than carbs — unusual.");
    if (per100.na > 5000) warnings.push("Sodium per 100 g is extremely high.");
    if (cat === "dish" && !ingredientLines.length) warnings.push("No ingredients listed for this dish.");
    if (block.truncated) warnings.push("The paste looks cut off (no END).");

    const logAsParsed = parseLogAs(fields.logAs);
    const units = {};
    const servingG = parseGramsField(fields.serving);
    let pieceG = parseGramsField(fields.piece);
    // Only an explicit Serving line (not batch÷servings) may set units.serving.
    if (servingG) units.serving = servingG;
    // Log as piece without Piece → derive one item from pack math into piece only.
    if (!pieceG && logAsParsed === "piece" && batch.grams && batch.servings) {
      pieceG = Math.round(batch.grams / batch.servings);
    }
    if (!pieceG && logAsParsed === "piece" && servingG) pieceG = servingG;
    if (pieceG) units.piece = pieceG;
    if (batch.grams) units.batch = batch.grams;

    const logAs = logAsParsed || (units.piece ? "piece" : "grams");
    if (logAs === "piece" && !units.piece) {
      warnings.push("Log as is piece, but Piece grams are missing — add Piece so you can log 1 or 2 items.");
    }

    let countLabel = null;
    if (logAs === "piece") {
      const rawLabel = String(fields.countAs || "").trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/)[0];
      countLabel = rawLabel || inferCountLabel(name, aliases);
    }

    const prep = prepParts.join("\n").slice(0, 1000);
    const notes = notesParts.join("\n").slice(0, 1000);
    const hasIngredients = ingredientLines.length > 0;
    const weighed = batch.grams != null ? batch.weighed : true;
    if (batch.grams != null && !weighed) warnings.push("Batch weight was estimated — weigh the finished dish next time for tighter numbers.");
    if (confidence === "low") warnings.push("Confidence is low — double-check the review numbers before saving.");
    const sd = sdFor(confidence, weighed, hasIngredients);

    const food = {
      name: name || "untitled",
      aliases: aliases.length ? aliases : (name ? [name.toLowerCase()] : []),
      cat,
      per100,
      units,
      logAs,
      countLabel,
      batch: batch.grams
        ? { grams: batch.grams, servings: batch.servings || 1, weighed }
        : null,
      recipe: {
        ingredients: ingredientLines,
        prep,
        notes,
      },
      confidence,
      sd,
      chatgptPer100,
      derivedFromTotals,
    };

    return {
      ok: rejects.length === 0 && !!name && per100.kcal >= 0 && (derivedFromTotals || !!chatgptPer100 || per100.kcal > 0 || (per100.p + per100.c + per100.f) === 0),
      canSave: rejects.length === 0 && !!name && Number.isFinite(per100.kcal),
      food,
      warnings,
      rejects,
      unknownLines,
      truncated: block.truncated,
      raw: originalPaste || block.rawBlock,
      found: true,
    };
  }

  /** Parse paste text → { found, results[] } or single-result helpers. */
  function parse(text) {
    const original = String(text || "");
    const blocks = extractBlocks(original);
    if (!blocks.length) {
      return {
        found: false,
        results: [],
        error: "I couldn't find a NUTRI v1 block in that. The AI may have replied in its own format; ask it to use NUTRI v1 … END.",
      };
    }
    const results = blocks.map((b) => parseBlock(b, original));
    return { found: true, results };
  }

  return { PROMPT, updatePrompt, foodUpdatePrompt, parse, preprocess, extractBlocks, parseMacros, parseBatch };
})();

if (typeof module !== "undefined") module.exports = NutriParse;
