/* NutriDaily — GAP v1 close-the-gap prompt + paste parser.
 * Deterministic only. LLMs live outside the app.
 * A GAP block may contain 2–3 Option sections (tradeoffs); legacy single-plan blocks still parse.
 */
const GapPrompt = (() => {
  const GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium", "potassium"];
  const MEALS = ["breakfast", "lunch", "dinner", "snack"];
  const TOTAL_KEY = { kcal: "kcal", protein: "p", carbs: "c", fat: "f", fiber: "fb", sodium: "na", potassium: "k" };
  const MINERAL_COVERAGE_MIN = 0.8;
  const LIMITS = Object.freeze({
    rawChars: 12000,
    lines: 200,
    // Longest persisted field is a 2,000-character Note plus its protocol key.
    lineChars: 4096,
    options: 10,
    labelChars: 160,
    noteChars: 2000,
    nameChars: 160,
    quantity: 1e9,
    grams: 1e9,
    nutrient: 1e9,
  });

  const BAND_HINT = {
    kcal: "range, ±10%",
    protein: "floor, hit or exceed",
    carbs: "range, ±15%",
    fat: "range, ±15%",
    fiber: "report only, not a hit target",
    sodium: "ceiling only, lower is better; warn if over",
    potassium: "food-based floor when coverage is adequate; do not suggest supplements or salt substitutes",
  };

  function fmtNum(n, digits) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "0";
    if (digits == null) return String(Math.round(x));
    return (Math.round(x * 10 ** digits) / 10 ** digits).toFixed(digits);
  }

  /** Map Ledger.totalsFor shape → long goal keys (means). */
  function totalsMeans(totals) {
    const out = {};
    for (const k of GOAL_KEYS) {
      const short = TOTAL_KEY[k];
      const cell = totals && totals[short];
      out[k] = cell && Number.isFinite(cell.mean) ? cell.mean : 0;
    }
    return out;
  }

  function remainingFrom(means, goals, totals) {
    // Honour plan exemptions the same way Today and Insights do: a declared
    // fast with no calories has nothing to "close", and a reduced day with
    // unscored protein must not ask for a floor the score already dropped.
    const scoring = (typeof Phases !== "undefined" && typeof Phases.effectiveGoals === "function")
      ? Phases.effectiveGoals(totals || null, goals)
      : goals;
    const unscored = (scoring && scoring._unscored) || null;
    const out = {};
    for (const k of GOAL_KEYS) {
      if (unscored && unscored[k]) {
        out[k] = 0;
        continue;
      }
      const g = Number(scoring && scoring[k]) || 0;
      const a = Number(means && means[k]) || 0;
      out[k] = Math.round((g - a) * 10) / 10;
    }
    return out;
  }

  /** Short-key macros ({kcal,p,c,f,fb,na}) → long goal keys. */
  function macroMeans(macros) {
    const out = {};
    for (const k of GOAL_KEYS) {
      const v = Number(macros && macros[TOTAL_KEY[k]]);
      out[k] = Number.isFinite(v) ? v : 0;
    }
    return out;
  }

  /** End-of-day projection: logged means plus each pending addend (long goal keys). */
  function projectTotals(means, addends) {
    const out = {};
    for (const k of GOAL_KEYS) {
      let sum = Number(means && means[k]) || 0;
      for (const a of (addends || [])) sum += Number(a && a[k]) || 0;
      out[k] = Math.round(sum * 10) / 10;
    }
    return out;
  }

  function portionLine(portion) {
    if (!portion || !portion.n) return "no history";
    const bits = [`n=${portion.n}`];
    if (portion.p25 != null && portion.p75 != null) {
      bits.push(`preferred ${fmtNum(portion.p25)}–${fmtNum(portion.p75)} g`);
    }
    if (portion.median != null) bits.push(`median ${fmtNum(portion.median)} g`);
    if (portion.last != null) bits.push(`last ${fmtNum(portion.last)} g`);
    return bits.join("; ");
  }

  function per100Line(per100) {
    const p = per100 || {};
    return (
      `${fmtNum(p.kcal)} kcal | P ${fmtNum(p.p, 1)} | C ${fmtNum(p.c, 1)} | F ${fmtNum(p.f, 1)}` +
      ` | Fiber ${fmtNum(p.fb, 1)} | Sodium ${p.na == null ? "unknown" : fmtNum(p.na)} mg` +
      ` | Potassium ${p.k == null ? "unknown" : fmtNum(p.k)} mg (per 100 g)`
    );
  }

  /**
   * @param {{
   *   day: string,
   *   logged?: Array<{name:string, grams?:number, displayQty?:string, meal?:string, macros?:object}>,
   *   totals?: object,
   *   goals?: object,
   *   candidates?: Array<object>
   * }} ctx
   */
  function buildGapPrompt(ctx) {
    const day = ctx.day || "";
    const means = ctx.totals && ctx.totals.kcal
      ? totalsMeans(ctx.totals)
      : (ctx.means || { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0, potassium: 0 });
    const goals = ctx.goals || {};
    const remaining = ctx.remaining || remainingFrom(means, goals, ctx.totals);
    const logged = Array.isArray(ctx.logged) ? ctx.logged : [];
    const candidates = Array.isArray(ctx.candidates) ? ctx.candidates : [];
    const sodiumCoverage = Number(ctx.totals && ctx.totals.naCoverage);
    const sodiumCovered = !ctx.totals || !ctx.totals.count ||
      !Number.isFinite(sodiumCoverage) || sodiumCoverage >= 0.8;

    let loggedBlock = "(nothing logged yet)\n";
    if (logged.length) {
      loggedBlock = logged.map((e) => {
        const qty = e.displayQty || (e.grams != null ? `${fmtNum(e.grams)} g` : "?");
        const m = e.macros || {};
        return (
          `- ${e.name}: ${qty} (${e.meal || "snack"}) → ` +
          `${fmtNum(m.kcal)} kcal | P ${fmtNum(m.p, 1)} | C ${fmtNum(m.c, 1)} | F ${fmtNum(m.f, 1)}` +
          ` | Fiber ${fmtNum(m.fb, 1)} | Sodium ${m.na == null ? "unknown" : fmtNum(m.na)}` +
          ` | Potassium ${m.k == null ? "unknown" : fmtNum(m.k)}`
        );
      }).join("\n") + "\n";
    }

    const remBits = [];
    for (const k of ["kcal", "protein", "carbs", "fat"]) {
      const g = Number(goals[k]) || 0;
      const a = Number(means[k]) || 0;
      const unit = k === "kcal" ? "" : " g";
      if (!(g > 0)) {
        remBits.push(`${k} ${fmtNum(a)}${unit} logged (no target set)`);
        continue;
      }
      const sign = remaining[k] > 0 ? "+" : "";
      remBits.push(`${k} ${sign}${fmtNum(remaining[k])}${unit} (${BAND_HINT[k]})`);
    }
    {
      const g = Number(goals.fiber) || 0;
      const a = Number(means.fiber) || 0;
      if (g > 0) remBits.push(`fiber ${fmtNum(a, 1)} of ${fmtNum(g)} g (${BAND_HINT.fiber})`);
      else remBits.push(`fiber ${fmtNum(a, 1)} g logged (no target)`);
    }
    {
      const g = Number(goals.potassium) || 0;
      const a = Number(means.potassium) || 0;
      const kCoverage = Number(ctx.totals && ctx.totals.kCoverage);
      const covered = !ctx.totals || !ctx.totals.count || !Number.isFinite(kCoverage) || kCoverage >= 0.8;
      if (!(g > 0)) {
        remBits.push(`potassium ${fmtNum(a)} mg logged (no target set${covered ? "" : "; incomplete data"})`);
      } else if (!covered) {
        remBits.push(`potassium ${fmtNum(a)} mg recorded, but coverage is ${fmtNum(kCoverage * 100)}% — treat as incomplete, not a verified shortfall`);
      } else {
        remBits.push(`potassium ${fmtNum(a)} of ${fmtNum(g)} mg (${BAND_HINT.potassium})`);
      }
    }
    {
      const g = Number(goals.sodium) || 0;
      const a = Number(means.sodium) || 0;
      const headroom = Number(remaining.sodium) || 0;
      if (!sodiumCovered) {
        remBits.push(`sodium ${fmtNum(a)} mg known subtotal; coverage is ${fmtNum(sodiumCoverage * 100)}% — incomplete, so do not compare it with the full ceiling`);
      } else if (!(g > 0)) {
        remBits.push(`sodium ${fmtNum(a)} mg logged (no ceiling set)`);
      } else if (headroom >= 0) {
        remBits.push(`sodium headroom +${fmtNum(headroom)} mg (${BAND_HINT.sodium})`);
      } else {
        remBits.push(`sodium OVER by ${fmtNum(Math.abs(headroom))} mg (${BAND_HINT.sodium})`);
      }
    }
    const remLine = remBits.join("; ");
    const sodiumRules = sodiumCovered
      ? (
        "- Sodium: ceiling only. Lower is better. Do NOT try to \"reach\" the sodium number.\n" +
        "  Prefer to stay under the ceiling. Options 1–2 may still overshoot when the candidate set forces it;\n" +
        "  if projected sodium exceeds the ceiling, warn clearly in Note (e.g. \"Sodium over ceiling by ~X mg\") and set Reachable: no.\n" +
        "- Reachable: yes means projected protein meets the floor AND projected sodium is at or under the ceiling\n" +
        "  (or no sodium ceiling is set). Deliberate kcal/carbs/fat drift does not by itself make Reachable: no — describe it in Note.\n" +
        "- If an option misses the protein floor or breaks the sodium ceiling, set Reachable: no and explain in Note.\n"
      )
      : (
        `- Sodium coverage is only ${fmtNum(sodiumCoverage * 100)}%. Treat every projected sodium value as a known subtotal, not a full-day total.\n` +
        "  Do NOT calculate sodium headroom or overshoot, compare the subtotal with the full ceiling, or use sodium to decide Reachable.\n" +
        "- Reachable: yes means projected protein meets the floor. Deliberate kcal/carbs/fat drift does not by itself make Reachable: no.\n" +
        "  Disclose incomplete sodium in each Note; do not claim that its ceiling passes or fails.\n" +
        "- If an option misses the protein floor, set Reachable: no and explain in Note.\n"
      );

    let candBlock = "(no candidates selected)\n";
    if (candidates.length) {
      candBlock = candidates.map((c, i) => {
        const piece = c.pieceGrams != null && Number.isFinite(c.pieceGrams)
          ? `; piece = ${fmtNum(c.pieceGrams)} g`
          : "";
        const logAs = c.logAs ? `; logAs ${c.logAs}` : "";
        const src = c.provenance === "ref"
          ? "Reference · USDA-style avg"
          : (c.provenance === "ai" ? "Yours · AI estimate" : "Yours");
        return (
          `${i + 1}. ${c.name}\n` +
          `   Source: ${src}\n` +
          `   Per 100 g: ${per100Line(c.per100)}\n` +
          `   Typical portion: ${portionLine(c.portion)}${piece}${logAs}`
        );
      }).join("\n") + "\n";
    }

    return (
      "You are a sports-nutrition assistant helping me close today's macro gap in NutriDaily.\n" +
      `Day: ${day}\n\n` +
      "Already logged today (do not change these; they are already eaten):\n" +
      loggedBlock +
      "\n" +
      "Totals so far:\n" +
      `- ${fmtNum(means.kcal)} kcal | P ${fmtNum(means.protein, 1)} | C ${fmtNum(means.carbs, 1)}` +
      ` | F ${fmtNum(means.fat, 1)} | Fiber ${fmtNum(means.fiber, 1)} | Sodium ${fmtNum(means.sodium)}${sodiumCovered ? "" : " known subtotal (incomplete)"}` +
      ` | Potassium ${fmtNum(means.potassium)}\n\n` +
      "Daily targets:\n" +
      (Number(goals.kcal) > 0 || Number(goals.protein) > 0
        ? `- ${fmtNum(goals.kcal)} kcal | P ${fmtNum(goals.protein)} | C ${fmtNum(goals.carbs)}` +
          ` | F ${fmtNum(goals.fat)}` +
          ` | Fiber ${fmtNum(goals.fiber)} g (report only)` +
          ` | Sodium ${fmtNum(goals.sodium)} mg (ceiling — lower is better)` +
          ` | Potassium ${fmtNum(goals.potassium)} mg (food-based floor; only judge when recorded coverage is adequate)\n\n`
        : "- (no kcal/protein targets set — propose sensible portions from history only; say so in Note)\n\n") +
      `Gap / status: ${remLine}\n` +
      "(For kcal/protein/carbs/fat: positive = still to add, negative = already over. Ignore gap math when no target is set.)\n\n" +
      "Candidate foods I plan to eat (ONLY assign quantities to these exact names):\n" +
      candBlock +
      "\n" +
      "Task:\n" +
      "- Propose exactly 3 plan OPTIONS with different tradeoffs. I will pick one in the app.\n" +
      "  Use these exact short labels on the Option line. Parentheticals are guidance for you only; do not put them on the Option line.\n" +
      "  1 | All selected (MUST include every candidate above with a positive qty; best overall fit among full-set plans)\n" +
      "  2 | Protect protein (may omit foods; prioritize the protein floor even if kcal/carbs/fat drift)\n" +
      "  3 | Lowest sodium (may omit foods; minimize sodium and avoid kcal overshoot; still meet protein if candidates allow; say so in Note if not)\n" +
      "- Each option must have its own Reachable, Note, Item lines, and Projected line.\n" +
      "- Projected = end-of-day totals for the WHOLE day: everything already logged above PLUS this option's items. Not just the new items.\n" +
      "- Prefer each food's preferred portion range when n ≥ 3. Stay near median/last when history is thin.\n" +
      "- Hit rules: protein is a floor; kcal/carbs/fat are soft ranges.\n" +
      "- Fiber: report in Projected only. Do NOT treat fiber as something to hit; fiber shortfalls never make Reachable: no.\n" +
      sodiumRules +
      "- Potassium: favor ordinary potassium-rich foods when values are known. Do not suggest supplements or potassium salt substitutes.\n" +
      "  A potassium shortfall does not by itself make Reachable: no because food data may be incomplete; disclose it in Note.\n" +
      "  Still give honest quantities for that strategy. Do not collapse to a single option when tradeoffs exist.\n" +
      "- Do NOT invent Item lines for foods not listed above. Use each candidate's exact Name.\n" +
      "- Qty MUST include a unit: `120 g` or `2 piece` (never a bare number). No thousands separators (write 1200 not 1,200).\n" +
      "- For countable candidates (logAs piece), prefer `N piece` over grams.\n" +
      "- Option 1 MUST have an Item line for EVERY candidate I selected (all names listed above). Never omit on Option 1.\n" +
      "  If the full set cannot hit targets cleanly, still include every food, set Reachable appropriately, and explain in Note.\n" +
      "  I will refine in chat (or deselect in the app) if I want fewer foods — do not silently drop foods from Option 1.\n" +
      "- Options 2–3 MAY omit Item lines for foods that strategy should skip (do not write 0 g).\n" +
      "- Plain numbers only (no commas in numbers). Reply with exactly one GAP v1 … END block containing three Option sections. Do not emit any other block type.\n\n" +
      "Reply exactly in this format:\n\n" +
      "GAP v1\n" +
      `Day: ${day || "<YYYY-MM-DD>"}\n` +
      "Option: 1 | All selected\n" +
      "Reachable: yes\n" +
      "Note: <tradeoff in one or two sentences>\n" +
      "Item: <exact candidate name> | <n> g | <meal>\n" +
      "Item: <exact candidate name> | <n> piece | <meal>\n" +
      "Projected: <kcal> kcal | P <g> | C <g> | F <g> | Fiber <g> | Sodium <mg> | Potassium <mg>\n" +
      "Option: 2 | Protect protein\n" +
      "(same fields; may omit some candidates)\n" +
      "Option: 3 | Lowest sodium\n" +
      "(same fields; may omit some candidates)\n" +
      "END\n"
    );
  }

  function preprocess(text) {
    let s = String(text || "");
    s = s.replace(/\u00a0/g, " ");
    s = s.replace(/[\u2013\u2014\u2212]/g, "-");
    s = s.replace(/(\d),(\d{3})\b/g, "$1$2");
    s = s.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    return s;
  }

  /** Prefer the last complete GAP v1 … END block (chat iterations often include drafts). */
  function extractBody(text) {
    const src = preprocess(text);
    const re = /GAP\s*v?1\b/gi;
    let m;
    let lastComplete = null;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length;
      const rest = src.slice(start);
      const endMatch = rest.match(/\n\s*END\s*[.!?]?(?:\n|$)/i);
      // Do not let a later protocol block's END accidentally "complete" a
      // truncated GAP block pasted before it.
      const nextBlock = rest.match(/\n\s*(?:GAP|NUTRI|PHASE)\s*v?\d+\b/i);
      if (endMatch && (!nextBlock || endMatch.index < nextBlock.index)) {
        const body = rest.slice(0, endMatch.index).replace(/^\s*\n/, "");
        lastComplete = body;
        re.lastIndex = start + endMatch.index + endMatch[0].length;
      }
    }
    return lastComplete;
  }

  function normalizeMeal(raw) {
    const t = String(raw || "").trim().toLowerCase();
    if (MEALS.includes(t)) return t;
    if (t === "breakfasts") return "breakfast";
    if (t === "lunches") return "lunch";
    if (t === "dinners") return "dinner";
    if (t === "snacks") return "snack";
    return "snack";
  }

  function parseProjected(val) {
    const s = String(val || "");
    const out = {};
    const kcal = s.match(/(-?\d+(?:\.\d+)?)\s*kcal/i);
    if (kcal) out.kcal = Math.round(Number(kcal[1]));
    const p = s.match(/\bP(?:rotein)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    const c = s.match(/\bC(?:arbs?)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    const f = s.match(/\bF(?:at)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    const fb = s.match(/\bFiber\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    const na = s.match(/\bSodium\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    const k = s.match(/\bPotassium\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    if (p) out.protein = Math.round(Number(p[1]));
    if (c) out.carbs = Math.round(Number(c[1]));
    if (f) out.fat = Math.round(Number(f[1]));
    if (fb) out.fiber = Math.round(Number(fb[1]));
    if (na) out.sodium = Math.round(Number(na[1]));
    if (k) out.potassium = Math.round(Number(k[1]));
    for (const key of Object.keys(out)) {
      if (!Number.isFinite(out[key]) || out[key] < 0) delete out[key];
    }
    return out;
  }

  function parseQtyField(raw) {
    const s = String(raw || "").trim().toLowerCase();
    const range = s.match(/^(-?\d+(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/i);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      const unitPresent = !!range[3];
      let unit = (range[3] || "g").toLowerCase();
      if (unit === "grams" || unit === "gram") unit = "g";
      if (unit === "pieces") unit = "piece";
      const qty = Math.round(((a + b) / 2) * 10) / 10;
      if (!Number.isFinite(qty) || qty <= 0 || qty > LIMITS.quantity) return null;
      const gramsHint = unit === "g" ? qty : (unit === "oz" ? Math.round(qty * 28.3495 * 10) / 10 : null);
      return { qty, unit, gramsHint, ranged: true, rangeText: s, unitPresent, unknownUnit: unitPresent && !(unit === "g" || unit === "oz" || unit === "piece" || unit === "serving") };
    }
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (!m) return null;
    const qty = Number(m[1]);
    if (!Number.isFinite(qty) || qty <= 0 || qty > LIMITS.quantity) return null;
    const unitPresent = !!m[2];
    let unit = (m[2] || "g").toLowerCase();
    if (unit === "grams" || unit === "gram") unit = "g";
    if (unit === "pieces") unit = "piece";
    if (unit === "servings") unit = "serving";
    const known = unit === "g" || unit === "oz" || unit === "piece" || unit === "serving";
    const gramsHint = unit === "g" ? qty : (unit === "oz" ? Math.round(qty * 28.3495 * 10) / 10 : null);
    return { qty, unit, gramsHint, ranged: false, unknownUnit: unitPresent && !known, unitPresent };
  }

  function matchCandidate(name, candidates, scorer) {
    const list = Array.isArray(candidates) ? candidates : [];
    const t = String(name || "").trim().toLowerCase();
    if (!t) return { cand: null, score: 0, exact: false, ambiguous: false };
    for (const c of list) {
      if (String(c.name || "").trim().toLowerCase() === t) {
        return { cand: c, score: 1, exact: true, ambiguous: false };
      }
    }
    if (typeof scorer !== "function" || !list.length) {
      return { cand: null, score: 0, exact: false, ambiguous: false };
    }
    const scored = list.map((c) => ({ c, s: scorer(t, c.name) })).sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (!best || best.s < 0.55) return { cand: null, score: 0, exact: false, ambiguous: false };
    const second = scored[1];
    const ambiguous = !!(second && second.s >= 0.55 && (best.s - second.s) < 0.08);
    if (ambiguous) return { cand: null, score: best.s, exact: false, ambiguous: true };
    return { cand: best.c, score: best.s, exact: false, ambiguous: false };
  }

  /** Whitelist explicit yes/no values; commentary such as "maybe" is incomplete. */
  function parseReachable(val) {
    const v = String(val || "").trim().replace(/^\*+|\*+$/g, "").replace(/^`+|`+$/g, "").trim().toLowerCase();
    if (/^(yes|y|true|1)\b/.test(v)) return { reachable: true, unknown: false };
    if (/^(no|n|false|0)\b/.test(v)) {
      return { reachable: false, unknown: false };
    }
    return { reachable: false, unknown: true };
  }

  function addIssue(issues, flag, message, warnings) {
    issues = Array.isArray(issues) ? issues : [];
    if (!issues.some((x) => x.flag === flag && x.message === message)) issues.push({ flag, message });
    if (message && warnings && !warnings.includes(message)) warnings.push(message);
  }

  function normalizeUnit(unit) {
    const raw = String(unit || "").trim().toLowerCase();
    const aliases = {
      gram: "g", grams: "g", gm: "g", gms: "g",
      ounce: "oz", ounces: "oz",
      pieces: "piece", pc: "piece", pcs: "piece",
      servings: "serving",
    };
    return aliases[raw] || raw;
  }

  /** Resolve a parsed quantity only from conversions actually carried by the selected food. */
  function resolveCandidateGrams(qtyParsed, cand) {
    const qty = Number(qtyParsed && qtyParsed.qty);
    let unit = normalizeUnit(qtyParsed && qtyParsed.unit);
    let assumed = false;
    if (!qtyParsed || !Number.isFinite(qty) || qty <= 0) {
      return { ok: false, unit, grams: null, assumed, reason: "invalid quantity" };
    }

    if (!qtyParsed.unitPresent) {
      const pieceG = Number(cand && (cand.pieceGrams != null
        ? cand.pieceGrams
        : cand.units && cand.units.piece));
      if (cand && (cand.logAs === "piece" || Number.isFinite(pieceG)) && qty <= 12 && pieceG > 0) {
        unit = "piece";
      } else {
        unit = "g";
      }
      assumed = true;
    }

    let perUnit = null;
    if (unit === "g") perUnit = 1;
    else if (unit === "oz") perUnit = 28.3495;
    else if (unit === "piece") {
      perUnit = Number(cand && (cand.pieceGrams != null
        ? cand.pieceGrams
        : cand.units && cand.units.piece));
    } else if (unit === "serving") {
      perUnit = Number(cand && (cand.servingGrams != null
        ? cand.servingGrams
        : cand.units && cand.units.serving));
    } else if (cand && cand.units && Object.prototype.hasOwnProperty.call(cand.units, unit)) {
      perUnit = Number(cand.units[unit]);
    }

    if (!Number.isFinite(perUnit) || perUnit <= 0) {
      return { ok: false, unit, grams: null, assumed, reason: `unsupported unit "${unit || "(missing)"}"` };
    }
    const grams = Math.round(qty * perUnit * 10) / 10;
    if (!Number.isFinite(grams) || grams <= 0 || grams > LIMITS.grams) {
      return { ok: false, unit, grams: null, assumed, reason: "quantity exceeds the storage limit" };
    }
    return {
      ok: true,
      unit,
      grams,
      assumed,
      reason: "",
    };
  }

  function per100Value(per100, key) {
    const short = TOTAL_KEY[key];
    const raw = per100 && per100[short] != null ? per100[short] : per100 && per100[key];
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function nutrientsFor(cand, grams) {
    const out = {};
    const scale = Number(grams) / 100;
    for (const key of GOAL_KEYS) {
      const per100 = per100Value(cand && cand.per100, key);
      if (per100 == null || !Number.isFinite(scale)) {
        out[key] = null;
      } else {
        const value = per100 * scale;
        out[key] = key === "kcal" || key === "sodium" || key === "potassium"
          ? Math.round(value)
          : Math.round(value * 10) / 10;
      }
    }
    return out;
  }

  function parseItemLine(line, candidates, scorer, hasCandidateList, warnings, issues) {
    const itemM = line.replace(/^\*+\s*/, "").replace(/\*+$/, "")
      .replace(/^[-•]\s*/, "")
      .match(/^Item:\s*(.+)$/i);
    if (!itemM) return null;
    const parts = itemM[1].split("|").map((p) => p.trim().replace(/^\*+|\*+$/g, ""));
    if (parts.length < 2) {
      addIssue(issues, "incomplete-item", `Ignored incomplete Item line: ${line}`, warnings);
      return null;
    }
    const name = parts[0];
    if (!name || name.length > LIMITS.nameChars) {
      addIssue(issues, "invalid-name", "Ignored Item with an overlong or missing food name", warnings);
      return null;
    }
    const qtyParsed = parseQtyField(parts[1]);
    if (!qtyParsed || !(qtyParsed.qty > 0)) {
      addIssue(issues, "invalid-quantity", `Ignored Item with bad qty: ${name}`, warnings);
      return null;
    }
    if (qtyParsed.ranged) {
      addIssue(issues, "ranged-quantity", `Used midpoint of range for ${name}: ${qtyParsed.rangeText}`, warnings);
    }
    const mealRaw = parts[2] || "snack";
    const meal = normalizeMeal(mealRaw);
    if (String(mealRaw).trim() && meal === "snack" && !/^snacks?$/i.test(String(mealRaw).trim())) {
      warnings.push(`Unrecognized meal "${mealRaw}" for ${name}; treated as snack`);
    }
    const match = matchCandidate(name, candidates, scorer);
    if (hasCandidateList) {
      if (match.ambiguous) {
        addIssue(issues, "ambiguous-food", `Dropped ambiguous food name: ${name}`, warnings);
        return null;
      }
      if (!match.cand) {
        addIssue(issues, "unresolved-food", `Dropped unknown food (not in candidates): ${name}`, warnings);
        return null;
      }
      if (!match.exact) {
        addIssue(issues, "fuzzy-food-match", `Matched "${name}" → "${match.cand.name}"`, warnings);
      }
    }
    const cand = match.cand;
    const qty = qtyParsed.qty;
    const converted = resolveCandidateGrams(qtyParsed, cand);
    if (!converted.ok) {
      addIssue(issues, "unsupported-unit", `Dropped ${name}: ${converted.reason} for the selected food`, warnings);
      return null;
    }
    if (converted.assumed) {
      const message = converted.unit === "piece"
        ? `Assumed ${qty} piece for ${name} (qty had no unit)`
        : `No unit on qty for ${name}; treated as grams`;
      addIssue(issues, "missing-unit", message, warnings);
    }
    const nutrients = nutrientsFor(cand, converted.grams);
    if (Object.values(nutrients).some((value) => value != null &&
        (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > LIMITS.nutrient))) {
      addIssue(issues, "out-of-range-nutrients", `Dropped ${name}: local nutrients exceed storage limits`, warnings);
      return null;
    }
    return {
      name: cand ? cand.name : name,
      foodId: cand && cand.id ? cand.id : null,
      qty,
      unit: converted.unit,
      grams: converted.grams,
      meal,
      nutrients,
      macros: {
        kcal: nutrients.kcal,
        p: nutrients.protein,
        c: nutrients.carbs,
        f: nutrients.fat,
        fb: nutrients.fiber,
        na: nutrients.sodium,
        k: nutrients.potassium,
      },
      _candidate: cand || null,
    };
  }

  function clamp01(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(1, n));
  }

  function roundNutrient(key, value) {
    if (!Number.isFinite(value)) return null;
    return key === "kcal" || key === "sodium" || key === "potassium"
      ? Math.round(value)
      : Math.round(value * 10) / 10;
  }

  function readBaseMean(totals, means, key) {
    const short = TOTAL_KEY[key];
    const cell = totals && totals[short];
    if (cell && Number.isFinite(Number(cell.mean))) return Number(cell.mean);
    const raw = means && means[key] != null ? means[key] : means && means[short];
    return Number.isFinite(Number(raw)) ? Number(raw) : null;
  }

  /** Normalize the trusted, app-owned data needed for an end-of-day projection. */
  function localContext(raw) {
    const ctx = raw && typeof raw === "object" ? raw : null;
    const totals = ctx && (ctx.totals || ctx.loggedTotals || ctx.baseTotals) || null;
    const means = ctx && (ctx.means || ctx.loggedMeans || ctx.baseMeans) || null;
    const available = !!(totals || means);
    const base = {};
    let baseComplete = available;
    for (const key of GOAL_KEYS) {
      const value = readBaseMean(totals, means, key);
      if (value == null || value < 0) {
        base[key] = 0;
        if (!["sodium", "potassium"].includes(key)) baseComplete = false;
      } else {
        base[key] = value;
      }
    }

    let count = Number(totals && totals.count);
    if (!Number.isFinite(count)) count = Number(ctx && (ctx.count != null ? ctx.count : ctx.entryCount));
    if (!Number.isFinite(count) || count < 0) {
      count = available && GOAL_KEYS.some((key) => base[key] > 0) ? 1 : 0;
    }

    const coverageFor = (key, short, explicitName) => {
      if (count === 0) return 1;
      const explicit = clamp01(totals && totals[`${short}Coverage`]);
      if (explicit != null) return explicit;
      const direct = clamp01(ctx && (ctx[explicitName] != null ? ctx[explicitName] : ctx[`${short}Coverage`]));
      if (direct != null) return direct;
      const coveredBool = ctx && ctx[`${key}Covered`];
      if (coveredBool === true) return 1;
      if (coveredBool === false) return 0;
      // Legacy Ledger totals had a numeric mineral total but no coverage field.
      const cell = totals && totals[short];
      if (cell && Number.isFinite(Number(cell.mean))) return 1;
      return 0;
    };

    return {
      available,
      baseComplete,
      base,
      count,
      kcal: Math.max(0, Number(base.kcal) || 0),
      sodiumCoverage: coverageFor("sodium", "na", "sodiumCoverage"),
      potassiumCoverage: coverageFor("potassium", "k", "potassiumCoverage"),
      goals: ctx && ctx.goals && typeof ctx.goals === "object" ? ctx.goals : {},
    };
  }

  function combineCoverage(baseCoverage, baseCount, baseKcal, knownItems, knownKcal, itemCount, itemKcal) {
    const countDen = Math.max(0, baseCount) + Math.max(0, itemCount);
    const kcalDen = Math.max(0, baseKcal) + Math.max(0, itemKcal);
    if (!countDen) return 1;
    const knownBaseItems = Math.max(0, baseCount) * Math.max(0, Math.min(1, baseCoverage));
    const knownBaseKcal = Math.max(0, baseKcal) * Math.max(0, Math.min(1, baseCoverage));
    const itemShare = (knownBaseItems + Math.max(0, knownItems)) / countDen;
    const calorieShare = kcalDen > 0
      ? (knownBaseKcal + Math.max(0, knownKcal)) / kcalDen
      : itemShare;
    return Math.max(0, Math.min(1, Math.min(itemShare, calorieShare)));
  }

  function sumLocalItems(items, optionIndex, issues, warnings) {
    const sums = Object.fromEntries(GOAL_KEYS.map((key) => [key, 0]));
    const mineral = {
      sodium: { items: 0, kcal: 0 },
      potassium: { items: 0, kcal: 0 },
    };
    let complete = true;
    let itemKcal = 0;
    for (const item of items) {
      const nutrients = item.nutrients || nutrientsFor(item._candidate, item.grams);
      item.nutrients = nutrients;
      const missing = ["kcal", "protein", "carbs", "fat", "fiber"]
        .filter((key) => nutrients[key] == null);
      if (missing.length) {
        complete = false;
        addIssue(
          issues,
          "incomplete-nutrients",
          `Option ${optionIndex}: ${item.name} is missing local ${missing.join(", ")} data`,
          warnings
        );
      }
      for (const key of ["kcal", "protein", "carbs", "fat", "fiber"]) {
        if (nutrients[key] != null) sums[key] += nutrients[key];
      }
      const kcal = Math.max(0, Number(nutrients.kcal) || 0);
      itemKcal += kcal;
      for (const key of ["sodium", "potassium"]) {
        if (nutrients[key] == null) continue;
        sums[key] += nutrients[key];
        mineral[key].items += 1;
        mineral[key].kcal += kcal;
      }
    }
    for (const key of GOAL_KEYS) sums[key] = roundNutrient(key, sums[key]);
    return { additions: sums, mineral, complete, itemKcal };
  }

  function projectionDiffers(ai, local) {
    if (!ai || !local) return false;
    const tolerances = { kcal: 25, protein: 2, carbs: 3, fat: 2, fiber: 2, sodium: 50, potassium: 75 };
    return GOAL_KEYS.some((key) => Number.isFinite(Number(ai[key])) &&
      Math.abs(Number(ai[key]) - Number(local[key])) > tolerances[key]);
  }

  function finalizeOption(raw, context, warnings) {
    const issues = raw._issues || [];
    if (!raw._reachableSeen) {
      addIssue(issues, "missing-reachable", `Option ${raw.index}: missing explicit Reachable: yes/no`, warnings);
    } else if (!raw._reachableKnown) {
      addIssue(issues, "unrecognized-reachable", `Option ${raw.index}: Reachable must be explicit yes or no`, warnings);
    }
    if (!raw._projectedSeen) {
      addIssue(issues, "missing-projected", `Option ${raw.index}: missing Projected line`, warnings);
    }

    const local = sumLocalItems(raw.items, raw.index, issues, warnings);
    let aggregateOutOfRange = GOAL_KEYS.some((key) =>
      !Number.isFinite(Number(local.additions[key])) || Number(local.additions[key]) > LIMITS.nutrient
    );
    if (aggregateOutOfRange) {
      local.complete = false;
      addIssue(
        issues,
        "aggregate-out-of-range",
        `Option ${raw.index}: combined local nutrition exceeds the supported storage range`,
        warnings
      );
    }
    if (!context.available || !context.baseComplete) {
      addIssue(
        issues,
        "missing-local-context",
        `Option ${raw.index}: trusted logged totals are required for end-of-day safety checks`,
        warnings
      );
    }

    let projected = null;
    let sodiumCoverage = 0;
    let potassiumCoverage = 0;
    if (context.available && context.baseComplete) {
      projected = {};
      for (const key of GOAL_KEYS) {
        projected[key] = roundNutrient(key, (Number(context.base[key]) || 0) + (Number(local.additions[key]) || 0));
      }
      if (GOAL_KEYS.some((key) =>
        !Number.isFinite(Number(projected[key])) || Number(projected[key]) > LIMITS.nutrient
      )) {
        aggregateOutOfRange = true;
        local.complete = false;
        addIssue(
          issues,
          "aggregate-out-of-range",
          `Option ${raw.index}: combined local projection exceeds the supported storage range`,
          warnings
        );
        // This derived field is optional. Never expose an outbound-invalid
        // projection to an apply path, even for manual review.
        projected = null;
      }
      sodiumCoverage = combineCoverage(
        context.sodiumCoverage,
        context.count,
        context.kcal,
        local.mineral.sodium.items,
        local.mineral.sodium.kcal,
        raw.items.length,
        local.itemKcal
      );
      potassiumCoverage = combineCoverage(
        context.potassiumCoverage,
        context.count,
        context.kcal,
        local.mineral.potassium.items,
        local.mineral.potassium.kcal,
        raw.items.length,
        local.itemKcal
      );
    }

    const goals = context.goals || {};
    const proteinFloor = Number(goals.protein) || 0;
    const sodiumCeiling = Number(goals.sodium) || 0;
    const lowProtein = !!(projected && proteinFloor > 0 && projected.protein < proteinFloor);
    // A known subtotal over the ceiling is already conclusive, even if coverage is incomplete.
    const highSodium = !!(projected && sodiumCeiling > 0 && projected.sodium > sodiumCeiling);
    if (lowProtein) {
      addIssue(
        issues,
        "low-protein",
        `Option ${raw.index}: local projection is below the protein floor (${projected.protein} < ${proteinFloor} g)`,
        warnings
      );
    }
    if (highSodium) {
      addIssue(
        issues,
        "high-sodium",
        `Option ${raw.index}: local sodium projection exceeds the ceiling (${projected.sodium} > ${sodiumCeiling} mg)`,
        warnings
      );
    }
    if (projected && (sodiumCoverage < MINERAL_COVERAGE_MIN || potassiumCoverage < MINERAL_COVERAGE_MIN)) {
      addIssue(
        issues,
        "low-mineral-coverage",
        `Option ${raw.index}: local mineral coverage is incomplete (Na ${Math.round(sodiumCoverage * 100)}%, K ${Math.round(potassiumCoverage * 100)}%)`,
        warnings
      );
    }
    if (projectionDiffers(raw.aiProjected, projected)) {
      const msg = `Option ${raw.index}: ignored AI Projected values that differ from local food math`;
      if (!warnings.includes(msg)) warnings.push(msg);
    }

    const protocolComplete = raw._reachableSeen && raw._reachableKnown && raw._projectedSeen;
    const issueFlags = [...new Set(issues.map((x) => x.flag))];
    const structuralFlags = new Set([
      "incomplete-item", "invalid-quantity", "ranged-quantity", "ambiguous-food",
      "unresolved-food", "fuzzy-food-match", "unsupported-unit", "missing-unit",
      "missing-candidates", "option-1-missing-candidates", "incomplete-nutrients",
      "missing-reachable", "unrecognized-reachable", "missing-projected", "missing-local-context",
      "low-mineral-coverage", "aggregate-out-of-range",
    ]);
    const complete = protocolComplete && context.available && context.baseComplete && local.complete &&
      !issueFlags.some((flag) => structuralFlags.has(flag));
    const sodiumVerifiable = !(sodiumCeiling > 0) || sodiumCoverage >= MINERAL_COVERAGE_MIN;
    const reachable = !!(projected && local.complete && !lowProtein && !highSodium && sodiumVerifiable);
    const safe = complete && reachable;
    const publicItems = raw.items.map((item) => {
      const { _candidate, ...rest } = item;
      return rest;
    });
    return {
      index: raw.index,
      label: raw.label || `Option ${raw.index}`,
      // Trusted/local fields used for decisions.
      reachable,
      safe,
      complete,
      autoApply: safe && complete,
      requiresManualConfirm: !(safe && complete),
      manualConfirm: !(safe && complete),
      flags: issueFlags,
      manualConfirmFlags: issueFlags,
      manualConfirmReasons: issues.map((x) => x.message),
      note: raw.note || "",
      items: publicItems,
      additions: local.additions,
      projected,
      localProjected: projected,
      mineralCoverage: { sodium: sodiumCoverage, potassium: potassiumCoverage },
      // Untrusted report fields are retained for transparency only.
      aiReachable: raw.aiReachable,
      reportedReachable: raw.aiReachable,
      aiProjected: raw.aiProjected || null,
      reportedProjected: raw.aiProjected || null,
    };
  }

  /**
   * Parse an untrusted GAP reply and assess it with trusted selected-food data.
   * `context` should contain `{ totals, goals }` (or `{ means, goals }`).
   * The AI's Projected/Reachable claims are retained as `ai*` fields but never
   * drive `projected`, `reachable`, `safe`, or `autoApply`.
   */
  function parseGapBlock(text, candidates, scorer, context) {
    // Convenience: allow parseGapBlock(text, candidates, { scorer, totals, goals }).
    if (scorer && typeof scorer === "object" && typeof scorer !== "function" && context == null) {
      context = scorer;
      scorer = typeof context.scorer === "function" ? context.scorer : null;
    }
    const rawText = String(text || "");
    const rawLines = rawText.split(/\r?\n/);
    if (rawText.length > LIMITS.rawChars || rawLines.length > LIMITS.lines ||
        rawLines.some((line) => line.length > LIMITS.lineChars)) {
      return {
        ok: false, complete: false, safe: false, autoApply: false,
        requiresManualConfirm: true, manualConfirm: true,
        flags: ["oversized"], manualConfirmFlags: ["oversized"],
        error: "GAP reply is too large. Ask for a shorter GAP v1 block and try again.",
      };
    }
    const body = extractBody(rawText);
    if (body == null) {
      const truncated = /GAP\s*v?1\b/i.test(preprocess(text));
      return {
        ok: false,
        complete: false,
        safe: false,
        autoApply: false,
        requiresManualConfirm: true,
        manualConfirm: true,
        flags: [truncated ? "truncated" : "missing-block"],
        manualConfirmFlags: [truncated ? "truncated" : "missing-block"],
        error: truncated
          ? "Incomplete GAP v1 block: a standalone END line is required before any plan can be used."
          : "No complete GAP v1 … END block found. Ask the AI to use the GAP v1 … END format.",
      };
    }
    const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
    const optionLines = lines.filter((line) => /^Option:\s*\d+/i.test(line));
    if (optionLines.length > LIMITS.options) {
      return {
        ok: false, complete: false, safe: false, autoApply: false,
        requiresManualConfirm: true, manualConfirm: true,
        flags: ["too-many-options"], manualConfirmFlags: ["too-many-options"],
        error: `GAP reply has too many options (maximum ${LIMITS.options}).`,
      };
    }
    let day = "";
    const warnings = [];
    const hasCandidateList = Array.isArray(candidates);
    // Pre-scan so a preamble Note before Option: 1 does not spawn a phantom legacy plan.
    const hasOptionHeader = lines.some((l) => /^Option:\s*\d+/i.test(l));
    const rawOptions = [];
    const rejected = [];
    let cur = null;

    function newOption(index, label, legacy) {
      return {
        index,
        label,
        note: "",
        items: [],
        aiReachable: null,
        aiProjected: null,
        aiRespects: "",
        _reachableSeen: false,
        _reachableKnown: false,
        _projectedSeen: false,
        _issues: [],
        _legacy: !!legacy,
      };
    }

    function pushCur() {
      if (!cur) return;
      if (!cur.items.length) {
        if (!cur._reachableSeen) {
          addIssue(cur._issues, "missing-reachable", `Option ${cur.index}: missing explicit Reachable: yes/no`, warnings);
        } else if (!cur._reachableKnown) {
          addIssue(cur._issues, "unrecognized-reachable", `Option ${cur.index}: Reachable must be explicit yes or no`, warnings);
        }
        addIssue(
          cur._issues,
          "incomplete-option",
          `Option ${cur.index} (${cur.label}) had no valid supported items — skipped`,
          warnings
        );
        rejected.push(cur);
        cur = null;
        return;
      }
      rawOptions.push(cur);
      cur = null;
    }

    /** Legacy single-plan blocks have no Option headers. */
    function ensureLegacyCur() {
      if (hasOptionHeader) return;
      if (cur) return;
      cur = newOption(1, "Plan", true);
    }

    for (const line of lines) {
      const dayM = line.match(/^Day:\s*(.+)$/i);
      if (dayM && !cur) {
        day = dayM[1].trim();
        if (day.length > 10) return {
          ok: false, complete: false, safe: false, autoApply: false,
          requiresManualConfirm: true, manualConfirm: true,
          flags: ["invalid-day"], manualConfirmFlags: ["invalid-day"],
          error: "GAP day is invalid.",
        };
        continue;
      }

      // Accept "Option: 1 | Label", "Option: 1 - Label", "Option: 1 — Label", "Option: 1 (Label)"
      const optM = line.match(/^Option:\s*(\d+)\s*(?:[|:\-–—(]\s*(.+?)\)?\s*)?$/i);
      if (optM) {
        pushCur();
        let label = (optM[2] || "").trim().replace(/^\|+/, "").trim();
        if (!label) label = `Option ${optM[1]}`;
        if (label.length > LIMITS.labelChars) return {
          ok: false, complete: false, safe: false, autoApply: false,
          requiresManualConfirm: true, manualConfirm: true,
          flags: ["overlong-label"], manualConfirmFlags: ["overlong-label"],
          error: "GAP option label is too long.",
        };
        cur = newOption(Number(optM[1]), label, false);
        continue;
      }

      const reachM = line.match(/^Reachable:\s*(.+)$/i);
      if (reachM) {
        ensureLegacyCur();
        if (!cur) continue;
        const r = parseReachable(reachM[1]);
        cur.aiReachable = r.reachable;
        cur._reachableSeen = true;
        cur._reachableKnown = !r.unknown;
        if (r.unknown) {
          addIssue(
            cur._issues,
            "unrecognized-reachable",
            `Option ${cur.index}: unrecognized Reachable "${reachM[1].trim()}"; use explicit yes or no`,
            warnings
          );
        }
        continue;
      }
      const noteM = line.match(/^Note:\s*(.*)$/i);
      if (noteM) {
        ensureLegacyCur();
        if (!cur) continue;
        cur.note = noteM[1].trim();
        if (cur.note.length > LIMITS.noteChars) return {
          ok: false, complete: false, safe: false, autoApply: false,
          requiresManualConfirm: true, manualConfirm: true,
          flags: ["overlong-note"], manualConfirmFlags: ["overlong-note"],
          error: "GAP option note is too long.",
        };
        continue;
      }
      const projM = line.match(/^Projected:\s*(.*)$/i);
      if (projM) {
        ensureLegacyCur();
        if (!cur) continue;
        cur.aiProjected = parseProjected(projM[1]);
        cur._projectedSeen = true;
        continue;
      }
      const respectsM = line.match(/^Respects:\s*(.*)$/i);
      if (respectsM) {
        ensureLegacyCur();
        if (!cur) continue;
        cur.aiRespects = respectsM[1].trim();
        continue;
      }
      if (/^Item:/i.test(line.replace(/^\*+\s*/, "").replace(/^[-•]\s*/, ""))) {
        ensureLegacyCur();
        if (!cur) continue;
        const item = parseItemLine(line, candidates, scorer, hasCandidateList, warnings, cur._issues);
        if (item) cur.items.push(item);
      }
    }
    pushCur();

    if (!rawOptions.length) {
      const flags = [...new Set(rejected.flatMap((o) => (o._issues || []).map((x) => x.flag)))];
      return {
        ok: false,
        complete: false,
        safe: false,
        autoApply: false,
        requiresManualConfirm: true,
        manualConfirm: true,
        flags: flags.length ? flags : ["incomplete-option"],
        manualConfirmFlags: flags.length ? flags : ["incomplete-option"],
        warnings,
        error: "GAP block found but no valid, locally resolvable options matched your selected foods.",
      };
    }

    if (hasCandidateList && candidates.length) {
      const opt1 = rawOptions.find((o) => o.index === 1);
      if (opt1) {
        const used = new Set((opt1.items || []).map((it) => String(it.name || "").trim().toLowerCase()));
        const missing = candidates
          .filter((c) => !used.has(String(c.name || "").trim().toLowerCase()))
          .map((c) => c.name);
        if (missing.length) {
          addIssue(
            opt1._issues,
            "option-1-missing-candidates",
            `Option 1 skipped: ${missing.join(", ")}`,
            warnings
          );
        }
      }
    } else if (!hasCandidateList) {
      for (const opt of rawOptions) {
        addIssue(
          opt._issues,
          "missing-candidates",
          `Option ${opt.index}: selected candidate foods are required for local verification`,
          warnings
        );
      }
    }

    const trusted = localContext(context);
    const options = rawOptions.map((option) => finalizeOption(option, trusted, warnings));
    const rejectedFlags = rejected.flatMap((option) => (option._issues || []).map((issue) => issue.flag));
    const flags = [...new Set(options.flatMap((option) => option.flags || []).concat(rejectedFlags))];
    const missingExplicitReachable = flags.includes("missing-reachable") || flags.includes("unrecognized-reachable");
    const rejectedOptions = rejected.map((option) => ({
      index: option.index,
      label: option.label,
      flags: [...new Set((option._issues || []).map((issue) => issue.flag))],
      reasons: (option._issues || []).map((issue) => issue.message),
    }));
    const first = options[0];
    if (missingExplicitReachable) {
      return {
        ok: false,
        complete: false,
        safe: false,
        autoApply: false,
        requiresManualConfirm: true,
        manualConfirm: true,
        flags,
        manualConfirmFlags: flags,
        warnings,
        day,
        options,
        rejectedOptions,
        error: "Every GAP option must include an explicit Reachable: yes or Reachable: no line.",
      };
    }

    const autoApply = rejected.length === 0 && options.length === 1 && first.autoApply === true;
    return {
      ok: true,
      day,
      options,
      rejectedOptions,
      warnings,
      complete: rejected.length === 0 && options.every((option) => option.complete),
      safe: first.safe,
      autoApply,
      requiresManualConfirm: !autoApply,
      manualConfirm: !autoApply,
      flags,
      manualConfirmFlags: flags,
      // Convenience for single-option / legacy callers
      reachable: first.reachable,
      aiReachable: first.aiReachable,
      reportedReachable: first.aiReachable,
      note: first.note,
      items: first.items,
      projected: first.projected,
      localProjected: first.localProjected,
      aiProjected: first.aiProjected,
      reportedProjected: first.aiProjected,
    };
  }

  return {
    GOAL_KEYS,
    MEALS,
    BAND_HINT,
    totalsMeans,
    remainingFrom,
    macroMeans,
    projectTotals,
    portionLine,
    buildGapPrompt,
    parseGapBlock,
    matchCandidate,
    preprocess,
    LIMITS,
  };
})();

if (typeof module !== "undefined") module.exports = GapPrompt;
