/* NutriDaily — versioned phases (goal timelines) and insight scoring.
 * Pure helpers: no DOM. Revisions are append-only and day-anchored so past
 * Insights stay stable when targets change.
 */
const Phases = (() => {
  const GENERIC_ADULT_POTASSIUM_REFERENCE = 3510;
  const DEFAULT_GOALS = {
    kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300,
    // Configurable generic adult reference, not an individualized prescription.
    potassium: GENERIC_ADULT_POTASSIUM_REFERENCE,
  };

  /**
   * Sodium and potassium are handled by the kidney as a coupled system, so the
   * ratio between them predicts blood pressure better than either number does
   * alone. The target is a *molar* ratio at or below 1.0 — that is the form
   * used in the literature, and the WHO targets (2000 mg Na, 3510 mg K) work
   * out to 0.97.
   *
   * Mass and molar ratios differ by a factor of 1.70 because potassium's
   * atomic mass is 70% higher, and confusing the two is the standard error
   * here. Everything is stored in mg and converted at the point of use.
   */
  const NA_MOLAR_MASS = 22.99;
  const K_MOLAR_MASS = 39.10;
  const NAK_MASS_TO_MOLAR = K_MOLAR_MASS / NA_MOLAR_MASS; // ≈ 1.7008

  /** Molar Na:K from milligram inputs. Null when potassium is unknown or zero. */
  function naKRatio(sodiumMg, potassiumMg) {
    if (sodiumMg == null || sodiumMg === "" || potassiumMg == null || potassiumMg === "") return null;
    const na = Number(sodiumMg);
    const k = Number(potassiumMg);
    if (!Number.isFinite(na) || !Number.isFinite(k) || na < 0 || k <= 0) return null;
    return (na / NA_MOLAR_MASS) / (k / K_MOLAR_MASS);
  }
  /** User-facing kinds (pills). Legacy "custom" still resolves in data. */
  const KINDS = ["cut", "maintain", "bulk", "recomp"];
  const KIND_LABEL = {
    cut: "Cut",
    bulk: "Bulk",
    maintain: "Maintain",
    recomp: "Recomp",
    custom: "Custom",
  };
  const MAJOR_KCAL_DELTA = 200;
  const MAJOR_PROTEIN_DELTA = 25;
  // A planned day is either an eating day or a declared fast. Values between 1
  // and MIN_PLANNED_KCAL are not a smaller eating day, they are a typo: every
  // published low-energy protocol (5:2, alternate-day) sits at 500-800 kcal, and
  // a dropped digit on any of those lands below 200. The real typo defence is
  // the acknowledgement ladder (LOW_KCAL_ACK_KCAL), not this floor — this only
  // has to catch the impossible values, not the merely-implausible ones.
  const MIN_PLANNED_KCAL = 200;
  const MAX_DAY_TARGET_KCAL = 6000;
  const LOW_KCAL_ACK_KCAL = 1200;   // at or above this, no acknowledgement is required
  const FAST_KCAL = 0;
  const DAY_INTENTS = ["reduced", "fast"];

  // Copy for the Fast control in the day-plan sheet. UI reads this via
  // Phases.FAST_DECLARATION_COPY so the wording stays decided in one place.
  // The threshold it describes is a hard cliff on a mean, not a fuzzy zone:
  // effectiveGoals/scoreDayTotals treat any totals.kcal.mean > 0 as having
  // eaten, so 5 kcal of milk in black coffee reverts the whole day to an
  // ordinary one scored against the full phase target.
  const FAST_DECLARATION_COPY =
    "A fast means 0 kcal for the entire day. Logging anything with calories — even a splash of milk — ends the fast, and the day is scored normally instead.";

  /** A declared fast (0) or a real planned-day range; never the gap between.
   *  A phase target (baseKcal) is a different quantity with its own literal
   *  800 floor — see dayPlanForDay, which checks the two ranges separately on
   *  purpose so the base side is never silently widened along with this one. */
  function isPlannedKcal(n) {
    return Number.isFinite(n) && (n === FAST_KCAL || (n >= MIN_PLANNED_KCAL && n <= MAX_DAY_TARGET_KCAL));
  }

  /** Local midnight that ends `dayKey` (start of the next calendar day). */
  function endOfLocalDayMs(dayKey) {
    if (!dayKey || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey))) return null;
    const end = new Date(String(dayKey) + "T12:00:00");
    if (Number.isNaN(end.getTime())) return null;
    end.setHours(24, 0, 0, 0);
    return end.getTime();
  }

  /**
   * True when a declaration's plannedAt lands after the target day ended.
   * Used only for fasts (they have no first-add lock); reduced days close on
   * the first food add instead. The boolean rides on modern records only —
   * never on stampMap clocks.
   */
  function isDeclaredAfterDay(dayKey, plannedAt) {
    const end = endOfLocalDayMs(dayKey);
    const at = Number(plannedAt);
    return Number.isFinite(end) && Number.isFinite(at) && at > end;
  }

  /**
   * Declaration window for a target day (§10).
   * Reduced: from the previous calendar day through the target day, closing
   * on the first food add. Fast: previous day through the following day;
   * declarations after the target day ends get declaredAfterDay stamped.
   */
  function dayIntentWindow(targetDay, opts) {
    const o = opts || {};
    const todayKey = o.todayKey || dayKeyFromDate(new Date());
    const intent = o.intent === "fast" ? "fast" : "reduced";
    const hasEverAdded = typeof o.hasEverAdded === "function" ? !!o.hasEverAdded(targetDay) : !!o.hasEverAdded;
    const prev = (() => {
      const d = new Date(String(targetDay) + "T12:00:00");
      d.setDate(d.getDate() - 1);
      return dayKeyFromDate(d);
    })();
    const next = (() => {
      const d = new Date(String(targetDay) + "T12:00:00");
      d.setDate(d.getDate() + 1);
      return dayKeyFromDate(d);
    })();
    let ok = false;
    let reason = "";
    if (intent === "fast") {
      ok = todayKey >= prev && todayKey <= next;
      if (!ok) {
        reason = todayKey < prev
          ? "Fasts can only be planned from the day before through the day after."
          : "The grace window for this fast has closed.";
      }
    } else {
      ok = todayKey >= prev && todayKey <= targetDay;
      if (!ok) {
        reason = todayKey < prev
          ? "Day plans can only be set from the day before or on the day itself."
          : "Day plans can only be set for this day before it ends.";
      } else if (hasEverAdded) {
        ok = false;
        reason = "Planned calories lock after the first food is logged.";
      }
    }
    return {
      ok,
      reason,
      declaredAfterDay: intent === "fast" && isDeclaredAfterDay(targetDay, o.plannedAt != null ? o.plannedAt : Date.now()),
      prevDay: prev,
      nextDay: next,
    };
  }
  const SEX_OPTIONS = ["male", "female", "other"];
  const ACTIVITY_OPTIONS = ["sedentary", "light", "moderate", "active", "very_active"];
  const ACTIVITY_LABEL = {
    sedentary: "Sedentary (desk, little exercise)",
    light: "Light (1–3 days/week)",
    moderate: "Moderate (3–5 days/week)",
    active: "Active (6–7 days/week)",
    very_active: "Very active (physical job or 2x/day)",
  };

  /** Per-nutrient hit bands (v1 global). */
  const BANDS = {
    kcal: { dir: "range", pct: 0.10 },
    protein: { dir: "floor", pct: 0.05 },
    fiber: { dir: "floor", pct: 0.10 },
    carbs: { dir: "range", pct: 0.15 },
    fat: { dir: "range", pct: 0.15 },
    sodium: { dir: "ceiling", pct: 0.05 },
    potassium: { dir: "floor", pct: 0.10 },
    // A ratio, not a milligram amount. Target <= 1.0 molar.
    // The published target is itself the boundary: 1.00 is a hit, 1.01 is not.
    naK: { dir: "ceiling", pct: 0 },
  };

  const GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium", "potassium"];
  const PERSISTENT_GOAL_BOUNDS = Object.freeze({
    kcal: Object.freeze([1200, 6000]),
    protein: Object.freeze([0, 400]),
    carbs: Object.freeze([0, 800]),
    fat: Object.freeze([0, 800]),
    fiber: Object.freeze([0, 150]),
    sodium: Object.freeze([0, 10000]),
    potassium: Object.freeze([0, 10000]),
  });
  const PERSISTENT_ENERGY_POLICY = Object.freeze({
    atwaterTolerance: 0.20,
    maxProteinShare: 0.40,
    minFatShare: 0.20,
    maxFatShare: 0.45,
  });

  /**
   * A protein floor that would take more than the app's own maximum protein
   * share of a planned day is not a target that day, it is a contradiction.
   * validatePersistentGoals already refuses to SAVE that combination; scoring
   * against it would grade someone on a configuration the app calls invalid.
   * The floor itself is never lowered — only the scoring cell drops out.
   */
  function proteinScorableOnPlan(plannedKcal, proteinG) {
    const needed = 4 * Number(proteinG) * (1 - BANDS.protein.pct);
    const allowed = Number(plannedKcal) * PERSISTENT_ENERGY_POLICY.maxProteinShare;
    return Number.isFinite(needed) && Number.isFinite(allowed) && needed <= allowed;
  }

  /**
   * Minimum share of a day's calories that must come from foods with a known
   * potassium value before the ratio is trustworthy.
   *
   * Missing potassium does not bias the ratio randomly — it always biases it
   * upward, because the sodium is counted and the potassium that came with it
   * is not. A half-covered day would reliably report a worse ratio than
   * reality, which is the kind of error that makes someone chase a problem
   * they do not have.
   */
  const NAK_MIN_COVERAGE = 0.8;

  function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function stableLegacyId(prefix, text) {
    // Two independent FNV-1a passes keep ids compact while remaining stable in
    // every browser. This is identity, not cryptography.
    const hash = (seed, input) => {
      let h = seed >>> 0;
      for (let i = 0; i < input.length; i += 1) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h.toString(36).padStart(7, "0");
    };
    return `${prefix}_legacy_${hash(2166136261, text)}${hash(3339675911, text)}`;
  }

  function normalizeGoals(g) {
    const out = { ...DEFAULT_GOALS };
    for (const k of GOAL_KEYS) {
      const n = Number(g && g[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  }

  /** Shared ingress/producer policy for a complete persistent target set. */
  function validatePersistentGoals(goals) {
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
      const bounds = PERSISTENT_GOAL_BOUNDS[key];
      if (!Number.isFinite(n)) {
        errors.push(key + " must be a finite number");
      } else if (n < bounds[0] || n > bounds[1]) {
        errors.push(key + " must be between " + bounds[0] + " and " + bounds[1]);
      } else values[key] = n;
    }
    let macroKcal = null;
    let proteinShare = null;
    let fatShare = null;
    if (["kcal", "protein", "carbs", "fat"].every((key) => Number.isFinite(values[key]))) {
      macroKcal = 4 * values.protein + 4 * values.carbs + 9 * values.fat;
      proteinShare = 4 * values.protein / values.kcal;
      fatShare = 9 * values.fat / values.kcal;
      if (Math.abs(macroKcal - values.kcal) / values.kcal > PERSISTENT_ENERGY_POLICY.atwaterTolerance) {
        errors.push("macro calories must be within 20% of stated calories");
      }
      if (proteinShare > PERSISTENT_ENERGY_POLICY.maxProteinShare) {
        errors.push("protein cannot exceed 40% of stated calories");
      }
      if (fatShare < PERSISTENT_ENERGY_POLICY.minFatShare ||
          fatShare > PERSISTENT_ENERGY_POLICY.maxFatShare) {
        errors.push("fat must provide 20–45% of stated calories");
      }
    }
    return { ok: errors.length === 0, errors, macroKcal, proteinShare, fatShare };
  }

  function goalsEqual(a, b) {
    const A = normalizeGoals(a), B = normalizeGoals(b);
    return GOAL_KEYS.every((k) => A[k] === B[k]);
  }

  function dayGoalOverride(settings, day) {
    const ov = settings && settings.dayGoals && settings.dayGoals[day];
    if (!ov || ov.cleared) return null;
    return ov;
  }

  /** One-day energy adjustment (legacy absolute kcal converted vs phase). */
  function dayPlanForDay(day, settings, phaseGoals) {
    const ov = dayGoalOverride(settings, day);
    if (!ov) return null;
    const base = phaseGoals || normalizeGoals(DEFAULT_GOALS);
    // targetKcal has to be known before intent can be decided: "fast" is only
    // ever the resolved target's own shape, not a label that can ride along
    // independently of it (Part IX.2) — a nonzero target with intent "fast"
    // is honoured by neither Sync.normalizeDayGoal nor
    // App.importedPlannedKcal, and this is the last gate before a number
    // becomes a grade, so it must not diverge from either.
    const targetKcal = Number(ov.targetKcal);
    // Absent on every record generation that predates this feature; a missing
    // intent is an ordinary planned day, not a fast nobody declared. A bare
    // ov.intent alone is not a declaration — this is the last gate before a
    // number becomes a grade, so it checks every part of the declaration
    // itself rather than trusting an ack (or a target of 0) enforced
    // somewhere upstream (Part VIII.2, Part IX.2).
    const intent = ov.intent === "fast" && ov.fastAcknowledged === true && targetKcal === 0 ? "fast" : "reduced";
    const frozenBase = Number(ov.baseKcal);
    // This shape carries ov.intent directly, so it is the one place 0 can be
    // gated on an explicit declaration rather than merely falling in range
    // (Part VII.3) — isPlannedKcal alone can't see intent, so check it here.
    const targetKcalOk = targetKcal === 0
      ? intent === "fast"
      : Number.isFinite(targetKcal) && targetKcal >= MIN_PLANNED_KCAL && targetKcal <= MAX_DAY_TARGET_KCAL;
    if (targetKcalOk &&
        Number.isFinite(frozenBase) && frozenBase >= 800 && frozenBase <= MAX_DAY_TARGET_KCAL) {
      // A locked no-op (targetKcal === frozenBase) is a healed restatement of
      // the phase's own target, not a plan, and must not need an
      // acknowledgement it was never offered the chance to give — mirrors
      // Sync.normalizeDayGoal's identical exemption.
      if (targetKcal !== frozenBase && targetKcal > 0 && targetKcal < LOW_KCAL_ACK_KCAL &&
          ov.veryLowCalorieAcknowledged !== true) {
        return null;
      }
      const kcal = targetKcal - frozenBase;
      return kcal !== 0 || ov.locked
        ? {
          kcal, targetKcal, baseKcal: frozenBase,
          plannedAt: Number(ov.plannedAt) || 0,
          locked: ov.locked === true,
          intent,
          ...(intent === "fast" && ov.declaredAfterDay === true ? { declaredAfterDay: true } : {}),
        }
        : null;
    }
    // Neither the delta-bump nor the legacy-absolute shape below can express
    // intent (sync.js's normalizeDayGoal never lets it ride along on either),
    // so a resolved target of exactly 0 here is an arithmetic accident, not a
    // declaration — [MIN_PLANNED_KCAL, MAX_DAY_TARGET_KCAL] only, never the
    // {0} ∪ … helper (Part VII.3: this was a laundering path into a fully
    // unscored day with no fast ever declared).
    if (ov.bumps && typeof ov.bumps === "object") {
      const kcal = Number(ov.bumps.kcal);
      const baseKcal = Number(base.kcal);
      const target = baseKcal + kcal;
      if (!(Number.isFinite(kcal) && kcal !== 0 &&
          Number.isFinite(baseKcal) && baseKcal >= 800 && baseKcal <= MAX_DAY_TARGET_KCAL &&
          target >= MIN_PLANNED_KCAL && target <= MAX_DAY_TARGET_KCAL)) {
        return null;
      }
      // A stale delta bump can resolve to a live very-low target after a
      // phase revision walks its base down — a record does not always
      // originate from a compliant client, so the ladder is enforced at the
      // point the number is finally concrete rather than trusted upstream
      // (Part VIII.2; this is the exact scenario VII.4 described).
      if (target < LOW_KCAL_ACK_KCAL && ov.veryLowCalorieAcknowledged !== true) return null;
      return { kcal, intent: "reduced" };
    }
    // Legacy absolute dayGoals → derive the calorie delta only. Historical
    // macro/electrolyte keys are intentionally ignored: a one-day adjustment
    // must never move protein, sodium or any other nutrient target.
    const absolute = Number(ov.kcal);
    const baseKcal = Number(base.kcal);
    if (!Number.isFinite(absolute) || absolute < MIN_PLANNED_KCAL || absolute > MAX_DAY_TARGET_KCAL ||
        !Number.isFinite(baseKcal) || baseKcal < 800 || baseKcal > MAX_DAY_TARGET_KCAL) return null;
    if (absolute < LOW_KCAL_ACK_KCAL && ov.veryLowCalorieAcknowledged !== true) return null;
    const kcal = absolute - baseKcal;
    return kcal !== 0
      ? { kcal, targetKcal: absolute, baseKcal, plannedAt: Number(ov.plannedAt) || 0, intent: "reduced" }
      : null;
  }

  function phaseCovers(phase, day) {
    if (!phase || !day) return false;
    if (phase.archived) return false;
    if (day < phase.startDay) return false;
    if (phase.endDay != null && day > phase.endDay) return false;
    return true;
  }

  function phaseForDay(phases, day) {
    const list = Array.isArray(phases) ? phases : [];
    // Legacy/synced data can overlap. Resolve deterministically to the phase
    // that started most recently rather than whichever array happened to win.
    return list.filter((p) => phaseCovers(p, day)).sort((a, b) =>
      String(b.startDay).localeCompare(String(a.startDay)) ||
      (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0) ||
      String(b.id || "").localeCompare(String(a.id || ""))
    )[0] || null;
  }

  function activePhase(phases) {
    const list = Array.isArray(phases) ? phases : [];
    return list.filter((p) => p && p.endDay == null && !p.archived).sort((a, b) =>
      String(b.startDay).localeCompare(String(a.startDay)) ||
      (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0) ||
      String(b.id || "").localeCompare(String(a.id || ""))
    )[0] || null;
  }

  function sortRevisions(revisions) {
    return [...(revisions || [])].sort((a, b) =>
      String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)) ||
      (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0) ||
      (a.createdAt || 0) - (b.createdAt || 0) ||
      String(a.id).localeCompare(String(b.id))
    );
  }

  function rawRevisionForDay(phase, day) {
    if (!phase || !Array.isArray(phase.revisions) || !phase.revisions.length) return null;
    const sorted = sortRevisions(phase.revisions);
    let pick = null;
    for (const r of sorted) {
      if (r.effectiveFrom <= day) pick = r;
      else break;
    }
    return pick || sorted[0];
  }

  function revisionTargetValidation(revision) {
    if (!revision || typeof revision !== "object") {
      return { ok: false, errors: ["target version is missing"] };
    }
    return validatePersistentGoals(normalizeGoals(revision.goals));
  }

  function revisionActivatable(revision) {
    return !!revision && revision.auditOnly !== true && revisionTargetValidation(revision).ok;
  }

  /** Nearest preceding policy-valid target; invalid rows remain audit-only. */
  function revisionForDay(phase, day) {
    if (!phase || !Array.isArray(phase.revisions) || !phase.revisions.length) return null;
    const sorted = sortRevisions(phase.revisions).filter(revisionActivatable);
    let pick = null;
    for (const revision of sorted) {
      if (revision.effectiveFrom <= day) pick = revision;
      else break;
    }
    return pick;
  }

  function latestActivatableRevision(phase) {
    return sortRevisions((phase && phase.revisions) || []).filter(revisionActivatable).slice(-1)[0] || null;
  }

  /** Kind is revision-dated just like the numeric targets. */
  function revisionKind(phase, revision) {
    return normalizeKind(revision && revision.kind != null ? revision.kind : phase && phase.kind);
  }

  function kindForDay(phase, day) {
    return revisionKind(phase, revisionForDay(phase, day));
  }

  function revisionLabel(phase, revision) {
    if (!revision) return phase && phase.name || "";
    if (revision.label) return revision.label;
    const version = String(revision.version || "");
    const match = version.match(/^(\d+)\.(\d+)$/);
    if (match) return formatPhaseName(
      revisionKind(phase, revision), Number(match[1]), Number(match[2])
    );
    const kind = revisionKind(phase, revision);
    const phaseVersion = String(phase && phase.name || "").match(/v(\d+)\.(\d+)/i);
    if (phaseVersion) return formatPhaseName(kind, Number(phaseVersion[1]), Number(phaseVersion[2]));
    return KIND_LABEL[kind] || kind;
  }

  function labelForDay(phase, day) {
    return revisionLabel(phase, revisionForDay(phase, day));
  }

  /**
   * Resolve immutable add-event days through the same phase/revision rules used
   * by goalsForDay. A later remove never erases the root add, so its governing
   * target version remains part of the historical record.
   */
  function governedRevisionUsage(phases, events) {
    const days = [...new Set((Array.isArray(events) ? events : [])
      .filter((event) => event && event.type === "add" && typeof event.day === "string" && event.day)
      .map((event) => event.day))].sort();
    const usage = new Map();
    for (const day of days) {
      const phase = phaseForDay(phases, day);
      const revision = revisionForDay(phase, day);
      if (!phase || !phase.id || !revision || !revision.id) continue;
      const key = `${phase.id}\u0000${revision.id}`;
      const row = usage.get(key) || {
        phaseId: phase.id,
        revisionId: revision.id,
        firstDay: day,
        days: [],
      };
      row.days.push(day);
      usage.set(key, row);
    }
    return [...usage.values()];
  }

  function revisionDeletionStatus(settings, phaseId, revisionId, events) {
    const phases = settings && Array.isArray(settings.phases) ? settings.phases : [];
    const phase = phases.find((p) => p && p.id === phaseId);
    if (!phase || !Array.isArray(phase.revisions)) return { ok: false, reason: "missing" };
    if (!phase.revisions.some((r) => r && r.id === revisionId)) return { ok: false, reason: "missing" };
    let history = events;
    if (!Array.isArray(history)) {
      try {
        history = typeof Ledger !== "undefined" && Ledger && typeof Ledger.allEvents === "function"
          ? Ledger.allEvents()
          : [];
      } catch (error) { history = []; }
    }
    const used = governedRevisionUsage(phases, history)
      .find((row) => row.phaseId === phaseId && row.revisionId === revisionId);
    if (used) return { ok: false, reason: "governed", day: used.firstDay, days: used.days.slice() };
    if (phase.revisions.length <= 1) return { ok: false, reason: "last" };
    return { ok: true };
  }

  function normalizeKind(kind) {
    if (kind === "cut" || kind === "bulk" || kind === "maintain" || kind === "recomp") return kind;
    return "maintain";
  }

  function ageFromDob(dob, onDay) {
    if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) return null;
    const day = onDay || new Date().toISOString().slice(0, 10);
    const [y, m, d] = String(dob).split("-").map(Number);
    const [Y, M, D] = String(day).split("-").map(Number);
    let age = Y - y;
    if (M < m || (M === m && D < d)) age -= 1;
    return age >= 0 && age < 130 ? age : null;
  }

  function normalizeProfile(p) {
    const out = {
      dob: "",
      sex: "",
      heightCm: null,
      activity: "",
      notes: "",
      updatedAt: 0,
    };
    if (!p || typeof p !== "object") return out;
    if (p.dob && /^\d{4}-\d{2}-\d{2}$/.test(String(p.dob))) out.dob = String(p.dob);
    if (SEX_OPTIONS.includes(p.sex)) out.sex = p.sex;
    const h = Number(p.heightCm);
    if (Number.isFinite(h) && h >= 90 && h <= 250) out.heightCm = Math.round(h * 10) / 10;
    if (ACTIVITY_OPTIONS.includes(p.activity)) out.activity = p.activity;
    if (p.notes != null) out.notes = String(p.notes).slice(0, 500);
    out.updatedAt = Number(p.updatedAt) || 0;
    // Preserve absence until the one-time generation migration runs. Treating
    // a missing released-v4 epoch as explicit zero can erase a post-reset
    // profile before the migration has a chance to stamp it.
    if (Object.prototype.hasOwnProperty.call(p, "resetEpoch")) {
      out.resetEpoch = Number.isSafeInteger(Number(p.resetEpoch)) && Number(p.resetEpoch) >= 0
        ? Number(p.resetEpoch) : 0;
    }
    return out;
  }

  function ensureProfile(settings) {
    if (!settings || typeof settings !== "object") return normalizeProfile(null);
    settings.profile = normalizeProfile(settings.profile);
    return settings.profile;
  }

  /** Latest non-cleared body weight (kg), preferring onOrBefore day then any. */
  function latestWeightKg(settings, onOrBefore) {
    const entries = Object.entries((settings && settings.weights) || {})
      .filter(([, w]) => w && !w.cleared && w.kg != null && Number.isFinite(Number(w.kg)))
      .sort((a, b) => b[0].localeCompare(a[0]));
    for (const [day, w] of entries) {
      if (onOrBefore && day > onOrBefore) continue;
      return Number(w.kg);
    }
    return entries.length ? Number(entries[0][1].kg) : null;
  }

  /**
   * Required for AI targets copy: dob→age, sex, height, activity, weightKg.
   * Returns { ok, missing: string[], age, profile, weightKg }.
   */
  function automatedTargetEligibility(settings, opts) {
    const profile = ensureProfile(settings);
    const today = (opts && opts.todayKey) || new Date().toISOString().slice(0, 10);
    const weightKg = opts && opts.weightKg != null && Number.isFinite(Number(opts.weightKg))
      ? Number(opts.weightKg)
      : latestWeightKg(settings, today);
    const age = ageFromDob(profile.dob, today);
    const missing = [];
    if (!profile.dob || age == null) missing.push("date of birth");
    if (!profile.sex) missing.push("sex");
    if (profile.heightCm == null) missing.push("height");
    if (!profile.activity) missing.push("activity level");
    if (weightKg == null || !(weightKg > 0)) missing.push("body weight");
    const under18 = age != null && age < 18;
    const highRisk = /\b(pregnan|breast\s*feed|nursing|kidney|renal|dialysis|eating\s+disorder|anorexi|bulimi|insulin|diabet|medical\s+condition|prescription|medication)\b/i
      .test(profile.notes || "");
    let status = "eligible";
    let message = "Profile supports automated target suggestions.";
    if (under18) {
      status = "blocked";
      message = "Automated calorie targets are not available for people under 18. Review targets with a qualified clinician.";
    } else if (missing.length) {
      status = "review";
      message = `For review only — add ${missing.join(", ")} before applying an automated calorie target.`;
    } else if (highRisk) {
      status = "review";
      message = "For review only — your profile notes indicate a condition or medication that needs individualized professional guidance.";
    }
    return {
      ok: status === "eligible",
      canApply: status === "eligible",
      status,
      message,
      missing,
      under18,
      highRisk,
      age,
      profile,
      weightKg: weightKg != null ? Math.round(weightKg * 100) / 100 : null,
    };
  }

  function profileReadyForAi(settings, opts) {
    return automatedTargetEligibility(settings, opts);
  }

  function mergeProfiles(a, b) {
    const A = normalizeProfile(a);
    const B = normalizeProfile(b);
    const at = Number(A.updatedAt) || 0, bt = Number(B.updatedAt) || 0;
    if (at !== bt) return bt > at ? B : A;
    const stable = (value) => {
      if (Array.isArray(value)) return value.map(stable);
      if (!value || typeof value !== "object") return value;
      const out = Object.create(null);
      for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
      return out;
    };
    return JSON.stringify(stable(B)) > JSON.stringify(stable(A)) ? B : A;
  }

  function formatPhaseName(kind, major, minor) {
    const label = KIND_LABEL[normalizeKind(kind)] || "Maintain";
    return `${label} v${major}.${minor}`;
  }

  function ensurePhaseVersion(phase) {
    if (!phase) return { major: 1, minor: 0 };
    let major = Number(phase.versionMajor);
    let minor = Number(phase.versionMinor);
    if (!Number.isFinite(major) || major < 1 || !Number.isFinite(minor) || minor < 0) {
      const m = String(phase.name || "").match(/v(\d+)\.(\d+)/i);
      if (m) {
        major = Math.max(1, Number(m[1]));
        minor = Math.max(0, Number(m[2]));
      } else {
        const n = Math.max(1, (phase.revisions || []).length);
        major = 1;
        minor = Math.max(0, n - 1);
      }
      phase.versionMajor = major;
      phase.versionMinor = minor;
    }
    return { major, minor };
  }

  function applyPhaseLabel(phase) {
    const v = ensurePhaseVersion(phase);
    phase.kind = normalizeKind(phase.kind);
    phase.name = formatPhaseName(phase.kind, v.major, v.minor);
    return phase.name;
  }

  /** Major if kind changes, kcal jumps ≥200, or protein jumps ≥25; else minor. */
  function detectMagnitude(prevGoals, nextGoals, prevKind, nextKind) {
    if (normalizeKind(prevKind) !== normalizeKind(nextKind)) return "major";
    const a = normalizeGoals(prevGoals);
    const b = normalizeGoals(nextGoals);
    if (Math.abs(a.kcal - b.kcal) >= MAJOR_KCAL_DELTA) return "major";
    if (Math.abs(a.protein - b.protein) >= MAJOR_PROTEIN_DELTA) return "major";
    return "minor";
  }

  function bumpVersion(phase, magnitude, labelKind) {
    const v = ensurePhaseVersion(phase);
    if (magnitude === "major") {
      phase.versionMajor = v.major + 1;
      phase.versionMinor = 0;
    } else {
      phase.versionMajor = v.major;
      phase.versionMinor = v.minor + 1;
    }
    applyPhaseLabel(phase);
    return {
      major: phase.versionMajor,
      minor: phase.versionMinor,
      label: formatPhaseName(
        labelKind == null ? phase.kind : labelKind,
        phase.versionMajor,
        phase.versionMinor
      ),
    };
  }

  /**
   * Resolve targets for a day. A one-day plan never moves a floor or a
   * ceiling — protein, fiber, sodium and potassium keep their numbers under
   * every intent. Carbs and fat follow energy by the same retarget policy a
   * phase revision uses. A target the plan makes arithmetically incoherent is
   * not scored that day (see _unscored below), and says so before you log.
   */
  function goalsForDay(day, settings) {
    const base = normalizeGoals((settings && settings.goals) || DEFAULT_GOALS);
    const phase = phaseForDay((settings && settings.phases) || [], day);
    const rev = revisionForDay(phase, day);
    const fromPhase = rev ? normalizeGoals(rev.goals) : base;
    const bumps = dayPlanForDay(day, settings, fromPhase);
    if (!bumps) return { ...fromPhase, _dayPlan: null, _phase: fromPhase, _unscored: null };
    const resolved = { ...fromPhase };
    if (Number.isFinite(bumps.targetKcal)) {
      resolved.kcal = bumps.targetKcal;
      resolved._phase = { ...fromPhase, kcal: bumps.baseKcal };
    } else {
      // dayPlanForDay's delta branch already validated fromPhase.kcal + bumps.kcal
      // into [MIN_PLANNED_KCAL, MAX_DAY_TARGET_KCAL] before returning, so this
      // can never land at or below 0 — no clamp needed, and one would read as
      // a second sanctioned route to a zero target alongside the fast branch.
      resolved.kcal = fromPhase.kcal + bumps.kcal;
      resolved._phase = fromPhase;
    }
    resolved._dayPlan = bumps;

    const intent = bumps.intent === "fast" ? "fast" : "reduced";
    if (intent === "fast") {
      // Phase values stay on the resolved object — Today and the phase editor
      // still need something to read — but nothing is graded: there is no
      // meaningful target to hold anyone to against zero calories. kcal
      // itself carries the same reason even though classify() already skips
      // a 0 target mechanically — without it, nutritionScore's exemptByPlan
      // never fires for kcal, and the row silently drops out of an all-fast
      // range instead of disclosing why, the one nutrient VII.6's mineral
      // disclosure fix missed (Part IX.3).
      const unscoredFast = { kcal: "declared fast" };
      for (const key of GOAL_KEYS) {
        if (key === "kcal") continue;
        unscoredFast[key] = "declared fast";
      }
      unscoredFast.naK = "declared fast";
      resolved._unscored = unscoredFast;
      return resolved;
    }

    // healLoggedDayGoals writes a {targetKcal === baseKcal, locked: true}
    // record for every logged day, even when the plan changed nothing — so
    // dayPlanForDay returns a non-null record on every logged day, not just
    // planned ones. Retargeting carbs/fat (and evaluating the protein floor)
    // against an energy figure that hasn't actually moved would silently
    // drift those two numbers on days the user never planned at all (see
    // Part VII.1). A locked no-op must resolve byte-identically to the phase
    // goals: nothing below this line may run unless the plan moved energy.
    if (resolved.kcal === fromPhase.kcal) {
      resolved._unscored = null;
      return resolved;
    }

    // Both test harnesses set globalThis.Analytics before any test runs, and
    // index.html loads phases.js before analytics.js — Analytics is defined
    // by the time this line executes either way. The guard is not for that;
    // it is what keeps phases.js loadable on its own if some future caller
    // requires it without analytics.js, the same way analytics.js guards its
    // own Phases reference. Absent Analytics, treat retargetForKcal as having
    // returned null: carbs/fat hold at phase values and drop out of scoring
    // instead of silently contradicting the day's calorie plan.
    const retargetForKcal = typeof Analytics !== "undefined" && typeof Analytics.retargetForKcal === "function"
      ? Analytics.retargetForKcal
      : null;
    const retargeted = retargetForKcal ? retargetForKcal(fromPhase, resolved.kcal) : null;
    const unscored = {};
    if (retargeted) {
      resolved.carbs = retargeted.carbs;
      resolved.fat = retargeted.fat;
    } else {
      unscored.carbs = "energy too low to retarget carbs and fat coherently";
      unscored.fat = "energy too low to retarget carbs and fat coherently";
    }
    if (!proteinScorableOnPlan(resolved.kcal, fromPhase.protein)) {
      unscored.protein = "protein floor exceeds the plan's maximum protein share";
    }
    resolved._unscored = Object.keys(unscored).length ? unscored : null;
    return resolved;
  }

  function formatDayPlanSummary(bumps) {
    if (!bumps) return "";
    const kcal = Number(bumps.kcal);
    return Number.isFinite(kcal) && kcal !== 0
      ? `${kcal > 0 ? "+" : ""}${Math.round(kcal)} kcal`
      : "";
  }

  function mirrorActiveGoals(settings) {
    const today = settings._todayKey || null;
    const phase = (today && phaseForDay(settings.phases, today)) || activePhase(settings.phases);
    const day = today || (phase && phase.startDay) || "1970-01-01";
    const rev = revisionForDay(phase, day);
    settings.goals = rev ? normalizeGoals(rev.goals) : normalizeGoals(settings.goals);
    return settings.goals;
  }

  /**
   * Canonical legacy ingress migration for persistent target policy.
   * Invalid revisions stay byte-visible as audit rows, but resolution can use
   * only the nearest preceding valid revision. If no valid target exists, the
   * documented generic default is activated and Settings is marked for review.
   */
  function sanitizePersistentTargets(settings, todayKey) {
    if (!settings || typeof settings !== "object") return { changed: false, review: null };
    const before = JSON.stringify({
      goals: settings.goals,
      goalsUpdatedAt: settings.goalsUpdatedAt,
      goalsResetEpoch: settings.goalsResetEpoch,
      phases: settings.phases,
      targetReview: settings.targetReview,
    });
    const phases = Array.isArray(settings.phases) ? settings.phases : [];
    const invalidByPhase = new Map();
    for (const phase of phases) {
      const invalid = [];
      for (const revision of (phase && phase.revisions) || []) {
        if (!revision || typeof revision !== "object") continue;
        const normalized = normalizeGoals(revision.goals);
        const validation = validatePersistentGoals(normalized);
        revision.goals = normalized;
        if (validation.ok) {
          delete revision.auditOnly;
          delete revision.targetValidationErrors;
        } else {
          revision.auditOnly = true;
          revision.targetValidationErrors = [...new Set(validation.errors)].sort();
          invalid.push(revision);
        }
      }
      if (phase && phase.id && invalid.length) invalidByPhase.set(phase.id, invalid);
    }

    const day = todayKey || "1970-01-01";
    const phase = phaseForDay(phases, day) || activePhase(phases);
    const rawCurrent = rawRevisionForDay(phase, day);
    const fallbackRevision = revisionForDay(phase, day);
    const singleton = normalizeGoals(settings.goals);
    const singletonValidation = validatePersistentGoals(singleton);
    let fallback = "singleton";
    if (fallbackRevision) {
      settings.goals = normalizeGoals(fallbackRevision.goals);
      settings.goalsUpdatedAt = Number(fallbackRevision.updatedAt || fallbackRevision.createdAt) || 0;
      if (Object.prototype.hasOwnProperty.call(fallbackRevision, "resetEpoch")) {
        settings.goalsResetEpoch = fallbackRevision.resetEpoch;
      }
      fallback = rawCurrent && rawCurrent.id !== fallbackRevision.id ? "preceding-valid" : "active-valid";
    } else if (singletonValidation.ok) {
      settings.goals = singleton;
      if (rawCurrent && !revisionActivatable(rawCurrent) && goalsEqual(singleton, DEFAULT_GOALS)) {
        fallback = "generic-default";
      }
    } else {
      settings.goals = { ...DEFAULT_GOALS };
      settings.goalsUpdatedAt = 0;
      fallback = "generic-default";
    }

    const activeInvalid = [];
    if (phase) {
      for (const revision of invalidByPhase.get(phase.id) || []) {
        const isCurrent = rawCurrent && revision.id === rawCurrent.id;
        const isFuture = phase.endDay == null && !phase.archived && revision.effectiveFrom > day;
        if (isCurrent || isFuture) activeInvalid.push(revision);
      }
    }
    const singletonUnsafe = !singletonValidation.ok;
    const required = singletonUnsafe || activeInvalid.length > 0;
    if (required) {
      const errors = [...new Set([
        ...(singletonUnsafe ? singletonValidation.errors : []),
        ...activeInvalid.flatMap((revision) => revision.targetValidationErrors || []),
      ])].sort();
      settings.targetReview = {
        version: 1,
        required: true,
        fallback: fallback === "active-valid" ? "singleton" : fallback,
        invalidRevisionIds: activeInvalid.map((revision) => String(revision.id || "")).sort(),
        errors,
      };
    } else delete settings.targetReview;

    const after = JSON.stringify({
      goals: settings.goals,
      goalsUpdatedAt: settings.goalsUpdatedAt,
      goalsResetEpoch: settings.goalsResetEpoch,
      phases: settings.phases,
      targetReview: settings.targetReview,
    });
    return { changed: before !== after, review: settings.targetReview || null };
  }

  function earliestDayFromEvents(events) {
    let min = null;
    for (const e of events || []) {
      if (e && e.day && (!min || e.day < min)) min = e.day;
    }
    return min;
  }

  /** Idempotent: synthesize one phase from legacy settings.goals if needed. */
  function ensureMigrated(settings, earliestDay, todayKey) {
    if (!settings || typeof settings !== "object") return settings;
    if (!settings.dayGoals || typeof settings.dayGoals !== "object") settings.dayGoals = {};
    if (!settings.weights || typeof settings.weights !== "object") settings.weights = {};
    ensureProfile(settings);
    if (Array.isArray(settings.phases) && settings.phases.length) {
      for (const p of settings.phases) {
        if (!p) continue;
        if (!p.revisionTombstones || typeof p.revisionTombstones !== "object") p.revisionTombstones = {};
        for (const r of p.revisions || []) {
          if (r && !r.updatedAt) r.updatedAt = r.createdAt || p.updatedAt || 0;
          if (r) r.kind = revisionKind(p, r);
        }
        p.kind = normalizeKind(p.kind === "custom" ? "maintain" : p.kind);
        ensurePhaseVersion(p);
        applyPhaseLabel(p);
      }
      mirrorActiveGoals(Object.assign(settings, { _todayKey: todayKey }));
      delete settings._todayKey;
      sanitizePersistentTargets(settings, todayKey);
      return settings;
    }
    const start = earliestDay || todayKey || "1970-01-01";
    const goals = normalizeGoals(settings.goals);
    const now = Number(settings.goalsUpdatedAt) || 0;
    const hasResetEpoch = Object.prototype.hasOwnProperty.call(settings, "goalsResetEpoch");
    const resetEpoch = hasResetEpoch && Number.isSafeInteger(Number(settings.goalsResetEpoch)) &&
      Number(settings.goalsResetEpoch) >= 0 ? Number(settings.goalsResetEpoch) : 0;
    const canonical = JSON.stringify({
      goals: GOAL_KEYS.map((key) => [key, goals[key]]),
      goalsUpdatedAt: now,
      // `todayKey` is presentation state, not identity. Two devices opening the
      // same no-event legacy document on different dates must synthesize the same
      // ids; an empty sentinel is the stable no-event anchor.
      earliestDay: earliestDay || "",
    });
    const phaseId = stableLegacyId("ph", canonical);
    const revisionId = stableLegacyId("rv", canonical);
    settings.phases = [{
      id: phaseId,
      name: formatPhaseName("maintain", 1, 0),
      kind: "maintain",
      syntheticLegacy: true,
      versionMajor: 1,
      versionMinor: 0,
      startDay: start,
      endDay: null,
      createdAt: now,
      updatedAt: now,
      ...(hasResetEpoch ? { resetEpoch } : {}),
      archived: false,
      revisionTombstones: {},
      revisions: [{
        id: revisionId,
        effectiveFrom: start,
        goals,
        kind: "maintain",
        createdAt: now,
        updatedAt: now,
        ...(hasResetEpoch ? { resetEpoch } : {}),
        note: "Migrated from settings",
        version: "1.0",
        label: formatPhaseName("maintain", 1, 0),
      }],
    }];
    settings.goals = goals;
    sanitizePersistentTargets(settings, todayKey || start);
    return settings;
  }

  function dayBefore(dayKey) {
    const d = new Date(dayKey + "T12:00:00");
    d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /**
   * Save active phase targets (and optional kind). Bumps version label.
   * Same-day revisions: replace the latest same-day row so Insights stay stable
   * and the form does not flip back to an older same-day id-ordered snapshot.
   * Returns { changed, bumped, label } or false if nothing to do.
   */
  function appendRevision(settings, goals, effectiveFrom, note, opts) {
    ensureMigrated(settings, effectiveFrom, effectiveFrom);
    const phase = phaseForDay(settings.phases, effectiveFrom) || activePhase(settings.phases);
    if (!phase) return false;
    const options = opts || {};
    const cur = revisionForDay(phase, effectiveFrom);
    const currentKind = revisionKind(phase, cur);
    const nextKind = options.kind != null ? normalizeKind(options.kind) : currentKind;
    const next = normalizeGoals(goals);
    const validation = validatePersistentGoals(next);
    if (!validation.ok) {
      const error = new Error(validation.errors[0] || "Persistent targets are invalid");
      error.code = "persistent-target-invalid";
      error.errors = validation.errors.slice();
      throw error;
    }
    const goalsChanged = !(cur && goalsEqual(cur.goals, next));
    const kindChanged = nextKind !== currentKind;

    if (!goalsChanged && !kindChanged) {
      mirrorActiveGoals(Object.assign(settings, { _todayKey: effectiveFrom }));
      delete settings._todayKey;
      applyPhaseLabel(phase);
      return false;
    }

    const magnitude = options.magnitude === "major" || options.magnitude === "minor"
      ? options.magnitude
      : detectMagnitude(cur ? cur.goals : next, next, currentKind, nextKind);

    // Phase-level kind is the kind at phase creation. Changing it immediately
    // would rewrite the meaning exposed by legacy callers before a tomorrow-
    // effective revision begins, so only the dated revision carries nextKind.
    const bumped = bumpVersion(phase, magnitude, nextKind);
    phase.revisions = phase.revisions || [];

    // Same calendar day: update the latest same-day row if one already exists
    // beyond the phase's first revision (keeps an original snapshot + avoids id races).
    const sortedRevs = sortRevisions(phase.revisions);
    const last = sortedRevs[sortedRevs.length - 1];
    const replace = last &&
      last.effectiveFrom === effectiveFrom &&
      sortedRevs.length > 1 &&
      last.id !== sortedRevs[0].id
      ? last
      : null;
    if (replace) {
      replace.goals = next;
      replace.kind = nextKind;
      replace.updatedAt = Date.now();
      replace.note = note || replace.note || "";
      replace.version = `${bumped.major}.${bumped.minor}`;
      replace.label = bumped.label;
    } else {
      const revisionNow = Date.now();
      phase.revisions.push({
        id: uid("rv"),
        effectiveFrom,
        goals: next,
        kind: nextKind,
        createdAt: revisionNow,
        updatedAt: revisionNow,
        note: note || "",
        version: `${bumped.major}.${bumped.minor}`,
        label: bumped.label,
      });
    }
    phase.updatedAt = Date.now();
    settings.goals = next;
    settings.goalsUpdatedAt = Date.now();
    return { changed: true, bumped: true, label: bumped.label, magnitude };
  }

  function updatePhaseMeta(settings, { kind, effectiveFrom }) {
    // Kept as a compatibility API, but an undated kind write is no longer
    // allowed: it would silently rewrite the meaning of every historical day.
    if (!effectiveFrom) return false;
    ensureMigrated(settings, effectiveFrom, effectiveFrom);
    const phase = activePhase(settings.phases);
    const revision = revisionForDay(phase, effectiveFrom);
    if (!phase || !revision) return false;
    return appendRevision(settings, revision.goals, effectiveFrom, "", { kind });
  }

  /** End active phase yesterday (relative to startDay) and open a new one at Kind v1.0. */
  function startPhase(settings, { kind, goals, startDay, copyGoals }) {
    ensureMigrated(settings, startDay, startDay);
    const prev = activePhase(settings.phases);
    const start = startDay;
    const k = normalizeKind(kind);
    const g = copyGoals && prev
      ? normalizeGoals((revisionForDay(prev, start) || {}).goals || settings.goals)
      : normalizeGoals(goals || settings.goals);
    const validation = validatePersistentGoals(g);
    if (!validation.ok) {
      const error = new Error(validation.errors[0] || "Persistent targets are invalid");
      error.code = "persistent-target-invalid";
      error.errors = validation.errors.slice();
      throw error;
    }
    // Validate the complete candidate before ending or archiving the existing
    // phase. A rejected producer value must not leave a half-applied phase
    // transition behind.
    if (prev) {
      const end = dayBefore(start);
      prev.endDay = end;
      // Starting again on the same day replaces a phase with no completed
      // calendar day. Archiving avoids an impossible/overlapping history row.
      if (end < prev.startDay) prev.archived = true;
      prev.updatedAt = Date.now();
    }
    const now = Date.now();
    const label = formatPhaseName(k, 1, 0);
    const phase = {
      id: uid("ph"),
      name: label,
      kind: k,
      versionMajor: 1,
      versionMinor: 0,
      startDay: start,
      endDay: null,
      createdAt: now,
      updatedAt: now,
      archived: false,
      revisionTombstones: {},
      revisions: [{
        id: uid("rv"),
        effectiveFrom: start,
        goals: g,
        kind: k,
        createdAt: now,
        updatedAt: now,
        note: "",
        version: "1.0",
        label,
      }],
    };
    settings.phases.push(phase);
    settings.goals = g;
    settings.goalsUpdatedAt = now;
    return phase;
  }

  /** Delete a target version from a phase. Keeps at least one revision. */
  function deleteRevision(settings, phaseId, revisionId, todayKey, events) {
    // Refuse before ensureMigrated or any other mutation. UI state can be stale,
    // and callers must not be able to tombstone governed history programmatically.
    const eligibility = revisionDeletionStatus(settings, phaseId, revisionId, events);
    if (!eligibility.ok) return eligibility;
    ensureMigrated(settings, todayKey, todayKey);
    const phase = (settings.phases || []).find((p) => p && p.id === phaseId);
    if (!phase || !Array.isArray(phase.revisions)) return { ok: false, reason: "missing" };
    const idx = phase.revisions.findIndex((r) => r && r.id === revisionId);
    if (idx < 0) return { ok: false, reason: "missing" };
    const deletedAt = Date.now();
    phase.revisionTombstones = { ...(phase.revisionTombstones || {}) };
    phase.revisionTombstones[revisionId] = Math.max(
      Number(phase.revisionTombstones[revisionId]) || 0,
      deletedAt
    );
    phase.revisions.splice(idx, 1);
    phase.updatedAt = deletedAt;

    // Sync phase label to the latest remaining revision when possible.
    const latest = sortRevisions(phase.revisions).slice(-1)[0];
    if (latest && latest.version && /^\d+\.\d+$/.test(String(latest.version))) {
      const [maj, min] = String(latest.version).split(".").map(Number);
      phase.versionMajor = maj;
      phase.versionMinor = min;
      applyPhaseLabel(phase);
    } else {
      applyPhaseLabel(phase);
    }
    mirrorActiveGoals(Object.assign(settings, { _todayKey: todayKey || phase.startDay }));
    delete settings._todayKey;
    return { ok: true, label: labelForDay(phase, todayKey || phase.startDay) };
  }

  /** Target versions for the phase history sheet (newest first). */
  function revisionHistoryRows(phase, onDay) {
    if (!phase) return [];
    const sorted = sortRevisions(phase.revisions).reverse();
    const currentId = onDay
      ? ((revisionForDay(phase, onDay) || {}).id || null)
      : ((sorted[0] || {}).id || null);
    return sorted.map((r, i) => {
      const g = normalizeGoals(r.goals);
      const version = r.version || "";
      const kind = revisionKind(phase, r);
      const label = revisionLabel(phase, r);
      return {
        id: r.id,
        version,
        label,
        effectiveFrom: r.effectiveFrom,
        createdAt: r.createdAt || 0,
        goals: g,
        kind,
        summary: `${Math.round(g.kcal)} kcal · P${Math.round(g.protein)} C${Math.round(g.carbs)} F${Math.round(g.fat)}`,
        current: r.id === currentId,
        auditOnly: !revisionActivatable(r),
        validationErrors: (r.targetValidationErrors || revisionTargetValidation(r).errors || []).slice(),
      };
    });
  }

  function classify(actual, target, band) {
    if (!target || !Number.isFinite(actual)) return "skip";
    if (band.dir === "floor") {
      return actual >= target * (1 - band.pct) ? "hit" : "under";
    }
    if (band.dir === "ceiling") {
      return actual <= target * (1 + band.pct) ? "hit" : "over";
    }
    // range
    const lo = target * (1 - band.pct);
    const hi = target * (1 + band.pct);
    if (actual < lo) return "under";
    if (actual > hi) return "over";
    return "hit";
  }

  /**
   * Live day state for the Today HUD. Three levels, not two:
   *
   *   "ok"   — at or under the printed number (floors are always ok; they fill up)
   *   "near" — past the printed number but still inside the scoring band
   *   "over" — past the band, which is what Insights records as "over"
   *
   * The "near" level exists to reconcile the two tabs. Today stays strict — it
   * flags the moment you pass your number, because that is a useful live nudge.
   * Insights is banded, so the same day can read green there. "near" is exactly
   * that zone, so the HUD can mark it with "!" instead of silently
   * contradicting the other tab.
   *
   * "under" is deliberately not a state. Mid-morning every total is under, so
   * warning on it would nag all day. Over is meaningful at any hour: you cannot
   * un-eat it.
   */
  function hudState(mean, goal, band) {
    const g = Number(goal) || 0;
    if (!g || !Number.isFinite(mean)) return "ok";
    if (!band || band.dir === "floor") return "ok";
    if (mean <= g) return "ok";
    return mean <= g * (1 + band.pct) ? "near" : "over";
  }

  /** Legacy boolean: true once past the printed goal (either warn level). */
  function hudBarOver(mean, goal, band) {
    return hudState(mean, goal, band) !== "ok";
  }

  /**
   * A declared fast that actually recorded food reverts to an ordinary day
   * everywhere: the data always beats the declaration. This is the one
   * place that sees both the declaration (goals._unscored, stamped from
   * goals._dayPlan.intent === "fast") and the data (totals), so it is where the
   * two get reconciled — and the only place, so Insights (via scoreDayTotals)
   * and the Today HUD (via updateHUD) cannot disagree about the same day.
   * Zero-kcal logging (black coffee, water) leaves totals.kcal.mean at 0 and
   * keeps the day a fast — there is no threshold constant here, only that one
   * comparison.
   */
  function effectiveGoals(totals, goals) {
    const declaredFast = !!(goals && goals._dayPlan && goals._dayPlan.intent === "fast");
    const ateOnAFast = declaredFast && totals && totals.count > 0 &&
      Number(totals.kcal && totals.kcal.mean) > 0;
    return ateOnAFast && goals._phase ? goals._phase : goals;
  }

  function scoreDayTotals(totals, goals) {
    if (!totals || !totals.count) return null;
    const goalsForScoring = effectiveGoals(totals, goals);
    const out = {};
    const kCovered = potassiumCovered(totals);
    const naCovered = sodiumCovered(totals);
    const macrosOk = macrosCovered(totals);
    const map = {
      kcal: totals.kcal.mean,
      protein: macrosOk ? totals.p.mean : undefined,
      carbs: macrosOk ? totals.c.mean : undefined,
      fat: macrosOk ? totals.f.mean : undefined,
      fiber: macrosOk ? totals.fb.mean : undefined,
      sodium: naCovered && totals.na ? totals.na.mean : undefined,
      // Sodium and potassium each stand on their own completeness contract.
      potassium: kCovered && totals.k ? totals.k.mean : undefined,
    };
    for (const k of GOAL_KEYS) {
      const band = BANDS[k];
      const actual = map[k];
      const target = goalsForScoring[k];
      const computed = actual === undefined ? "skip" : classify(actual, target, band);
      const unscoredReason = goalsForScoring && goalsForScoring._unscored && goalsForScoring._unscored[k];
      out[k] = {
        status: unscoredReason ? "skip" : computed,
        actual,
        target,
        delta: actual === undefined ? 0 : actual - target,
      };
      // A plan exemption and a missing-coverage skip are different facts, and
      // a real fast has near-zero mineral coverage by nature — both can be
      // true on the same cell (VIII.4). exemptByPlan records the plan fact
      // unconditionally whenever the plan named this key; skipReason records
      // only that the *coverage* skip happened to also be a disclosed
      // exemption, so a day that just lacks sodium data (no plan involved)
      // never carries it. Nothing may conflate the two.
      if (unscoredReason) out[k].exemptByPlan = true;
      if (unscoredReason && computed !== "skip") out[k].skipReason = "unscored-plan";
    }

    const paired = pairedMinerals(totals);
    const jointCovered = nakCovered(totals);
    const ratio = jointCovered ? naKRatio(paired.na, paired.k) : null;
    const ratioTarget = Number(goalsForScoring.naK) || 1.0;
    const naKUnscoredReason = goalsForScoring && goalsForScoring._unscored && goalsForScoring._unscored.naK;
    out.naK = {
      status: naKUnscoredReason ? "skip" : (ratio == null ? "skip" : classify(ratio, ratioTarget, BANDS.naK)),
      actual: ratio,
      target: ratioTarget,
      delta: ratio == null ? 0 : ratio - ratioTarget,
      coverage: totals.naKCoverage != null
        ? totals.naKCoverage
        : Math.min(Number(totals.naCoverage) || 0, Number(totals.kCoverage) || 0),
    };
    if (naKUnscoredReason) out.naK.exemptByPlan = true;
    if (naKUnscoredReason && ratio != null) out.naK.skipReason = "unscored-plan";
    return out;
  }

  function pairedMinerals(totals) {
    if (!totals) return { na: null, k: null };
    const pairedNa = totals.naKNa && Number(totals.naKNa.mean);
    const pairedK = totals.naKK && Number(totals.naKK.mean);
    if (Number.isFinite(pairedNa) && Number.isFinite(pairedK)) return { na: pairedNa, k: pairedK };
    // Legacy totals predate paired sums; preserve their old all-total reading.
    return {
      na: totals.na && Number.isFinite(Number(totals.na.mean)) ? Number(totals.na.mean) : null,
      k: totals.k && Number.isFinite(Number(totals.k.mean)) ? Number(totals.k.mean) : null,
    };
  }

  /** True only when paired Na+K entries cover enough of what was eaten. */
  function nakCovered(totals) {
    if (!totals || !totals.count) return false;
    const paired = pairedMinerals(totals);
    if (!Number.isFinite(paired.na) || !Number.isFinite(paired.k) || paired.k <= 0) return false;
    if (totals.naKCoverage != null) {
      return Number.isFinite(totals.naKCoverage) && totals.naKCoverage >= NAK_MIN_COVERAGE;
    }
    // Compatibility for totals created before paired coverage existed.
    return sodiumCovered(totals) && potassiumCovered(totals);
  }

  /**
   * Sodium completeness contract. New ledger totals carry `naCoverage`; its
   * absence means a legacy total whose numeric sodium was historically assumed
   * known. An explicit low coverage value is never silently upgraded.
   */
  function sodiumCovered(totals) {
    if (!totals || !totals.count || !totals.na || !Number.isFinite(Number(totals.na.mean))) return false;
    if (totals.naCoverage == null) return true;
    return Number.isFinite(totals.naCoverage) && totals.naCoverage >= NAK_MIN_COVERAGE;
  }

  /** Potassium completeness is independent of sodium completeness. */
  function potassiumCovered(totals) {
    if (!totals || !totals.count || !totals.k || !Number.isFinite(Number(totals.k.mean))) return false;
    if (totals.kCoverage == null) return true;
    return Number.isFinite(totals.kCoverage) && totals.kCoverage >= NAK_MIN_COVERAGE;
  }

  /**
   * Protein / carb / fat / fiber completeness. Same 80% threshold as minerals.
   * Absence of macroCoverage means a legacy total that historically treated
   * stored zeros as known — preserve that so old fixture totals keep scoring.
   */
  function macrosCovered(totals) {
    if (!totals || !totals.count) return false;
    if (totals.macroCoverage == null) return true;
    return Number.isFinite(totals.macroCoverage) && totals.macroCoverage >= NAK_MIN_COVERAGE;
  }

  function scoreRange(keys, totalsForDay, settings, opts) {
    const excludeDay = (opts && opts.excludeDay) || null;
    const rows = {};
    for (const k of GOAL_KEYS) rows[k] = { hit: 0, under: 0, over: 0, skip: 0, exempt: 0, sumDelta: 0, n: 0 };

    let logged = 0;
    for (const day of keys) {
      if (excludeDay && day === excludeDay) continue;
      // Mark-incomplete days leave scorecards (diary still has the entries).
      const ov = settings && settings.dayGoals && settings.dayGoals[day];
      if (ov && ov.incomplete === true && !ov.cleared) continue;
      const t = totalsForDay(day);
      if (!t || !t.count) continue;
      logged += 1;
      const goals = goalsForDay(day, settings);
      const scored = scoreDayTotals(t, goals);
      if (!scored) continue;
      for (const k of GOAL_KEYS) {
        const s = scored[k];
        if (!s || s.status === "skip") {
          rows[k].skip += 1;
          // A plan exemption and a missing-coverage skip are different facts
          // (Part VIII.4) — this is the surface renderScorecard actually
          // renders, so it needs the same disclosure nutritionScore already
          // carries, not a silently smaller row (Part X.2b / VI.2 step 4).
          if (s && s.exemptByPlan) rows[k].exempt += 1;
          continue;
        }
        rows[k][s.status] += 1;
        rows[k].sumDelta += s.delta;
        rows[k].n += 1;
      }
    }

    const nutrients = GOAL_KEYS.map((k) => {
      const r = rows[k];
      const row = {
        key: k,
        label: k === "kcal" ? "Calories" : k === "sodium" ? "Sodium" : k[0].toUpperCase() + k.slice(1),
        hit: r.hit,
        under: r.under,
        over: r.over,
        avgDelta: r.n ? r.sumDelta / r.n : 0,
        n: r.n,
      };
      if (r.exempt) row.exemptN = r.exempt;
      return row;
    });

    return { logged, days: keys.length, nutrients };
  }

  function callouts(scorecard) {
    if (!scorecard || !scorecard.logged) return { need: null, over: null };
    const needCands = scorecard.nutrients
      .filter((n) => n.n >= 3 && n.under / n.n >= 0.25)
      .map((n) => ({ ...n, rate: n.under / n.n, abs: Math.abs(n.avgDelta) }))
      .sort((a, b) => b.rate - a.rate || b.abs - a.abs);
    const overCands = scorecard.nutrients
      .filter((n) => n.n >= 3 && n.over / n.n >= 0.25)
      .map((n) => ({ ...n, rate: n.over / n.n, abs: Math.abs(n.avgDelta) }))
      .sort((a, b) => b.rate - a.rate || b.abs - a.abs);

    const fmtD = (n) => {
      const u = n.key === "kcal" ? " kcal" : (n.key === "sodium" || n.key === "potassium") ? " mg" : " g";
      const v = Math.round(Math.abs(n.avgDelta));
      return `${v}${u}`;
    };

    // n is the count of *scored* days, not every logged day — a fast that
    // recorded a zero-kcal item (or a reduced day with an unscored cell) is
    // logged but exempt on some or all keys, so calling n "logged days" here
    // would claim a total scoreRange never actually used for this row.
    const need = needCands[0]
      ? `Needs work: ${needCands[0].label.toLowerCase()}, under on ${needCands[0].under} of ${needCands[0].n} scored days (avg ${fmtD(needCands[0])} short).`
      : null;
    const over = overCands[0]
      ? `Overdid: ${overCands[0].label.toLowerCase()}, over on ${overCands[0].over} of ${overCands[0].n} scored days (avg +${fmtD(overCands[0])}).`
      : null;
    return { need, over };
  }

  function dayKeyFromDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function shortDate(dayKey) {
    const d = new Date(dayKey + "T12:00:00");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function phaseById(phases, id) {
    if (!id) return null;
    return (phases || []).find((p) => p && p.id === id && !p.archived) || null;
  }

  /** Inclusive day keys for a phase, capped at todayKey. */
  function phaseDayKeys(phase, todayKey) {
    if (!phase || !phase.startDay) return [];
    const end = phase.endDay && phase.endDay < todayKey ? phase.endDay : todayKey;
    if (end < phase.startDay) return [];
    const keys = [];
    const cur = new Date(phase.startDay + "T12:00:00");
    const last = new Date(end + "T12:00:00");
    while (cur <= last) {
      keys.push(dayKeyFromDate(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return keys;
  }

  function phaseContext(settings, todayKey, phaseOpt) {
    const phase = phaseOpt || phaseForDay(settings.phases, todayKey) || activePhase(settings.phases);
    if (!phase) return "";
    const end = phase.endDay || todayKey;
    const rev = revisionForDay(phase, end);
    const goals = rev ? normalizeGoals(rev.goals) : normalizeGoals(settings.goals);
    if (phase.endDay == null) {
      const start = new Date(phase.startDay + "T12:00:00");
      const today = new Date(todayKey + "T12:00:00");
      const dayNum = Math.max(1, Math.round((today - start) / 86400000) + 1);
      const since = rev && rev.effectiveFrom !== phase.startDay
        ? ` · targets since ${rev.effectiveFrom.slice(5)}`
        : "";
      return `${revisionLabel(phase, rev)} · day ${dayNum} · ${Math.round(goals.kcal)} kcal${since}`;
    }
    const days = phaseDayKeys(phase, todayKey).length;
    return `${revisionLabel(phase, rev)} · ${days} day${days === 1 ? "" : "s"} · ${shortDate(phase.startDay)} – ${shortDate(phase.endDay)} · ${Math.round(goals.kcal)} kcal`;
  }

  /** Compact rows for Insights phase history (newest first). */
  function phaseHistoryRows(settings, todayKey, totalsForDay) {
    const list = (settings.phases || []).filter((p) => p && !p.archived);
    const currentPhaseId = ((phaseForDay(list, todayKey) || {}).id || null);
    list.sort((a, b) => {
      const ae = a.endDay || todayKey;
      const be = b.endDay || todayKey;
      return be.localeCompare(ae) || b.startDay.localeCompare(a.startDay);
    });
    return list.map((phase) => {
      const keys = phaseDayKeys(phase, todayKey);
      let logged = 0;
      for (const day of keys) {
        const t = totalsForDay ? totalsForDay(day) : null;
        if (t && t.count) logged += 1;
      }
      const end = phase.endDay || todayKey;
      const startRev = revisionForDay(phase, phase.startDay);
      const endRev = revisionForDay(phase, end);
      const endKind = revisionKind(phase, endRev);
      const k0 = startRev ? normalizeGoals(startRev.goals).kcal : null;
      const k1 = endRev ? normalizeGoals(endRev.goals).kcal : null;
      let kcalLabel = "";
      if (k0 != null && k1 != null && k0 !== k1) kcalLabel = `${Math.round(k0)} → ${Math.round(k1)} kcal`;
      else if (k0 != null) kcalLabel = `${Math.round(k0)} kcal`;
      const w = keys.length ? weightDelta(settings, keys[0], keys[keys.length - 1]) : null;
      let weightLabel = "";
      if (w) {
        const sign = w.delta >= 0 ? "+" : "";
        const unit = (settings && settings.weightUnit) === "kg" ? "kg" : "lb";
        const d = unit === "kg" ? w.delta : w.delta / 0.45359237;
        weightLabel = `${sign}${d.toFixed(1)} ${unit}`;
      }
      return {
        id: phase.id,
        name: revisionLabel(phase, endRev),
        kind: endKind,
        kindLabel: KIND_LABEL[endKind] || endKind,
        active: phase.id === currentPhaseId,
        startDay: phase.startDay,
        endDay: phase.endDay,
        days: keys.length,
        logged,
        kcalLabel,
        weightLabel,
        rangeLabel: phase.endDay
          ? `${shortDate(phase.startDay)} – ${shortDate(phase.endDay)}`
          : `${shortDate(phase.startDay)} – now`,
      };
    });
  }

  function mergePhases(a, b, events) {
    const stable = (value) => {
      if (Array.isArray(value)) return value.map(stable);
      if (!value || typeof value !== "object") return value;
      const out = Object.create(null);
      for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
      return out;
    };
    const tiePick = (x, y, stamp) => {
      const xs = stamp(x), ys = stamp(y);
      if (xs !== ys) return ys > xs ? y : x;
      if (!!x.deleted !== !!y.deleted) return y.deleted ? y : x;
      return JSON.stringify(stable(y)) > JSON.stringify(stable(x)) ? y : x;
    };
    const revisionStamp = (r) => Number(r && (r.updatedAt || r.createdAt)) || 0;
    const mergeTombstones = (x, y) => {
      const out = { ...(x || {}) };
      for (const [id, ts] of Object.entries(y || {})) {
        out[id] = Math.max(Number(out[id]) || 0, Number(ts) || 0);
      }
      return out;
    };
    const revisionSurvives = (r, tombstones) => {
      const deletedAt = tombstones && tombstones[r.id];
      // Fully legacy revisions may have neither timestamp. They remain valid
      // unless an explicit tombstone exists for their id.
      return deletedAt == null || Number(deletedAt) < revisionStamp(r);
    };
    const map = new Map();
    for (const p of [...(a || []), ...(b || [])]) {
      if (!p || !p.id) continue;
      const cur = map.get(p.id);
      if (!cur) {
        const copy = {
          ...p,
          revisionTombstones: { ...(p.revisionTombstones || {}) },
          revisions: [...(p.revisions || [])],
        };
        map.set(p.id, copy);
        continue;
      }
      const newer = tiePick(cur, p, (x) => Number(x && x.updatedAt) || 0);
      const older = newer === p ? cur : p;
      const revisionTombstones = mergeTombstones(older.revisionTombstones, newer.revisionTombstones);
      const revisionTombstoneEpochs = mergeTombstones(
        older.revisionTombstoneEpochs, newer.revisionTombstoneEpochs
      );
      const revMap = new Map();
      for (const r of [...(older.revisions || []), ...(newer.revisions || [])]) {
        if (!r || !r.id) continue;
        const prior = revMap.get(r.id);
        revMap.set(r.id, prior ? tiePick(prior, r, revisionStamp) : r);
      }
      const revisions = [...revMap.values()].sort((x, y) =>
        String(x.effectiveFrom).localeCompare(String(y.effectiveFrom)) ||
        (x.createdAt || 0) - (y.createdAt || 0) ||
        String(x.id).localeCompare(String(y.id))
      );
      map.set(p.id, {
        ...older,
        ...newer,
        revisionTombstones,
        revisionTombstoneEpochs,
        revisions,
        updatedAt: Math.max(cur.updatedAt || 0, p.updatedAt || 0),
      });
    }
    let merged = [...map.values()];
    // Old settings had no phase identity. All deterministic synthetic legacy
    // candidates represent the same slot, so collapse them before resolving an
    // active phase. A real legacy target beats an untouched fresh default even
    // when both documents lack clocks.
    const synthetic = merged.filter((phase) => phase && phase.syntheticLegacy);
    if (synthetic.length > 1) {
      const isDefault = (phase) => {
        const first = sortRevisions(phase.revisions)[0];
        return first && goalsEqual(first.goals, DEFAULT_GOALS);
      };
      const hasActivatable = (phase) => (phase.revisions || []).some(revisionActivatable);
      const winner = synthetic.slice().sort((x, y) =>
        (Number(!hasActivatable(x)) - Number(!hasActivatable(y))) ||
        (Number(isDefault(x)) - Number(isDefault(y))) ||
        ((Number(y.updatedAt) || Number(y.createdAt) || 0) - (Number(x.updatedAt) || Number(x.createdAt) || 0)) ||
        String(x.startDay || "").localeCompare(String(y.startDay || "")) ||
        JSON.stringify(stable(y)).localeCompare(JSON.stringify(stable(x)))
      )[0];
      const ids = new Set(synthetic.map((phase) => phase.id));
      merged = merged.filter((phase) => !ids.has(phase.id) || phase.id === winner.id);
    }
    merged.sort((x, y) =>
      String(x.startDay).localeCompare(String(y.startDay)) || String(x.id).localeCompare(String(y.id))
    );
    // Resolve protection against the complete pre-tombstone revision union.
    // This lets an add from one shard preserve the target version that governed
    // it even when another shard, unaware of that add, carries a later delete.
    const protectedKeys = new Set(governedRevisionUsage(merged, events).map((row) =>
      `${row.phaseId}\u0000${row.revisionId}`
    ));
    return merged.map((phase) => {
      const tombstones = { ...(phase.revisionTombstones || {}) };
      const tombstoneEpochs = { ...(phase.revisionTombstoneEpochs || {}) };
      const revisions = (phase.revisions || []).filter((revision) => {
        if (!revision || !revision.id) return false;
        const protectedKey = `${phase.id}\u0000${revision.id}`;
        if (protectedKeys.has(protectedKey)) {
          // An invalid delete cannot remain latent: removing it makes the merge
          // canonical and idempotent instead of re-fighting it on every shard.
          delete tombstones[revision.id];
          delete tombstoneEpochs[revision.id];
          return true;
        }
        return revisionSurvives(revision, tombstones);
      });
      for (const id of Object.keys(tombstoneEpochs)) {
        if (!Object.prototype.hasOwnProperty.call(tombstones, id)) delete tombstoneEpochs[id];
      }
      return {
        ...phase,
        revisionTombstones: tombstones,
        revisionTombstoneEpochs: tombstoneEpochs,
        revisions,
      };
    });
  }

  function mergeWeights(a, b) {
    const out = { ...(a || {}) };
    for (const [day, w] of Object.entries(b || {})) {
      if (!w || typeof w !== "object") continue;
      const cur = out[day];
      const ordered = (value) => Object.fromEntries(Object.entries(value || {}).sort(([x], [y]) => x.localeCompare(y)));
      const curText = JSON.stringify(ordered(cur)), nextText = JSON.stringify(ordered(w));
      if (!cur || (w.updatedAt || 0) > (cur.updatedAt || 0) ||
          ((w.updatedAt || 0) === (cur.updatedAt || 0) && nextText > curText)) out[day] = { ...w };
    }
    return out;
  }

  function filterPhasesAfter(phases, ts) {
    return (phases || []).filter((p) => (p.updatedAt || 0) >= ts || (p.createdAt || 0) >= ts);
  }

  function filterWeightsAfter(map, ts) {
    const out = {};
    for (const [day, w] of Object.entries(map || {})) {
      if ((w && w.updatedAt || 0) >= ts) out[day] = w;
    }
    return out;
  }

  function weightForDay(settings, day) {
    const w = settings && settings.weights && settings.weights[day];
    if (!w || w.cleared || w.kg == null) return null;
    return Number(w.kg);
  }

  /** Weight change across a day range (first → last logged). */
  function weightDelta(settings, startDay, endDay) {
    const entries = Object.entries(settings.weights || {})
      .filter(([d, w]) => d >= startDay && d <= endDay && w && !w.cleared && w.kg != null)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length < 2) return null;
    const first = Number(entries[0][1].kg);
    const last = Number(entries[entries.length - 1][1].kg);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
    return { first, last, delta: last - first, n: entries.length };
  }

  /**
   * Cumulative intake vs the phase calorie target (not the day's plan target).
   * A planned refeed at 2500 that is eaten to 2500 is +500 against the phase,
   * not a perfect 0 — hiding that surplus was the old bug. An honoured
   * declared fast with nothing logged contributes actual 0 vs the phase.
   */
  function kcalBalance(keys, totalsForDay, settings) {
    let sum = 0;
    let n = 0;
    for (const day of keys) {
      const t = totalsForDay(day);
      const g = goalsForDay(day, settings);
      const isHonouredFast = !!(g && g._dayPlan && g._dayPlan.intent === "fast") &&
        (!t || !t.count || !(t.kcal && Number(t.kcal.mean) > 0));
      if ((!t || !t.count) && !isHonouredFast) continue;
      const phaseKcal = Number(g && g._phase && g._phase.kcal);
      const reference = Number.isFinite(phaseKcal) ? phaseKcal : Number(g && g.kcal);
      if (!Number.isFinite(reference)) continue;
      const intake = (t && t.count && t.kcal && Number.isFinite(t.kcal.mean)) ? t.kcal.mean : 0;
      sum += intake - reference;
      n += 1;
    }
    return n ? { sum, n, avg: sum / n } : null;
  }

  return {
    DEFAULT_GOALS,
    GENERIC_ADULT_POTASSIUM_REFERENCE,
    KINDS,
    KIND_LABEL,
    SEX_OPTIONS,
    ACTIVITY_OPTIONS,
    ACTIVITY_LABEL,
    BANDS,
    PERSISTENT_GOAL_BOUNDS,
    PERSISTENT_ENERGY_POLICY,
    MIN_PLANNED_KCAL,
    MAX_DAY_TARGET_KCAL,
    LOW_KCAL_ACK_KCAL,
    FAST_KCAL,
    DAY_INTENTS,
    FAST_DECLARATION_COPY,
    isPlannedKcal,
    endOfLocalDayMs,
    isDeclaredAfterDay,
    dayIntentWindow,
    proteinScorableOnPlan,
    normalizeGoals,
    validatePersistentGoals,
    sanitizePersistentTargets,
    goalsEqual,
    goalsForDay,
    dayPlanForDay,
    formatDayPlanSummary,
    phaseForDay,
    activePhase,
    revisionForDay,
    rawRevisionForDay,
    revisionActivatable,
    latestActivatableRevision,
    revisionKind,
    kindForDay,
    revisionLabel,
    labelForDay,
    governedRevisionUsage,
    revisionDeletionStatus,
    ensureMigrated,
    appendRevision,
    updatePhaseMeta,
    startPhase,
    deleteRevision,
    revisionHistoryRows,
    formatPhaseName,
    detectMagnitude,
    applyPhaseLabel,
    ensurePhaseVersion,
    normalizeKind,
    ageFromDob,
    normalizeProfile,
    ensureProfile,
    latestWeightKg,
    profileReadyForAi,
    automatedTargetEligibility,
    mergeProfiles,
    dayBefore,
    classify,
    naKRatio,
    nakCovered,
    sodiumCovered,
    potassiumCovered,
    macrosCovered,
    pairedMinerals,
    NAK_MIN_COVERAGE,
    NAK_MASS_TO_MOLAR,
    hudState,
    hudBarOver,
    effectiveGoals,
    scoreDayTotals,
    scoreRange,
    callouts,
    phaseContext,
    phaseById,
    phaseDayKeys,
    phaseHistoryRows,
    shortDate,
    mergePhases,
    mergeWeights,
    filterPhasesAfter,
    filterWeightsAfter,
    weightForDay,
    weightDelta,
    kcalBalance,
    earliestDayFromEvents,
    mirrorActiveGoals,
    uid,
  };
})();

if (typeof module !== "undefined") module.exports = Phases;
