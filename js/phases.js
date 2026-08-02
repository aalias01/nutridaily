/* NutriDaily — versioned phases (goal timelines) and insight scoring.
 * Pure helpers: no DOM. Revisions are append-only and day-anchored so past
 * Insights stay stable when targets change.
 */
const Phases = (() => {
  const DEFAULT_GOALS = { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300 };
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
  };

  const GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium"];

  function uid(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function normalizeGoals(g) {
    const out = { ...DEFAULT_GOALS };
    for (const k of GOAL_KEYS) {
      const n = Number(g && g[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
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

  /** Active signed bumps for a day (legacy absolute overrides converted vs phase). */
  function bumpsForDay(day, settings, phaseGoals) {
    const ov = dayGoalOverride(settings, day);
    if (!ov) return null;
    const base = phaseGoals || normalizeGoals(DEFAULT_GOALS);
    if (ov.bumps && typeof ov.bumps === "object") {
      const out = {};
      let any = false;
      for (const k of GOAL_KEYS) {
        const n = Number(ov.bumps[k]);
        if (Number.isFinite(n) && n !== 0) { out[k] = n; any = true; }
      }
      return any ? out : null;
    }
    // Legacy absolute dayGoals → treat as delta from phase for that day
    const out = {};
    let any = false;
    for (const k of GOAL_KEYS) {
      if (ov[k] == null || !Number.isFinite(Number(ov[k]))) continue;
      const delta = Number(ov[k]) - (base[k] || 0);
      if (delta !== 0) { out[k] = delta; any = true; }
    }
    return any ? out : null;
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
    return list.find((p) => phaseCovers(p, day)) || null;
  }

  function activePhase(phases) {
    const list = Array.isArray(phases) ? phases : [];
    return list.find((p) => p && p.endDay == null && !p.archived) || null;
  }

  function sortRevisions(revisions) {
    return [...(revisions || [])].sort((a, b) =>
      String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)) ||
      (a.createdAt || 0) - (b.createdAt || 0) ||
      String(a.id).localeCompare(String(b.id))
    );
  }

  function revisionForDay(phase, day) {
    if (!phase || !Array.isArray(phase.revisions) || !phase.revisions.length) return null;
    const sorted = sortRevisions(phase.revisions);
    let pick = null;
    for (const r of sorted) {
      if (r.effectiveFrom <= day) pick = r;
      else break;
    }
    return pick || sorted[0];
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
  function profileReadyForAi(settings, opts) {
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
    return {
      ok: missing.length === 0,
      missing,
      age,
      profile,
      weightKg: weightKg != null ? Math.round(weightKg * 100) / 100 : null,
    };
  }

  function mergeProfiles(a, b) {
    const A = normalizeProfile(a);
    const B = normalizeProfile(b);
    if ((B.updatedAt || 0) >= (A.updatedAt || 0)) return B;
    return A;
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

  function bumpVersion(phase, magnitude) {
    const v = ensurePhaseVersion(phase);
    if (magnitude === "major") {
      phase.versionMajor = v.major + 1;
      phase.versionMinor = 0;
    } else {
      phase.versionMajor = v.major;
      phase.versionMinor = v.minor + 1;
    }
    applyPhaseLabel(phase);
    return { major: phase.versionMajor, minor: phase.versionMinor, label: phase.name };
  }

  /** Resolve targets for a calendar day. phase revision + day bumps (legacy absolute still works). */
  function goalsForDay(day, settings) {
    const base = normalizeGoals((settings && settings.goals) || DEFAULT_GOALS);
    const phase = phaseForDay((settings && settings.phases) || [], day);
    const rev = revisionForDay(phase, day);
    const fromPhase = rev ? normalizeGoals(rev.goals) : base;
    const bumps = bumpsForDay(day, settings, fromPhase);
    if (!bumps) return { ...fromPhase, _bumps: null, _phase: fromPhase };
    const resolved = { ...fromPhase };
    for (const k of GOAL_KEYS) {
      if (bumps[k] != null) resolved[k] = Math.max(0, fromPhase[k] + bumps[k]);
    }
    resolved._bumps = bumps;
    resolved._phase = fromPhase;
    return resolved;
  }

  function formatBumpSummary(bumps) {
    if (!bumps) return "";
    const parts = [];
    if (bumps.kcal) parts.push(`${bumps.kcal > 0 ? "+" : ""}${Math.round(bumps.kcal)} kcal`);
    if (bumps.protein) parts.push(`${bumps.protein > 0 ? "+" : ""}${Math.round(bumps.protein)} g P`);
    if (bumps.carbs) parts.push(`${bumps.carbs > 0 ? "+" : ""}${Math.round(bumps.carbs)} g C`);
    if (bumps.fat) parts.push(`${bumps.fat > 0 ? "+" : ""}${Math.round(bumps.fat)} g F`);
    return parts.join(" · ");
  }

  function mirrorActiveGoals(settings) {
    const phase = activePhase(settings.phases);
    const today = settings._todayKey || null;
    const day = today || (phase && phase.startDay) || "1970-01-01";
    const rev = revisionForDay(phase, day);
    settings.goals = rev ? normalizeGoals(rev.goals) : normalizeGoals(settings.goals);
    return settings.goals;
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
        p.kind = normalizeKind(p.kind === "custom" ? "maintain" : p.kind);
        ensurePhaseVersion(p);
        applyPhaseLabel(p);
      }
      mirrorActiveGoals(Object.assign(settings, { _todayKey: todayKey }));
      delete settings._todayKey;
      return settings;
    }
    const start = earliestDay || todayKey || "1970-01-01";
    const goals = normalizeGoals(settings.goals);
    const now = settings.goalsUpdatedAt || Date.now();
    settings.phases = [{
      id: uid("ph"),
      name: formatPhaseName("maintain", 1, 0),
      kind: "maintain",
      versionMajor: 1,
      versionMinor: 0,
      startDay: start,
      endDay: null,
      createdAt: now,
      updatedAt: now,
      archived: false,
      revisions: [{
        id: uid("rv"),
        effectiveFrom: start,
        goals,
        createdAt: now,
        note: "Migrated from settings",
        version: "1.0",
        label: formatPhaseName("maintain", 1, 0),
      }],
    }];
    settings.goals = goals;
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
    const phase = activePhase(settings.phases);
    if (!phase) return false;
    const options = opts || {};
    const nextKind = options.kind != null ? normalizeKind(options.kind) : normalizeKind(phase.kind);
    const next = normalizeGoals(goals);
    const cur = revisionForDay(phase, effectiveFrom);
    const goalsChanged = !(cur && goalsEqual(cur.goals, next));
    const kindChanged = nextKind !== normalizeKind(phase.kind);

    if (!goalsChanged && !kindChanged) {
      mirrorActiveGoals(Object.assign(settings, { _todayKey: effectiveFrom }));
      delete settings._todayKey;
      applyPhaseLabel(phase);
      return false;
    }

    let magnitude = options.magnitude === "major" || options.magnitude === "minor"
      ? options.magnitude
      : detectMagnitude(cur ? cur.goals : next, next, phase.kind, nextKind);

    // Kind-only change with identical numbers: still bump label, no new revision row.
    if (!goalsChanged && kindChanged) {
      phase.kind = nextKind;
      const bumped = bumpVersion(phase, "major");
      phase.updatedAt = Date.now();
      mirrorActiveGoals(Object.assign(settings, { _todayKey: effectiveFrom }));
      delete settings._todayKey;
      return { changed: false, bumped: true, label: bumped.label, magnitude: "major" };
    }

    phase.kind = nextKind;
    const bumped = bumpVersion(phase, magnitude);
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
      replace.createdAt = Date.now();
      replace.note = note || replace.note || "";
      replace.version = `${bumped.major}.${bumped.minor}`;
      replace.label = bumped.label;
    } else {
      phase.revisions.push({
        id: uid("rv"),
        effectiveFrom,
        goals: next,
        createdAt: Date.now(),
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

  function updatePhaseMeta(settings, { kind }) {
    ensureMigrated(settings, null, null);
    const phase = activePhase(settings.phases);
    if (!phase) return;
    if (kind) phase.kind = normalizeKind(kind);
    applyPhaseLabel(phase);
    phase.updatedAt = Date.now();
  }

  /** End active phase yesterday (relative to startDay) and open a new one at Kind v1.0. */
  function startPhase(settings, { kind, goals, startDay, copyGoals }) {
    ensureMigrated(settings, startDay, startDay);
    const prev = activePhase(settings.phases);
    const start = startDay;
    if (prev) {
      const end = dayBefore(start);
      if (end >= prev.startDay) prev.endDay = end;
      else prev.endDay = prev.startDay;
      prev.updatedAt = Date.now();
    }
    const k = normalizeKind(kind);
    const g = copyGoals && prev
      ? normalizeGoals((revisionForDay(prev, start) || {}).goals || settings.goals)
      : normalizeGoals(goals || settings.goals);
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
      revisions: [{
        id: uid("rv"),
        effectiveFrom: start,
        goals: g,
        createdAt: now,
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
  function deleteRevision(settings, phaseId, revisionId, todayKey) {
    ensureMigrated(settings, todayKey, todayKey);
    const phase = (settings.phases || []).find((p) => p && p.id === phaseId);
    if (!phase || !Array.isArray(phase.revisions)) return { ok: false, reason: "missing" };
    if (phase.revisions.length <= 1) return { ok: false, reason: "last" };
    const idx = phase.revisions.findIndex((r) => r && r.id === revisionId);
    if (idx < 0) return { ok: false, reason: "missing" };
    phase.revisions.splice(idx, 1);
    phase.updatedAt = Date.now();

    // Sync phase label to the latest remaining revision when possible.
    const latest = sortRevisions(phase.revisions).slice(-1)[0];
    if (latest && latest.version && /^\d+\.\d+$/.test(String(latest.version))) {
      const [maj, min] = String(latest.version).split(".").map(Number);
      phase.versionMajor = maj;
      phase.versionMinor = min;
      if (latest.label) phase.name = latest.label;
      else applyPhaseLabel(phase);
    } else {
      applyPhaseLabel(phase);
    }
    mirrorActiveGoals(Object.assign(settings, { _todayKey: todayKey || phase.startDay }));
    delete settings._todayKey;
    return { ok: true, label: phase.name };
  }

  /** Target versions for the phase history sheet (newest first). */
  function revisionHistoryRows(phase) {
    if (!phase) return [];
    const sorted = sortRevisions(phase.revisions).reverse();
    return sorted.map((r, i) => {
      const g = normalizeGoals(r.goals);
      const version = r.version || "";
      const label = r.label || (version ? formatPhaseName(phase.kind, ...version.split(".").map(Number)) : phase.name);
      return {
        id: r.id,
        version,
        label,
        effectiveFrom: r.effectiveFrom,
        createdAt: r.createdAt || 0,
        goals: g,
        summary: `${Math.round(g.kcal)} kcal · P${Math.round(g.protein)} C${Math.round(g.carbs)} F${Math.round(g.fat)}`,
        current: i === 0,
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

  /** Today HUD: warn when past the printed goal for ceiling/range; floors never warn high. */
  function hudBarOver(mean, goal, band) {
    if (!band || band.dir === "floor") return false;
    const g = Number(goal) || 0;
    return g > 0 && Number.isFinite(mean) && mean > g;
  }

  function scoreDayTotals(totals, goals) {
    if (!totals || !totals.count) return null;
    const out = {};
    const map = {
      kcal: totals.kcal.mean,
      protein: totals.p.mean,
      carbs: totals.c.mean,
      fat: totals.f.mean,
      fiber: totals.fb.mean,
      sodium: totals.na.mean,
    };
    for (const k of GOAL_KEYS) {
      const band = BANDS[k];
      const actual = map[k];
      const target = goals[k];
      const status = classify(actual, target, band);
      out[k] = {
        status,
        actual,
        target,
        delta: actual - target,
      };
    }
    return out;
  }

  function scoreRange(keys, totalsForDay, settings, opts) {
    const excludeDay = (opts && opts.excludeDay) || null;
    const rows = {};
    for (const k of GOAL_KEYS) rows[k] = { hit: 0, under: 0, over: 0, skip: 0, sumDelta: 0, n: 0 };

    let logged = 0;
    for (const day of keys) {
      if (excludeDay && day === excludeDay) continue;
      const t = totalsForDay(day);
      if (!t || !t.count) continue;
      logged += 1;
      const goals = goalsForDay(day, settings);
      const scored = scoreDayTotals(t, goals);
      if (!scored) continue;
      for (const k of GOAL_KEYS) {
        const s = scored[k];
        if (!s || s.status === "skip") { rows[k].skip += 1; continue; }
        rows[k][s.status] += 1;
        rows[k].sumDelta += s.delta;
        rows[k].n += 1;
      }
    }

    const nutrients = GOAL_KEYS.map((k) => {
      const r = rows[k];
      return {
        key: k,
        label: k === "kcal" ? "Calories" : k === "sodium" ? "Sodium" : k[0].toUpperCase() + k.slice(1),
        hit: r.hit,
        under: r.under,
        over: r.over,
        avgDelta: r.n ? r.sumDelta / r.n : 0,
        n: r.n,
      };
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
      const u = n.key === "kcal" ? " kcal" : n.key === "sodium" ? " mg" : " g";
      const v = Math.round(Math.abs(n.avgDelta));
      return `${v}${u}`;
    };

    const need = needCands[0]
      ? `Needs work: ${needCands[0].label.toLowerCase()}, under on ${needCands[0].under} of ${needCands[0].n} logged days (avg ${fmtD(needCands[0])} short).`
      : null;
    const over = overCands[0]
      ? `Overdid: ${overCands[0].label.toLowerCase()}, over on ${overCands[0].over} of ${overCands[0].n} logged days (avg +${fmtD(overCands[0])}).`
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
    const phase = phaseOpt || activePhase(settings.phases);
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
      return `${phase.name} · day ${dayNum} · ${Math.round(goals.kcal)} kcal${since}`;
    }
    const days = phaseDayKeys(phase, todayKey).length;
    return `${phase.name} · ${days} day${days === 1 ? "" : "s"} · ${shortDate(phase.startDay)} – ${shortDate(phase.endDay)} · ${Math.round(goals.kcal)} kcal`;
  }

  /** Compact rows for Insights phase history (newest first). */
  function phaseHistoryRows(settings, todayKey, totalsForDay) {
    const list = (settings.phases || []).filter((p) => p && !p.archived);
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
        name: phase.name,
        kind: phase.kind,
        kindLabel: KIND_LABEL[phase.kind] || phase.kind,
        active: phase.endDay == null,
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

  function mergePhases(a, b) {
    const map = new Map();
    for (const p of [...(a || []), ...(b || [])]) {
      if (!p || !p.id) continue;
      const cur = map.get(p.id);
      if (!cur) {
        map.set(p.id, {
          ...p,
          revisions: [...(p.revisions || [])],
        });
        continue;
      }
      const newer = (p.updatedAt || 0) >= (cur.updatedAt || 0) ? p : cur;
      const older = newer === p ? cur : p;
      const revMap = new Map();
      for (const r of [...(older.revisions || []), ...(newer.revisions || [])]) {
        if (!r || !r.id) continue;
        if (!revMap.has(r.id)) revMap.set(r.id, r);
      }
      const revisions = [...revMap.values()].sort((x, y) =>
        String(x.effectiveFrom).localeCompare(String(y.effectiveFrom)) ||
        (x.createdAt || 0) - (y.createdAt || 0) ||
        String(x.id).localeCompare(String(y.id))
      );
      map.set(p.id, {
        ...older,
        ...newer,
        revisions,
        updatedAt: Math.max(cur.updatedAt || 0, p.updatedAt || 0),
      });
    }
    return [...map.values()].sort((x, y) => String(x.startDay).localeCompare(String(y.startDay)));
  }

  function mergeWeights(a, b) {
    const out = { ...(a || {}) };
    for (const [day, w] of Object.entries(b || {})) {
      if (!w || typeof w !== "object") continue;
      const cur = out[day];
      if (!cur || (w.updatedAt || 0) >= (cur.updatedAt || 0)) out[day] = { ...w };
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

  function kcalBalance(keys, totalsForDay, settings) {
    let sum = 0;
    let n = 0;
    for (const day of keys) {
      const t = totalsForDay(day);
      if (!t || !t.count) continue;
      const g = goalsForDay(day, settings);
      sum += t.kcal.mean - g.kcal;
      n += 1;
    }
    return n ? { sum, n, avg: sum / n } : null;
  }

  return {
    DEFAULT_GOALS,
    KINDS,
    KIND_LABEL,
    SEX_OPTIONS,
    ACTIVITY_OPTIONS,
    ACTIVITY_LABEL,
    BANDS,
    normalizeGoals,
    goalsEqual,
    goalsForDay,
    bumpsForDay,
    formatBumpSummary,
    phaseForDay,
    activePhase,
    revisionForDay,
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
    mergeProfiles,
    dayBefore,
    classify,
    hudBarOver,
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
