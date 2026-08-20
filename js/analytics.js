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
  /** Automated target changes are deliberately narrower than manual entry. */
  const MIN_AUTOMATED_KCAL = 1200;
  const MAX_AUTOMATED_KCAL = 6000;
  /** Even a perfect flat line cannot prove zero intake/scale/model error. */
  const MIN_TDEE_MARGIN_KCAL = 100;
  /** A small absolute fat floor prevents calorie retargeting from erasing fat. */
  const MIN_RETARGET_FAT_G = 30;
  const DOW_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MEALS = ["breakfast", "lunch", "dinner", "snack"];
  /** Nutrient keys as they appear on a built day row. */
  const NUTRIENTS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium", "potassium"];
  /** Map nutrient key → Ledger totals key. */
  const TOTALS_KEY = {
    kcal: "kcal", protein: "p", carbs: "c", fat: "f", fiber: "fb", sodium: "na",
    potassium: "k",
  };
  const UNIT = { kcal: "", protein: " g", carbs: " g", fat: " g", fiber: " g", sodium: " mg", potassium: " mg", naK: "" };
  const LABEL = {
    kcal: "Calories", protein: "Protein", carbs: "Carbs",
    fat: "Fat", fiber: "Fiber", sodium: "Sodium", potassium: "Potassium",
    naK: "Na:K ratio",
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
   * @param {Function} [opts.dayPlanForDay] day → calorie-plan record | null
   * @param {Function} [opts.firstAddAt] day → immutable first-add timestamp | null
   * @returns {Array<Object>} rows: { day, dow, weekend, logged, intent,
   *   accounted, itemCount, kcal, protein, carbs, fat, fiber, sodium, goals,
   *   weightKg, dayPlan, firstAddAt }
   */
  function buildDays(opts) {
    const o = opts || {};
    const keys = o.keys || [];
    const totalsForDay = o.totalsForDay || (() => null);
    const goalsForDay = o.goalsForDay || (() => ({}));
    const weightKgForDay = o.weightKgForDay || (() => null);
    const dayPlanForDay = o.dayPlanForDay || (() => null);
    const firstAddAt = o.firstAddAt || (() => null);

    return keys.map((day) => {
      const t = totalsForDay(day);
      const logged = !!(t && t.count);
      const dow = dateOf(day).getDay();
      const goals = goalsForDay(day) || {};
      // The resolved bump (not the raw stored record) is the only reliable
      // source for intent: an improperly-flagged fast (e.g. missing
      // fastAcknowledged) fails validation inside Phases.dayPlanForDay and
      // resolves to no bump at all, so trusting the raw record here would
      // read a rejected declaration as a real one.
      //
      // A locked no-op (kcal delta 0) is what healLoggedDayGoals writes for
      // every logged day even when nobody planned anything — that is a
      // restatement of the phase target, not a reduced-day declaration.
      // Treating it as intent "reduced" would make partialDays exclude every
      // healed day and silence the unfinished-log gate.
      const resolvedBump = goals._dayPlan;
      const intent = !resolvedBump
        ? null
        : resolvedBump.intent === "fast"
          ? "fast"
          : (Number(resolvedBump.kcal) !== 0 ? "reduced" : null);
      // A day with zero entries always totals to 0 kcal by construction, so
      // this only ever matters for distinguishing "no data available" (t
      // null, some callers pass no totals accessor at all) from a real
      // logged 0 — both read as 0 here, which is what a fast expects.
      const kcalMean = t && t.kcal && Number.isFinite(t.kcal.mean) ? t.kcal.mean : 0;
      const row = {
        day,
        dow,
        weekend: dow === 0 || dow === 6,
        logged,
        itemCount: (t && t.count) || 0,
        goals,
        intent,
        // accounted = logged || (intent === "fast" && loggedKcal === 0).
        // Logging anything with calories reverts a fast to an ordinary day
        // (Phases.effectiveGoals), so the fast clause only ever adds true,
        // undeclared-food fasts — a logged zero-kcal item is already covered
        // by the `logged` term on the left.
        accounted: logged || (intent === "fast" && kcalMean === 0),
        weightKg: numOrNull(weightKgForDay(day)),
        dayPlan: dayPlanForDay(day) || null,
        firstAddAt: numOrNull(firstAddAt(day)),
      };
      for (const k of NUTRIENTS) {
        const bucket = t && t[TOTALS_KEY[k]];
        row[k] = logged && bucket ? bucket.mean : null;
      }
      // Each absolute mineral has its own completeness contract. The ratio has
      // a stricter paired-entry contract so separately-known subsets are never
      // divided as though they came from the same foods.
      row.kCoverage = logged && t && Number.isFinite(t.kCoverage) ? t.kCoverage : 0;
      row.kItems = (t && t.kItems) || 0;
      // Sodium coverage is explicit for new nullable-Na entries. Totals created
      // before that contract have no coverage field; their numeric sodium was
      // historically treated as known, so preserve that interpretation.
      row.naCoverage = logged && t && Number.isFinite(t.naCoverage) ? t.naCoverage : (logged ? 1 : 0);
      row.naItems = (t && t.naItems) || 0;
      row.macroCoverage = logged && t && Number.isFinite(t.macroCoverage) ? t.macroCoverage : (logged ? 1 : 0);
      row.macroItems = (t && t.macroItems) || 0;
      row.naKCoverage = logged && t && Number.isFinite(t.naKCoverage)
        ? t.naKCoverage
        : Math.min(row.naCoverage, row.kCoverage);
      row.naKItems = (t && t.naKItems) || 0;
      row.pairedSodium = t && t.naKNa && Number.isFinite(t.naKNa.mean) ? t.naKNa.mean : row.sodium;
      row.pairedPotassium = t && t.naKK && Number.isFinite(t.naKK.mean) ? t.naKK.mean : row.potassium;
      row.sodiumCovered = typeof Phases !== "undefined" ? Phases.sodiumCovered(t) : false;
      row.potassiumCovered = typeof Phases !== "undefined" ? Phases.potassiumCovered(t) : false;
      row.macrosCovered = typeof Phases !== "undefined" ? Phases.macrosCovered(t) : (row.macroCoverage >= 0.8);
      row.jointCovered = typeof Phases !== "undefined" ? Phases.nakCovered(t) : false;
      // Compatibility aliases used by existing renderers.
      row.naCovered = row.sodiumCovered;
      row.kCovered = row.potassiumCovered;
      if (!row.sodiumCovered) row.sodium = null;
      if (!row.potassiumCovered) row.potassium = null;
      // Incomplete macros: keep kcal; null P/C/F/fiber so scores skip and renormalize.
      if (!row.macrosCovered) {
        row.protein = null;
        row.carbs = null;
        row.fat = null;
        row.fiber = null;
      }
      // Explicit user mark (Mark incomplete) — diary stays; stats skip the day.
      const rawPlan = row.dayPlan;
      row.excluded = !!(rawPlan && rawPlan.incomplete === true && !rawPlan.cleared);
      row.excludeReason = row.excluded ? (rawPlan.excludeReason || "incomplete") : null;
      row.naK = row.jointCovered && typeof Phases !== "undefined"
        ? Phases.naKRatio(row.pairedSodium, row.pairedPotassium)
        : null;
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

  /** Logged days plus honoured (undeclared-food) fasts — every row where `accounted` is true. */
  function accountedRows(days) {
    return (days || []).filter((d) => d.accounted);
  }

  /**
   * Days that participate in Insight averages / TDEE / consistency denominators.
   * Excluded (= Mark incomplete) leave the scored calendar entirely.
   */
  function completeRows(days) {
    return (days || []).filter((d) => d.accounted && !d.excluded);
  }

  function completeLoggedRows(days) {
    return (days || []).filter((d) => d.logged && !d.excluded);
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
    if (key === "overall") {
      const values = completeLoggedRows(days)
        .map((d) => (d.overallHit && Number.isFinite(d.overallHit.pct) ? d.overallHit.pct : null))
        .filter(Number.isFinite);
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
    const values = completeLoggedRows(days).map((d) => d[key]).filter(Number.isFinite);
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
   * @returns {{slope:number, intercept:number, n:number, r2:number,
   *   slopeSe:number, rmse:number, residualSd:number}|null}
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
    const residualSd = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;
    const slopeSe = n > 2 ? residualSd / Math.sqrt(sxx) : 0;
    const rmse = Math.sqrt(ssRes / n);
    return { slope, intercept, n, r2, slopeSe, rmse, residualSd };
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
   * @returns {{kgPerDay, kgPerWeek, n, spanDays, r2, rmseKg,
   *   residualSdKg, seKgPerDay, first, last}|null}
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
      rmseKg: fit.rmse,
      residualSdKg: fit.residualSd,
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
   * The estimate and the action gate are intentionally separate. A number can
   * still be useful to inspect when its interval is wide or the food logs look
   * incomplete; those conditions must never silently enable a target change.
   *
   * @returns {{tdee, marginKcal, intervalLow, intervalHigh, intakeAvg,
   *   medianIntake, completionRatio, kgPerWeek, loggedDays, rangeDays,
   *   coverage, weighIns, spanDays, fitR2, fitRmseKg, partialLogDays,
   *   confidence, actionable, reason, actionReason}}
   */
  function estimateTdee(days, opts) {
    const o = opts || {};
    const kcalPerKg = o.kcalPerKg || KCAL_PER_KG;
    const excludeDay = o.excludeDay || o.todayKey || null;
    const rows = (days || []).filter((d) =>
      !(excludeDay && d.day === excludeDay) && !d.excluded);
    const logged = loggedRows(rows);
    // TDEE's intake and coverage are drawn from the same calendar the weight
    // regression already reflects. A fast's deficit shows up in the trend
    // line whether or not the day is counted here, so excluding it from
    // intake while the regression keeps its effect would bias the estimate
    // upward — including it at 0 keeps numerator and denominator aligned.
    // Mark-incomplete days leave both intake and the coverage calendar.
    const accounted = accountedRows(rows);
    const rangeDays = rows.length;
    const coverage = rangeDays ? accounted.length / rangeDays : 0;
    const trend = trendWeight(rows, { halfLifeDays: o.halfLifeDays || 7 });
    const rate = weightRate(trend);
    const weighIns = trend.filter((p) => !p.carried).length;
    const spanDays = rate ? rate.spanDays : 0;
    // A day only reaches `accounted` without being `logged` by honouring a
    // declared fast, and a fast's real kcal total is 0 by definition — so an
    // accounted-but-unlogged row always contributes 0 here, never a guess.
    const intakes = accounted.map((r) => (r.logged ? r.kcal : 0)).filter(Number.isFinite);
    const intakeAvg = mean(intakes);
    const medianIntake = median(intakes);
    const completionRatios = logged.map((r) => {
      const goal = Number(r.goals && r.goals.kcal);
      return Number.isFinite(r.kcal) && Number.isFinite(goal) && goal > 0 ? r.kcal / goal : null;
    }).filter(Number.isFinite);
    const completionRatio = median(completionRatios);
    const oneItemLowDays = logged.filter((row) => {
      const goal = Number(row.goals && row.goals.kcal);
      return row.itemCount <= 1 && Number.isFinite(goal) && goal > 0 && row.kcal < goal * 0.75;
    }).length;
    const oneItemLowShare = logged.length ? oneItemLowDays / logged.length : 0;
    const partial = partialDays(rows, o);

    const base = {
      tdee: null, marginKcal: null, intervalLow: null, intervalHigh: null,
      intakeAvg, medianIntake, completionRatio,
      kgPerWeek: rate ? rate.kgPerWeek : null,
      loggedDays: logged.length,
      fastedDays: accounted.filter((d) => d.intent === "fast" && !(d.kcal > 0)).length,
      rangeDays, coverage, weighIns, spanDays,
      fitR2: rate ? rate.r2 : null,
      fitRmseKg: rate ? rate.rmseKg : null,
      partialLogDays: partial.flagged.length,
      oneItemLowDays,
      oneItemLowShare,
      confidence: "none", actionable: false, reason: "", actionReason: "",
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
        reason: `Only ${Math.round(coverage * 100)}% of days are accounted for (logged or declared fast) — needs 50%+ to be meaningful.`,
      };
    }

    const tdee = intakeAvg - rate.kgPerDay * kcalPerKg;
    // Combine uncertainty in mean intake with uncertainty in the weight slope.
    // This is an approximate 95% band, but materially more honest than showing
    // only the regression term when intake itself swings widely.
    const intakeSe = intakes.length > 1 ? (stdev(intakes) || 0) / Math.sqrt(intakes.length) : 0;
    const slopeKcalSe = (rate.seKgPerDay || 0) * kcalPerKg;
    const modeledMargin = 1.96 * Math.sqrt(intakeSe * intakeSe + slopeKcalSe * slopeKcalSe);
    const margin = Math.max(MIN_TDEE_MARGIN_KCAL, modeledMargin);
    const intervalLow = Number.isFinite(margin) ? tdee - margin : null;
    const intervalHigh = Number.isFinite(margin) ? tdee + margin : null;

    let sampleConfidence = "low";
    if (spanDays >= 21 && weighIns >= 10 && coverage >= 0.8) sampleConfidence = "high";
    else if (spanDays >= 14 && weighIns >= 6 && coverage >= 0.65) sampleConfidence = "medium";

    const minPlausibleIntake = Number.isFinite(o.minPlausibleIntakeKcal)
      ? o.minPlausibleIntakeKcal : 800;
    const minCompletionRatio = Number.isFinite(o.minCompletionRatio)
      ? o.minCompletionRatio : 0.65;
    const intakePlausible = Number.isFinite(medianIntake) && medianIntake >= minPlausibleIntake &&
      (completionRatio == null || completionRatio >= minCompletionRatio) && oneItemLowShare < 0.5;
    const fitPlausible = Number.isFinite(rate.rmseKg) && rate.rmseKg <= (o.maxFitRmseKg || 0.75);
    const ratePlausible = Math.abs(rate.kgPerWeek) <= (o.maxAbsKgPerWeek || 1.5);
    const minPlausibleTdee = Number.isFinite(o.minPlausibleTdeeKcal)
      ? o.minPlausibleTdeeKcal : MIN_AUTOMATED_KCAL;
    const maxPlausibleTdee = Number.isFinite(o.maxPlausibleTdeeKcal)
      ? o.maxPlausibleTdeeKcal : MAX_AUTOMATED_KCAL;
    const estimatePlausible = Number.isFinite(tdee) &&
      tdee >= minPlausibleTdee && tdee <= maxPlausibleTdee &&
      Number.isFinite(intervalLow) && intervalLow >= 1000 &&
      Number.isFinite(intervalHigh) && intervalHigh <= MAX_AUTOMATED_KCAL;
    const marginPlausible = Number.isFinite(margin) && margin <= (o.maxActionMarginKcal || 400);
    const actionProblems = [];
    if (sampleConfidence === "low") actionProblems.push("needs a stronger span of complete food logs and weigh-ins");
    if (!intakePlausible) {
      actionProblems.push("logged intake looks too incomplete to drive an automated target");
    }
    if (oneItemLowShare >= 0.5) {
      actionProblems.push("most days contain only one low-calorie item and are likely partial logs");
    }
    if (!fitPlausible) actionProblems.push("weight readings do not fit a stable enough trend");
    if (!ratePlausible) actionProblems.push("the inferred weight-change rate is outside the supported range");
    if (!estimatePlausible) actionProblems.push("the expenditure estimate is outside the supported range");
    if (!marginPlausible) actionProblems.push("the uncertainty range is too wide");
    if (partial.flagged.length) {
      actionProblems.push(`${partial.flagged.length} unusually low-intake day(s) may be incomplete`);
    }

    const actionable = actionProblems.length === 0;
    const confidence = actionable ? sampleConfidence : "low";

    return {
      ...base,
      tdee,
      marginKcal: Number.isFinite(margin) ? margin : null,
      intervalLow,
      intervalHigh,
      kgPerWeek: rate.kgPerWeek,
      fitR2: rate.r2,
      fitRmseKg: rate.rmseKg,
      confidence,
      actionable,
      intakePlausible,
      reason: "",
      actionReason: actionProblems.join("; "),
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
    // Mark-incomplete days leave the scored calendar (not hits, not misses).
    const rows = (days || []).filter((d) => !d.excluded);
    // A declared fast counts toward consistency the same as a logged day —
    // `accounted`, not `logged`, is what "did you account for this day"
    // means throughout this function. `logged` stays reserved for "has
    // food", which is a different question every other caller of that field
    // still means.
    const scored = rows.filter((d) => !(todayKey && d.day === todayKey && !d.accounted));
    const accounted = scored.filter((d) => d.accounted);

    let current = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (todayKey && rows[i].day === todayKey && !rows[i].accounted) continue; // grace for today
      if (rows[i].accounted) current += 1;
      else break;
    }
    let longest = 0, run = 0;
    for (const d of rows) {
      if (d.accounted) { run += 1; longest = Math.max(longest, run); }
      else if (!(todayKey && d.day === todayKey)) run = 0;
    }

    const weekdays = scored.filter((d) => !d.weekend);
    const weekends = scored.filter((d) => d.weekend);
    const rate = (list) => (list.length ? list.filter((d) => d.accounted).length / list.length : null);

    return {
      loggedDays: accounted.length,
      totalDays: scored.length,
      rate: scored.length ? accounted.length / scored.length : 0,
      currentStreak: current,
      longestStreak: longest,
      weekdayRate: rate(weekdays),
      weekendRate: rate(weekends),
      missedDays: scored.filter((d) => !d.accounted).map((d) => d.day),
      // Honoured fasts within `accounted`. A zero-kcal item (black coffee)
      // still counts as fasted — `d.logged` alone can't tell that apart from
      // eating, so this checks the same signal effectiveGoals does: whether
      // any calories were actually recorded. A fast that recorded real kcal
      // reverted to an ordinary day and is not counted here.
      fastedDays: accounted.filter((d) => d.intent === "fast" && !(d.kcal > 0)).length,
    };
  }

  /**
   * How much each target contributes to the score.
   *
   * A flat average across the seven tracked nutrients is the obvious choice and the wrong
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
    // Exactly one 0.10 mineral-completeness slot. Joint-covered days require
    // sodium, potassium, and their paired ratio. Otherwise both independently
    // complete absolute minerals are required; incomplete days are skipped.
    naK: 0.10,
    carbs: 0.05,    // largely implied once calories and protein land
    fat: 0.05,
  };

  /** Non-mineral nutrients scored directly; minerals are one composite below. */
  const SCORED_KEYS = ["kcal", "protein", "carbs", "fat", "fiber"];
  /** Nutrients that count toward Intake Overall day hit-rate. */
  const OVERALL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium", "potassium"];
  const OVERALL_HIT = 0.8;
  const OVERALL_MID = 0.5;
  const OVERALL_GOAL_PCT = 80;

  /**
   * Share of scored nutrients that landed in-band for one day.
   * Heatmap / Overall trend paint from the same bands as the dock (80% / 50%).
   */
  function dayTargetHitRate(day, scoreDay) {
    const empty = { rate: null, pct: null, hit: 0, n: 0, status: "empty", goal: OVERALL_GOAL_PCT };
    if (!day) return empty;
    const honouredFast = day.intent === "fast" && day.accounted && !(day.kcal > 0);
    if (honouredFast) {
      return { rate: null, pct: null, hit: 0, n: 0, status: "fast", goal: OVERALL_GOAL_PCT };
    }
    if (!day.logged || typeof scoreDay !== "function") {
      return { ...empty, status: day.logged ? "logged" : "empty" };
    }
    const s = scoreDay(toTotalsLike(day), day.goals || {});
    if (!s) return { ...empty, status: "logged" };

    let hit = 0;
    let n = 0;
    for (const k of OVERALL_KEYS) {
      const cell = s[k];
      if (!cell) continue;
      const st = cell.status;
      if (st === "hit" || st === "under" || st === "over") {
        n += 1;
        if (st === "hit") hit += 1;
      }
    }
    if (!n) return { ...empty, status: "logged" };
    const rate = hit / n;
    const pct = rate * 100;
    let status = "over";
    if (rate >= OVERALL_HIT) status = "hit";
    else if (rate >= OVERALL_MID) status = "under";
    return { rate, pct, hit, n, status, goal: OVERALL_GOAL_PCT };
  }

  // A hit rate built on one or two real days is not evidence — the same bar
  // biggestGap already holds a nutrient to before naming it "the problem".
  // Reused here so a weighted row cannot carry the targets component on
  // n:1 while nine declared-plan exemptions ride along for free on the 30%
  // consistency component (Part X.1): below this many scored days, the row
  // still discloses (n and exemptN both render), it just earns no weight.
  const MIN_SCORED_DAYS = 3;

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
      for (const k of SCORED_KEYS) {
        tally[k] = { hit: 0, n: 0, exempt: 0 };
      }
      const mineralHandling = {
        hit: 0, n: 0, exempt: 0, jointN: 0, absoluteN: 0,
        ratioHits: 0, sodiumHits: 0, potassiumHits: 0,
      };
      const todayKey = opts && opts.todayKey;
      const targetRows = completeLoggedRows(days).filter((d) => !(todayKey && d.day === todayKey));
      for (const d of targetRows) {
        const s = scoreDay(toTotalsLike(d), d.goals || {});
        if (!s) continue;
        const goals = d.goals || {};
        const enabled = (key, fallback) => {
          const raw = goals[key] ?? fallback;
          const value = Number(raw);
          return Number.isFinite(value) && value > 0;
        };
        const ratioEnabled = enabled("naK", 1.0);
        const sodiumEnabled = enabled("sodium", null);
        const potassiumEnabled = enabled("potassium", null);
        const ratioCell = ratioEnabled && s.naK && s.naK.status !== "skip" ? s.naK : null;
        const sodiumCell = sodiumEnabled && s.sodium && s.sodium.status !== "skip" ? s.sodium : null;
        const potassiumCell = potassiumEnabled && s.potassium && s.potassium.status !== "skip" ? s.potassium : null;
        const enabledAbsolutes = [
          sodiumEnabled ? sodiumCell : undefined,
          potassiumEnabled ? potassiumCell : undefined,
        ].filter((cell) => cell !== undefined);
        const absolutesUsable = enabledAbsolutes.length > 0 && enabledAbsolutes.every(Boolean);

        // A jointly covered day can enforce the ratio plus whichever absolute
        // constraints are enabled. A zero goal is disabled, not a required
        // cell that can only ever miss. Without a usable ratio, fall back to
        // the enabled absolute constraints only when all of them are covered.
        if (ratioCell) {
          if (!enabledAbsolutes.every(Boolean)) continue;
          mineralHandling.n += 1;
          mineralHandling.jointN += 1;
          if (ratioCell.status === "hit") mineralHandling.ratioHits += 1;
          if (sodiumCell && sodiumCell.status === "hit") mineralHandling.sodiumHits += 1;
          if (potassiumCell && potassiumCell.status === "hit") mineralHandling.potassiumHits += 1;
          if (ratioCell.status === "hit" && enabledAbsolutes.every((cell) => cell.status === "hit")) {
            mineralHandling.hit += 1;
          }
        } else if (absolutesUsable) {
          mineralHandling.n += 1;
          mineralHandling.absoluteN += 1;
          if (sodiumCell && sodiumCell.status === "hit") mineralHandling.sodiumHits += 1;
          if (potassiumCell && potassiumCell.status === "hit") mineralHandling.potassiumHits += 1;
          if (enabledAbsolutes.every((cell) => cell.status === "hit")) mineralHandling.hit += 1;
        } else if (s.naK && s.naK.exemptByPlan) {
          // Same disclosure as the per-key tally above: a fast unscores the
          // whole mineral slot, and that is a different fact from a day that
          // simply lacks sodium/potassium coverage — exemptByPlan carries the
          // plan fact even when coverage would have skipped the cell anyway
          // (a real fast has near-zero mineral coverage by nature), so it is
          // what disclosure counts off, never skipReason (Part VIII.4).
          mineralHandling.exempt += 1;
        }
        for (const k of Object.keys(tally)) {
          const cell = s[k];
          if (!cell) continue;
          if (cell.status === "skip") {
            // A plan exemption and a missing-coverage skip are different facts
            // — only the former is disclosed to the user at declaration time,
            // so only the former is worth naming in the score breakdown.
            if (cell.exemptByPlan) tally[k].exempt += 1;
            continue;
          }
          tally[k].n += 1;
          if (cell.status === "hit") tally[k].hit += 1;
        }
      }
      let acc = 0, wsum = 0;
      for (const k of Object.keys(tally)) {
        const t = tally[k];
        // A range where a target was exempt every day still gets a visible row
        // — disappearing silently is exactly the "guesswork you can't inspect"
        // the score breakdown exists to avoid. It just never earns weight.
        if (!t.n && !t.exempt) continue; // no goal set for this nutrient in this range
        const w = SCORE_WEIGHTS[k] || 0;
        // A row with no scored days has no hit rate — 0 would be
        // indistinguishable from "missed every day", the exact suspicion the
        // exemption disclosure exists to prevent (Part VII.7).
        const hitRate = t.n ? t.hit / t.n : null;
        const row = { key: k, label: LABEL[k], weight: w, hitRate, hit: t.hit, n: t.n };
        if (t.exempt) row.exemptN = t.exempt;
        nutrients.push(row);
        // Below MIN_SCORED_DAYS the row still discloses (n and exemptN both
        // render above) but does not carry the targets component — a hit
        // rate on 1-2 real days is not enough evidence to grade on, and
        // letting it through is exactly how a mostly-exempt range reaches an
        // unearned 100 (Part X.1).
        if (t.n >= MIN_SCORED_DAYS) {
          acc += hitRate * w;
          wsum += w;
        }
      }
      if (mineralHandling.n || mineralHandling.exempt) {
        const hitRate = mineralHandling.n ? mineralHandling.hit / mineralHandling.n : null;
        const w = SCORE_WEIGHTS.naK;
        const row = {
          key: "naK",
          label: "Mineral balance",
          mode: mineralHandling.jointN && mineralHandling.absoluteN ? "mixed" : (mineralHandling.jointN ? "joint" : "absolute"),
          ratioN: mineralHandling.jointN,
          sodiumN: mineralHandling.absoluteN,
          ratioHits: mineralHandling.ratioHits,
          absoluteSodiumHits: mineralHandling.sodiumHits,
          potassiumHits: mineralHandling.potassiumHits,
          weight: w,
          hitRate,
          hit: mineralHandling.hit,
          n: mineralHandling.n,
        };
        if (mineralHandling.exempt) row.exemptN = mineralHandling.exempt;
        nutrients.push(row);
        if (mineralHandling.n >= MIN_SCORED_DAYS) {
          acc += hitRate * w;
          wsum += w;
        }
      }
      targets = wsum ? acc / wsum : null;
    }

    const parts = { consistency: cons.rate, targets, nutrients };
    const weights = { consistency: 0.30, targets: 0.70 };
    // An all-exempt range has zero scored targets — every nutrient cell was a
    // declared plan exemption, never a hit. Simply dropping `targets` out of
    // the weighted mean would let consistency alone report a perfect score;
    // an unjustified perfect is exactly as dishonest as an unjustified miss,
    // so the grade is suppressed rather than computed on nothing.
    const hasExemptRows = nutrients.some((n) => n.exemptN);
    let acc = 0, wsum = 0;
    if (!(targets == null && hasExemptRows)) {
      for (const k of Object.keys(weights)) {
        if (parts[k] == null) continue;
        acc += parts[k] * weights[k];
        wsum += weights[k];
      }
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
    const minDays = (opts && opts.minDays) || MIN_SCORED_DAYS;
    // A row with n === 0 (exempt every day, e.g. protein on an all-low-kcal
    // range) has no scored days and therefore no hit rate — it cannot be the
    // thing costing the score the most, so it is excluded outright rather
    // than relying on minDays to happen to filter it out.
    const ranked = (nutrients || [])
      .filter((n) => n.n > 0 && n.n >= minDays && n.hitRate < 0.8)
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
      na: { mean: Number.isFinite(row.sodium) ? row.sodium : 0 },
      naCoverage: Number.isFinite(row.naCoverage) ? row.naCoverage : 0,
      naItems: row.naItems || 0,
      k: { mean: row.potassium == null ? 0 : row.potassium },
      kCoverage: row.kCoverage || 0,
      kItems: row.kItems || 0,
      naKNa: { mean: Number.isFinite(row.pairedSodium) ? row.pairedSodium : 0 },
      naKK: { mean: Number.isFinite(row.pairedPotassium) ? row.pairedPotassium : 0 },
      naKCoverage: row.naKCoverage || 0,
      naKItems: row.naKItems || 0,
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
        const exemptDays = typeof Phases !== "undefined" && key !== "overall"
          ? logged.filter((r) => {
              const resolved = Phases.effectiveGoals(toTotalsLike(r), r.goals || {});
              return !!(resolved && resolved._unscored && resolved._unscored[key]);
            }).length
          : 0;
        const overallVals = key === "overall"
          ? logged.map((r) => (r.overallHit && r.overallHit.pct)).filter(Number.isFinite)
          : null;
        return {
          weekStart: ws,
          endDay: end,
          label: `${shortDate(ws)}`,
          rangeLabel: `${shortDate(rows[0].day)} – ${shortDate(end)}`,
          days: rows.length,
          loggedDays: logged.length,
          exemptDays,
          value: key === "overall"
            ? mean(overallVals)
            : mean(logged.map((r) => r[key])),
          goal: key === "overall"
            ? OVERALL_GOAL_PCT
            : mean(rows.map((r) => (key === "kcal" ? phaseKcalOf(r) : (r.goals || {})[key]))),
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
      const match = completeLoggedRows(days).filter((d) => d.dow === dow);
      const all = (days || []).filter((d) => d.dow === dow);
      rows.push({
        dow,
        label: DOW_LABEL[dow],
        weekend: dow === 0 || dow === 6,
        n: match.length,
        totalDays: all.length,
        avg: mean(match.map((d) => d[key])),
        goal: mean(all.map((d) => (key === "kcal" ? phaseKcalOf(d) : (d.goals || {})[key]))),
      });
    }
    // Monday-first reads better next to the weekly rollup.
    return rows.slice(1).concat(rows.slice(0, 1));
  }

  /** Largest weekday↔weekend gap worth mentioning, or null. */
  function weekendEffect(days, key) {
    const logged = completeLoggedRows(days);
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
    const logged = completeLoggedRows(days);
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
   * @param {string} metric one of kcal | protein | sodium | potassium | fiber
   */
  function topFoods(keys, entriesForDay, metric, limit) {
    const field = { kcal: "kcal", protein: "p", sodium: "na", potassium: "k", fiber: "fb", carbs: "c", fat: "f" }[metric] || "kcal";
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

  /**
   * Aggregate named meals for a nutrient across the range.
   * peak = max single log; days[] = per-day max (one pill per day).
   */
  function foodNutrientAgg(keys, entriesForDay, metric) {
    const field = { kcal: "kcal", protein: "p", sodium: "na", potassium: "k", fiber: "fb", carbs: "c", fat: "f" }[metric] || "kcal";
    const agg = new Map();
    for (const day of keys || []) {
      for (const e of entriesForDay(day) || []) {
        const v = (e.macros && e.macros[field]) || 0;
        if (!v) continue;
        const name = e.name || "";
        if (!name) continue;
        let cur = agg.get(name);
        if (!cur) {
          cur = {
            name,
            peak: v,
            peakDay: day,
            peakSource: e.source || "",
            count: 0,
            total: 0,
            dayMax: Object.create(null),
            daySource: Object.create(null),
          };
          agg.set(name, cur);
        }
        cur.count += 1;
        cur.total += v;
        const prevDay = cur.dayMax[day] || 0;
        if (v >= prevDay) {
          cur.dayMax[day] = v;
          cur.daySource[day] = e.source || "";
        }
        if (v > cur.peak || (v === cur.peak && day > cur.peakDay)) {
          cur.peak = v;
          cur.peakDay = day;
          cur.peakSource = e.source || "";
        }
      }
    }
    return [...agg.values()].map((r) => {
      const days = Object.keys(r.dayMax)
        .map((day) => ({
          day,
          value: r.dayMax[day],
          source: r.daySource[day] || "",
        }))
        .sort((a, b) => b.value - a.value || (a.day < b.day ? 1 : -1));
      return {
        name: r.name,
        peak: r.peak,
        peakDay: r.peakDay,
        peakSource: r.peakSource,
        count: r.count,
        total: r.total,
        value: r.peak,
        days,
      };
    });
  }

  /**
   * Rank foods by biggest single log line for the nutrient (not range sum).
   * Ties break toward the more recent peak day. value aliases peak for bar width.
   */
  function topFoodPeaks(keys, entriesForDay, metric, limit) {
    return foodNutrientAgg(keys, entriesForDay, metric)
      .sort((a, b) => b.peak - a.peak || (b.peakDay > a.peakDay ? 1 : -1))
      .slice(0, limit || 5);
  }

  /** Protein relative to body weight — the form the evidence is actually in. */
  function proteinPerKg(days) {
    const logged = completeLoggedRows(days);
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
  function heatmapCells(days, key, scoreDay, opts) {
    const excludeDay = opts && (opts.excludeDay || opts.todayKey);
    if (key === "overall") {
      return (days || []).map((d) => {
        const hr = (d.overallHit && typeof d.overallHit === "object")
          ? d.overallHit
          : dayTargetHitRate(d, scoreDay);
        const honouredFast = hr.status === "fast";
        const fasted = d.intent === "fast";
        let status = hr.status || "empty";
        if (excludeDay && d.day === excludeDay && d.logged && status !== "fast") {
          status = "logged";
        }
        return {
          day: d.day,
          dow: d.dow,
          weekStart: weekStart(d.day),
          logged: d.logged,
          intent: d.intent || null,
          accounted: !!d.accounted,
          fasted,
          value: Number.isFinite(hr.pct) ? hr.pct : null,
          goal: OVERALL_GOAL_PCT,
          ratio: hr.rate,
          hit: hr.hit,
          n: hr.n,
          status: honouredFast ? "fast" : status,
        };
      });
    }
    return (days || []).map((d) => {
      const goal = (d.goals || {})[key] || 0;
      const value = d[key];
      let status = "empty";
      let ratio = null;
      // An honoured fast with no calories uses status "fast". A declared fast
      // that recorded food keeps its marker for display/audit (§11) while still
      // grading against phase targets — `fasted` is the declaration flag, and
      // status holds the ordinary grade.
      const honouredFast = d.intent === "fast" && d.accounted && !(d.kcal > 0);
      const fasted = d.intent === "fast";
      if (honouredFast) {
        status = "fast";
      } else if (d.logged && Number.isFinite(value)) {
        ratio = goal ? value / goal : null;
        if (excludeDay && d.day === excludeDay) {
          // Keep the activity visible without grading an in-progress day.
          status = "logged";
        } else if (typeof scoreDay === "function") {
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
        intent: d.intent || null,
        accounted: !!d.accounted,
        fasted,
        value,
        goal,
        ratio,
        status,
      };
    });
  }

  /**
   * Phase calorie reference for a day row — `_phase.kcal` when a plan froze
   * a baseline, otherwise the resolved kcal. Used wherever Insights averages
   * a "typical target" so a declared fast's 0 cannot drag the comparison.
   */
  function phaseKcalOf(dayOrGoals) {
    const g = dayOrGoals && dayOrGoals.goals ? dayOrGoals.goals : dayOrGoals;
    if (!g || typeof g !== "object") return null;
    const phase = g._phase && Number(g._phase.kcal);
    if (Number.isFinite(phase)) return phase;
    const kcal = Number(g.kcal);
    return Number.isFinite(kcal) ? kcal : null;
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
    const logged = completeLoggedRows(days).filter((d) => Number.isFinite(d[key]));
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
    const pick = (d) => (key === "overall"
      ? (d.overallHit && Number.isFinite(d.overallHit.pct) ? d.overallHit.pct : null)
      : d[key]);
    const recent = completeLoggedRows(rows.slice(-w));
    const prior = completeLoggedRows(rows.slice(-2 * w, -w));
    if (recent.length < 2 || prior.length < 2) return null;
    const a = mean(prior.map(pick).filter(Number.isFinite));
    const b = mean(recent.map(pick).filter(Number.isFinite));
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
   * @returns {Array<{id, tone, text, priority?, panel?}>}
   *   tone: info | watch | good
   *   priority: lower sorts first (honesty notes are 0)
   *   panel: optional `#id` of the owning Insights panel for jump navigation
   */
  function observations(days, opts) {
    const o = opts || {};
    const out = [];
    const logged = loggedRows(days);
    const accounted = accountedRows(days);
    // An all-fast range has nothing "logged" but still has testimony — do not
    // bail before the fasts observation below can speak.
    if (!logged.length && !accounted.length) return out;

    const excluded = (days || []).filter((d) => d.excluded);
    if (excluded.length) {
      const n = excluded.length;
      out.push({
        id: "excluded-days",
        tone: "info",
        priority: 0,
        text: `${n} day${n === 1 ? " is" : "s are"} marked incomplete and left out of averages and TDEE.`,
      });
    }

    const cons = consistency(days, o);
    if (logged.length && cons.totalDays >= 7 && cons.rate < 0.6) {
      out.push({
        id: "coverage",
        tone: "info",
        priority: 10,
        panel: "#insight-heatmap",
        text: `${cons.loggedDays} of ${cons.totalDays} days accounted for. Averages below are drawn from logged eating days only.`,
      });
    }
    if (logged.length && cons.weekdayRate != null && cons.weekendRate != null && cons.weekdayRate - cons.weekendRate >= 0.3) {
      out.push({
        id: "weekend-logging",
        tone: "info",
        priority: 20,
        panel: "#insight-heatmap",
        text: `Weekends are logged less often (${Math.round(cons.weekendRate * 100)}% vs ${Math.round(cons.weekdayRate * 100)}% on weekdays), so the averages lean weekday.`,
      });
    }

    const we = logged.length ? weekendEffect(days, "kcal") : null;
    if (we && we.notable) {
      const dir = we.delta > 0 ? "higher" : "lower";
      out.push({
        id: "weekend-kcal",
        tone: "watch",
        priority: 30,
        panel: "#intake-stats",
        // Keep the magnitude here (kcal-locked). The chronological trend is
        // the place to inspect weekend spikes after Day of week was retired.
        text: `Weekend calories run ${Math.abs(Math.round(we.delta))} kcal ${dir} than weekdays.`,
      });
    }

    const kcalStats = summaryStats(days, "kcal");
    if (kcalStats.n >= 7 && kcalStats.cv != null && kcalStats.cv >= 0.25) {
      out.push({
        id: "variability",
        tone: "info",
        priority: 40,
        panel: "#intake-stats",
        // Keep ±sd kcal here; Typical swing owns the same figure when the
        // dock is on Kcal, and this note stays self-sufficient otherwise.
        text: `Daily calories swing a lot (±${Math.round(kcalStats.sd)} kcal). Weekly view is the steadier read.`,
      });
    }

    const mom = logged.length ? momentum(days, "kcal", 7) : null;
    if (mom && Math.abs(mom.pct || 0) >= 0.08) {
      const dir = mom.delta > 0 ? "up" : "down";
      out.push({
        id: "momentum",
        tone: "info",
        priority: 50,
        panel: "#intake-stats",
        text: `Last 7 logged days are ${dir} ${Math.abs(Math.round(mom.delta))} kcal/day vs the week before.`,
      });
    }

    const partial = partialDays(days, opts);
    if (partial.flagged.length) {
      const n = partial.flagged.length;
      const adj = partial.adjustedAvg != null
        ? ` Without them the average is ${Math.round(partial.adjustedAvg)} kcal instead of ${Math.round(partial.avg)}.`
        : "";
      out.push({
        id: "partial-days",
        tone: "info",
        priority: 0,
        text: `${n} day${n === 1 ? "" : "s"} logged under ${Math.round(partial.threshold)} kcal with one or two items — possibly unfinished logs rather than light days. They are still counted.${adj}`,
      });
    }

    // Design Phase 3: honesty note for macro-incomplete days (scoring).
    // Jump opens the first incomplete day.
    const incompleteMacro = logged.filter((d) => d.macrosCovered === false);
    if (incompleteMacro.length) {
      const n = incompleteMacro.length;
      out.push({
        id: "macro-incomplete",
        tone: "info",
        priority: 0,
        panel: "#today-day-detail",
        jumpDay: incompleteMacro[0].day,
        text: `${n} day${n === 1 ? " has" : "s have"} calories without complete macros; those macros are not scored.`,
      });
    }

    const bumps = dayPlanAudit(days, opts);
    if (bumps.total) {
      const late = bumps.declaredLate
        ? ` ${bumps.declaredLate} ${bumps.declaredLate === 1 ? "was" : "were"} set after logging began.`
        : "";
      const unlogged = bumps.unlogged
        ? ` ${bumps.unlogged} planned day${bumps.unlogged === 1 ? "" : "s"} recorded no food, so there is nothing to compare the plan against.`
        : "";
      const legacy = bumps.legacy
        ? ` Planning provenance is unknown for ${bumps.legacy} legacy ${bumps.legacy === 1 ? "record" : "records"}.`
        : "";
      out.push({
        id: "bumps",
        // Unlogged and legacy (no usable plannedAt) are disclosures, not
        // integrity alarms. Only a plan set after logging began escalates.
        tone: bumps.declaredLate ? "watch" : "info",
        priority: 0,
        text: `${bumps.total} day${bumps.total === 1 ? "" : "s"} used a day status calorie override, so ${bumps.total === 1 ? "it is" : "they are"} scored against the adjusted calorie target.${late}${unlogged}${legacy}`,
      });
    }
    if (bumps.fasts) {
      const late = bumps.fastsDeclaredAfterDay;
      const lateText = late
        ? ` ${late} of these were declared after the day ended.`
        : "";
      const reverted = (bumps.fastDays || []).filter((f) => f.logged).length;
      const revertedText = reverted
        ? ` ${reverted} declared fast day${reverted === 1 ? "" : "s"} recorded food and ${reverted === 1 ? "is" : "are"} counted as ordinary day${reverted === 1 ? "" : "s"}.`
        : "";
      out.push({
        id: "fasts",
        // A late declaration is reported, not punished — it still buys
        // nothing but streak credit. The tone only shifts once it stops
        // being the exception: more than half the fasts in range declared
        // after the fact is worth a second look.
        tone: late * 2 > bumps.fasts ? "watch" : "info",
        priority: 0,
        text: `${bumps.fasts} declared fast${bumps.fasts === 1 ? "" : "s"} in this range.${lateText}${revertedText}`,
      });
    }

    return out;
  }

  // -------------------------------------------------------- data honesty

  /**
   * Days that look like a forgotten log rather than a day of eating.
   *
   * A day holding one 250 kcal entry drags every average down and quietly
   * distorts the TDEE estimate, which assumes logged intake is complete. A
   * declared day (fast or reduced) is no longer a candidate at all: the
   * declaration is timestamped user testimony about that exact day, made
   * before the food was logged, so flagging it anyway is the app arguing
   * with a plan it already accepted. Everything left is undeclared, so it
   * only ever *flags*: the days stay in every calculation, and the
   * counterfactual average is offered beside the real one rather than
   * replacing it. Silently discarding someone's data because it looks odd is
   * worse than showing an average they can judge.
   *
   * Thresholds are relative to the person's own median, not an absolute
   * calorie floor, so a 1,400 kcal eater is not permanently flagged.
   */
  function partialDays(days, opts) {
    const o = opts || {};
    const ratio = o.ratio || 0.4;
    const maxItems = o.maxItems || 2;
    const excludeDay = o.excludeDay || o.todayKey || null;
    const logged = loggedRows(days).filter((d) => !(excludeDay && d.day === excludeDay) && !d.intent);
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

  /**
   * Days in range that contain one-off / quick-kcal entries, and what share of
   * those days' calories they account for. Disclosure only — never exclude.
   *
   * @param {string[]} keys day keys in range
   * @param {(day: string) => object[]} entriesForDay
   * @param {{ excludeDay?: string|null }} [opts]
   *   Optional day to omit (caller-chosen). Do not pass Insights `todayKey` by
   *   default — unlike partialDays, once/quick disclosure should include today.
   */
  function onceDays(keys, entriesForDay, opts) {
    const empty = { days: [], n: 0, onceKcal: 0, dayKcal: 0, share: null };
    if (!keys || !keys.length || typeof entriesForDay !== "function") return empty;
    const o = opts || {};
    const skipDay = o.excludeDay || null;
    const days = [];
    let onceKcal = 0;
    let dayKcal = 0;
    for (const day of keys) {
      if (skipDay && day === skipDay) continue;
      const entries = entriesForDay(day) || [];
      const once = entries.filter((e) => e && (e.source === "once" || e.source === "quick"));
      if (!once.length) continue;
      const oK = once.reduce((s, e) => s + (Number(e.macros && e.macros.kcal) || 0), 0);
      const dK = entries.reduce((s, e) => s + (Number(e.macros && e.macros.kcal) || 0), 0);
      days.push({
        day,
        onceKcal: oK,
        dayKcal: dK,
        share: dK > 0 ? oK / dK : null,
        n: once.length,
      });
      onceKcal += oK;
      dayKcal += dK;
    }
    return {
      days,
      n: days.length,
      onceKcal,
      dayKcal,
      share: dayKcal > 0 ? onceKcal / dayKcal : null,
    };
  }

  /**
   * Single definition of day-plan provenance for reduced plans and fasts.
   *
   * Precedence:
   *   1. persisted declaredAfterDay === true → "declaredLate" (fast testimony),
   *      unless optional `day` + usable plannedAt prove the stamp is false
   *      (advance declare mis-stamps — fall through to derive)
   *   2. plannedAt vs firstAddAt → "planned" | "declaredLate"
   *      (plannedAt <= firstAddAt counts as planned; equality is not late)
   *   3. plannedAt present, no firstAddAt:
   *        intent === "fast" → "planned" (empty day is expected for a fast)
   *        otherwise → "unlogged" (modern reduced plan, nothing to compare)
   *   4. no usable plannedAt → "legacy"
   *
   * Only bump.plannedAt participates in the derived compare. updatedAt is a
   * mutation clock — heal/sync can rewrite it to the first-add timestamp —
   * and must not decide lateness. Non-positive timestamps are absent
   * (Phases.dayPlanForDay writes plannedAt: 0 when the stored record has none);
   * callers must not pass goals._dayPlan expecting that placeholder to classify
   * as a real plan time. firstAddAt: 0 is treated the same way (absent).
   *
   * Accepts `{ dayPlan, firstAddAt?, intent?, day? }`. `dayPlan` must be present
   * as an own property (may be null → `"legacy"`). No duck-typing of wrapper
   * vs record, and no legacy plan-opt aliases on `buildDays`.
   * `declaredAfterDay` is read only from the plan record, not from the wrapper.
   *
   * @returns {"planned"|"declaredLate"|"unlogged"|"legacy"}
   */
  function dayPlanProvenance(row) {
    const r = row || {};
    if (!Object.prototype.hasOwnProperty.call(r, "dayPlan")) return "legacy";
    const bump = r.dayPlan;
    if (!bump || typeof bump !== "object") return "legacy";
    // Derive from plannedAt only. updatedAt is intentionally ignored (heal
    // can set it equal to firstAddAt and would falsify "late").
    const candidate = numOrNull(bump.plannedAt);
    // plannedAt: 0 is the dayPlanForDay placeholder for "missing", not epoch.
    const plannedAt = Number.isFinite(candidate) && candidate > 0 ? candidate : null;
    if (bump.declaredAfterDay === true) {
      const day = typeof r.day === "string" ? r.day : null;
      const stampDisproved = !!(day && plannedAt != null
        && typeof Phases !== "undefined"
        && typeof Phases.isDeclaredAfterDay === "function"
        && !Phases.isDeclaredAfterDay(day, plannedAt));
      if (!stampDisproved) return "declaredLate";
    }
    const firstAddRaw = numOrNull(r.firstAddAt);
    // Same placeholder rule as plannedAt: 0 is absent, not Unix epoch.
    const firstAdd = Number.isFinite(firstAddRaw) && firstAddRaw > 0 ? firstAddRaw : null;
    if (plannedAt != null && firstAdd != null) {
      return plannedAt <= firstAdd ? "planned" : "declaredLate";
    }
    if (plannedAt != null) {
      const intent = r.intent || bump.intent;
      // A declared fast with no food is the happy path, not a provenance gap.
      if (intent === "fast") return "planned";
      return "unlogged";
    }
    return "legacy";
  }

  /**
   * Which days had a one-day energy adjustment, and which were adjusted after
   * the fact. Old records may contain macro/electrolyte bump keys; only their
   * kcal delta remains effective or appears in this audit.
   *
   * An energy adjustment is legitimate — a planned refeed or a wedding can
   * genuinely have a different calorie target. Because it can convert an
   * "over" day into a "hit", recording planned versus late (declaredLate)
   * adjustments keeps the feature useful without making adherence self-marking.
   *
   * A fast is not an energy adjustment and is counted separately: its kcal
   * cell is exempt, not scored against a target of 0, so folding its
   * resolved delta (targetKcal − baseKcal, i.e. the whole phase target) into
   * `kcalTotal` would misreport an exemption as a deliberate multi-thousand
   * calorie cut. What is worth auditing for a fast is *when* it was
   * declared — a late declaration buys only streak credit, never a better
   * grade, so it is reported rather than folded into `declaredLate` on the
   * energy-adjustment side, which means something different (a target moved
   * after logging began). Both intents still classify through
   * `dayPlanProvenance`.
   */
  function dayPlanAudit(days, opts) {
    const excludeDay = opts && (opts.excludeDay || opts.todayKey);
    const rows = [];
    let declaredLate = 0;
    let planned = 0;
    let unlogged = 0;
    let legacy = 0;
    let kcalTotal = 0;
    const fastRows = [];
    let fastsDeclaredAfterDay = 0;
    for (const d of days || []) {
      if (excludeDay && d.day === excludeDay) continue;
      const b = d.dayPlan;
      if (!b) continue;
      const intent = d.goals && d.goals._dayPlan && d.goals._dayPlan.intent === "fast" ? "fast" : "reduced";
      if (intent === "fast") {
        const declaredAfterDay = b.declaredAfterDay === true;
        const provenance = dayPlanProvenance({
          dayPlan: b, firstAddAt: d.firstAddAt, intent: "fast", day: d.day,
        });
        if (declaredAfterDay) fastsDeclaredAfterDay += 1;
        fastRows.push({ day: d.day, provenance, declaredAfterDay, logged: d.logged });
        continue;
      }
      // Resolved goals carry the phase-aware delta even for the oldest
      // absolute `{kcal: ...}` dayGoal shape. Fall back to the raw modern bump
      // so callers that provide audit rows directly remain compatible.
      const resolvedKcal = d.goals && d.goals._dayPlan && d.goals._dayPlan.kcal;
      const rawKcal = b.bumps && b.bumps.kcal;
      const kcal = Number(resolvedKcal != null ? resolvedKcal : rawKcal);
      if (!Number.isFinite(kcal) || kcal === 0) continue;
      const provenance = dayPlanProvenance({
        dayPlan: b, firstAddAt: d.firstAddAt, intent: "reduced", day: d.day,
      });
      if (provenance === "declaredLate") declaredLate += 1;
      else if (provenance === "planned") planned += 1;
      else if (provenance === "unlogged") unlogged += 1;
      else legacy += 1;
      kcalTotal += kcal;
      rows.push({
        day: d.day,
        bumps: { kcal },
        declaredLate: provenance === "declaredLate",
        provenance,
        logged: d.logged,
      });
    }
    return {
      total: rows.length, declaredLate, planned, unlogged, legacy, kcalTotal, days: rows,
      fasts: fastRows.length, fastsDeclaredAfterDay, fastDays: fastRows,
    };
  }

  // ----------------------------------------------------------- comparison

  /**
   * Everything worth comparing about a stretch of days, in one object, so two
   * phases can be put side by side without recomputing each metric twice.
   */
  function rangeSummary(days, scoreDay, opts) {
    const logged = completeLoggedRows(days);
    const trend = trendWeight(days, opts);
    const rate = weightRate(trend);
    const score = nutritionScore(days, scoreDay, opts);
    return {
      days: days.length,
      loggedDays: logged.length,
      coverage: days.length ? logged.length / days.length : 0,
      kcalAvg: mean(logged.map((d) => d.kcal)),
      kcalGoal: mean(days.map((d) => phaseKcalOf(d))),
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
  function retargetForKcal(goals, newKcal, opts) {
    const g = { ...(goals || {}) };
    const rawKcal = Number(newKcal);
    if (!Number.isFinite(rawKcal) || rawKcal < MIN_AUTOMATED_KCAL || rawKcal > MAX_AUTOMATED_KCAL) {
      return null;
    }
    const kcal = Math.round(rawKcal / 10) * 10;
    const protein = Number(g.protein);
    if (!Number.isFinite(protein) || protein < 0) return null;
    const requestedFatFloor = Number(opts && opts.minFatGrams);
    const minFat = Number.isFinite(requestedFatFloor)
      ? Math.max(MIN_RETARGET_FAT_G, requestedFatFloor)
      : MIN_RETARGET_FAT_G;
    const proteinKcal = protein * 4;
    const protectedKcal = proteinKcal + minFat * 9;
    // Never manufacture an internally contradictory goal. The caller can ask
    // the person to choose more energy or explicitly revise protected protein.
    if (protectedKcal > kcal) return null;

    const available = kcal - protectedKcal;
    const curCarbKcal = Math.max(0, Number(g.carbs) || 0) * 4;
    const curExtraFatKcal = Math.max(0, (Number(g.fat) || 0) - minFat) * 9;
    const curTotal = curCarbKcal + curExtraFatKcal;
    const carbShare = curTotal > 0 ? curCarbKcal / curTotal : 0.55;

    // Search the small integer space so Atwater calories never exceed the
    // target and land within at most 3 kcal, while preserving the prior split
    // as closely as integer grams allow.
    let best = null;
    for (let extraFat = 0; extraFat <= Math.floor(available / 9); extraFat++) {
      const remaining = available - extraFat * 9;
      const carbs = Math.max(0, Math.floor(remaining / 4));
      const used = carbs * 4 + extraFat * 9;
      const gap = available - used;
      const share = available > 0 ? (carbs * 4) / available : carbShare;
      const splitError = Math.abs(share - carbShare);
      if (!best || gap < best.gap || (gap === best.gap && splitError < best.splitError)) {
        best = { carbs, fat: minFat + extraFat, gap, splitError };
      }
    }
    if (!best || best.gap > 3) return null;
    return {
      ...g,
      kcal,
      protein,
      carbs: best.carbs,
      fat: best.fat,
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

  /** "0.5 kg/wk" or "1.1 lb/wk" from a kg/week magnitude. */
  function formatWeeklyRate(kgPerWeek, unit) {
    const u = unit === "kg" ? "kg" : "lb";
    const n = kgToDisplay(Math.abs(Number(kgPerWeek)), u);
    if (n == null || !Number.isFinite(n) || n === 0) return null;
    const shown = n.toFixed(2).replace(/\.?0+$/, "");
    return shown + " " + u + "/wk";
  }

  return {
    KCAL_PER_KG, MIN_AUTOMATED_KCAL, MAX_AUTOMATED_KCAL, MIN_RETARGET_FAT_G,
    MIN_TDEE_MARGIN_KCAL,
    DOW_LABEL, MEALS, NUTRIENTS, TOTALS_KEY, UNIT, LABEL,
    dayKeyFromDate, dateOf, addDays, daysBetween, weekStart, shortDate,
    buildDays, loggedRows, accountedRows, completeRows, completeLoggedRows, toTotalsLike,
    mean, median, stdev, summaryStats, rollingMean, linearFit,
    trendWeight, weightRate, estimateTdee, intakeForRate, projectWeight,
    consistency, nutritionScore, gradeFor, biggestGap, SCORE_WEIGHTS,
    dayTargetHitRate, OVERALL_KEYS, OVERALL_HIT, OVERALL_MID, OVERALL_GOAL_PCT,
    weeklyRollup, byDayOfWeek, weekendEffect, macroSplit, byMeal, topFoods, foodNutrientAgg, topFoodPeaks,
    proteinPerKg, heatmapCells, heatmapWeeks, extremes, momentum, observations,
    phaseKcalOf,
    partialDays, onceDays, dayPlanAudit, dayPlanProvenance,
    rangeSummary, compareSummaries, retargetForKcal,
    fmtNum, fmtSigned, kgToDisplay, formatWeeklyRate,
  };
})();

if (typeof module !== "undefined") module.exports = Analytics;
