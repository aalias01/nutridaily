/* NutriDaily — NUTRI v1 paste parser.
 * Deterministic only. ChatGPT lives outside the app; this module owns numbers.
 */
const NutriParse = (() => {
  const CATS = new Set(["dish", "meat", "protein", "grain", "legume", "veg", "fruit", "dairy", "fat", "nuts", "bev", "snack"]);

  const PROMPT =
    "You are a nutrition data formatter. I will describe a dish I cooked. Reply with ONE fenced code\n" +
    "block and nothing else, in exactly this format:\n\n" +
    "NUTRI v1\n" +
    "Name: <short dish name>\n" +
    "Aliases: <other names I might search for, comma separated>\n" +
    "Category: <one of: dish, meat, protein, grain, legume, veg, fruit, dairy, fat, nuts, bev, snack>\n" +
    "Batch: <finished weight in grams> g total, <number> servings\n" +
    "Totals: <kcal> kcal | P <g> | C <g> | F <g> | Fiber <g> | Sodium <mg>\n" +
    "Per 100 g: <kcal> kcal | P <g> | C <g> | F <g> | Fiber <g> | Sodium <mg>\n" +
    "Ingredients:\n" +
    "- <ingredient> - <amount in grams>\n" +
    "Prep: <one or two lines: cooking method, oil used, anything that changes the numbers>\n" +
    "Notes: <assumptions you made>\n" +
    "Confidence: <high | medium | low>\n" +
    "END\n\n" +
    "Rules:\n" +
    "- Plain numbers only. No ranges, no \"approx\", no units inside the number.\n" +
    "- Totals are for the FINISHED dish, after cooking.\n" +
    "- If I told you the finished weight, use it. If I did not, estimate it and write \"(estimated)\"\n" +
    "  after the number, like: Batch: 760 g total (estimated), 4 servings.\n" +
    "- Per 100 g must equal Totals divided by Batch grams, times 100. Do that arithmetic and check it.\n" +
    "- Use USDA-style values. Account for oil absorbed and water lost in cooking.\n" +
    "- Sodium in milligrams. Everything else in grams.\n" +
    "- No commentary before or after the code block.\n\n" +
    "My dish:\n";

  function updatePrompt(raw) {
    return PROMPT + "\nThis is my current saved version. Return a corrected block in the same format:\n" + String(raw || "");
  }

  function preprocess(text) {
    let s = String(text || "");
    s = s.replace(/\u00a0/g, " ");
    s = s.replace(/[\u2013\u2014\u2212]/g, "-");
    s = s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"');
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
      const endMatch = rest.match(/\n\s*END\s*(?:\n|$)/i);
      let body, truncated = false;
      if (endMatch) {
        body = rest.slice(0, endMatch.index);
      } else {
        body = rest;
        truncated = true;
      }
      blocks.push({ body: body.replace(/^\s*\n/, ""), truncated, rawBlock: src.slice(m.index, start + (endMatch ? endMatch.index + endMatch[0].length : rest.length)) });
      if (endMatch) re.lastIndex = start + endMatch.index + endMatch[0].length;
      else break;
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
    serving: "serving",
    piece: "piece", each: "piece", "per piece": "piece",
    ingredients: "ingredients",
    prep: "prep", preparation: "prep", method: "prep",
    notes: "notes",
    confidence: "confidence",
  };

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
    const estimated = /\(estimated\)|\bapprox\b|\bapproximately\b|~/i.test(s);
    let grams = null, servings = null;
    const gTotal = s.match(/(-?\d+(?:\.\d+)?)\s*g(?:rams?)?\s*total/i);
    if (gTotal) grams = Number(gTotal[1]);
    const each = s.match(/(-?\d+(?:\.\d+)?)\s*g(?:rams?)?\s*each/i);
    const servN = s.match(/(-?\d+(?:\.\d+)?)\s*servings?\b/i) || s.match(/\bmakes\s+(-?\d+(?:\.\d+)?)/i);
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
      na: Math.round((m.na || 0) * factor),
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
        if (!k) {
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
    if (per100Parsed.present.kcal) chatgptPer100 = {
      kcal: per100Parsed.macros.kcal || 0,
      p: per100Parsed.macros.p || 0,
      c: per100Parsed.macros.c || 0,
      f: per100Parsed.macros.f || 0,
      fb: per100Parsed.macros.fb || 0,
      na: per100Parsed.macros.na || 0,
    };

    let per100 = null;
    let derivedFromTotals = false;
    if (totalsParsed.present.kcal && batch.grams && batch.grams >= 10) {
      per100 = scaleMacros({
        kcal: totalsParsed.macros.kcal || 0,
        p: totalsParsed.macros.p || 0,
        c: totalsParsed.macros.c || 0,
        f: totalsParsed.macros.f || 0,
        fb: totalsParsed.macros.fb || 0,
        na: totalsParsed.macros.na || 0,
      }, 100 / batch.grams);
      derivedFromTotals = true;
    } else if (chatgptPer100) {
      per100 = { ...chatgptPer100 };
    }

    if (!per100) {
      rejects.push("Need macros: provide Per 100 g, or Totals plus Batch weight.");
      per100 = { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0 };
    }

    const softMissing = [];
    if (!(totalsParsed.present.fb || per100Parsed.present.fb || (derivedFromTotals && totalsParsed.present.fb))) {
      if (!per100Parsed.present.fb && !totalsParsed.present.fb) softMissing.push("fiber");
    }
    if (!per100Parsed.present.fb && !totalsParsed.present.fb) {
      warnings.push("Fiber missing — defaulting to 0 (you can edit).");
      per100.fb = per100.fb || 0;
    }
    if (!per100Parsed.present.na && !totalsParsed.present.na) {
      warnings.push("Sodium missing — defaulting to 0 (you can edit).");
      per100.na = per100.na || 0;
    }

    if (chatgptPer100 && derivedFromTotals) {
      const diff = Math.abs(chatgptPer100.kcal - per100.kcal);
      const pct = per100.kcal ? (diff / per100.kcal) * 100 : 0;
      if (pct > 8 && diff > 5) {
        warnings.push(
          `ChatGPT's per-100 g line (${chatgptPer100.kcal} kcal) doesn't match its own totals (${per100.kcal} kcal). Using the totals-based value.`
        );
      }
    }

    for (const [k, label] of [["kcal", "kcal"], ["p", "protein"], ["c", "carbs"], ["f", "fat"], ["fb", "fiber"], ["na", "sodium"]]) {
      const v = per100[k];
      if (!Number.isFinite(v) || v < 0) rejects.push(`${label} must be a non-negative number.`);
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

    const units = {};
    if (fields.serving) {
      const n = Number(String(fields.serving).match(/-?\d+(?:\.\d+)?/)?.[0]);
      if (Number.isFinite(n) && n > 0) units.serving = n;
    } else if (batch.grams && batch.servings) {
      units.serving = Math.round(batch.grams / batch.servings);
    }
    if (fields.piece) {
      const n = Number(String(fields.piece).match(/-?\d+(?:\.\d+)?/)?.[0]);
      if (Number.isFinite(n) && n > 0) units.piece = n;
    }
    if (batch.grams) units.batch = batch.grams;

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
      softMissing,
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
        error: "I couldn't find a NUTRI v1 block in that. ChatGPT may have replied in its own format.",
      };
    }
    const results = blocks.map((b) => parseBlock(b, original));
    return { found: true, results };
  }

  return { PROMPT, updatePrompt, parse, preprocess, extractBlocks, parseMacros, parseBatch };
})();

if (typeof module !== "undefined") module.exports = NutriParse;
