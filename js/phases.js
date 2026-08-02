/* NutriDaily — versioned phases (goal timelines) and insight scoring.
 * Pure helpers: no DOM. Revisions are append-only and day-anchored so past
 * Insights stay stable when targets change.
 */
const Phases = (() => {
  const DEFAULT_GOALS = { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300 };
  const KINDS = ["cut", "bulk", "maintain", "custom"];
  const KIND_LABEL = { cut: "Cut", bulk: "Bulk", maintain: "Maintain", custom: "Custom" };

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

  function revisionForDay(phase, day) {
    if (!phase || !Array.isArray(phase.revisions) || !phase.revisions.length) return null;
    const sorted = [...phase.revisions].sort((a, b) =>
      String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)) ||
      String(a.id).localeCompare(String(b.id))
    );
    let pick = null;
    for (const r of sorted) {
      if (r.effectiveFrom <= day) pick = r;
      else break;
    }
    return pick || sorted[0];
  }

  /** Resolve targets for a calendar day. dayGoals > phase revision > defaults. */
  function goalsForDay(day, settings) {
    const base = normalizeGoals((settings && settings.goals) || DEFAULT_GOALS);
    const phase = phaseForDay((settings && settings.phases) || [], day);
    const rev = revisionForDay(phase, day);
    const fromPhase = rev ? normalizeGoals(rev.goals) : base;
    const ov = dayGoalOverride(settings, day);
    if (!ov) return fromPhase;
    const { updatedAt: _u, cleared: _c, ...rest } = ov;
    const patch = {};
    for (const k of GOAL_KEYS) {
      if (rest[k] != null && Number.isFinite(Number(rest[k]))) patch[k] = Number(rest[k]);
    }
    return { ...fromPhase, ...patch };
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
    if (Array.isArray(settings.phases) && settings.phases.length) {
      mirrorActiveGoals(Object.assign(settings, { _todayKey: todayKey }));
      delete settings._todayKey;
      return settings;
    }
    const start = earliestDay || todayKey || "1970-01-01";
    const goals = normalizeGoals(settings.goals);
    const now = settings.goalsUpdatedAt || Date.now();
    settings.phases = [{
      id: uid("ph"),
      name: "My goals",
      kind: "maintain",
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

  /** Append a revision effective today (re-scores today). Returns false if unchanged. */
  function appendRevision(settings, goals, effectiveFrom, note) {
    ensureMigrated(settings, effectiveFrom, effectiveFrom);
    const phase = activePhase(settings.phases);
    if (!phase) return false;
    const next = normalizeGoals(goals);
    const cur = revisionForDay(phase, effectiveFrom);
    if (cur && goalsEqual(cur.goals, next)) {
      mirrorActiveGoals(Object.assign(settings, { _todayKey: effectiveFrom }));
      delete settings._todayKey;
      return false;
    }
    phase.revisions = phase.revisions || [];
    phase.revisions.push({
      id: uid("rv"),
      effectiveFrom,
      goals: next,
      createdAt: Date.now(),
      note: note || "",
    });
    phase.updatedAt = Date.now();
    settings.goals = next;
    settings.goalsUpdatedAt = Date.now();
    return true;
  }

  function updatePhaseMeta(settings, { name, kind }) {
    ensureMigrated(settings, null, null);
    const phase = activePhase(settings.phases);
    if (!phase) return;
    if (name != null && String(name).trim()) phase.name = String(name).trim().slice(0, 48);
    if (kind && KINDS.includes(kind)) phase.kind = kind;
    phase.updatedAt = Date.now();
  }

  /** End active phase yesterday (relative to startDay) and open a new one. */
  function startPhase(settings, { name, kind, goals, startDay, copyGoals }) {
    ensureMigrated(settings, startDay, startDay);
    const prev = activePhase(settings.phases);
    const start = startDay;
    if (prev) {
      const end = dayBefore(start);
      if (end >= prev.startDay) prev.endDay = end;
      else prev.endDay = prev.startDay;
      prev.updatedAt = Date.now();
    }
    const g = copyGoals && prev
      ? normalizeGoals((revisionForDay(prev, start) || {}).goals || settings.goals)
      : normalizeGoals(goals || settings.goals);
    const now = Date.now();
    const phase = {
      id: uid("ph"),
      name: (name && String(name).trim()) || KIND_LABEL[kind] || "Phase",
      kind: KINDS.includes(kind) ? kind : "custom",
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
      }],
    };
    settings.phases.push(phase);
    settings.goals = g;
    settings.goalsUpdatedAt = now;
    return phase;
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

  function phaseContext(settings, todayKey) {
    const phase = activePhase(settings.phases);
    if (!phase) return "";
    const rev = revisionForDay(phase, todayKey);
    const goals = rev ? normalizeGoals(rev.goals) : normalizeGoals(settings.goals);
    const start = new Date(phase.startDay + "T12:00:00");
    const today = new Date(todayKey + "T12:00:00");
    const dayNum = Math.max(1, Math.round((today - start) / 86400000) + 1);
    const kind = KIND_LABEL[phase.kind] || phase.kind;
    const since = rev && rev.effectiveFrom !== phase.startDay
      ? ` · targets since ${rev.effectiveFrom.slice(5)}`
      : "";
    return `${phase.name} · ${kind} · day ${dayNum} · ${Math.round(goals.kcal)} kcal${since}`;
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
    BANDS,
    normalizeGoals,
    goalsEqual,
    goalsForDay,
    phaseForDay,
    activePhase,
    revisionForDay,
    ensureMigrated,
    appendRevision,
    updatePhaseMeta,
    startPhase,
    dayBefore,
    scoreDayTotals,
    scoreRange,
    callouts,
    phaseContext,
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
