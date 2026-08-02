/* NutriDaily — GAP v1 close-the-gap prompt + paste parser.
 * Deterministic only. LLMs live outside the app.
 */
const GapPrompt = (() => {
  const GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium"];
  const MEALS = ["breakfast", "lunch", "dinner", "snack"];
  const TOTAL_KEY = { kcal: "kcal", protein: "p", carbs: "c", fat: "f", fiber: "fb", sodium: "na" };

  const BAND_HINT = {
    kcal: "range (±10%)",
    protein: "floor (hit or exceed)",
    carbs: "range (±15%)",
    fat: "range (±15%)",
    fiber: "floor (hit or exceed)",
    sodium: "ceiling (do not exceed)",
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
   *   candidates?: Array<{
   *     id?: string, name: string, per100?: object, logAs?: string, pieceGrams?: number|null,
   *     portion?: {n:number, median?:number, p25?:number, p75?:number, last?:number}|null
   *   }>
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

    const remLine = GOAL_KEYS.map((k) => {
      const unit = k === "kcal" ? "" : (k === "sodium" ? " mg" : " g");
      const sign = remaining[k] > 0 ? "+" : "";
      return `${k} ${sign}${fmtNum(remaining[k])}${unit} (${BAND_HINT[k]})`;
    }).join("; ");

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
      ` | F ${fmtNum(goals.fat)} | Fiber ${fmtNum(goals.fiber)} | Sodium ${fmtNum(goals.sodium)}\n\n` +
      `Remaining (target − actual): ${remLine}\n\n` +
      "Candidate foods I plan to eat (ONLY assign quantities to these exact names):\n" +
      candBlock +
      "\n" +
      "Task:\n" +
      "- Propose grams (or piece counts when piece weight is listed) for each candidate so the day approaches targets.\n" +
      "- Prefer each food's preferred portion range when n ≥ 3. Stay near median/last when history is thin.\n" +
      "- Protein and fiber are floors; sodium is a ceiling; kcal/carbs/fat are soft ranges.\n" +
      "- If the candidate set cannot hit targets within preferred ranges, set Reachable: no, explain briefly in Note,\n" +
      "  and still propose the best honest quantities. I may add another food in the app and re-copy this prompt,\n" +
      "  or we can iterate in chat (raise qty / swap) before you emit the final block.\n" +
      "- Do NOT invent plan Item lines for foods not listed above. Use each candidate's exact Name on Item lines.\n" +
      "- Qty must include a unit: e.g. `120 g` or `2 piece` (not a bare number).\n" +
      "- Omit Item lines for foods I should skip (do not write 0 g).\n" +
      "- Reference catalog foods use USDA-style averages. If you refine macros for any candidate (especially Reference),\n" +
      "  ALSO emit a NUTRI v1 … END block for that food (same Name) so I can update My Foods. You may refine several.\n" +
      "- If during our chat we agree on a brand-new homemade dish not in the list, ALSO emit a NUTRI v1 … END block for it.\n" +
      "  Still keep GAP Item lines limited to the candidate names I selected (or tell me to re-select after importing).\n" +
      (refineNames.length
        ? `- Candidates that especially benefit from a NUTRI refine: ${refineNames.join("; ")}.\n`
        : "") +
      "- Plain numbers only. One GAP v1 block for the final answer (plus optional NUTRI blocks).\n\n" +
      "Reply with the GAP plan (and optional NUTRI v1 blocks if needed), exactly:\n\n" +
      "GAP v1\n" +
      `Day: ${day || "<YYYY-MM-DD>"}\n` +
      "Reachable: yes\n" +
      "Note: <one or two sentences>\n" +
      "Item: <exact candidate name> | <n> g | <meal>\n" +
      "Item: <exact candidate name> | <n> g | <meal>\n" +
      "Projected: <kcal> kcal | P <g> | C <g> | F <g> | Fiber <g> | Sodium <mg>\n" +
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

  /**
   * Parse Item qty field: "120 g", "1.5 piece", "2 pieces"
   * @returns {{ qty: number, unit: string, gramsHint: number|null }}
   */
  function parseQtyField(raw) {
    const s = String(raw || "").trim().toLowerCase();
    // Ranges like "100-150 g" → take midpoint and flag via range flag
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

  /**
   * @returns {{ cand: object|null, score: number, exact: boolean, ambiguous: boolean }}
   */
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

  /**
   * @param {string} text
   * @param {Array<{id?:string, name:string, pieceGrams?:number|null}>} [candidates]
   * @param {(q:string, name:string)=>number} [scorer]
   */
  function parseGapBlock(text, candidates, scorer) {
    const body = extractBody(text);
    if (!body) {
      return { ok: false, error: "No GAP v1 block found. Ask the AI to use the GAP v1 … END format." };
    }
    const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
    let day = "";
    let reachable = true;
    let note = "";
    let projected = null;
    const items = [];
    const warnings = [];
    const hasCandidateList = Array.isArray(candidates);

    for (const line of lines) {
      const dayM = line.match(/^Day:\s*(.+)$/i);
      if (dayM) { day = dayM[1].trim(); continue; }
      const reachM = line.match(/^Reachable:\s*(.+)$/i);
      if (reachM) {
        const v = reachM[1].trim().toLowerCase();
        // LLMs often annotate: "no — protein short", "No (still under)"
        reachable = !/^(no|false|0|partial)\b/.test(v);
        continue;
      }
      const noteM = line.match(/^Note:\s*(.*)$/i);
      if (noteM) { note = noteM[1].trim(); continue; }
      const projM = line.match(/^Projected:\s*(.*)$/i);
      if (projM) { projected = parseProjected(projM[1]); continue; }
      // Allow light markdown: **Item:** / - Item:
      const itemM = line.replace(/^\*+\s*/, "").replace(/\*+$/, "")
        .replace(/^[-•]\s*/, "")
        .match(/^Item:\s*(.+)$/i);
      if (!itemM) continue;
      const parts = itemM[1].split("|").map((p) => p.trim().replace(/^\*+|\*+$/g, ""));
      if (parts.length < 2) {
        warnings.push(`Ignored incomplete Item line: ${line}`);
        continue;
      }
      const name = parts[0];
      const qtyParsed = parseQtyField(parts[1]);
      if (!qtyParsed || !(qtyParsed.qty > 0)) {
        warnings.push(`Ignored Item with bad qty: ${name}`);
        continue;
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
          continue;
        }
        if (!match.cand) {
          warnings.push(`Dropped unknown food (not in candidates): ${name}`);
          continue;
        }
        if (!match.exact) {
          warnings.push(`Matched "${name}" → "${match.cand.name}"`);
        }
      }
      const cand = match.cand;
      let grams = qtyParsed.gramsHint;
      let unit = qtyParsed.unit;
      let qty = qtyParsed.qty;
      if (grams == null && unit === "piece" && cand && cand.pieceGrams) {
        grams = Math.round(qty * cand.pieceGrams * 10) / 10;
      } else if (grams == null && unit === "g") {
        grams = qty;
      }
      // Leave grams null when unit needs food-specific conversion and food is unknown
      items.push({
        name: cand ? cand.name : name,
        foodId: cand && cand.id ? cand.id : null,
        qty,
        unit,
        grams: grams != null ? grams : null,
        meal,
      });
    }

    if (!items.length) {
      return { ok: false, error: "GAP block found but no valid Item lines matched your selected foods." };
    }
    return { ok: true, day, reachable, note, items, projected, warnings };
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
