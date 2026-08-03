/* NutriDaily — analytics engine.
 *
 * Pure, deterministic, dependency-free derivations over a range of days.
 * Nothing here touches storage or the DOM: callers pass in accessor callbacks
 * (`totalsForDay`, `goalsForDay`, `weightKgForDay`, `entriesForDay`) so the
 * whole module is unit-testable in node.
 *
 * Design notes
 * ------------
 * - Daily nutrition data is noisy. Almost every number here is smoothed
 *   (rolling means, EMA trend weight, weekly rollups) because the *trend* is
 *   the signal and the single day is not.
 * - Anything that can be wrong is gated behind an explicit confidence level
 *   rather than shown as a confident-looking number (see `estimateTdee`).
 * - No value judgements: statuses are descriptive ("under", "over", "hit"),
 *   never scolding.
 */
const Analytics = (() => {
  /** Energy density of body-mass change (kcal per kg). Standard 3500 kcal/lb. */
  const KCAL_PER_KG = 7700;
  const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MEALS = ["breakfast", "lunch", "dinner", "snack"];
  /** Nutrient keys as they appear on a built day row. */
  const NUTRIENTS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium"];
  /** Map nutrient key → Ledger totals key. */
  const TOTALS_KEY = {
    kcal: "kcal", protein: "p", carbs: "c", fat: "f", fiber: "fb", sodium: "na",
  };
  const UNIT = { kcal: "", protein: " g", carbs: " g", fat: " g", fiber: " g", sodium: " mg" };
  const LABEL = {
    kcal: "Calories", protein: "Protein", carbs: "Carbs",
    fat: "Fat", fiber: "Fiber", sodium: "Sodium",
  };

  // ---------------------------------------------------------------- dates

  function dayKeyFromDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function dateOf(dayKey) {
    return new Date(String(dayKey) + "T12:00:00");
  }

  function addDays(dayKey, n) {
    const d = dateOf(dayKey);
    d.setDate(d.getDate() + n);
    return dayKeyFromDate(d);
  }

  function daysBetween(a, b) {
    return Math.round((dateOf(b) - dateOf(a)) / 86400000);
  }

  /** Monday-start week key for a day. */
  function weekStart(dayKey) {
    const d = dateOf(dayKey);
    const dow = d.getDay();               // 0 = Sun
    const back = dow === 0 ? 6 : dow - 1; // Monday = 0 back
    d.setDate(d.getDate() - back);
    return dayKeyFromDate(d);
  }

  function shortDate(dayKey) {
    return dateOf(dayKey).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  // ------------------------------------------------------------ build rows

  /**
   * Normalize a day range into flat rows the rest of the module consumes.
   *
   * @param {Object} opts
   * @param {string[]} opts.keys            ordered day keys (oldest → newest)
   * @param {Function} opts.totalsForDay    day → Ledger totals
   * @param {Function} opts.goalsForDay     day → resolved goals for that day
   * @param {Function} [opts.weightKgForDay] day → body weight in kg (or null)
   * @param {Function} [opts.bumpForDay] day → { bumps, updatedAt } | null
   * @returns {Array<Object>} rows: { day, dow, weekend, logged, itemCount,
   *   kcal, protein, carbs, fat, fiber, sodium, goals, weightKg, bump }
   */
  function buildDays(opts) {
    const o = opts || {};
    const keys = o.keys || [];
    const totalsForDay = o.totalsForDay || (() => null);
    const goalsForDay = o.goalsForDay || (() => ({}));
    const weightKgForDay = o.weightKgForDay || (() => null);
    const bumpForDay = o.bumpForDay || (() => null);

    return keys.map((day) => {
      const t = totalsForDay(day);
      const logged = !!(t && t.count);
      const dow = dateOf(day).getDay();
      const row = {
        day,
        dow,
        weekend: dow === 0 || dow === 6,
        logged,
        itemCount: (t && t.count) || 0,
        goals: goalsForDay(day) || {},
        weightKg: numOrNull(weightKgForDay(day)),
        bump: bumpForDay(day) || null,
      };
      for (const k of NUTRIENTS) {
        const bucket = t && t[TOTALS_KEY[k]];
        row[k] = logged && bucket ? bucket.mean : null;
      }
      return row;
    });
  }

  /** Strict: `Number(null)` is 0, which would invent weigh-ins out of gaps. */
  function numOrNull(v) {
    if (v == null || v === "" || typeof v === "boolean") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function loggedRows(days) {
    return (days || []).filter((d) => d.logged);
  }

  // ------------------------------------------------------------- statistics

  /** Mean of finite values; null when empty. */
  function mean(values) {
    const v = (values || []).filter(Number.isFinite);
    if (!v.length) return null;
    return v.reduce((s, x) => s + x, 0) / v.length;
  }

  function median(values) {
    const v = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  /** Sample standard deviation; null when fewer than 2 values. */
  function stdev(values) {
    const v = (values || []).filter(Number.isFinite);
    if (v.length < 2) return null;
    const m = mean(v);
    const ss = v.reduce((s, x) => s + (x - m) * (x - m), 0);
    return Math.sqrt(ss / (v.length - 1));
  }

  /**
   * Spread of intake around its own mean. Low CV = steady eater, which matters
   * more than most people realise: the same weekly average eaten steadily
   * behaves differently from a restrict/binge sawtooth.
   */
  function summaryStats(days, key) {
    const values = loggedRows(days).map((d) => d[key]).filter(Number.isFinite);
    const m = mean(values);
    const sd = stdev(values);
    return {
      key,
      n: values.length,
      avg: m,
      median: median(values),
      sd,
      cv: m && sd != null ? sd / m : null,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
    };
  }

  /**
   * Trailing rolling mean over an ordered value array (nulls = no data).
   * Emits null until `minPoints` real values exist in the window, so the
   * smoothed line never starts on a single noisy day.
   */
  function rollingMean(values, window, minPoints) {
    const w = Math.max(1, window || 7);
    const need = Math.max(1, minPoints || Math.min(3, w));
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const slice = values.slice(Math.max(0, i - w + 1), i + 1).filter(Number.isFinite);
      out.push(slice.length >= need ? slice.reduce((s, x) => s + x, 0) / slice.length : null);
    }
    return out;
  }

  /**
   * Least-squares fit of y on x.
   * @returns {{slope:number, intercept:number, n:number, r2:number, slopeSe:number}|null}
   */
  function linearFit(xs, ys) {
    const pts = [];
    for (let i = 0; i < xs.length; i++) {
      if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pts.push([xs[i], ys[i]]);
    }
    const n = pts.length;
    if (n < 2) return null;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [x, y] of pts) {
      sxx += (x - mx) * (x - mx);
      sxy += (x - mx) * (y - my);
      syy += (y - my) * (y - my);
    }
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    let ssRes = 0;
    for (const [x, y] of pts) {
      const e = y - (intercept + slope * x);
      ssRes += e * e;
    }
    const r2 = syy === 0 ? 1 : Math.max(0, 1 - ssRes / syy);
    const slopeSe = n > 2 ? Math.sqrt(ssRes / (n - 2) / sxx) : 0;
    return { slope, intercept, n, r2, slopeSe };
  }

  // ---------------------------------------------------------- trend weight

  /**
   * Gap-aware exponential moving average of body weight ("trend weight").
   *
   * Scale weight bounces several pounds a day on water and gut content alone.
   * The EMA is what people actually mean by "am I losing weight". Because
   * weigh-ins are irregular, the smoothing factor is time-based:
   * alpha = 1 - exp(-Δdays / tau), tau = halfLife / ln2.
   *
   * @param {Array} days rows from buildDays
   * @param {Object} [opts] { halfLifeDays = 7 }
   * @returns {Array<{day, raw, trend, carried}>} trend is null before the
   *   first weigh-in; `carried` marks days where the trend is held flat.
   */
  function trendWeight(days, opts) {
    const halfLife = Math.max(1, (opts && opts.halfLifeDays) || 7);
    const tau = halfLife / Math.LN2;
    let trend = null;
    let lastDay = null;
    return (days || []).map((d) => {
      const raw = numOrNull(d.weightKg);
      let carried = true;
      if (raw != null) {
        if (trend == null) {
          trend = raw;
        } else {
          const gap = Math.max(1, daysBetween(lastDay, d.day));
          const alpha = 1 - Math.exp(-gap / tau);
          trend = trend + alpha * (raw - trend);
        }
        lastDay = d.day;
        carried = false;
      }
      return { day: d.day, raw, trend, carried };
    });
  }

  /**
   * Rate of weight change.
   *
   * The regression runs on the *raw* weigh-ins, not the EMA. Least squares is
   * already noise-tolerant and unbiased, whereas an EMA lags its own input —
   * fitting the smoothed line would systematically understate the real rate
   * (a true -0.7 kg/wk reads as roughly -0.35 over a two-week window). The
   * trend is still what gets drawn and what "current weight" means; it just
   * isn't what the slope is measured from.
   *
   * @returns {{kgPerDay, kgPerWeek, n, spanDays, r2, seKgPerDay, first, last}|null}
   */
  function weightRate(trendSeries, opts) {
    const windowDays = (opts && opts.windowDays) || null;
    let series = trendSeries || [];
    if (windowDays && series.length) {
      const cutoff = addDays(series[series.length - 1].day, -(windowDays - 1));
      series = series.filter((p) => p.day >= cutoff);
    }
    // Only real weigh-in days carry information; carried days repeat a value.
    const anchors = series.filter((p) => p.raw != null);
    if (anchors.length < 2) return null;
    const base = anchors[0].day;
    const fit = linearFit(
      anchors.map((p) => daysBetween(base, p.day)),
      anchors.map((p) => p.raw)
    );
    if (!fit) return null;
    const spanDays = daysBetween(anchors[0].day, anchors[anchors.length - 1].day) + 1;
    return {
      kgPerDay: fit.slope,
      kgPerWeek: fit.slope * 7,
      n: anchors.length,
      spanDays,
      r2: fit.r2,
      seKgPerDay: fit.slopeSe,
      first: anchors[0].trend,
      last: anchors[anchors.length - 1].trend,
    };
  }

  // ------------------------------------------------------- adaptive TDEE

  /**
   * Estimate total daily energy expenditure from what actually happened:
   * TDEE ≈ mean intake − (trend weight slope in kg/day × 7700).
   *
   * This is the single most useful number a tracker can give, because it
   * replaces a formula's guess about your metabolism with your own data. It is
   * also easy to get badly wrong, so it is gated: sparse logging or too few
   * weigh-ins returns `confidence: "none"` with a plain-language `reason`
   * instead of a number.
   *
   * @returns {{tdee, marginKcal, intakeAvg, kgPerWeek, loggedDays, rangeDays,
   *   coverage, weighIns, spanDays, confidence, reason}}
   */
  function estimateTdee(days, opts) {
    const o = opts || {};
    const kcalPerKg = o.kcalPerKg || KCAL_PER_KG;
    const rows = days || [];
    const logged = loggedRows(rows);
    const rangeDays = rows.length;
    const coverage = rangeDays ? logged.length / rangeDays : 0;
    const trend = trendWeight(rows, { halfLifeDays: o.halfLifeDays || 7 });
    const rate = weightRate(trend);
    const weighIns = trend.filter((p) => !p.carried).length;
    const spanDays = rate ? rate.spanDays : 0;
    const intakeAvg = mean(logged.map((r) => r.kcal));

    const base = {
      tdee: null, marginKcal: null, intakeAvg, kgPerWeek: rate ? rate.kgPerWeek : null,
      loggedDays: logged.length, rangeDays, coverage, weighIns, spanDays,
      confidence: "none", reason: "",
    };

    if (!rate || weighIns < 3) {
      return { ...base, reason: "Needs at least 3 weigh-ins in this range." };
    }
    if (spanDays < 10) {
      return { ...base, reason: "Needs weigh-ins spanning at least 10 days." };
    }
    if (logged.length < 7) {
      return { ...base, reason: "Needs at least 7 logged days of food." };
    }
    if (coverage < 0.5) {
      return {
        ...base,
        reason: `Only ${Math.round(coverage * 100)}% of days are logged — needs 50%+ to be meaningful.`,
      };
    }

    const tdee = intakeAvg - rate.kgPerDay * kcalPerKg;
    // 95% band on the slope, carried through to kcal.
    const margin = 1.96 * (rate.seKgPerDay || 0) * kcalPerKg;

    let confidence = "low";
    if (spanDays >= 21 && weighIns >= 10 && coverage >= 0.8) confidence = "high";
    else if (spanDays >= 14 && weighIns >= 6 && coverage >= 0.65) confidence = "medium";

    return {
      ...base,
      tdee,
      marginKcal: Number.isFinite(margin) ? margin : null,
      kgPerWeek: rate.kgPerWeek,
      confidence,
      reason: "",
    };
  }

  /**
   * "What would I have to eat to move at rate X?" — the natural follow-up to
   * a TDEE estimate, and the thing goal-setting screens usually skip.
   *
   * @param {Object} tdee result of estimateTdee
   * @param {number} targetKgPerWeek negative to lose, positive to gain
   */
  function intakeForRate(tdee, targetKgPerWeek, opts) {
    if (!tdee || tdee.tdee == null) return null;
    const kcalPerKg = (opts && opts.kcalPerKg) || KCAL_PER_KG;
    const delta = (Number(targetKgPerWeek) || 0) * kcalPerKg / 7;
    return tdee.tdee + delta;
  }

  /**
   * Where the current trajectory lands, with an honest horizon.
   * @returns {{kgPerWeek, weeks, projectedKg, fromKg}|null}
   */
  function projectWeight(days, opts) {
    const weeks = (opts && opts.weeks) || 4;
    const trend = trendWeight(days, opts);
    const rate = weightRate(trend);
    if (!rate) return null;
    const anchors = trend.filter((p) => p.trend != null);
    const fromKg = anchors[anchors.length - 1].trend;
    return {
      kgPerWeek: rate.kgPerWeek,
      weeks,
      fromKg,
      projectedKg: fromKg + rate.kgPerWeek * weeks,
      confident: rate.n >= 6 && rate.spanDays >= 14,
    };
  }

  // -------------------------------------------------------- consistency

  /**
   * Logging behaviour. Kept separate from target adherence because they are
   * different problems with different fixes: you can log every day and miss
   * every target, or hit every target on the four days you bothered to log.
   *
   * @param {Array} days rows from buildDays
   * @param {Object} [opts] { todayKey } — today is excluded from "missed" when
   *   still unlogged, since the day is not over.
   */
  function consistency(days, opts) {
    const todayKey = (opts && opts.todayKey) || null;
    const rows = days || [];
    const scored = rows.filter((d) => !(todayKey && d.day === todayKey && !d.logged));
    const logged = scored.filter((d) => d.logged);

    let current = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (todayKey && rows[i].day === todayKey && !rows[i].logged) continue; // grace for today
      if (rows[i].logged) current += 1;
      else break;
    }
    let longest = 0, run = 0;
    for (const d of rows) {
      if (d.logged) { run += 1; longest = Math.max(longest, run); }
      else if (!(todayKey && d.day === todayKey)) run = 0;
    }

    const weekdays = scored.filter((d) => !d.weekend);
    const weekends = scored.filter((d) => d.weekend);
    const rate = (list) => (list.length ? list.filter((d) => d.logged).length / list.length : null);

    return {
      loggedDays: logged.length,
      totalDays: scored.length,
      rate: scored.length ? logged.length / scored.length : 0,
      currentStreak: current,
      longestStreak: longest,
      weekdayRate: rate(weekdays),
      weekendRate: rate(weekends),
      missedDays: scored.filter((d) => !d.logged).map((d) => d.day),
    };
  }

  /**
   * How much each target contributes to the score.
   *
   * A flat average across the six nutrients is the obvious choice and the wrong
   * one, for two reasons.
   *
   * First, they are not independent. Protein and carbs are 4 kcal/g and fat is
   * 9, so once calories and protein land, carbs and fat are very nearly
   * determined. Scoring kcal, carbs and fat equally counts energy adherence
   * three times and lets it dominate everything else.
   *
   * Second, a ceiling most people clear without trying is not evidence of
   * effort. Someone who never cooks with salt hits the sodium target every day
   * by doing nothing, and a flat average hands them a free sixth of the score.
   * Sodium still counts — going over is real — it just does not count like a
   * target you have to work at.
   *
   * So these weights track distinct daily effort, not nutrient importance.
   */
  const SCORE_WEIGHTS = {
    kcal: 0.30,     // energy adherence — the primary lever
    protein: 0.30,  // floor, most often missed, most outcome-relevant at fixed kcal
    fiber: 0.20,    // floor, and a genuinely separate behaviour: food quality
    sodium: 0.10,   // ceiling guardrail — real, but usually cleared without effort
    carbs: 0.05,    // largely implied once calories and protein land
    fat: 0.05,
  };

  /**
   * One headline number, 0–100, so the tab opens with an answer rather than a
   * chart to interpret. Two components: logging consistency (30%) and an
   * effort-weighted target rate (70%, see SCORE_WEIGHTS).
   *
   * A nutrient with no goal set scores no days and drops out entirely, with the
   * remaining weights renormalized — so zeroing a target removes it from the
   * score rather than counting as a permanent miss.
   *
   * @param {Array} days
   * @param {Function} scoreDay (totalsLike, goals) → per-nutrient statuses,
   *   normally Phases.scoreDayTotals. Falls back to consistency-only when absent.
   */
  function nutritionScore(days, scoreDay, opts) {
    const cons = consistency(days, opts);
    const nutrients = [];
    let targets = null;

    if (typeof scoreDay === "function") {
      const tally = {};
      for (const k of NUTRIENTS) tally[k] = { hit: 0, n: 0 };
      for (const d of loggedRows(days)) {
        const s = scoreDay(toTotalsLike(d), d.goals || {});
        if (!s) continue;
        for (const k of NUTRIENTS) {
          const cell = s[k];
          if (!cell || cell.status === "skip") continue;
          tally[k].n += 1;
          if (cell.status === "hit") tally[k].hit += 1;
        }
      }
      let acc = 0, wsum = 0;
      for (const k of NUTRIENTS) {
        const t = tally[k];
        if (!t.n) continue; // no goal set for this nutrient in this range
        const w = SCORE_WEIGHTS[k] || 0;
        const hitRate = t.hit / t.n;
        nutrients.push({ key: k, label: LABEL[k], weight: w, hitRate, hit: t.hit, n: t.n });
        acc += hitRate * w;
        wsum += w;
      }
      targets = wsum ? acc / wsum : null;
    }

    const parts = { consistency: cons.rate, targets, nutrients };
    const weights = { consistency: 0.30, targets: 0.70 };
    let acc = 0, wsum = 0;
    for (const k of Object.keys(weights)) {
      if (parts[k] == null) continue;
      acc += parts[k] * weights[k];
      wsum += weights[k];
    }
    const score = wsum ? Math.round((acc / wsum) * 100) : null;
    const gap = biggestGap(nutrients);
    return { score, grade: gradeFor(score, !!gap), parts, nutrients, gap, consistency: cons };
  }

  /**
   * The target costing the score the most, weight included — so a shaky fiber
   * habit outranks a rare calorie overshoot. Turns the number into a next step
   * instead of a verdict. Null when nothing is meaningfully off.
   */
  function biggestGap(nutrients, opts) {
    const minDays = (opts && opts.minDays) || 3;
    const ranked = (nutrients || [])
      .filter((n) => n.n >= minDays && n.hitRate < 0.8)
      .map((n) => ({ ...n, cost: (1 - n.hitRate) * n.weight }))
      .sort((a, b) => b.cost - a.cost);
    return ranked[0] || null;
  }

  /**
   * @param {number|null} score
   * @param {boolean} [hasGap] true when a target is still being missed often.
   *   The top grade is withheld in that case: claiming "dialed in" directly
   *   above a line naming a missed target reads as the app not reading its own
   *   output. Weighting means a single soft target can leave the number high
   *   while a real habit is still unbuilt.
   */
  function gradeFor(score, hasGap) {
    if (score == null) return "No data yet";
    if (score >= 85) return hasGap ? "On track" : "Dialed in";
    if (score >= 70) return "On track";
    if (score >= 55) return "Mixed";
    if (score >= 35) return "Finding a rhythm";
    return "Early days";
  }

  /** Shape a built day row back into the totals object Phases expects. */
  function toTotalsLike(row) {
    return {
      count: row.itemCount || 1,
      kcal: { mean: row.kcal || 0 },
      p: { mean: row.protein || 0 },
      c: { mean: row.carbs || 0 },
      f: { mean: row.fat || 0 },
      fb: { mean: row.fiber || 0 },
      na: { mean: row.sodium || 0 },
    };
  }

  // ---------------------------------------------------------- aggregations

  /**
   * Weekly averages. Weeks are how nutrition actually works — a 700 kcal
   * Saturday inside a 2000 kcal week is noise, not a failure — so this is the
   * view most worth defaulting to over long ranges.
   *
   * Averages are over *logged* days only, with `loggedDays` exposed so the UI
   * can flag a week that is really one Tuesday.
   */
  function weeklyRollup(days, key) {
    const buckets = new Map();
    for (const d of days || []) {
      const ws = weekStart(d.day);
      if (!buckets.has(ws)) buckets.set(ws, []);
      buckets.get(ws).push(d);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ws, rows]) => {
        const logged = rows.filter((r) => r.logged);
        const end = rows[rows.length - 1].day;
        return {
          weekStart: ws,
          endDay: end,
          label: `${shortDate(ws)}`,
          rangeLabel: `${shortDate(rows[0].day)} – ${shortDate(end)}`,
          days: rows.length,
          loggedDays: logged.length,
          value: mean(logged.map((r) => r[key])),
          goal: mean(rows.map((r) => (r.goals || {})[key])),
          partial: logged.length > 0 && logged.length < 4,
        };
      });
  }

  /**
   * Day-of-week pattern. Surfaces the weekend drift that wrecks otherwise
   * good weeks and is invisible on a daily bar chart.
   */
  function byDayOfWeek(days, key) {
    const rows = [];
    for (let dow = 0; dow < 7; dow++) {
      const match = loggedRows(days).filter((d) => d.dow === dow);
      const all = (days || []).filter((d) => d.dow === dow);
      rows.push({
        dow,
        label: DOW_LABEL[dow],
        weekend: dow === 0 || dow === 6,
        n: match.length,
        totalDays: all.length,
        avg: mean(match.map((d) => d[key])),
        goal: mean(all.map((d) => (d.goals || {})[key])),
      });
    }
    // Monday-first reads better next to the weekly rollup.
    return rows.slice(1).concat(rows.slice(0, 1));
  }

  /** Largest weekday↔weekend gap worth mentioning, or null. */
  function weekendEffect(days, key) {
    const logged = loggedRows(days);
    const wk = logged.filter((d) => !d.weekend);
    const we = logged.filter((d) => d.weekend);
    if (wk.length < 3 || we.length < 2) return null;
    const a = mean(wk.map((d) => d[key]));
    const b = mean(we.map((d) => d[key]));
    if (a == null || b == null || !a) return null;
    const delta = b - a;
    return {
      weekdayAvg: a,
      weekendAvg: b,
      delta,
      pct: delta / a,
      n: { weekday: wk.length, weekend: we.length },
      notable: Math.abs(delta / a) >= 0.10,
    };
  }

  /**
   * Share of calories from each macro, next to the share implied by the
   * current targets. Ratios travel better than raw grams when calories move.
   */
  function macroSplit(days) {
    const logged = loggedRows(days);
    const gP = mean(logged.map((d) => d.protein));
    const gC = mean(logged.map((d) => d.carbs));
    const gF = mean(logged.map((d) => d.fat));
    const goals = (days || []).map((d) => d.goals || {});
    const tP = mean(goals.map((g) => g.protein));
    const tC = mean(goals.map((g) => g.carbs));
    const tF = mean(goals.map((g) => g.fat));

    const split = (p, c, f) => {
      const kp = (p || 0) * 4, kc = (c || 0) * 4, kf = (f || 0) * 9;
      const tot = kp + kc + kf;
      if (!tot) return null;
      return {
        protein: kp / tot, carbs: kc / tot, fat: kf / tot,
        kcalFromMacros: tot,
        grams: { protein: p, carbs: c, fat: f },
      };
    };
    return { actual: split(gP, gC, gF), target: split(tP, tC, tF), n: logged.length };
  }

  /**
   * Where the calories land across the day. Meal timing is the lever people
   * reach for when the daily total is already fine but the day still feels off.
   */
  function byMeal(keys, entriesForDay) {
    const totals = {};
    for (const m of MEALS) totals[m] = { meal: m, kcal: 0, protein: 0, items: 0, days: new Set() };
    let grand = 0;
    for (const day of keys || []) {
      for (const e of entriesForDay(day) || []) {
        const m = MEALS.includes(e.meal) ? e.meal : "snack";
        const kcal = (e.macros && e.macros.kcal) || 0;
        totals[m].kcal += kcal;
        totals[m].protein += (e.macros && e.macros.p) || 0;
        totals[m].items += 1;
        totals[m].days.add(day);
        grand += kcal;
      }
    }
    return MEALS.map((m) => {
      const t = totals[m];
      const nDays = t.days.size;
      return {
        meal: m,
        label: m[0].toUpperCase() + m.slice(1),
        kcal: t.kcal,
        protein: t.protein,
        items: t.items,
        daysPresent: nDays,
        avgKcal: nDays ? t.kcal / nDays : 0,
        pct: grand ? t.kcal / grand : 0,
      };
    });
  }

  /**
   * Biggest contributors by a chosen metric. Ranking by protein or sodium —
   * not just calories — is what turns this from trivia into something you can
   * act on ("my sodium is one soup").
   *
   * @param {string} metric one of kcal | protein | sodium | fiber
   */
  function topFoods(keys, entriesForDay, metric, limit) {
    const field = { kcal: "kcal", protein: "p", sodium: "na", fiber: "fb", carbs: "c", fat: "f" }[metric] || "kcal";
    const agg = new Map();
    let grand = 0;
    for (const day of keys || []) {
      for (const e of entriesForDay(day) || []) {
        const v = (e.macros && e.macros[field]) || 0;
        if (!v) continue;
        const cur = agg.get(e.name) || { name: e.name, value: 0, count: 0 };
        cur.value += v;
        cur.count += 1;
        agg.set(e.name, cur);
        grand += v;
      }
    }
    return [...agg.values()]
      .sort((a, b) => b.value - a.value)
      .slice(0, limit || 5)
      .map((r) => ({ ...r, pct: grand ? r.value / grand : 0, total: grand }));
  }

  /** Protein relative to body weight — the form the evidence is actually in. */
  function proteinPerKg(days) {
    const logged = loggedRows(days);
    const p = mean(logged.map((d) => d.protein));
    const trend = trendWeight(days);
    const anchors = trend.filter((t) => t.trend != null);
    const kg = anchors.length ? anchors[anchors.length - 1].trend : null;
    if (p == null || !kg) return null;
    return { gPerKg: p / kg, proteinAvg: p, weightKg: kg };
  }

  /**
   * Calendar heatmap cells: one square per day, coloured by how the chosen
   * nutrient landed against that day's target. Whole-range consistency at a
   * glance, in the layout everyone already understands from commit graphs.
   */
  function heatmapCells(days, key, scoreDay) {
    return (days || []).map((d) => {
      const goal = (d.goals || {})[key] || 0;
      const value = d[key];
      let status = "empty";
      let ratio = null;
      if (d.logged && Number.isFinite(value)) {
        ratio = goal ? value / goal : null;
        if (typeof scoreDay === "function") {
          const s = scoreDay(toTotalsLike(d), d.goals || {});
          status = (s && s[key] && s[key].status) || "hit";
          if (status === "skip") status = "logged";
        } else {
          status = "logged";
        }
      }
      return {
        day: d.day,
        dow: d.dow,
        weekStart: weekStart(d.day),
        logged: d.logged,
        value,
        goal,
        ratio,
        status,
      };
    });
  }

  /** Group heatmap cells into Monday-start week columns, padded to 7 rows. */
  function heatmapWeeks(cells) {
    const map = new Map();
    for (const c of cells || []) {
      if (!map.has(c.weekStart)) map.set(c.weekStart, new Array(7).fill(null));
      const idx = c.dow === 0 ? 6 : c.dow - 1; // Monday = row 0
      map.get(c.weekStart)[idx] = c;
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([ws, col]) => ({ weekStart: ws, label: shortDate(ws), cells: col }));
  }

  /** Highest and lowest logged days for a nutrient. */
  function extremes(days, key) {
    const logged = loggedRows(days).filter((d) => Number.isFinite(d[key]));
    if (!logged.length) return null;
    const sorted = [...logged].sort((a, b) => a[key] - b[key]);
    return { low: sorted[0], high: sorted[sorted.length - 1] };
  }

  /**
   * Compare the most recent stretch against the one before it. "Better or
   * worse than I was" is the question a bare average never answers.
   */
  function momentum(days, key, windowDays) {
    const w = windowDays || 7;
    const rows = days || [];
    if (rows.length < w + 2) return null;
    const recent = loggedRows(rows.slice(-w));
    const prior = loggedRows(rows.slice(-2 * w, -w));
    if (recent.length < 2 || prior.length < 2) return null;
    const a = mean(prior.map((d) => d[key]));
    const b = mean(recent.map((d) => d[key]));
    if (a == null || b == null) return null;
    return {
      recentAvg: b,
      priorAvg: a,
      delta: b - a,
      pct: a ? (b - a) / a : null,
      recentN: recent.length,
      priorN: prior.length,
    };
  }

  /**
   * Short, factual observations ranked by how much they'd change a decision.
   * Descriptive only — no praise, no scolding.
   *
   * @returns {Array<{id, tone, text}>} tone: info | watch | good
   */
  function observations(days, opts) {
    const o = opts || {};
    const out = [];
    const logged = loggedRows(days);
    if (!logged.length) return out;

    const cons = consistency(days, o);
    if (cons.totalDays >= 7 && cons.rate < 0.6) {
      out.push({
        id: "coverage",
        tone: "info",
        text: `${cons.loggedDays} of ${cons.totalDays} days logged. Averages below are drawn from logged days only.`,
      });
    }
    if (cons.weekdayRate != null && cons.weekendRate != null && cons.weekdayRate - cons.weekendRate >= 0.3) {
      out.push({
        id: "weekend-logging",
        tone: "info",
        text: `Weekends are logged less often (${Math.round(cons.weekendRate * 100)}% vs ${Math.round(cons.weekdayRate * 100)}% on weekdays), so the averages lean weekday.`,
      });
    }

    const we = weekendEffect(days, "kcal");
    if (we && we.notable) {
      const dir = we.delta > 0 ? "higher" : "lower";
      out.push({
        id: "weekend-kcal",
        tone: "watch",
        text: `Weekend calories run ${Math.abs(Math.round(we.delta))} kcal ${dir} than weekdays (${Math.round(we.weekdayAvg)} → ${Math.round(we.weekendAvg)}).`,
      });
    }

    const kcalStats = summaryStats(days, "kcal");
    if (kcalStats.n >= 7 && kcalStats.cv != null && kcalStats.cv >= 0.25) {
      out.push({
        id: "variability",
        tone: "info",
        text: `Daily calories swing a lot (±${Math.round(kcalStats.sd)} kcal around ${Math.round(kcalStats.avg)}). Weekly view is the steadier read.`,
      });
    }

    const ppk = proteinPerKg(days);
    if (ppk) {
      out.push({
        id: "protein-per-kg",
        tone: "info",
        text: `Protein averages ${ppk.gPerKg.toFixed(1)} g per kg of body weight.`,
      });
    }

    const mom = momentum(days, "kcal", 7);
    if (mom && Math.abs(mom.pct || 0) >= 0.08) {
      const dir = mom.delta > 0 ? "up" : "down";
      out.push({
        id: "momentum",
        tone: "info",
        text: `Last 7 logged days are ${dir} ${Math.abs(Math.round(mom.delta))} kcal/day vs the week before.`,
      });
    }

    const partial = partialDays(days);
    if (partial.flagged.length) {
      const n = partial.flagged.length;
      const adj = partial.adjustedAvg != null
        ? ` Without them the average is ${Math.round(partial.adjustedAvg)} kcal instead of ${Math.round(partial.avg)}.`
        : "";
      out.push({
        id: "partial-days",
        tone: "info",
        text: `${n} day${n === 1 ? "" : "s"} logged under ${Math.round(partial.threshold)} kcal with one or two items — possibly unfinished logs rather than light days. They are still counted.${adj}`,
      });
    }

    const bumps = bumpAudit(days);
    if (bumps.total) {
      const retro = bumps.retroactive
        ? ` ${bumps.retroactive} ${bumps.retroactive === 1 ? "was" : "were"} set after the day ended.`
        : "";
      out.push({
        id: "bumps",
        tone: bumps.retroactive ? "watch" : "info",
        text: `${bumps.total} day${bumps.total === 1 ? "" : "s"} used a target bump, so ${bumps.total === 1 ? "it is" : "they are"} scored against the adjusted target.${retro}`,
      });
    }

    return out;
  }

  // -------------------------------------------------------- data honesty

  /**
   * Days that look like a forgotten log rather than a day of eating.
   *
   * A day holding one 250 kcal entry drags every average down and quietly
   * distorts the TDEE estimate, which assumes logged intake is complete. But a
   * genuine fast looks identical in the data, so this only ever *flags*: the
   * days stay in every calculation, and the counterfactual average is offered
   * beside the real one rather than replacing it. Silently discarding someone's
   * data because it looks odd is worse than showing an average they can judge.
   *
   * Thresholds are relative to the person's own median, not an absolute
   * calorie floor, so a 1,400 kcal eater is not permanently flagged.
   */
  function partialDays(days, opts) {
    const o = opts || {};
    const ratio = o.ratio || 0.4;
    const maxItems = o.maxItems || 2;
    const logged = loggedRows(days);
    const empty = { flagged: [], median: null, avg: null, adjustedAvg: null, threshold: null };
    if (logged.length < 5) return empty; // no baseline worth trusting yet

    const med = median(logged.map((d) => d.kcal));
    if (!med) return empty;
    const threshold = med * ratio;
    const flagged = logged.filter((d) =>
      Number.isFinite(d.kcal) && d.kcal < threshold && d.itemCount <= maxItems
    );
    const rest = logged.filter((d) => !flagged.includes(d));
    return {
      flagged: flagged.map((d) => ({ day: d.day, kcal: d.kcal, itemCount: d.itemCount })),
      median: med,
      threshold,
      avg: mean(logged.map((d) => d.kcal)),
      adjustedAvg: rest.length ? mean(rest.map((d) => d.kcal)) : null,
    };
  }

  /** True when a day's bump was recorded after that day had already ended. */
  function bumpIsRetroactive(dayKey, updatedAt) {
    if (!updatedAt) return false;
    const end = dateOf(dayKey);
    end.setHours(24, 0, 0, 0);
    return updatedAt > end.getTime();
  }

  /**
   * Which days had their targets bumped, and which of those were bumped after
   * the fact.
   *
   * Bumping is legitimate — a planned refeed or a wedding genuinely has a
   * different target, and scoring it against the plan you set beats pretending
   * every day is identical. But because a bump moves the target, it converts an
   * "over" day into a "hit", so an unmarked bump makes adherence self-marking.
   * Recording them, and separating planned from retroactive, keeps the feature
   * useful without letting it quietly launder a miss.
   */
  function bumpAudit(days) {
    const rows = [];
    let retroactive = 0;
    let kcalTotal = 0;
    for (const d of days || []) {
      const b = d.bump;
      if (!b || !b.bumps) continue;
      const entries = Object.entries(b.bumps).filter(([, v]) => Number(v));
      if (!entries.length) continue;
      const retro = bumpIsRetroactive(d.day, b.updatedAt);
      if (retro) retroactive += 1;
      kcalTotal += Number(b.bumps.kcal) || 0;
      rows.push({ day: d.day, bumps: b.bumps, retroactive: retro, logged: d.logged });
    }
    return { total: rows.length, retroactive, planned: rows.length - retroactive, kcalTotal, days: rows };
  }

  // ----------------------------------------------------------- comparison

  /**
   * Everything worth comparing about a stretch of days, in one object, so two
   * phases can be put side by side without recomputing each metric twice.
   */
  function rangeSummary(days, scoreDay, opts) {
    const logged = loggedRows(days);
    const trend = trendWeight(days, opts);
    const rate = weightRate(trend);
    const score = nutritionScore(days, scoreDay, opts);
    return {
      days: days.length,
      loggedDays: logged.length,
      coverage: days.length ? logged.length / days.length : 0,
      kcalAvg: mean(logged.map((d) => d.kcal)),
      kcalGoal: mean(days.map((d) => (d.goals || {}).kcal)),
      proteinAvg: mean(logged.map((d) => d.protein)),
      fiberAvg: mean(logged.map((d) => d.fiber)),
      sodiumAvg: mean(logged.map((d) => d.sodium)),
      kgPerWeek: rate ? rate.kgPerWeek : null,
      weighIns: rate ? rate.n : 0,
      score: score.score,
      targetRate: score.parts.targets,
      proteinRate: (score.nutrients.find((n) => n.key === "protein") || {}).hitRate ?? null,
    };
  }

  /**
   * Side-by-side rows for two range summaries. `better` is deliberately null
   * for anything without an objective direction — a bigger calorie average is
   * not better or worse without knowing whether you were cutting or bulking.
   */
  function compareSummaries(current, previous, opts) {
    const o = opts || {};
    const unit = o.weightUnit === "kg" ? "kg" : "lb";
    const toDisp = (kg) => (kg == null ? null : kgToDisplay(kg, unit));
    const row = (key, label, a, b, fmtFn, higherBetter) => ({
      key, label,
      current: a, previous: b,
      delta: a != null && b != null ? a - b : null,
      format: fmtFn,
      better: higherBetter == null || a == null || b == null || a === b
        ? null
        : (higherBetter ? a > b : a < b),
    });
    return [
      row("score", "Score", current.score, previous.score, (v) => (v == null ? "—" : String(v)), true),
      row("coverage", "Days logged", current.coverage, previous.coverage, (v) => (v == null ? "—" : `${Math.round(v * 100)}%`), true),
      row("kcal", "Avg calories", current.kcalAvg, previous.kcalAvg, (v) => (v == null ? "—" : String(Math.round(v))), null),
      row("kcalGoal", "Calorie target", current.kcalGoal, previous.kcalGoal, (v) => (v == null ? "—" : String(Math.round(v))), null),
      row("rate", `Weight rate (${unit}/wk)`, toDisp(current.kgPerWeek), toDisp(previous.kgPerWeek), (v) => (v == null ? "—" : fmtSigned(v, 2)), null),
      row("protein", "Protein met", current.proteinRate, previous.proteinRate, (v) => (v == null ? "—" : `${Math.round(v * 100)}%`), true),
      row("targets", "Targets met", current.targetRate, previous.targetRate, (v) => (v == null ? "—" : `${Math.round(v * 100)}%`), true),
    ];
  }

  // ------------------------------------------------------------- goal math

  /**
   * Rebuild macro targets around a new calorie number.
   *
   * Protein is set by body weight, not by energy intake, so it holds — that is
   * the whole point of protecting it in a deficit. Fiber and sodium are
   * independent of calories, so they hold too. The change lands on carbs and
   * fat, split in whatever ratio they already sit at, so the macros still add
   * up to the calories instead of silently contradicting them.
   */
  function retargetForKcal(goals, newKcal) {
    const g = { ...(goals || {}) };
    const kcal = Math.max(800, Math.round(Number(newKcal) / 10) * 10);
    const proteinKcal = (Number(g.protein) || 0) * 4;
    const remaining = Math.max(0, kcal - proteinKcal);
    const curCarbKcal = (Number(g.carbs) || 0) * 4;
    const curFatKcal = (Number(g.fat) || 0) * 9;
    const curTotal = curCarbKcal + curFatKcal;
    const carbShare = curTotal > 0 ? curCarbKcal / curTotal : 0.55;
    const round5 = (n) => Math.max(0, Math.round(n / 5) * 5);
    return {
      ...g,
      kcal,
      carbs: round5((remaining * carbShare) / 4),
      fat: round5((remaining * (1 - carbShare)) / 9),
    };
  }

  // ------------------------------------------------------------ formatting

  function fmtNum(v, digits) {
    if (v == null || !Number.isFinite(v)) return "—";
    return digits ? v.toFixed(digits) : String(Math.round(v));
  }

  function fmtSigned(v, digits) {
    if (v == null || !Number.isFinite(v)) return "—";
    const s = v >= 0 ? "+" : "";
    return s + (digits ? v.toFixed(digits) : String(Math.round(v)));
  }

  function kgToDisplay(kg, unit) {
    if (kg == null || !Number.isFinite(kg)) return null;
    return unit === "kg" ? kg : kg / 0.45359237;
  }

  return {
    KCAL_PER_KG, DOW_LABEL, MEALS, NUTRIENTS, TOTALS_KEY, UNIT, LABEL,
    dayKeyFromDate, dateOf, addDays, daysBetween, weekStart, shortDate,
    buildDays, loggedRows, toTotalsLike,
    mean, median, stdev, summaryStats, rollingMean, linearFit,
    trendWeight, weightRate, estimateTdee, intakeForRate, projectWeight,
    consistency, nutritionScore, gradeFor, biggestGap, SCORE_WEIGHTS,
    weeklyRollup, byDayOfWeek, weekendEffect, macroSplit, byMeal, topFoods,
    proteinPerKg, heatmapCells, heatmapWeeks, extremes, momentum, observations,
    partialDays, bumpAudit, bumpIsRetroactive,
    rangeSummary, compareSummaries, retargetForKcal,
    fmtNum, fmtSigned, kgToDisplay,
  };
})();

if (typeof module !== "undefined") module.exports = Analytics;
