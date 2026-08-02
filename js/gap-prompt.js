/* NutriDaily — GAP v1 close-the-gap prompt + paste parser.
 * Deterministic only. LLMs live outside the app.
 * A GAP block may contain 2–3 Option sections (tradeoffs); legacy single-plan blocks still parse.
 */
const GapPrompt = (() => {
  const GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium"];
  const MEALS = ["breakfast", "lunch", "dinner", "snack"];
  const TOTAL_KEY = { kcal: "kcal", protein: "p", carbs: "c", fat: "f", fiber: "fb", sodium: "na" };

  const BAND_HINT = {
    kcal: "range, ±10%",
    protein: "floor, hit or exceed",
    carbs: "range, ±15%",
    fat: "range, ±15%",
    fiber: "report only, not a hit target",
    sodium: "ceiling only, lower is better; warn if over",
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

  function remainingFrom(means, goals) {
    const out = {};
    for (const k of GOAL_KEYS) {
      const g = Number(goals && goals[k]) || 0;
      const a = Number(means && means[k]) || 0;
      out[k] = Math.round((g - a) * 10) / 10;
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
      ` | Fiber ${fmtNum(p.fb, 1)} | Sodium ${fmtNum(p.na)} mg (per 100 g)`
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
      : (ctx.means || { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 });
    const goals = ctx.goals || {};
    const remaining = ctx.remaining || remainingFrom(means, goals);
    const logged = Array.isArray(ctx.logged) ? ctx.logged : [];
    const candidates = Array.isArray(ctx.candidates) ? ctx.candidates : [];

    let loggedBlock = "(nothing logged yet)\n";
    if (logged.length) {
      loggedBlock = logged.map((e) => {
        const qty = e.displayQty || (e.grams != null ? `${fmtNum(e.grams)} g` : "?");
        const m = e.macros || {};
        return (
          `- ${e.name}: ${qty} (${e.meal || "snack"}) → ` +
          `${fmtNum(m.kcal)} kcal | P ${fmtNum(m.p, 1)} | C ${fmtNum(m.c, 1)} | F ${fmtNum(m.f, 1)}` +
          ` | Fiber ${fmtNum(m.fb, 1)} | Sodium ${fmtNum(m.na)}`
        );
      }).join("\n") + "\n";
    }

    const remBits = [];
    for (const k of ["kcal", "protein", "carbs", "fat"]) {
      const unit = k === "kcal" ? "" : " g";
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
      const g = Number(goals.sodium) || 0;
      const a = Number(means.sodium) || 0;
      const headroom = Number(remaining.sodium) || 0;
      if (!(g > 0)) {
        remBits.push(`sodium ${fmtNum(a)} mg logged (no ceiling set)`);
      } else if (headroom >= 0) {
        remBits.push(`sodium headroom +${fmtNum(headroom)} mg (${BAND_HINT.sodium})`);
      } else {
        remBits.push(`sodium OVER by ${fmtNum(Math.abs(headroom))} mg (${BAND_HINT.sodium})`);
      }
    }
    const remLine = remBits.join("; ");

    let candBlock = "(no candidates selected)\n";
    const refineNames = [];
    if (candidates.length) {
      candBlock = candidates.map((c, i) => {
        const piece = c.pieceGrams != null && Number.isFinite(c.pieceGrams)
          ? `; piece = ${fmtNum(c.pieceGrams)} g`
          : "";
        const logAs = c.logAs ? `; logAs ${c.logAs}` : "";
        const src = c.provenance === "ref"
          ? "Reference · USDA-style avg (may refine with NUTRI v1)"
          : (c.provenance === "ai" ? "Yours · AI estimate" : "Yours");
        if (c.provenance === "ref" || c.refine) refineNames.push(c.name);
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
      "This is NOT medical advice. Treat your output as educational reference only.\n" +
      "I must consult a qualified health professional before making major diet or training changes,\n" +
      "especially if I have a medical condition, take medication, am pregnant, or am under 18.\n\n" +
      `Day: ${day}\n\n` +
      "Already logged today (do not change these; they are already eaten):\n" +
      loggedBlock +
      "\n" +
      "Totals so far:\n" +
      `- ${fmtNum(means.kcal)} kcal | P ${fmtNum(means.protein, 1)} | C ${fmtNum(means.carbs, 1)}` +
      ` | F ${fmtNum(means.fat, 1)} | Fiber ${fmtNum(means.fiber, 1)} | Sodium ${fmtNum(means.sodium)}\n\n` +
      "Daily targets:\n" +
      `- ${fmtNum(goals.kcal)} kcal | P ${fmtNum(goals.protein)} | C ${fmtNum(goals.carbs)}` +
      ` | F ${fmtNum(goals.fat)}` +
      ` | Fiber ${fmtNum(goals.fiber)} g (report only)` +
      ` | Sodium ${fmtNum(goals.sodium)} mg (ceiling — lower is better)\n\n` +
      `Gap / status: ${remLine}\n` +
      "(For kcal/protein/carbs/fat: positive = still to add, negative = already over.)\n\n" +
      "Candidate foods I plan to eat (ONLY assign quantities to these exact names):\n" +
      candBlock +
      "\n" +
      "Task:\n" +
      "- Propose exactly 3 plan OPTIONS with different tradeoffs. I will pick one in the app.\n" +
      "  Use these exact short labels on the Option line. Parentheticals are guidance for you only; do not put them on the Option line.\n" +
      "  1 | Balanced (closest on protein + kcal/carbs/fat within preferred portions)\n" +
      "  2 | Protect protein (prioritize the protein floor even if kcal/carbs/fat drift)\n" +
      "  3 | Lowest sodium (minimize sodium and avoid kcal overshoot; still meet protein if candidates allow; say so in Note if not)\n" +
      "- Each option must have its own Reachable, Note, Item lines, and Projected line.\n" +
      "- Projected = end-of-day totals for the WHOLE day: everything already logged above PLUS this option's items. Not just the new items.\n" +
      "- Prefer each food's preferred portion range when n ≥ 3. Stay near median/last when history is thin.\n" +
      "- Hit rules: protein is a floor; kcal/carbs/fat are soft ranges.\n" +
      "- Fiber: report in Projected only. Do NOT treat fiber as something to hit; fiber shortfalls never make Reachable: no.\n" +
      "- Sodium: ceiling only. Lower is better. Do NOT try to \"reach\" the sodium number.\n" +
      "  Prefer to stay under the ceiling. Options 1–2 may still overshoot when the candidate set forces it;\n" +
      "  if projected sodium exceeds the ceiling, warn clearly in Note (e.g. \"Sodium over ceiling by ~X mg\") and set Reachable: no.\n" +
      "- Reachable: yes means projected protein meets the floor AND projected sodium is at or under the ceiling\n" +
      "  (or no sodium ceiling is set). Deliberate kcal/carbs/fat drift that the option's strategy calls for does NOT\n" +
      "  by itself make Reachable: no — describe it in Note instead.\n" +
      "- If an option misses the protein floor or breaks the sodium ceiling, set Reachable: no and explain in Note.\n" +
      "  Still give honest quantities for that strategy. Do not collapse to a single option when tradeoffs exist.\n" +
      "- Do NOT invent Item lines for foods not listed above. Use each candidate's exact Name.\n" +
      "- Qty must include a unit: e.g. `120 g` or `2 piece` (not a bare number).\n" +
      "- Omit Item lines for foods that option should skip (do not write 0 g).\n" +
      "- Reference catalog foods use USDA-style averages. If you refine macros for any candidate,\n" +
      "  ALSO emit a NUTRI v1 … END block for that food (same Name) so I can update My Foods.\n" +
      "- Brand-new homemade dishes agreed in chat: emit NUTRI v1, but GAP Items stay limited to selected candidates.\n" +
      (refineNames.length
        ? `- Candidates that especially benefit from a NUTRI refine: ${refineNames.join("; ")}.\n`
        : "") +
      "- Plain numbers only. One GAP v1 block with three Option sections (plus optional NUTRI blocks).\n\n" +
      "Reply exactly in this format:\n\n" +
      "GAP v1\n" +
      `Day: ${day || "<YYYY-MM-DD>"}\n` +
      "Option: 1 | Balanced\n" +
      "Reachable: yes\n" +
      "Note: <tradeoff in one or two sentences>\n" +
      "Item: <exact candidate name> | <n> g | <meal>\n" +
      "Item: <exact candidate name> | <n> g | <meal>\n" +
      "Projected: <kcal> kcal | P <g> | C <g> | F <g> | Fiber <g> | Sodium <mg>\n" +
      "Option: 2 | Protect protein\n" +
      "(same fields)\n" +
      "Option: 3 | Lowest sodium\n" +
      "(same fields)\n" +
      "END\n"
    );
  }

  function preprocess(text) {
    let s = String(text || "");
    s = s.replace(/\u00a0/g, " ");
    s = s.replace(/[\u2013\u2014\u2212]/g, "-");
    s = s.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    return s;
  }

  /** Prefer the last complete GAP v1 … END block (chat iterations often include drafts). */
  function extractBody(text) {
    const src = preprocess(text);
    const re = /GAP\s*v?1\b/gi;
    let m;
    let lastComplete = null;
    let lastAny = null;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length;
      const rest = src.slice(start);
      const endMatch = rest.match(/\n\s*END\s*(?:\n|$)/i);
      const body = (endMatch ? rest.slice(0, endMatch.index) : rest).replace(/^\s*\n/, "");
      lastAny = body;
      if (endMatch) lastComplete = body;
    }
    return lastComplete != null ? lastComplete : lastAny;
  }

  function parseNum(line) {
    const m = String(line).match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : NaN;
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
    if (p) out.protein = Math.round(Number(p[1]));
    if (c) out.carbs = Math.round(Number(c[1]));
    if (f) out.fat = Math.round(Number(f[1]));
    if (fb) out.fiber = Math.round(Number(fb[1]));
    if (na) out.sodium = Math.round(Number(na[1]));
    return out;
  }

  function parseQtyField(raw) {
    const s = String(raw || "").trim().toLowerCase();
    const range = s.match(/^(-?\d+(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:\.\d+)?)\s*(g|grams?|oz|piece|pieces)?$/i);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      let unit = (range[3] || "g").toLowerCase();
      if (unit === "grams" || unit === "gram") unit = "g";
      if (unit === "pieces") unit = "piece";
      const qty = Math.round(((a + b) / 2) * 10) / 10;
      return { qty, unit, gramsHint: unit === "g" ? qty : null, ranged: true, rangeText: s };
    }
    const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
    if (!m) {
      const n = parseNum(s);
      return Number.isFinite(n) ? { qty: n, unit: "g", gramsHint: n, ranged: false, unknownUnit: false } : null;
    }
    const qty = Number(m[1]);
    let unit = (m[2] || "g").toLowerCase();
    if (unit === "grams" || unit === "gram") unit = "g";
    if (unit === "pieces") unit = "piece";
    if (unit === "servings") unit = "serving";
    const known = unit === "g" || unit === "oz" || unit === "piece" || unit === "serving";
    const gramsHint = unit === "g" ? qty : null;
    return { qty, unit, gramsHint, ranged: false, unknownUnit: !known };
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

  function parseReachable(val) {
    const v = String(val || "").trim().toLowerCase();
    return !/^(no|false|0|partial)\b/.test(v);
  }

  function parseItemLine(line, candidates, scorer, hasCandidateList, warnings) {
    const itemM = line.replace(/^\*+\s*/, "").replace(/\*+$/, "")
      .replace(/^[-•]\s*/, "")
      .match(/^Item:\s*(.+)$/i);
    if (!itemM) return null;
    const parts = itemM[1].split("|").map((p) => p.trim().replace(/^\*+|\*+$/g, ""));
    if (parts.length < 2) {
      warnings.push(`Ignored incomplete Item line: ${line}`);
      return null;
    }
    const name = parts[0];
    const qtyParsed = parseQtyField(parts[1]);
    if (!qtyParsed || !(qtyParsed.qty > 0)) {
      warnings.push(`Ignored Item with bad qty: ${name}`);
      return null;
    }
    if (qtyParsed.ranged) {
      warnings.push(`Used midpoint of range for ${name}: ${qtyParsed.rangeText}`);
    }
    if (qtyParsed.unknownUnit) {
      warnings.push(`Unrecognized unit "${qtyParsed.unit}" for ${name}; confirm amount when logging`);
    }
    const meal = normalizeMeal(parts[2] || "snack");
    const match = matchCandidate(name, candidates, scorer);
    if (hasCandidateList) {
      if (match.ambiguous) {
        warnings.push(`Dropped ambiguous food name: ${name}`);
        return null;
      }
      if (!match.cand) {
        warnings.push(`Dropped unknown food (not in candidates): ${name}`);
        return null;
      }
      if (!match.exact) {
        warnings.push(`Matched "${name}" → "${match.cand.name}"`);
      }
    }
    const cand = match.cand;
    let grams = qtyParsed.gramsHint;
    const unit = qtyParsed.unit;
    const qty = qtyParsed.qty;
    if (grams == null && unit === "piece" && cand && cand.pieceGrams) {
      grams = Math.round(qty * cand.pieceGrams * 10) / 10;
    } else if (grams == null && unit === "g") {
      grams = qty;
    }
    return {
      name: cand ? cand.name : name,
      foodId: cand && cand.id ? cand.id : null,
      qty,
      unit,
      grams: grams != null ? grams : null,
      meal,
    };
  }

  /**
   * @returns {{
   *   ok: boolean,
   *   error?: string,
   *   day?: string,
   *   options?: Array<{index:number, label:string, reachable:boolean, note:string, items:Array, projected:object|null}>,
   *   warnings?: string[],
   *   // legacy convenience (first option)
   *   reachable?: boolean,
   *   note?: string,
   *   items?: Array,
   *   projected?: object|null
   * }}
   */
  function parseGapBlock(text, candidates, scorer) {
    const body = extractBody(text);
    if (!body) {
      return { ok: false, error: "No GAP v1 block found. Ask the AI to use the GAP v1 … END format." };
    }
    const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
    let day = "";
    const warnings = [];
    const hasCandidateList = Array.isArray(candidates);
    const options = [];
    let cur = null;

    function pushCur() {
      if (!cur) return;
      if (!cur.items.length) {
        warnings.push(`Option ${cur.index} (${cur.label}) had no valid items — skipped`);
        cur = null;
        return;
      }
      options.push({
        index: cur.index,
        label: cur.label || `Option ${cur.index}`,
        reachable: cur.reachable !== false,
        note: cur.note || "",
        items: cur.items,
        projected: cur.projected || null,
      });
      cur = null;
    }

    function ensureLegacyCur() {
      if (cur) return;
      cur = {
        index: 1,
        label: "Plan",
        reachable: true,
        note: "",
        items: [],
        projected: null,
        _legacy: true,
      };
    }

    for (const line of lines) {
      const dayM = line.match(/^Day:\s*(.+)$/i);
      if (dayM && !cur) { day = dayM[1].trim(); continue; }

      const optM = line.match(/^Option:\s*(\d+)\s*(?:\|\s*(.+))?$/i);
      if (optM) {
        pushCur();
        cur = {
          index: Number(optM[1]),
          label: (optM[2] || `Option ${optM[1]}`).trim(),
          reachable: true,
          note: "",
          items: [],
          projected: null,
        };
        continue;
      }

      const reachM = line.match(/^Reachable:\s*(.+)$/i);
      if (reachM) {
        ensureLegacyCur();
        cur.reachable = parseReachable(reachM[1]);
        continue;
      }
      const noteM = line.match(/^Note:\s*(.*)$/i);
      if (noteM) {
        ensureLegacyCur();
        cur.note = noteM[1].trim();
        continue;
      }
      const projM = line.match(/^Projected:\s*(.*)$/i);
      if (projM) {
        ensureLegacyCur();
        cur.projected = parseProjected(projM[1]);
        continue;
      }
      if (/^Item:/i.test(line.replace(/^\*+\s*/, "").replace(/^[-•]\s*/, ""))) {
        ensureLegacyCur();
        const item = parseItemLine(line, candidates, scorer, hasCandidateList, warnings);
        if (item) cur.items.push(item);
      }
    }
    pushCur();

    if (!options.length) {
      return { ok: false, error: "GAP block found but no valid options/items matched your selected foods." };
    }

    const first = options[0];
    return {
      ok: true,
      day,
      options,
      warnings,
      // Convenience for single-option / legacy callers
      reachable: first.reachable,
      note: first.note,
      items: first.items,
      projected: first.projected,
    };
  }

  return {
    GOAL_KEYS,
    MEALS,
    BAND_HINT,
    totalsMeans,
    remainingFrom,
    portionLine,
    buildGapPrompt,
    parseGapBlock,
    matchCandidate,
    preprocess,
  };
})();

if (typeof module !== "undefined") module.exports = GapPrompt;
