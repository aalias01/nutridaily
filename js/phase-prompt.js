/* NutriDaily — PHASE v1 AI target prompt + paste parser.
 * Deterministic only. LLMs live outside the app.
 */
const PhasePrompt = (() => {
  const GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium", "potassium"];
  const REQUIRED_KEYS = ["kcal", "protein", "carbs", "fat"];
  const PRESERVE_KEYS = ["fiber", "sodium", "potassium"];
  const LIMITS = Object.freeze({
    rawChars: 12000,
    bodyChars: 12000,
    lines: 200,
    lineChars: 2000,
    options: 10,
    labelChars: 160,
    reasonChars: 1000,
    sourceChars: 1000,
  });
  const LOCAL_BOUNDS = Object.freeze({
    kcal: Object.freeze([1200, 6000]),
    protein: Object.freeze([0, 400]),
    carbs: Object.freeze([0, 800]),
    fat: Object.freeze([0, 800]),
    fiber: Object.freeze([0, 150]),
    sodium: Object.freeze([0, 10000]),
    potassium: Object.freeze([0, 10000]),
  });
  const LOCAL_ENERGY_POLICY = Object.freeze({
    atwaterTolerance: 0.20,
    maxProteinShare: 0.40,
    minFatShare: 0.20,
    maxFatShare: 0.45,
  });
  const BOUNDS = typeof Phases !== "undefined" && Phases.PERSISTENT_GOAL_BOUNDS
    ? Phases.PERSISTENT_GOAL_BOUNDS : LOCAL_BOUNDS;
  const ENERGY_POLICY = typeof Phases !== "undefined" && Phases.PERSISTENT_ENERGY_POLICY
    ? Phases.PERSISTENT_ENERGY_POLICY : LOCAL_ENERGY_POLICY;

  const KIND_BRIEF = {
    cut: "fat-loss / calorie deficit while protecting protein and training",
    maintain: "weight maintenance with balanced macros",
    bulk: "muscle gain / surplus with enough protein and controlled fat gain",
    recomp: "body recomposition: lose fat and gain or preserve muscle near maintenance calories with high protein",
  };

  function kindLabel(kind) {
    if (typeof Phases !== "undefined" && Phases.KIND_LABEL && Phases.KIND_LABEL[kind]) {
      return Phases.KIND_LABEL[kind];
    }
    return String(kind || "Maintain");
  }

  function activityLabel(activity) {
    if (typeof Phases !== "undefined" && Phases.ACTIVITY_LABEL && Phases.ACTIVITY_LABEL[activity]) {
      return Phases.ACTIVITY_LABEL[activity];
    }
    return String(activity || "");
  }

  /**
   * @param {{ kind: string, age: number, profile: object, weightKg: number, weightUnit?: string, notes?: string }} ctx
   */
  function buildTargetPrompt(ctx) {
    const kind = (typeof Phases !== "undefined" ? Phases.normalizeKind(ctx.kind) : ctx.kind) || "maintain";
    const label = kindLabel(kind);
    const brief = KIND_BRIEF[kind] || KIND_BRIEF.maintain;
    const p = ctx.profile || {};
    const notes = (ctx.notes != null ? String(ctx.notes) : (p.notes || "")).trim();
    const sex = p.sex || "unspecified";
    const height = p.heightCm != null ? `${p.heightCm} cm` : "unknown";
    const activity = activityLabel(p.activity) || p.activity || "unknown";
    const weight = ctx.weightKg != null
      ? (ctx.weightUnit === "kg"
        ? `${Number(ctx.weightKg).toFixed(1)} kg`
        : `${(Number(ctx.weightKg) / 0.45359237).toFixed(1)} lb`)
      : "unknown";
    const age = ctx.age != null ? String(ctx.age) : "unknown";

    return (
      "You are a sports-nutrition assistant helping me set daily macro targets for a personal tracker (NutriDaily).\n" +
      `My selected phase goal: ${label} (${brief}).\n\n` +
      "My profile (use these exact values; do not invent replacements):\n" +
      `- Age: ${age} years\n` +
      `- Sex: ${sex}\n` +
      `- Height: ${height}\n` +
      `- Weight: ${weight}\n` +
      `- Activity: ${activity}\n` +
      (notes ? `- Notes: ${notes}\n` : "") +
      "\n" +
      "Task:\n" +
      `- Propose exactly 3 daily target options tailored to ${label}.\n` +
      "- Label them Conservative, Balanced, and Aggressive (relative to that goal).\n" +
      "- For each option give: kcal, protein g, carbs g, fat g, fiber g, sodium mg, potassium mg.\n" +
      "- Plain integers only. No thousands separators (write 2100 not 2,100). No ranges inside the number fields.\n" +
      "- Include a short Reason (why these numbers for this person and goal).\n" +
      "- Include Sources: named equations/guidelines (e.g. Mifflin-St Jeor, ISSN protein guidance).\n" +
      "  Do not invent fake URLs. Prefer well-known position stands and standard equations.\n" +
      "- Do not infer pregnancy, kidney/renal status, or medication use from missing notes. If Notes mention any of them, avoid aggressive targets and explicitly recommend clinician/dietitian review.\n" +
      "- Flag briefly if inputs look extreme or unsafe.\n\n" +
      "Reply with ONE fenced code block and nothing else, exactly in this format:\n\n" +
      "PHASE v1\n" +
      `Kind: ${kind}\n` +
      "Option: 1 | Conservative\n" +
      "Kcal: <n>\n" +
      "Protein: <n>\n" +
      "Carbs: <n>\n" +
      "Fat: <n>\n" +
      "Fiber: <n>\n" +
      "Sodium: <n>\n" +
      "Potassium: <n>\n" +
      "Reason: <one or two sentences>\n" +
      "Sources: <semicolon-separated names>\n" +
      "Option: 2 | Balanced\n" +
      "(same fields)\n" +
      "Option: 3 | Aggressive\n" +
      "(same fields)\n" +
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

  /** Prefer the last complete PHASE v1 … END body (chat pastes often include the prompt template). */
  function extractBodies(text) {
    const src = preprocess(text);
    const re = /PHASE\s*v?1\b/gi;
    const bodies = [];
    let m;
    while ((m = re.exec(src))) {
      const start = m.index + m[0].length;
      const rest = src.slice(start);
      const endMatch = rest.match(/\n\s*END\s*[.!?]?(?:\n|$)/i);
      // A later protocol block cannot lend its END to a truncated PHASE block.
      const nextBlock = rest.match(/\n\s*(?:PHASE|GAP|NUTRI)\s*v?\d+\b/i);
      const complete = !!endMatch && (!nextBlock || endMatch.index < nextBlock.index);
      const endAt = complete
        ? endMatch.index
        : nextBlock ? nextBlock.index : rest.length;
      const body = rest.slice(0, endAt).replace(/^\s*\n/, "");
      bodies.push({ body, complete });
      if (complete) re.lastIndex = start + endMatch.index + endMatch[0].length;
    }
    return bodies;
  }

  function parseNum(line) {
    const raw = String(line).trim();
    if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return NaN;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  /**
   * Validate a complete persistent target set. The 4/4/9 check catches
   * internally contradictory AI or manual targets before they reach storage.
   */
  function validateGoals(goals) {
    if (typeof Phases !== "undefined" && typeof Phases.validatePersistentGoals === "function") {
      return Phases.validatePersistentGoals(goals);
    }
    const values = {};
    const errors = [];
    const raw = goals && typeof goals === "object" ? goals : {};
    for (const key of GOAL_KEYS) {
      const value = raw[key];
      const missing = value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim());
      let n = NaN;
      if (!missing) {
        try { n = Number(value); } catch (_) { n = NaN; }
      }
      const bounds = BOUNDS[key];
      if (!Number.isFinite(n)) {
        errors.push(key + " must be a finite number");
        continue;
      }
      if (n < bounds[0] || n > bounds[1]) {
        errors.push(key + " must be between " + bounds[0] + " and " + bounds[1]);
        continue;
      }
      values[key] = n;
    }

    let macroKcal = null;
    let proteinShare = null;
    let fatShare = null;
    if (["kcal", "protein", "carbs", "fat"].every((key) => Number.isFinite(values[key]))) {
      macroKcal = 4 * values.protein + 4 * values.carbs + 9 * values.fat;
      proteinShare = 4 * values.protein / values.kcal;
      fatShare = 9 * values.fat / values.kcal;
      if (Math.abs(macroKcal - values.kcal) / values.kcal > ENERGY_POLICY.atwaterTolerance) {
        errors.push("macro calories must be within 20% of stated calories");
      }
      if (proteinShare > ENERGY_POLICY.maxProteinShare) {
        errors.push("protein cannot exceed 40% of stated calories");
      }
      if (fatShare < ENERGY_POLICY.minFatShare || fatShare > ENERGY_POLICY.maxFatShare) {
        errors.push("fat must provide 20–45% of stated calories");
      }
    }
    return { ok: errors.length === 0, errors, macroKcal, proteinShare, fatShare };
  }

  function parseOneBody(body, currentGoals) {
    if (body.length > LIMITS.bodyChars) {
      return { kind: null, options: [], warnings: [], error: `PHASE body exceeds ${LIMITS.bodyChars} characters.` };
    }
    const physicalLines = body.split(/\n/);
    if (physicalLines.length > LIMITS.lines) {
      return { kind: null, options: [], warnings: [], error: `PHASE body exceeds ${LIMITS.lines} lines.` };
    }
    if (physicalLines.some((line) => line.length > LIMITS.lineChars)) {
      return { kind: null, options: [], warnings: [], error: `PHASE line exceeds ${LIMITS.lineChars} characters.` };
    }
    const lines = physicalLines.map((l) => l.trim()).filter(Boolean);
    let kind = null;
    const options = [];
    const warnings = [];
    let cur = null;
    let optionCount = 0;
    let error = null;

    function pushCur() {
      if (!cur) return;
      const missing = REQUIRED_KEYS.filter((k) => !Number.isFinite(Number(cur[k])));
      if (missing.length) {
        warnings.push(`Dropped Option ${cur.index} (${cur.label || "?"}): missing ${missing.join(", ")}`);
        cur = null;
        return;
      }
      for (const key of PRESERVE_KEYS) {
        if (Number.isFinite(Number(cur[key]))) continue;
        const prior = currentGoals && currentGoals[key];
        if (prior == null || prior === "" || typeof prior === "boolean" || !Number.isFinite(Number(prior))) {
          warnings.push(`Dropped Option ${cur.index} (${cur.label || "?"}): missing ${key} and no current target was provided`);
          cur = null;
          return;
        }
        cur[key] = Number(prior);
        warnings.push(`Option ${cur.index}: ${key} missing — kept current target ${Math.round(Number(prior))}`);
      }
      const goals = {};
      for (const k of GOAL_KEYS) {
        let n = Math.round(Number(cur[k]));
        if (!Number.isFinite(n) || n < 0) {
          warnings.push(`Dropped Option ${cur.index} (${cur.label || "?"}): ${k} invalid`);
          cur = null;
          return;
        }
        const [lo, hi] = BOUNDS[k] || [0, Infinity];
        if (n < lo || n > hi) {
          warnings.push(`Dropped Option ${cur.index} (${cur.label || "?"}): ${k}=${n} outside ${lo}–${hi}`);
          cur = null;
          return;
        }
        goals[k] = n;
      }
      const validation = validateGoals(goals);
      if (!validation.ok) {
        warnings.push(`Dropped Option ${cur.index} (${cur.label || "?"}): ${validation.errors[0]}`);
        cur = null;
        return;
      }
      options.push({
        index: cur.index,
        label: cur.label || `Option ${cur.index}`,
        goals,
        reason: cur.reason || "",
        sources: cur.sources || "",
      });
      cur = null;
    }

    for (const line of lines) {
      const opt = line.match(/^Option:\s*(\d+)\s*(?:\|\s*(.+))?$/i);
      if (opt) {
        pushCur();
        optionCount += 1;
        if (optionCount > LIMITS.options) {
          error = `PHASE body exceeds ${LIMITS.options} options.`;
          break;
        }
        const index = Number(opt[1]);
        if (!Number.isSafeInteger(index) || index < 1 || index > LIMITS.options) {
          error = `PHASE option number must be between 1 and ${LIMITS.options}.`;
          break;
        }
        const label = (opt[2] || "").trim();
        if (label.length > LIMITS.labelChars) {
          error = `PHASE option label exceeds ${LIMITS.labelChars} characters.`;
          break;
        }
        cur = {
          index,
          label,
          reason: "",
          sources: "",
        };
        continue;
      }
      const kindM = line.match(/^Kind:\s*(.+)$/i);
      if (kindM) {
        const raw = kindM[1].trim().toLowerCase();
        kind = typeof Phases !== "undefined" ? Phases.normalizeKind(raw) : raw;
        continue;
      }
      if (!cur) continue;
      const kv = line.match(/^(Kcal|Protein|Carbs|Fat|Fiber|Sodium|Potassium|Reason|Sources):\s*(.*)$/i);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === "reason") {
        if (val.length > LIMITS.reasonChars) {
          error = `PHASE reason exceeds ${LIMITS.reasonChars} characters.`;
          break;
        }
        cur.reason = val;
      }
      else if (key === "sources") {
        if (val.length > LIMITS.sourceChars) {
          error = `PHASE sources exceed ${LIMITS.sourceChars} characters.`;
          break;
        }
        cur.sources = val;
      }
      else if (key === "kcal") cur.kcal = parseNum(val);
      else cur[key] = parseNum(val);
    }
    if (error) return { kind, options: [], warnings, error };
    pushCur();
    return { kind, options, warnings };
  }

  function parsePhaseBlock(text, currentGoals) {
    const raw = String(text || "");
    if (raw.length > LIMITS.rawChars) {
      return { ok: false, complete: false, error: `PHASE paste exceeds ${LIMITS.rawChars} characters.` };
    }
    const bodies = extractBodies(raw);
    if (!bodies.length) {
      return { ok: false, complete: false, error: "No PHASE v1 block found. Ask the AI to use the PHASE v1 … END format." };
    }
    const completeBodies = bodies.filter((entry) => entry.complete);
    if (!completeBodies.length) {
      return {
        ok: false,
        complete: false,
        error: "Incomplete PHASE v1 block: a standalone END line is required before recommendations can be used.",
      };
    }
    // Prefer last complete body that yields ≥1 option (prompt template often precedes the reply).
    let best = null;
    for (let i = completeBodies.length - 1; i >= 0; i--) {
      const parsed = parseOneBody(completeBodies[i].body, currentGoals);
      if (parsed.error) {
        return { ok: false, complete: true, error: parsed.error, warnings: parsed.warnings || [] };
      }
      if (parsed.options.length >= 1) {
        best = parsed;
        break;
      }
      if (!best) best = parsed;
    }
    if (!best || best.options.length < 1) {
      return {
        ok: false,
        error: "PHASE block found but no complete options (need kcal and macros).",
        warnings: best ? best.warnings : [],
      };
    }
    return { ok: true, complete: true, kind: best.kind, options: best.options, warnings: best.warnings };
  }

  return {
    buildTargetPrompt, parsePhaseBlock, validateGoals,
    KIND_BRIEF, LIMITS, BOUNDS, ENERGY_POLICY,
  };
})();

if (typeof module !== "undefined") module.exports = PhasePrompt;
