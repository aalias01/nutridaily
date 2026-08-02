/* NutriDaily — PHASE v1 AI target prompt + paste parser.
 * Deterministic only. LLMs live outside the app.
 */
const PhasePrompt = (() => {
  const GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium"];

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
   * @param {{ kind: string, age: number, profile: object, weightKg: number, notes?: string }} ctx
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
      "This is NOT medical advice. Treat your output as educational reference only.\n" +
      "I must consult a qualified health professional before making major diet or training changes,\n" +
      "especially if I have a medical condition, take medication, am pregnant, or am under 18.\n\n" +
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
      "- For each option give: kcal, protein g, carbs g, fat g, fiber g, sodium mg.\n" +
      "- Plain integers only. No ranges inside the number fields.\n" +
      "- Include a short Reason (why these numbers for this person and goal).\n" +
      "- Include Sources: named equations/guidelines (e.g. Mifflin-St Jeor, ISSN protein guidance).\n" +
      "  Do not invent fake URLs. Prefer well-known position stands and standard equations.\n" +
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
    s = s.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    return s;
  }

  function extractBody(text) {
    const src = preprocess(text);
    const m = src.match(/PHASE\s*v?1\b/i);
    if (!m) return null;
    const start = m.index + m[0].length;
    const rest = src.slice(start);
    const endMatch = rest.match(/\n\s*END\s*(?:\n|$)/i);
    const body = endMatch ? rest.slice(0, endMatch.index) : rest;
    return body.replace(/^\s*\n/, "");
  }

  function parseNum(line) {
    const m = String(line).match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }

  function parsePhaseBlock(text) {
    const body = extractBody(text);
    if (!body) {
      return { ok: false, error: "No PHASE v1 block found. Ask the AI to use the PHASE v1 … END format." };
    }
    const lines = body.split(/\n/).map((l) => l.trim()).filter(Boolean);
    let kind = "maintain";
    const options = [];
    let cur = null;

    function pushCur() {
      if (!cur) return;
      const goals = {};
      for (const k of GOAL_KEYS) {
        const n = Number(cur[k]);
        if (!Number.isFinite(n)) {
          cur._bad = true;
          return;
        }
        goals[k] = Math.round(n);
      }
      options.push({
        index: cur.index,
        label: cur.label || `Option ${cur.index}`,
        goals,
        reason: cur.reason || "",
        sources: cur.sources || "",
      });
    }

    for (const line of lines) {
      const opt = line.match(/^Option:\s*(\d+)\s*(?:\|\s*(.+))?$/i);
      if (opt) {
        pushCur();
        cur = {
          index: Number(opt[1]),
          label: (opt[2] || "").trim(),
          reason: "",
          sources: "",
        };
        continue;
      }
      const kindM = line.match(/^Kind:\s*(.+)$/i);
      if (kindM && !cur) {
        const raw = kindM[1].trim().toLowerCase();
        kind = typeof Phases !== "undefined" ? Phases.normalizeKind(raw) : raw;
        continue;
      }
      if (!cur) continue;
      const kv = line.match(/^(Kcal|Protein|Carbs|Fat|Fiber|Sodium|Reason|Sources):\s*(.*)$/i);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === "reason") cur.reason = val;
      else if (key === "sources") cur.sources = val;
      else if (key === "kcal") cur.kcal = parseNum(val);
      else cur[key] = parseNum(val);
    }
    pushCur();

    const good = options.filter((o) => o && o.goals);
    if (good.length < 1) {
      return { ok: false, error: "PHASE block found but no complete options (need kcal and macros)." };
    }
    return { ok: true, kind, options: good };
  }

  return { buildTargetPrompt, parsePhaseBlock, KIND_BRIEF };
})();

if (typeof module !== "undefined") module.exports = PhasePrompt;
