/* NutriDaily analytics tests — run with: node tests/test-analytics.js
 * Covers the derived layer: trend weight, adaptive TDEE, rollups, consistency,
 * scoring, breakdowns. Everything here is pure, so fixtures are hand-checkable.
 */
const Phases = require("../js/phases.js");
// In the browser these are script-tag globals. analytics.js reads `Phases` for
// potassium coverage and the Na:K ratio, so the global must exist before it is
// required — otherwise buildDays silently degrades to "no ratio" and tests
// fail for reasons that have nothing to do with the code under test.
globalThis.Phases = Phases;
const Analytics = require("../js/analytics.js");
// The dependency now runs both directions: goalsForDay retargets carbs/fat on
// a reduced day via Analytics.retargetForKcal, guarded the same defensive way
// analytics.js guards its own Phases reference. Without this global, phases.js
// silently falls back to "Analytics absent" and every reduced-day plan reads
// as unscored instead of retargeted.
globalThis.Analytics = Analytics;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function approx(a, b, tol, name) {
  ok(a != null && Math.abs(a - b) <= (tol || 0.5), name, `got ${a}, want ~${b}`);
}

// ---------------------------------------------------------------- fixtures

const GOALS = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };

/** Build day keys ending at `end` (inclusive), oldest first. */
function keysEndingAt(end, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(Analytics.addDays(end, -i));
  return out;
}

/**
 * Fixture builder. `spec(dayKey, index)` returns null (unlogged) or
 * { kcal, protein, carbs, fat, fiber, sodium, weightKg, items }.
 */
function makeDays(keys, spec) {
  const data = new Map();
  keys.forEach((k, i) => data.set(k, spec(k, i)));
  return Analytics.buildDays({
    keys,
    totalsForDay: (day) => {
      const d = data.get(day);
      if (!d || d.kcal == null) return { count: 0 };
      return {
        count: d.items || 3,
        kcal: { mean: d.kcal }, p: { mean: d.protein }, c: { mean: d.carbs },
        f: { mean: d.fat }, fb: { mean: d.fiber }, na: { mean: d.sodium },
      };
    },
    goalsForDay: () => GOALS,
    weightKgForDay: (day) => {
      const d = data.get(day);
      return d && d.weightKg != null ? d.weightKg : null;
    },
  });
}

const END = "2026-08-02"; // a Sunday

console.log("\n[0] Environment");
{
  ok(typeof globalThis.Phases !== "undefined", "Phases is global, as it is in the browser");
  ok(Analytics.buildDays({
    keys: ["2026-08-02"],
    totalsForDay: () => ({ count: 2, kcal: { mean: 2000 }, p: { mean: 100 }, c: { mean: 200 },
      f: { mean: 60 }, fb: { mean: 25 }, na: { mean: 2000 }, k: { mean: 4000 }, kCoverage: 1, kItems: 2 }),
    goalsForDay: () => ({ ...GOALS, potassium: 3400, naK: 1.0 }),
  })[0].naK != null, "the ratio wiring is live (guards against a silent degrade)");
}

console.log("\n[1] Date helpers");
{
  ok(Analytics.addDays("2026-08-02", -1) === "2026-08-01", "addDays back one");
  ok(Analytics.addDays("2026-03-01", -1) === "2026-02-28", "addDays across month boundary");
  ok(Analytics.daysBetween("2026-08-01", "2026-08-08") === 7, "daysBetween");
  ok(Analytics.weekStart("2026-08-02") === "2026-07-27", "weekStart: Sunday belongs to prior Monday");
  ok(Analytics.weekStart("2026-07-27") === "2026-07-27", "weekStart: Monday is its own start");
  ok(Analytics.weekStart("2026-07-30") === "2026-07-27", "weekStart: Thursday → Monday");
  // DST-safe: keys are built at noon, so no 23/25-hour drift.
  ok(Analytics.addDays("2026-11-01", 1) === "2026-11-02", "addDays across US DST fallback");
}

console.log("\n[2] Statistics");
{
  ok(Analytics.mean([]) === null, "mean of empty is null");
  approx(Analytics.mean([1, 2, 3, 4]), 2.5, 0.001, "mean");
  approx(Analytics.median([3, 1, 2]), 2, 0.001, "median odd");
  approx(Analytics.median([4, 1, 2, 3]), 2.5, 0.001, "median even");
  approx(Analytics.stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.01, "sample stdev");
  ok(Analytics.stdev([5]) === null, "stdev needs 2+ points");

  const roll = Analytics.rollingMean([10, 20, 30, 40], 2, 2);
  ok(roll[0] === null, "rolling mean withholds until window filled");
  approx(roll[1], 15, 0.001, "rolling mean window 2");
  approx(roll[3], 35, 0.001, "rolling mean trailing");

  const rollGap = Analytics.rollingMean([10, null, 30, null], 3, 2);
  approx(rollGap[2], 20, 0.001, "rolling mean skips nulls");

  const fit = Analytics.linearFit([0, 1, 2, 3], [1, 3, 5, 7]);
  approx(fit.slope, 2, 0.0001, "linearFit slope");
  approx(fit.intercept, 1, 0.0001, "linearFit intercept");
  approx(fit.r2, 1, 0.0001, "linearFit r2 on a perfect line");
  ok(Analytics.linearFit([1], [1]) === null, "linearFit needs 2+ points");
}

console.log("\n[3] Trend weight (EMA)");
{
  // Noisy scale readings around a genuine downward drift.
  const raw = [80.0, 81.2, 79.4, 80.6, 79.0, 80.2, 78.6, 79.8, 78.2, 79.4];
  const keys = keysEndingAt(END, raw.length);
  const days = makeDays(keys, (k, i) => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: raw[i] }));
  const trend = Analytics.trendWeight(days, { halfLifeDays: 7 });

  ok(trend.length === raw.length, "trend series matches range length");
  approx(trend[0].trend, 80.0, 0.0001, "trend seeds on first weigh-in");
  ok(trend.every((p) => !p.carried), "no carried days when every day has a weigh-in");

  const sdRaw = Analytics.stdev(raw);
  const sdTrend = Analytics.stdev(trend.map((p) => p.trend));
  ok(sdTrend < sdRaw * 0.6, "trend is markedly smoother than raw scale", `sd ${sdTrend.toFixed(2)} vs ${sdRaw.toFixed(2)}`);
  ok(trend[9].trend < trend[0].trend, "trend follows the real downward drift");

  // Gaps: trend holds flat, and a long gap moves further on the next weigh-in.
  const gapKeys = keysEndingAt(END, 10);
  const gapDays = makeDays(gapKeys, (k, i) => ({
    kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: i === 0 ? 80 : i === 9 ? 78 : null,
  }));
  const gapTrend = Analytics.trendWeight(gapDays, { halfLifeDays: 7 });
  ok(gapTrend[4].carried && gapTrend[4].trend === 80, "trend carries flat across unweighed days");
  ok(gapTrend[9].trend < 79.2, "9-day gap applies a large alpha", `got ${gapTrend[9].trend.toFixed(2)}`);

  const noneDays = makeDays(keysEndingAt(END, 5), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  ok(Analytics.trendWeight(noneDays).every((p) => p.trend === null), "no weigh-ins → null trend throughout");
}

console.log("\n[4] Weight rate");
{
  // Exactly -0.1 kg/day = -0.7 kg/week, clean line.
  const keys = keysEndingAt(END, 15);
  const days = makeDays(keys, (k, i) => ({
    kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: 80 - i * 0.1,
  }));
  const rate = Analytics.weightRate(Analytics.trendWeight(days));
  ok(rate != null, "weightRate returns a result");
  ok(rate.kgPerWeek < 0, "detects loss");
  approx(rate.kgPerWeek, -0.7, 0.12, "rate ≈ -0.7 kg/week");
  ok(rate.n === 15, "counts every weigh-in as an anchor");
  ok(rate.spanDays === 15, "span covers the range");

  const flat = makeDays(keysEndingAt(END, 10), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: 80 }));
  approx(Analytics.weightRate(Analytics.trendWeight(flat)).kgPerWeek, 0, 0.001, "flat weight → zero rate");

  const one = makeDays(keysEndingAt(END, 5), (k, i) => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: i === 0 ? 80 : null }));
  ok(Analytics.weightRate(Analytics.trendWeight(one)) === null, "single weigh-in → no rate");
}

console.log("\n[5] Adaptive TDEE");
{
  // Eat 2000 flat, lose 0.1 kg/day → TDEE = 2000 + 0.1*7700 = 2770.
  const keys = keysEndingAt(END, 28);
  const days = makeDays(keys, (k, i) => ({
    kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: 80 - i * 0.1,
  }));
  const t = Analytics.estimateTdee(days);
  ok(t.confidence === "high", "full logging + daily weigh-ins → high confidence", `got ${t.confidence}`);
  ok(t.actionable === true, "strong plausible inputs explicitly permit target actions");
  approx(t.tdee, 2770, 25, "TDEE ≈ intake + deficit implied by weight loss");
  approx(t.intakeAvg, 2000, 0.5, "intake average");
  approx(t.coverage, 1, 0.001, "coverage 100%");

  // Weight gain flips the sign: eat 3000, gain 0.05 kg/day → TDEE ≈ 2615.
  const gain = makeDays(keys, (k, i) => ({
    kcal: 3000, protein: 180, carbs: 350, fat: 90, fiber: 30, sodium: 2000,
    weightKg: 80 + i * 0.05,
  }));
  approx(Analytics.estimateTdee(gain).tdee, 3000 - 385, 25, "gaining weight → TDEE below intake");

  // Weight stable → TDEE ≈ intake.
  const stable = makeDays(keys, () => ({ kcal: 2400, protein: 150, carbs: 250, fat: 70, fiber: 30, sodium: 2000, weightKg: 80 }));
  approx(Analytics.estimateTdee(stable).tdee, 2400, 5, "stable weight → TDEE ≈ intake");

  // Gating: each guard fires with a reason and no number.
  const fewWeighIns = makeDays(keys, (k, i) => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: i < 2 ? 80 - i * 0.1 : null }));
  const g1 = Analytics.estimateTdee(fewWeighIns);
  ok(g1.tdee === null && g1.confidence === "none" && /3 weigh-ins/.test(g1.reason), "gated on too few weigh-ins");

  const shortSpan = makeDays(keysEndingAt(END, 8), (k, i) => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: 80 - i * 0.1 }));
  const g2 = Analytics.estimateTdee(shortSpan);
  ok(g2.tdee === null && /10 days/.test(g2.reason), "gated on short weigh-in span");

  const sparse = makeDays(keys, (k, i) => ({
    kcal: i % 4 === 0 ? 2000 : null, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: 80 - i * 0.1,
  }));
  const g3 = Analytics.estimateTdee(sparse);
  ok(g3.tdee === null && /50%/.test(g3.reason), "gated on thin food logging", `reason: ${g3.reason}`);

  // Noisy but real data should land in a sane band, not a wild one.
  const noisy = makeDays(keys, (k, i) => ({
    kcal: 2000 + ((i * 137) % 400) - 200, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: 80 - i * 0.07 + (i % 3 === 0 ? 0.4 : -0.3),
  }));
  const nt = Analytics.estimateTdee(noisy);
  ok(nt.tdee > 2000 && nt.tdee < 3200, "noisy data still yields a plausible TDEE", `got ${Math.round(nt.tdee)}`);
  ok(nt.marginKcal > 0, "reports a confidence margin");

  // Adversarial: consistent tiny logs can look statistically perfect while
  // clearly failing the absolute-completion contract.
  const tiny = makeDays(keys, () => ({
    kcal: 250, protein: 15, carbs: 30, fat: 8, fiber: 2, sodium: 200,
    weightKg: 80,
  }));
  const tinyTdee = Analytics.estimateTdee(tiny);
  ok(tinyTdee.tdee != null, "tiny-log estimate remains visible for honest review");
  ok(tinyTdee.confidence === "low" && tinyTdee.actionable === false,
    "28 statistically neat 250 kcal logs never become high-confidence/actionable");
  ok(tinyTdee.intakePlausible === false && /incomplete/i.test(tinyTdee.actionReason),
    "tiny-log action pause names completion plausibility");

  // Exact adversarial fixture: a beautifully stable scale cannot turn 28 days
  // of one 1,200-kcal item against a 2,200-kcal target into an action signal.
  const uniformPartial = Analytics.buildDays({
    keys,
    totalsForDay: () => ({
      count: 1,
      kcal: { mean: 1200 }, p: { mean: 80 }, c: { mean: 120 },
      f: { mean: 45 }, fb: { mean: 12 }, na: { mean: 1200 },
    }),
    goalsForDay: () => ({ ...GOALS, kcal: 2200 }),
    weightKgForDay: () => 80,
  });
  const uniformPartialTdee = Analytics.estimateTdee(uniformPartial);
  ok(uniformPartialTdee.tdee != null && uniformPartialTdee.actionable === false,
    "28 one-item 1200/2200 days with stable weight are review-only");
  ok(uniformPartialTdee.oneItemLowDays === 28 && /one low-calorie item|incomplete/i.test(uniformPartialTdee.actionReason),
    "uniform one-item partial logging is named in the action pause");
  ok(uniformPartialTdee.marginKcal >= Analytics.MIN_TDEE_MARGIN_KCAL && uniformPartialTdee.marginKcal > 0,
    "a perfect flat fixture still has a nonzero TDEE uncertainty floor");

  const oneStub = makeDays(keys, (k, i) => ({
    kcal: i === 10 ? 250 : 2000,
    protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    items: i === 10 ? 1 : 4,
    weightKg: 80,
  }));
  const stubTdee = Analytics.estimateTdee(oneStub);
  ok(stubTdee.partialLogDays === 1 && stubTdee.actionable === false,
    "an isolated likely-partial day pauses actions in the estimator contract itself");

  // Adversarial: a computable but very poor weight fit stays displayable and
  // cannot enable an action even when logging coverage is perfect.
  const wildWeights = makeDays(keys, (k, i) => ({
    kcal: 2200, protein: 150, carbs: 220, fat: 70, fiber: 30, sodium: 2000,
    weightKg: 80 - i * 0.02 + (i % 2 ? 2 : -2),
  }));
  const wild = Analytics.estimateTdee(wildWeights);
  ok(wild.tdee != null && wild.marginKcal > 0, "wide estimate remains visible with its margin");
  ok(wild.actionable === false && wild.confidence === "low",
    "poor residual fit / wide uncertainty cannot become actionable");
  ok(/trend|uncertainty/i.test(wild.actionReason), "wide estimate explains why action is paused");

  const implausibleRate = makeDays(keys, (k, i) => ({
    kcal: 2200, protein: 150, carbs: 220, fat: 70, fiber: 30, sodium: 2000,
    weightKg: 80 - i * 0.3,
  }));
  const implausible = Analytics.estimateTdee(implausibleRate);
  ok(implausible.tdee != null && implausible.actionable === false,
    "implausible rate can display but cannot drive a target");

  const belowAutoFloor = makeDays(keys, () => ({
    kcal: 1100, protein: 100, carbs: 110, fat: 35, fiber: 20, sodium: 1500,
    weightKg: 80,
  }));
  const lowExpenditure = Analytics.estimateTdee(belowAutoFloor);
  ok(Math.round(lowExpenditure.tdee) === 1100 && lowExpenditure.actionable === false &&
      /expenditure estimate/i.test(lowExpenditure.actionReason),
    "a sub-1200 expenditure estimate remains visible but is outside the action gate");

  const unfinishedToday = makeDays(keys, (day) => ({
    kcal: day === END ? 250 : 2000,
    protein: day === END ? 10 : 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: 80,
  }));
  const completedOnly = Analytics.estimateTdee(unfinishedToday, { todayKey: END });
  ok(completedOnly.loggedDays === 27 && Math.round(completedOnly.intakeAvg) === 2000,
    "adaptive TDEE excludes the current in-progress day");

  // intakeForRate inverts cleanly.
  approx(Analytics.intakeForRate(t, -0.5), t.tdee - 550, 1, "intake for -0.5 kg/week");
  approx(Analytics.intakeForRate(t, 0), t.tdee, 0.001, "intake to maintain = TDEE");
  ok(Analytics.intakeForRate({ tdee: null }, -0.5) === null, "no TDEE → no target intake");
}

console.log("\n[6] Consistency and streaks");
{
  const keys = keysEndingAt(END, 14);
  // Miss days at index 3 and 4; today (last) is logged.
  const days = makeDays(keys, (k, i) => (i === 3 || i === 4 ? null : { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const c = Analytics.consistency(days, { todayKey: END });
  ok(c.loggedDays === 12 && c.totalDays === 14, "counts logged vs total");
  approx(c.rate, 12 / 14, 0.001, "logging rate");
  ok(c.currentStreak === 9, "current streak runs back to the last gap", `got ${c.currentStreak}`);
  ok(c.longestStreak === 9, "longest streak", `got ${c.longestStreak}`);
  ok(c.missedDays.length === 2, "lists missed days");

  // Today unlogged should not break a streak or count as a miss.
  const graceDays = makeDays(keys, (k, i) => (i === keys.length - 1 ? null : { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const g = Analytics.consistency(graceDays, { todayKey: END });
  ok(g.totalDays === 13, "unlogged today excluded from the denominator");
  ok(g.currentStreak === 13, "unlogged today does not break the streak", `got ${g.currentStreak}`);

  // Weekday vs weekend split.
  const weekendSkip = makeDays(keys, (k) => {
    const dow = Analytics.dateOf(k).getDay();
    return dow === 0 || dow === 6 ? null : { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 };
  });
  const w = Analytics.consistency(weekendSkip, { todayKey: END });
  approx(w.weekdayRate, 1, 0.001, "weekdays fully logged");
  approx(w.weekendRate, 0, 0.001, "weekends unlogged");
}

console.log("\n[7] Nutrition score");
{
  const keys = keysEndingAt(END, 14);
  const perfect = makeDays(keys, () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const sPerfect = Analytics.nutritionScore(perfect, Phases.scoreDayTotals, { todayKey: END });
  ok(sPerfect.score === 100, "on-target every day → 100", `got ${sPerfect.score}`);
  ok(sPerfect.grade === "Dialed in", "top grade label");

  const none = makeDays(keys, () => null);
  const sNone = Analytics.nutritionScore(none, Phases.scoreDayTotals, { todayKey: END });
  ok(sNone.score === 0, "nothing logged → 0", `got ${sNone.score}`);

  // Half the days logged, all on target → consistency drags the score down
  // but does not zero it.
  const half = makeDays(keys, (k, i) => (i % 2 ? { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 } : null));
  const sHalf = Analytics.nutritionScore(half, Phases.scoreDayTotals, { todayKey: END });
  ok(sHalf.score > 60 && sHalf.score < 90, "half-logged but on target sits mid-range", `got ${sHalf.score}`);
  approx(sHalf.parts.targets, 1, 0.001, "target hit rate unaffected by missed days");

  // Protein short every day should cost more than fat being short.
  const lowProtein = makeDays(keys, () => ({ kcal: 2000, protein: 60, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const sLowP = Analytics.nutritionScore(lowProtein, Phases.scoreDayTotals, { todayKey: END });
  ok(sLowP.score < sPerfect.score, "missing protein lowers the score");
  const lowPn = sLowP.nutrients.find((n) => n.key === "protein");
  approx(lowPn.hitRate, 0, 0.001, "protein hit rate zero when always short");

  // Without a scorer it degrades to consistency only rather than throwing.
  const sNoScorer = Analytics.nutritionScore(perfect, null, { todayKey: END });
  ok(sNoScorer.score === 100 && sNoScorer.parts.targets === null, "degrades gracefully with no scorer");
  ok(Analytics.gradeFor(null) === "No data yet", "null score has a label");
}

console.log("\n[8] Weekly rollup");
{
  // END is a Sunday, so 21 days back starts exactly on a Monday: 3 clean weeks.
  const keys = keysEndingAt(END, 21);
  ok(Analytics.dateOf(keys[0]).getDay() === 1, "fixture starts on a Monday");
  const days = makeDays(keys, (k, i) => ({ kcal: 1000 + i * 100, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const weeks = Analytics.weeklyRollup(days, "kcal");
  ok(weeks.length === 3, "21 days ending Sunday spans 3 Monday-start buckets", `got ${weeks.length}`);

  // Ranges that straddle week boundaries get a partial bucket at each end.
  // 23 days back from a Sunday starts mid-week, so the oldest bucket is partial.
  const straddle = Analytics.weeklyRollup(makeDays(keysEndingAt(END, 23), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 })), "kcal");
  ok(straddle.length === 4, "23 days spans 4 buckets (partial first week)", `got ${straddle.length}`);
  ok(straddle[0].days === 2 && straddle[0].partial, "oldest bucket holds only its 2 in-range days");
  ok(weeks.every((w) => w.weekStart === Analytics.weekStart(w.weekStart)), "bucket keys are Mondays");
  ok(weeks[weeks.length - 1].value > weeks[0].value, "rising intake shows in the rollup");
  approx(weeks[1].goal, GOALS.kcal, 0.001, "goal averaged per week");

  const partial = Analytics.weeklyRollup(
    makeDays(keys, (k, i) => (i < 19 ? null : { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 })),
    "kcal"
  );
  ok(partial.some((w) => w.partial), "weeks built from a couple of days are flagged partial");
  ok(partial[0].value === null, "weeks with no logged days have a null average");
}

console.log("\n[9] Day-of-week patterns");
{
  const keys = keysEndingAt(END, 28);
  const days = makeDays(keys, (k) => {
    const dow = Analytics.dateOf(k).getDay();
    const weekend = dow === 0 || dow === 6;
    return { kcal: weekend ? 2800 : 1900, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 };
  });
  const dow = Analytics.byDayOfWeek(days, "kcal");
  ok(dow.length === 7, "seven rows");
  ok(dow[0].label === "Mon" && dow[6].label === "Sun", "Monday-first ordering");
  approx(dow[0].avg, 1900, 0.5, "weekday average");
  approx(dow[6].avg, 2800, 0.5, "Sunday average");

  const we = Analytics.weekendEffect(days, "kcal");
  ok(we && we.notable, "flags a real weekend effect");
  approx(we.delta, 900, 1, "weekend delta");
  approx(we.pct, 900 / 1900, 0.01, "weekend delta as a share");

  const flat = makeDays(keys, () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  ok(!Analytics.weekendEffect(flat, "kcal").notable, "no false positive on flat data");
  ok(Analytics.weekendEffect(makeDays(keysEndingAt(END, 3), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 })), "kcal") === null, "needs enough of both to compare");
}

console.log("\n[10] Macro split");
{
  // 150p / 200c / 65f = 600 + 800 + 585 = 1985 kcal
  const days = makeDays(keysEndingAt(END, 7), () => ({ kcal: 1985, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const split = Analytics.macroSplit(days);
  approx(split.actual.protein, 600 / 1985, 0.001, "protein share of calories");
  approx(split.actual.carbs, 800 / 1985, 0.001, "carb share");
  approx(split.actual.fat, 585 / 1985, 0.001, "fat share");
  approx(split.actual.protein + split.actual.carbs + split.actual.fat, 1, 0.0001, "shares sum to 1");
  approx(split.target.protein, 600 / 1985, 0.001, "target split from goals");

  const empty = Analytics.macroSplit(makeDays(keysEndingAt(END, 5), () => null));
  ok(empty.actual === null, "no logged days → null actual split");
}

console.log("\n[11] Meals and top foods");
{
  const keys = keysEndingAt(END, 3);
  const entries = {
    [keys[0]]: [
      { name: "Oats", meal: "breakfast", macros: { kcal: 300, p: 10, na: 5 } },
      { name: "Chicken bowl", meal: "lunch", macros: { kcal: 700, p: 50, na: 900 } },
    ],
    [keys[1]]: [
      { name: "Oats", meal: "breakfast", macros: { kcal: 300, p: 10, na: 5 } },
      { name: "Ramen", meal: "dinner", macros: { kcal: 500, p: 15, na: 1800 } },
    ],
    [keys[2]]: [
      { name: "Chips", meal: null, macros: { kcal: 200, p: 2, na: 300 } },
    ],
  };
  const entriesFor = (d) => entries[d] || [];

  const meals = Analytics.byMeal(keys, entriesFor);
  const byName = Object.fromEntries(meals.map((m) => [m.meal, m]));
  ok(byName.breakfast.kcal === 600, "breakfast total across days");
  approx(byName.breakfast.avgKcal, 300, 0.001, "breakfast per-day average uses days present");
  ok(byName.snack.kcal === 200, "entries with no meal fall into snack");
  approx(meals.reduce((s, m) => s + m.pct, 0), 1, 0.0001, "meal shares sum to 1");

  const topK = Analytics.topFoods(keys, entriesFor, "kcal", 5);
  ok(topK[0].name === "Chicken bowl", "top by calories", `got ${topK[0].name}`);
  ok(topK.find((f) => f.name === "Oats").count === 2, "repeat foods aggregate");

  const topNa = Analytics.topFoods(keys, entriesFor, "sodium", 5);
  ok(topNa[0].name === "Ramen", "top by sodium differs from top by calories", `got ${topNa[0].name}`);
  approx(topNa[0].pct, 1800 / 3005, 0.001, "sodium share");

  const topP = Analytics.topFoods(keys, entriesFor, "protein", 2);
  ok(topP.length === 2 && topP[0].name === "Chicken bowl", "top by protein, limited");

  // Peaks: one huge single log beats many modest repeats (range totals diverge).
  const peakEntries = {};
  const peakKeys = keysEndingAt(END, 8);
  for (let i = 0; i < peakKeys.length; i += 1) {
    peakEntries[peakKeys[i]] = [
      { name: "Daily tofu", macros: { kcal: 200, p: 20, c: 5, f: 10, fb: 2, na: 400, k: 100 }, source: "personal" },
    ];
  }
  // Single spike below the tofu range total (8×400=3200) but above any one tofu log.
  peakEntries[peakKeys[1]].push({
    name: "Hot Iron lunch",
    macros: { kcal: 900, p: 40, c: 60, f: 40, fb: 4, na: 2600, k: 800 },
    source: "once",
  });
  const peakFor = (d) => peakEntries[d] || [];
  const byTotal = Analytics.topFoods(peakKeys, peakFor, "sodium", 5);
  const byPeak = Analytics.topFoodPeaks(peakKeys, peakFor, "sodium", 5);
  ok(byTotal[0].name === "Daily tofu", "totals still crown the repeated food", `got ${byTotal[0] && byTotal[0].name}`);
  ok(byPeak[0].name === "Hot Iron lunch", "peaks crowns the single spike", `got ${byPeak[0] && byPeak[0].name}`);
  ok(byPeak[0].peak === 2600 && byPeak[0].peakDay === peakKeys[1], "peak keeps amount and day");
  ok(byPeak[0].peakSource === "once", "peak remembers one-off source");
  ok(byPeak[0].value === byPeak[0].peak, "peak value aliases for bar width");

  // Single-day range: same pct model the day-detail card uses.
  const oneDay = [keys[0]];
  const dayNa = Analytics.topFoods(oneDay, entriesFor, "sodium", 6);
  const dayGrand = (entriesFor(keys[0]) || []).reduce((s, e) => s + ((e.macros && e.macros.na) || 0), 0);
  ok(dayNa.length > 0, "single-day topFoods returns rows");
  approx(dayNa.reduce((s, r) => s + r.pct, 0), 1, 0.001, "single-day shares sum to 1");
  approx(dayNa[0].total, dayGrand, 0.001, "single-day total matches entry sum");
}

console.log("\n[12] Heatmap");
{
  const keys = keysEndingAt(END, 14);
  const days = makeDays(keys, (k, i) => (i === 2 ? null : { kcal: i === 5 ? 3200 : 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const cells = Analytics.heatmapCells(days, "kcal", Phases.scoreDayTotals);
  ok(cells.length === 14, "one cell per day");
  ok(cells[2].status === "empty", "unlogged day is empty");
  ok(cells[0].status === "hit", "on-target day is a hit");
  ok(cells[5].status === "over", "3200 vs 2000 target reads as over", `got ${cells[5].status}`);
  approx(cells[5].ratio, 1.6, 0.001, "ratio vs goal");

  const weeks = Analytics.heatmapWeeks(cells);
  ok(weeks.every((w) => w.cells.length === 7), "every column has 7 slots");
  const flat = weeks.flatMap((w) => w.cells).filter(Boolean);
  ok(flat.length === 14, "no cells lost in the grid");
  const mondayCol = weeks[0].cells;
  ok(mondayCol[0] === null || Analytics.dateOf(mondayCol[0].day).getDay() === 1, "row 0 is Monday");

  const noScorer = Analytics.heatmapCells(days, "kcal", null);
  ok(noScorer[0].status === "logged", "without a scorer, logged days are just 'logged'");
}

console.log("\n[13] Momentum, extremes, protein per kg");
{
  const keys = keysEndingAt(END, 20);
  const days = makeDays(keys, (k, i) => ({
    kcal: i < 10 ? 2400 : 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: 75,
  }));
  // Last 7 days are all 2000; the prior 7 straddle the step (4×2400 + 3×2000).
  const m = Analytics.momentum(days, "kcal", 7);
  approx(m.recentAvg, 2000, 0.5, "recent window average");
  approx(m.priorAvg, (4 * 2400 + 3 * 2000) / 7, 0.5, "prior window average");
  ok(m.delta < 0, "step down shows as negative momentum");

  const stepped = makeDays(keys, (k, i) => ({ kcal: i < 13 ? 2500 : 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const m2 = Analytics.momentum(stepped, "kcal", 7);
  ok(m2.delta < 0, "detects a step down");
  ok(Analytics.momentum(makeDays(keysEndingAt(END, 4), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 })), "kcal", 7) === null, "needs two full windows");

  const ex = Analytics.extremes(days, "kcal");
  approx(ex.high.kcal, 2400, 0.5, "highest day");
  approx(ex.low.kcal, 2000, 0.5, "lowest day");
  ok(Analytics.extremes(makeDays(keysEndingAt(END, 3), () => null), "kcal") === null, "no logged days → no extremes");

  const ppk = Analytics.proteinPerKg(days);
  approx(ppk.gPerKg, 2.0, 0.01, "150 g protein at 75 kg = 2.0 g/kg");
  ok(Analytics.proteinPerKg(makeDays(keysEndingAt(END, 5), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }))) === null, "needs a weight to divide by");
}

console.log("\n[14] Projection");
{
  const keys = keysEndingAt(END, 21);
  const days = makeDays(keys, (k, i) => ({
    kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
    weightKg: 80 - i * 0.1,
  }));
  const p = Analytics.projectWeight(days, { weeks: 4 });
  approx(p.kgPerWeek, -0.7, 0.12, "projection uses the trend rate");
  approx(p.projectedKg, p.fromKg + p.kgPerWeek * 4, 0.001, "projects forward 4 weeks");
  ok(p.confident, "enough weigh-ins to be called confident");
  ok(Analytics.projectWeight(makeDays(keysEndingAt(END, 5), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }))) === null, "no weigh-ins → no projection");
}

console.log("\n[15] Observations");
{
  const keys = keysEndingAt(END, 28);
  const days = makeDays(keys, (k) => {
    const dow = Analytics.dateOf(k).getDay();
    const weekend = dow === 0 || dow === 6;
    // Wide enough swing that summaryStats.cv clears the 0.25 variability floor
    // so the wording guard below is not a vacuous `!varNote || …` pass.
    return { kcal: weekend ? 3600 : 1600, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: 75 };
  });
  const obs = Analytics.observations(days, { todayKey: END });
  ok(obs.some((o) => o.id === "weekend-kcal"), "surfaces the weekend calorie gap");
  ok(obs.some((o) => o.id === "protein-per-kg"), "surfaces protein per kg");
  ok(obs.some((o) => o.id === "variability"), "surfaces calorie variability when CV is high");
  ok(obs.every((o) => o.text && o.tone), "every observation has text and a tone");
  ok(obs.every((o) => !/should|bad|failed|too much/i.test(o.text)), "observations stay descriptive, not scolding");
  const weNote = obs.find((o) => o.id === "weekend-kcal");
  ok(weNote && weNote.panel === "#dow-pattern" && typeof weNote.priority === "number",
    "weekend-kcal carries panel + priority for Insights jump triage");
  ok(weNote && /\d+\s*kcal/.test(weNote.text) && !/\d+\s*→\s*\d+/.test(weNote.text),
    "weekend-kcal keeps the magnitude but drops the weekday→weekend pair");
  const varNote = obs.find((o) => o.id === "variability");
  ok(varNote && /\d+\s*kcal/.test(varNote.text) && !/around \d+/.test(varNote.text),
    "variability keeps ±sd kcal without restating the average");

  const sparse = makeDays(keys, (k, i) => (i % 3 ? null : { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  ok(Analytics.observations(sparse, { todayKey: END }).some((o) => o.id === "coverage"), "warns when averages rest on few days");
  ok(Analytics.observations(makeDays(keysEndingAt(END, 5), () => null), { todayKey: END }).length === 0, "no data → no observations");
}

console.log("\n[16] Edge cases");
{
  ok(Analytics.buildDays({ keys: [] }).length === 0, "empty range");
  ok(Analytics.consistency([], {}).rate === 0, "consistency on empty range");
  ok(Analytics.weeklyRollup([], "kcal").length === 0, "rollup on empty range");
  ok(Analytics.byMeal([], () => []).every((m) => m.kcal === 0), "byMeal on empty range");
  ok(Analytics.topFoods([], () => [], "kcal").length === 0, "topFoods on empty range");
  ok(Analytics.estimateTdee([]).confidence === "none", "TDEE on empty range");

  const oneDay = makeDays(keysEndingAt(END, 1), () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: 80 }));
  ok(Analytics.summaryStats(oneDay, "kcal").sd === null, "sd undefined for a single day");
  ok(Analytics.nutritionScore(oneDay, Phases.scoreDayTotals, { todayKey: END }).score === 100, "single perfect day scores");

  // Zero goals must not divide by zero.
  const zeroGoal = Analytics.buildDays({
    keys: keysEndingAt(END, 3),
    totalsForDay: () => ({ count: 1, kcal: { mean: 2000 }, p: { mean: 100 }, c: { mean: 200 }, f: { mean: 60 }, fb: { mean: 20 }, na: { mean: 1000 } }),
    goalsForDay: () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 }),
    weightKgForDay: () => null,
  });
  const zc = Analytics.heatmapCells(zeroGoal, "kcal", Phases.scoreDayTotals);
  ok(zc.every((c) => c.ratio === null), "zero goal → null ratio, no Infinity");
  ok(Analytics.fmtNum(Infinity) === "—", "non-finite formats as em dash");
  ok(Analytics.fmtSigned(2.5, 1) === "+2.5", "signed formatting");
  ok(Analytics.kgToDisplay(null, "lb") === null, "null weight converts to null");
  approx(Analytics.kgToDisplay(100, "lb"), 220.46, 0.01, "kg → lb");
}


console.log("\n[17] Band semantics (floor / ceiling / range)");
{
  // The contract every Insights surface must honour, pinned here so a future
  // refactor cannot quietly reintroduce a parallel threshold table.
  const B = Phases.BANDS;
  ok(B.protein.dir === "floor" && B.fiber.dir === "floor", "protein and fiber are floors");
  ok(B.sodium.dir === "ceiling", "sodium is a ceiling");
  ok(B.kcal.dir === "range" && B.carbs.dir === "range" && B.fat.dir === "range", "kcal, carbs and fat are ranges");

  // Floors: exceeding the target is never a problem.
  ok(Phases.classify(300, 150, B.protein) === "hit", "double the protein target is still a hit");
  ok(Phases.classify(90, 30, B.fiber) === "hit", "triple the fiber target is still a hit");
  ok(Phases.classify(100, 150, B.protein) === "under", "short protein is under");
  ok(["hit", "under"].includes(Phases.classify(999, 150, B.protein)), "a floor never returns 'over'");

  // Ceilings: lower is always fine, only exceeding counts.
  ok(Phases.classify(0, 2300, B.sodium) === "hit", "zero sodium is within the ceiling");
  ok(Phases.classify(500, 2300, B.sodium) === "hit", "well under the sodium ceiling is a hit");
  ok(Phases.classify(4000, 2300, B.sodium) === "over", "past the sodium ceiling is over");
  ok(["hit", "over"].includes(Phases.classify(1, 2300, B.sodium)), "a ceiling never returns 'under'");

  // Ranges: both directions count.
  ok(Phases.classify(1000, 2000, B.kcal) === "under", "far below the calorie range is under");
  ok(Phases.classify(3000, 2000, B.kcal) === "over", "far above the calorie range is over");

  // The Today HUD must agree: floors never warn for being high.
  ok(Phases.hudBarOver(300, 150, B.protein) === false, "Today never warns on high protein");
  ok(Phases.hudBarOver(90, 30, B.fiber) === false, "Today never warns on high fiber");
  ok(Phases.hudBarOver(2500, 2300, B.sodium) === true, "Today warns past the sodium ceiling");

  // Scorecard aggregation over a range must inherit the same shape.
  const keys = keysEndingAt(END, 10);
  const highFloors = makeDays(keys, () => ({ kcal: 2000, protein: 400, carbs: 200, fat: 65, fiber: 90, sodium: 300 }));
  const cells = Analytics.heatmapCells(highFloors, "protein", Phases.scoreDayTotals);
  ok(cells.every((c) => c.status === "hit"), "heatmap: sky-high protein days are all hits");
  const naCells = Analytics.heatmapCells(highFloors, "sodium", Phases.scoreDayTotals);
  ok(naCells.every((c) => c.status === "hit"), "heatmap: very low sodium days are all hits, never 'under'");

  // A range of very low sodium should score a perfect sodium hit rate and a
  // negative avgDelta — which the UI must render as headroom, not a shortfall.
  const totalsMap = {};
  for (const d of highFloors) totalsMap[d.day] = {
    count: 3,
    kcal: { mean: d.kcal }, p: { mean: d.protein }, c: { mean: d.carbs },
    f: { mean: d.fat }, fb: { mean: d.fiber }, na: { mean: d.sodium },
  };
  const card = Phases.scoreRange(keys, (day) => totalsMap[day], {
    goals: GOALS, phases: [], weights: {},
  });
  const na = card.nutrients.find((n) => n.key === "sodium");
  ok(na.under === 0, "scorecard: sodium never accumulates 'under' days");
  ok(na.over === 0 && na.hit === 10, "scorecard: low sodium counts as hits");
  ok(na.avgDelta < 0, "scorecard: low sodium yields a negative delta (headroom, not shortfall)");
  const prot = card.nutrients.find((n) => n.key === "protein");
  ok(prot.over === 0, "scorecard: protein never accumulates 'over' days");
  ok(prot.hit === 10, "scorecard: high protein counts as hits");

  // The score must not punish generous protein or frugal sodium.
  const modest = makeDays(keys, () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 }));
  const sHigh = Analytics.nutritionScore(highFloors, Phases.scoreDayTotals, { todayKey: END });
  const sModest = Analytics.nutritionScore(modest, Phases.scoreDayTotals, { todayKey: END });
  ok(sHigh.nutrients.find((n) => n.key === "protein").hitRate === 1, "score: high protein is full marks");
  ok(sHigh.score >= sModest.score - 1, "score: exceeding floors is not penalised versus hitting them exactly",
    `high ${sHigh.score} vs modest ${sModest.score}`);
}


console.log("\n[18] Effort weighting in the score");
{
  const keys = keysEndingAt(END, 14);
  const on = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000 };
  const perfect = makeDays(keys, () => on);
  const base = Analytics.nutritionScore(perfect, Phases.scoreDayTotals, { todayKey: END });
  ok(base.score === 100, "all targets met still scores 100");

  const W = Analytics.SCORE_WEIGHTS;
  const effective = Object.values(W).reduce((a, v) => a + v, 0);
  approx(effective, 1, 0.0001, "effort weights contain exactly one 0.10 mineral slot");
  ok(Object.keys(W).filter((k) => k === "naK" || k === "sodium" || k === "potassium").length === 1,
    "the composite has no extra sodium or potassium weight aliases");
  ok(W.kcal > W.carbs && W.kcal > W.fat, "energy outweighs the macros it largely determines");
  ok(W.protein >= W.kcal, "protein carries at least as much as calories");
  ok(W.naK < W.protein && W.naK < W.fiber, "the mineral composite carries less than the primary floors");
  ok(W.carbs === W.fat && W.carbs <= 0.05, "carbs and fat are residual once kcal and protein land");

  // Missing an effortful target must cost more than missing an implied one.
  const missProtein = Analytics.nutritionScore(makeDays(keys, () => ({ ...on, protein: 60 })), Phases.scoreDayTotals, { todayKey: END });
  const missFat = Analytics.nutritionScore(makeDays(keys, () => ({ ...on, fat: 20 })), Phases.scoreDayTotals, { todayKey: END });
  ok(missProtein.score < missFat.score, "missing protein costs more than missing fat",
    `protein ${missProtein.score} vs fat ${missFat.score}`);

  const missFiber = Analytics.nutritionScore(makeDays(keys, () => ({ ...on, fiber: 5 })), Phases.scoreDayTotals, { todayKey: END });
  const missSodium = Analytics.nutritionScore(makeDays(keys, () => ({ ...on, sodium: 6000 })), Phases.scoreDayTotals, { todayKey: END });
  ok(missFiber.score < missSodium.score, "missing fiber costs more than blowing the sodium ceiling",
    `fiber ${missFiber.score} vs sodium ${missSodium.score}`);

  // The free-component problem: clearing a ceiling effortlessly must not
  // inflate the score the way a flat six-way average did.
  const flatWouldGive = (hits) => hits / 6; // the old model, for contrast
  const lowNa = makeDays(keys, () => ({ ...on, sodium: 100, protein: 60 }));
  const s1 = Analytics.nutritionScore(lowNa, Phases.scoreDayTotals, { todayKey: END });
  ok(s1.parts.targets < flatWouldGive(5), "trivially clearing sodium no longer props up a missed protein floor",
    `weighted ${s1.parts.targets.toFixed(3)} vs flat ${flatWouldGive(5).toFixed(3)}`);

  // Nutrients with no goal drop out and the rest renormalize.
  const noFiberGoal = Analytics.buildDays({
    keys,
    totalsForDay: () => ({ count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 0 }, na: { mean: 2000 } }),
    goalsForDay: () => ({ kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 0, sodium: 2300 }),
    weightKgForDay: () => null,
  });
  const sNoFiber = Analytics.nutritionScore(noFiberGoal, Phases.scoreDayTotals, { todayKey: END });
  ok(!sNoFiber.nutrients.some((n) => n.key === "fiber"), "a zeroed goal drops out of the breakdown");
  ok(sNoFiber.score === 100, "a zeroed goal is not scored as a permanent miss", `got ${sNoFiber.score}`);

  // Biggest gap ranks by weighted cost, not raw miss count.
  const mixed = makeDays(keys, (k, i) => ({ ...on, fat: 20, protein: i < 7 ? 60 : 150 }));
  const g = Analytics.nutritionScore(mixed, Phases.scoreDayTotals, { todayKey: END }).gap;
  ok(g && g.key === "protein", "gap picks the costly target over the more-often-missed cheap one", `got ${g && g.key}`);
  ok(g.n === 13 && g.hit === 6, "gap reports completed-day counts and excludes today");
  ok(Analytics.nutritionScore(perfect, Phases.scoreDayTotals, { todayKey: END }).gap === null, "no gap when everything lands");
  ok(Analytics.biggestGap([{ key: "fiber", weight: 0.2, hitRate: 0, n: 2 }]) === null, "gap needs a few days before it speaks");
}


console.log("\n[19] Partial-day detection");
{
  const keys = keysEndingAt(END, 14);
  const full = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, items: 4 };
  // Two days holding a single small entry — the shape of a forgotten log.
  const withStubs = makeDays(keys, (k, i) =>
    (i === 4 || i === 9 ? { ...full, kcal: 260, items: 1 } : full));
  const p = Analytics.partialDays(withStubs);
  ok(p.flagged.length === 2, "flags the two stub days", `got ${p.flagged.length}`);
  ok(p.flagged.every((d) => d.itemCount === 1), "flagged days carry their item count");
  ok(p.adjustedAvg > p.avg, "reports what the average would be without them");
  approx(p.adjustedAvg, 2000, 1, "adjusted average excludes the stubs");

  // A low day with a full set of entries is a light day, not a broken log.
  const lightButComplete = makeDays(keys, (k, i) =>
    (i === 4 ? { ...full, kcal: 600, items: 5 } : full));
  ok(Analytics.partialDays(lightButComplete).flagged.length === 0,
    "a low day with many items is not flagged");

  // Thresholds are personal, not absolute.
  const smallEater = makeDays(keys, () => ({ ...full, kcal: 1300 }));
  ok(Analytics.partialDays(smallEater).flagged.length === 0,
    "a consistently smaller eater is never flagged");

  ok(Analytics.partialDays(makeDays(keysEndingAt(END, 3), () => full)).flagged.length === 0,
    "needs a baseline before flagging anything");
  ok(Analytics.partialDays(makeDays(keys, () => null)).flagged.length === 0, "no logged days, nothing to flag");

  const todayStub = makeDays(keys, (day) => day === END
    ? { ...full, kcal: 250, items: 1 }
    : full);
  ok(Analytics.partialDays(todayStub, { todayKey: END }).flagged.length === 0,
    "unfinished today is excluded from completed-day partial-log audits");

  // Flagged days must still be counted everywhere else.
  const stats = Analytics.summaryStats(withStubs, "kcal");
  ok(stats.n === 14, "flagged days remain in the underlying stats");
}

console.log("\n[20] Bump audit");
{
  const keys = keysEndingAt(END, 10);
  const endOf = (day) => { const d = Analytics.dateOf(day); d.setHours(24, 0, 0, 0); return d.getTime(); };

  const base = { ...GOALS, potassium: 3400 };
  const settings = {
    goals: base, phases: [], weights: {},
    dayGoals: {
      [keys[0]]: {
        bumps: { kcal: 500, protein: 50, carbs: 100, fat: 20, fiber: 10, sodium: -500, potassium: 900 },
        updatedAt: 1,
      },
      [keys[1]]: {
        kcal: 2300, protein: 999, carbs: 999, fat: 999, fiber: 999, sodium: 9999, potassium: 9999,
        updatedAt: 2,
      },
    },
  };
  const adjusted = Phases.goalsForDay(keys[0], settings);
  ok(adjusted.kcal === base.kcal + 500, "one-day energy adjustment changes calories");
  for (const key of ["protein", "fiber", "sodium", "potassium"]) {
    ok(adjusted[key] === base[key], `one-day adjustment cannot move ${key}`);
  }
  // Carbs and fat are not floors or ceilings — they are the arithmetic
  // residual of calories and protein, so a one-day plan retargets them by the
  // same policy a phase revision uses (spec §4). Floors and ceilings
  // (protein, fiber, sodium, potassium) never move; only these two do.
  const retargeted = Analytics.retargetForKcal(base, adjusted.kcal);
  ok(retargeted && adjusted.carbs === retargeted.carbs && adjusted.fat === retargeted.fat,
    "carbs and fat follow energy via the same retarget policy a phase revision uses");
  const atwater = adjusted.protein * 4 + adjusted.carbs * 4 + adjusted.fat * 9;
  ok(atwater <= adjusted.kcal && adjusted.kcal - atwater <= 3,
    "reduced-day carbs/fat stay Atwater-consistent within retargetForKcal's tolerance",
    `sum ${atwater} vs ${adjusted.kcal}`);
  ok(Object.keys(adjusted._dayPlan).sort().join(",") === "intent,kcal" && adjusted._dayPlan.kcal === 500 &&
      adjusted._dayPlan.intent === "reduced",
    "legacy multi-nutrient bump keys are dropped from resolved metadata; intent defaults to reduced");
  const legacyAbsolute = Phases.goalsForDay(keys[1], settings);
  ok(legacyAbsolute.kcal === 2300, "legacy absolute day goal derives a calorie adjustment");
  ok(legacyAbsolute.protein === base.protein && legacyAbsolute.sodium === base.sodium && legacyAbsolute.potassium === base.potassium,
    "legacy absolute macro and electrolyte targets are ignored");
  ok(Phases.formatDayPlanSummary({ kcal: 500, protein: 50, sodium: -500 }) === "+500 kcal",
    "energy-adjustment summary contains calories only");

  ok(Analytics.dayPlanProvenance({ dayPlan: { bumps: { kcal: 500 }, plannedAt: endOf(keys[0]) - 7200e3 },
    firstAddAt: endOf(keys[0]) - 3600e3,
  }) === "planned", "plan recorded before first add is planned");
  ok(Analytics.dayPlanProvenance({ dayPlan: { bumps: { kcal: 500 }, plannedAt: endOf(keys[0]) + 3600e3 },
    firstAddAt: endOf(keys[0]),
  }) === "declaredLate", "plan recorded after first add is declaredLate");
  ok(Analytics.dayPlanProvenance({ dayPlan: { bumps: { kcal: 500 }, plannedAt: endOf(keys[0]) - 3600e3 },
    firstAddAt: null,
  }) === "unlogged", "timestamped plan with no food is unlogged, not legacy");
  ok(Analytics.dayPlanProvenance({ dayPlan: { bumps: { kcal: 500 } },
    firstAddAt: endOf(keys[0]),
  }) === "legacy", "no plannedAt is legacy");
  ok(Analytics.dayPlanProvenance({ dayPlan: { intent: "fast", declaredAfterDay: true, plannedAt: 1 },
    firstAddAt: null,
  }) === "declaredLate", "persisted declaredAfterDay is authoritative declaredLate");
  ok(Analytics.dayPlanProvenance({
    dayPlan: {
      intent: "fast", declaredAfterDay: true,
      plannedAt: endOf(keys[0]) - 3600e3,
    },
    firstAddAt: null, intent: "fast", day: keys[0],
  }) === "planned", "false declaredAfterDay stamp is ignored when plannedAt is still on-day");
  ok(Analytics.dayPlanProvenance({
    dayPlan: { intent: "fast", plannedAt: endOf(keys[0]) - 3600e3 },
    firstAddAt: 0, intent: "fast",
  }) === "planned", "firstAddAt: 0 is absent, not Unix epoch late");
  // F2: dayPlanForDay placeholder plannedAt: 0 must not classify as epoch time.
  ok(Analytics.dayPlanProvenance({ dayPlan: { kcal: -200, plannedAt: 0, intent: "reduced" },
    firstAddAt: endOf(keys[0]) - 3600e3,
  }) === "legacy", "plannedAt: 0 is absent, not an on-time plan");
  // F3: equality at the first-add boundary is planned; updatedAt-only is legacy.
  ok(Analytics.dayPlanProvenance({ dayPlan: { bumps: { kcal: 500 }, plannedAt: endOf(keys[0]) - 3600e3 },
    firstAddAt: endOf(keys[0]) - 3600e3,
  }) === "planned", "plannedAt equal to firstAddAt is planned, not late");
  ok(Analytics.dayPlanProvenance({ dayPlan: { bumps: { kcal: 500 }, updatedAt: endOf(keys[0]) + 86400e3 },
    firstAddAt: endOf(keys[0]),
  }) === "legacy", "updatedAt-only records fall through to legacy");
  // R2-b: missing declaration clock is disclosure, not a watch integrity alarm.
  const legacyOnlyDay = Analytics.addDays(END, -5);
  const legacyOnlyDays = Analytics.buildDays({
    keys: [legacyOnlyDay],
    totalsForDay: () => ({ count: 2, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 60 }, fb: { mean: 25 }, na: { mean: 2000 } }),
    goalsForDay: () => ({ ...GOALS, _dayPlan: { kcal: 300, intent: "reduced" }, _phase: GOALS }),
    dayPlanForDay: () => ({ kcal: 2300, updatedAt: endOf(legacyOnlyDay) - 3600e3 }),
    firstAddAt: () => endOf(legacyOnlyDay) - 7200e3,
  });
  const legacyObs = Analytics.observations(legacyOnlyDays, {}).find((o) => o.id === "bumps");
  ok(legacyObs && legacyObs.tone === "info" && /legacy/i.test(legacyObs.text),
    "legacy-only observation stays info (missing clock is not laundering evidence)");

  ok(Analytics.dayPlanProvenance({
    bump: { bumps: { kcal: 500 }, plannedAt: endOf(keys[0]) - 7200e3 },
    firstAddAt: endOf(keys[0]) - 3600e3,
  }) === "legacy", "legacy bump key is not accepted — pass dayPlan");
  ok(Analytics.dayPlanProvenance({
    day: keys[0], goals: GOALS, logged: true, firstAddAt: endOf(keys[0]),
  }) === "legacy", "buildDays row without dayPlan refuses to invent a label");
  // B3: a plan record that itself carries a `day` key must still classify when
  // wrapped as { dayPlan } — duck-typing on the wrapper used to poison this.
  ok(Analytics.dayPlanProvenance({
    dayPlan: {
      day: keys[0], targetKcal: 0, baseKcal: 2000, intent: "fast",
      fastAcknowledged: true, plannedAt: 1, declaredAfterDay: true,
    },
    firstAddAt: null,
  }) === "declaredLate", "dayPlan with a day key still uses declaredAfterDay on the plan");
  // B4: wrapper-level declaredAfterDay alone is not testimony.
  ok(Analytics.dayPlanProvenance({
    dayPlan: { targetKcal: 0, baseKcal: 2000, intent: "fast", plannedAt: 1 },
    declaredAfterDay: true,
    firstAddAt: null,
  }) === "planned", "declaredAfterDay on the wrapper is ignored; only the plan counts");

  const bumps = {
    [keys[2]]: { bumps: { kcal: 500, protein: 50, sodium: -500 }, plannedAt: endOf(keys[2]) - 7200e3, updatedAt: endOf(keys[2]) - 7200e3 },
    [keys[5]]: { bumps: { kcal: 800 }, plannedAt: endOf(keys[5]) + 86400e3, updatedAt: endOf(keys[5]) + 86400e3 },
    [keys[7]]: { bumps: { kcal: 0 }, plannedAt: endOf(keys[7]), updatedAt: endOf(keys[7]) },
    [keys[8]]: { bumps: { protein: 100, sodium: -1000 }, plannedAt: endOf(keys[8]), updatedAt: endOf(keys[8]) },
    // Absolute shape with plannedAt but no firstAdd → unlogged (updatedAt alone would be legacy).
    [keys[9]]: { kcal: 2300, protein: 999, plannedAt: endOf(keys[9]) - 3600e3, updatedAt: endOf(keys[9]) - 3600e3 },
  };
  const firstAdds = {
    [keys[2]]: endOf(keys[2]) - 3600e3,
    [keys[5]]: endOf(keys[5]),
    // No immutable first-add provenance is available for the legacy absolute row.
  };
  const days = Analytics.buildDays({
    keys,
    totalsForDay: () => ({ count: 3, kcal: { mean: 2500 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } }),
    goalsForDay: (d) => d === keys[9]
      ? { ...GOALS, _dayPlan: { kcal: 300 }, _phase: GOALS }
      : GOALS,
    weightKgForDay: () => null,
    dayPlanForDay: (d) => bumps[d] || null,
    firstAddAt: (d) => firstAdds[d] || null,
  });
  const audit = Analytics.dayPlanAudit(days);
  ok(audit.total === 3, "counts only energy adjustments with a non-zero calorie delta", `got ${audit.total}`);
  ok(audit.declaredLate === 1 && audit.planned === 1 && audit.unlogged === 1 && audit.legacy === 0,
    "compares plan time with first-add time; timestamped-with-no-food is unlogged, not legacy");
  ok(audit.kcalTotal === 1600, "sums modern and legacy calorie deltas");
  ok(audit.days.every((r) => r.day && typeof r.declaredLate === "boolean"), "rows carry day and declaredLate flag");
  ok(audit.days.every((r) => Object.keys(r.bumps).length === 1 && Number.isFinite(r.bumps.kcal)),
    "audit sanitizes legacy records to their energy adjustment");
  ok(Analytics.dayPlanAudit(makeDays(keys, () => null)).total === 0, "no bumps, empty audit");
  const completedAudit = Analytics.dayPlanAudit(days, { todayKey: END });
  ok(completedAudit.total === 2 && !completedAudit.days.some((r) => r.day === END),
    "current day is excluded from completed-day adjustment audits");

  const obs = Analytics.observations(days, { todayKey: END });
  const bumpObs = obs.find((o) => o.id === "bumps");
  ok(!!bumpObs, "bumps surface as an observation");
  ok(/day plan/.test(bumpObs.text), "audit wording calls it a day plan");
  ok(bumpObs.tone === "watch", "a declaredLate bump raises the tone");
  ok(bumpObs.priority === 0 && bumpObs.panel == null,
    "bumps is an honesty note: highest priority, no jump panel");
  ok(/after logging began/.test(bumpObs.text) && !/provenance is unknown/.test(bumpObs.text),
    "completed-day observation uses immutable provenance and excludes today's unfinished audit row");

  // S2 regression: a planned day with no food must not be called legacy or watch.
  const unloggedPlanDay = Analytics.addDays(END, -3);
  const loggedNeighbor = Analytics.addDays(END, -2);
  const unloggedDays = Analytics.buildDays({
    keys: [unloggedPlanDay, loggedNeighbor],
    totalsForDay: (day) => day === loggedNeighbor
      ? { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } }
      : { count: 0 },
    goalsForDay: (day) => day === unloggedPlanDay
      ? { ...GOALS, _dayPlan: { kcal: -400, intent: "reduced" }, _phase: GOALS }
      : GOALS,
    dayPlanForDay: (day) => day === unloggedPlanDay
      ? {
          targetKcal: 1600, baseKcal: 2000, plannedAt: endOf(unloggedPlanDay) - 7200e3,
          updatedAt: endOf(unloggedPlanDay) - 7200e3,
        }
      : null,
    firstAddAt: () => null,
  });
  const unloggedAudit = Analytics.dayPlanAudit(unloggedDays);
  ok(unloggedAudit.total === 1 && unloggedAudit.unlogged === 1 && unloggedAudit.legacy === 0 &&
      unloggedAudit.declaredLate === 0,
    "reduced plan with no entries audits as unlogged only");
  const unloggedObs = Analytics.observations(unloggedDays, {}).find((o) => o.id === "bumps");
  ok(unloggedObs && unloggedObs.tone === "info", "unlogged planned day is info, not watch");
  ok(unloggedObs && /recorded no food/.test(unloggedObs.text) && !/legacy/i.test(unloggedObs.text),
    "unlogged copy names the gap and avoids legacy");

  // Guard against over-correcting S2 into silence: still late → still watch.
  const lateReducedDay = Analytics.addDays(END, -4);
  const lateReducedDays = Analytics.buildDays({
    keys: [lateReducedDay],
    totalsForDay: () => ({ count: 2, kcal: { mean: 1800 }, p: { mean: 120 }, c: { mean: 180 }, f: { mean: 60 }, fb: { mean: 25 }, na: { mean: 2000 } }),
    goalsForDay: () => ({ ...GOALS, _dayPlan: { kcal: 500, intent: "reduced" }, _phase: GOALS }),
    dayPlanForDay: () => ({
      targetKcal: 2500, baseKcal: 2000,
      plannedAt: endOf(lateReducedDay) - 1000,
      updatedAt: endOf(lateReducedDay) - 1000,
    }),
    firstAddAt: () => endOf(lateReducedDay) - 7200e3,
  });
  const lateObs = Analytics.observations(lateReducedDays, {}).find((o) => o.id === "bumps");
  ok(lateObs && lateObs.tone === "watch" && /after logging began/.test(lateObs.text),
    "reduced plan after first add still watch + late disclosure");
}

console.log("\n[21] Range comparison");
{
  const mk = (n, kcal, weightFrom, slope) => {
    const keys = keysEndingAt(END, n);
    return makeDays(keys, (k, i) => ({
      kcal, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000,
      weightKg: weightFrom + i * slope,
    }));
  };
  const cur = Analytics.rangeSummary(mk(21, 2000, 80, -0.05), Phases.scoreDayTotals, { todayKey: END });
  const prev = Analytics.rangeSummary(mk(21, 2400, 82, -0.01), Phases.scoreDayTotals, {});
  ok(cur.loggedDays === 21 && cur.coverage === 1, "summary counts logged days");
  approx(cur.kcalAvg, 2000, 1, "summary average intake");
  ok(cur.kgPerWeek < prev.kgPerWeek, "summary picks up the faster loss");
  ok(cur.score != null && cur.targetRate != null, "summary carries the score");

  const rows = Analytics.compareSummaries(cur, prev, { weightUnit: "kg" });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  ok(rows.length === 7, "seven comparison rows");
  ok(byKey.kcal.better === null, "calorie average has no objective direction");
  ok(byKey.rate.better === null, "weight rate has no objective direction");
  ok(byKey.coverage.better === null, "equal coverage is not called better");
  ok(byKey.score.delta != null, "score carries a delta");
  ok(byKey.rate.format(byKey.rate.current).startsWith("-"), "loss formats with a sign");

  const worse = Analytics.compareSummaries(prev, cur, { weightUnit: "kg" });
  ok(worse.find((r) => r.key === "score").better === (prev.score > cur.score), "score direction follows the numbers");
}

console.log("\n[22] Retarget macros for a new calorie goal");
{
  const g = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const up = Analytics.retargetForKcal(g, 2500);
  ok(up.kcal === 2500, "sets the new calorie target");
  ok(up.protein === 150, "protein holds — it tracks body weight, not energy");
  ok(up.fiber === 30 && up.sodium === 2300, "fiber and sodium are independent of calories");
  ok(up.carbs > g.carbs && up.fat > g.fat, "the increase lands on carbs and fat");
  const sum = up.protein * 4 + up.carbs * 4 + up.fat * 9;
  ok(Math.abs(sum - up.kcal) <= 30, "macros still add up to the calories", `sum ${sum} vs ${up.kcal}`);

  const down = Analytics.retargetForKcal(g, 1600);
  ok(down.protein === 150, "protein is protected in a deficit");
  ok(down.carbs < g.carbs && down.fat < g.fat, "the cut lands on carbs and fat");
  const sumD = down.protein * 4 + down.carbs * 4 + down.fat * 9;
  ok(Math.abs(sumD - down.kcal) <= 30, "macros still add up after a cut", `sum ${sumD} vs ${down.kcal}`);

  // Current carb:fat ratio is preserved, not reset to some default.
  const fatty = Analytics.retargetForKcal({ ...g, carbs: 100, fat: 111 }, 2000);
  ok(fatty.fat * 9 > fatty.carbs * 4, "a fat-leaning split stays fat-leaning");

  ok(Analytics.retargetForKcal(g, 1190) === null, "automated targets below 1200 are refused");
  ok(Analytics.retargetForKcal(g, 9000) === null, "automated targets above the supported maximum are refused");
  ok(Analytics.retargetForKcal({ kcal: 2000, protein: 0, carbs: 0, fat: 0 }, 2000).carbs > 0,
    "handles empty macro targets without dividing by zero");
  ok(Analytics.retargetForKcal({ ...g, protein: 250 }, 1200) === null,
    "refuses a target that cannot fit protected protein plus minimum fat");
  const floorFit = Analytics.retargetForKcal({ ...g, protein: 225 }, 1200);
  ok(floorFit && floorFit.protein === 225 && floorFit.fat >= Analytics.MIN_RETARGET_FAT_G,
    "a tight feasible target still protects protein and a defensible fat floor");
  for (const plan of [up, down, fatty, floorFit]) {
    const atwater = plan.protein * 4 + plan.carbs * 4 + plan.fat * 9;
    ok(atwater <= plan.kcal && plan.kcal - atwater <= 3,
      `retargeted macros are Atwater-consistent at ${plan.kcal} kcal`, `macros ${atwater}`);
  }
}


console.log("\n[23] Top foods covers every nutrient");
{
  const keys = keysEndingAt(END, 3);
  const entries = {
    [keys[0]]: [
      { name: "Rice", meal: "lunch", macros: { kcal: 400, p: 8, c: 88, f: 1, fb: 2, na: 5 } },
      { name: "Olive oil", meal: "lunch", macros: { kcal: 240, p: 0, c: 0, f: 27, fb: 0, na: 0 } },
    ],
    [keys[1]]: [
      { name: "Rice", meal: "lunch", macros: { kcal: 400, p: 8, c: 88, f: 1, fb: 2, na: 5 } },
      { name: "Lentils", meal: "dinner", macros: { kcal: 230, p: 18, c: 40, f: 1, fb: 16, na: 4 } },
    ],
    [keys[2]]: [
      { name: "Salted nuts", meal: "snack", macros: { kcal: 300, p: 10, c: 12, f: 26, fb: 4, na: 900 } },
    ],
  };
  const entriesFor = (d) => entries[d] || [];

  // Every metric the UI offers must rank by that metric, not fall back to kcal.
  const top = (m) => Analytics.topFoods(keys, entriesFor, m, 5)[0].name;
  ok(top("kcal") === "Rice", "kcal ranking", `got ${top("kcal")}`);
  ok(top("carbs") === "Rice", "carbs ranking", `got ${top("carbs")}`);
  ok(top("fat") === "Olive oil", "fat ranking is not just kcal again", `got ${top("fat")}`);
  ok(top("fiber") === "Lentils", "fiber ranking", `got ${top("fiber")}`);
  ok(top("sodium") === "Salted nuts", "sodium ranking", `got ${top("sodium")}`);
  ok(top("protein") === "Lentils", "protein ranking", `got ${top("protein")}`);

  const potassiumEntries = {
    [keys[0]]: [
      { name: "High calorie", macros: { kcal: 900, k: 80 } },
      { name: "High potassium", macros: { kcal: 100, k: 900 } },
    ],
  };
  ok(Analytics.topFoods(keys, (d) => potassiumEntries[d] || [], "potassium", 5)[0].name === "High potassium",
    "potassium ranking uses potassium rather than falling back to calories");

  // Shares are computed against that metric's own total, not calories.
  const fat = Analytics.topFoods(keys, entriesFor, "fat", 5);
  // Rice 1 + oil 27 (day 1), rice 1 + lentils 1 (day 2), nuts 26 (day 3).
  const fatTotal = 1 + 27 + 1 + 1 + 26;
  approx(fat[0].pct, 27 / fatTotal, 0.001, "fat share is of total fat, not of calories");
  approx(fat.reduce((s2, r) => s2 + r.pct, 0), 1, 0.001, "fat shares sum to 1");

  ok(Analytics.topFoods(keys, entriesFor, "nonsense", 5)[0].name === "Rice",
    "an unknown metric falls back to calories rather than breaking");
}

console.log("\n[24] Editing a food never rewrites history");
{
  // This is the ledger's core promise, asserted here so a future change to
  // Foods or the entry pipeline cannot quietly break it.
  const Ledger2 = require("../js/ledger.js");
  globalThis.FOOD_DB = require("../js/data-foods.js");
  globalThis.FoodMatch = require("../js/foodmatch.js");
  const Foods = require("../js/foods.js");

  Ledger2.clearAll();
  Ledger2._resetCacheForTests();
  let food = Foods.createFromDraft({
    name: "Chapati", cat: "dish",
    per100: { kcal: 300, p: 9, c: 55, f: 5, fb: 4, na: 300 }, units: { piece: 40 },
  });
  Ledger2.addEntry("2026-07-10", Foods.entryFromQty(food, 100, "g", "lunch"));

  const before = Ledger2.totalsFor("2026-07-10").kcal.mean;
  ok(before === 300, "logged at the original macros", `got ${before}`);

  food = Foods.applyUpdate(food, {
    name: "Chapati", cat: "dish",
    per100: { kcal: 400, p: 9, c: 55, f: 5, fb: 4, na: 300 }, units: { piece: 40 },
  });
  ok(Ledger2.totalsFor("2026-07-10").kcal.mean === 300, "the past day is untouched by the edit");

  Ledger2.addEntry("2026-07-12", Foods.entryFromQty(food, 100, "g", "lunch"));
  ok(Ledger2.totalsFor("2026-07-12").kcal.mean === 400, "days logged after the edit use the new macros");

  const stored = Ledger2.entriesFor("2026-07-10")[0];
  ok(stored.macros.kcal === 300, "the entry stores its own macro snapshot");
  ok(stored.foodVersion === 1, "and the food version it was logged at", `got ${stored.foodVersion}`);
  Ledger2.clearAll();
  Ledger2._resetCacheForTests();
}


console.log("\n[25] Sodium:potassium ratio");
{
  // Molar ratio, not mass — the two differ by 1.70 and confusing them is the
  // standard error in this area.
  approx(Phases.NAK_MASS_TO_MOLAR, 1.7008, 0.001, "mass->molar factor");
  approx(Phases.naKRatio(2000, 3510), 0.969, 0.005, "WHO targets land just under 1.0 molar");
  approx(Phases.naKRatio(3400, 2500), 2.313, 0.01, "typical Western intake is ~2.3");
  approx(Phases.naKRatio(2300, 2300), Phases.NAK_MASS_TO_MOLAR, 0.001, "equal mass is NOT a 1.0 ratio");
  ok(Phases.naKRatio(2000, 0) === null, "zero potassium yields null, not Infinity");
  ok(Phases.naKRatio(2000, null) === null, "unknown potassium yields null");

  // Band direction: a ceiling. Lower is always fine.
  ok(Phases.BANDS.naK.dir === "ceiling", "the ratio is a ceiling");
  ok(Phases.classify(0.4, 1.0, Phases.BANDS.naK) === "hit", "a very low ratio is a hit, never 'under'");
  ok(Phases.classify(2.0, 1.0, Phases.BANDS.naK) === "over", "a high ratio is over");
  ok(Phases.BANDS.potassium.dir === "floor", "potassium is a floor");
  ok(Phases.classify(6000, 3400, Phases.BANDS.potassium) === "hit", "high potassium is never flagged");
}

console.log("\n[26] Potassium coverage gating");
{
  const mkTotals = (kcal, na, kMg, coverage, count) => ({
    count: count == null ? 4 : count,
    kcal: { mean: kcal }, p: { mean: 100 }, c: { mean: 200 }, f: { mean: 60 },
    fb: { mean: 25 }, na: { mean: na }, k: { mean: kMg },
    kCoverage: coverage, kItems: 3,
  });

  ok(Phases.nakCovered(mkTotals(2000, 2300, 3000, 1.0)) === true, "full coverage is usable");
  ok(Phases.nakCovered(mkTotals(2000, 2300, 3000, 0.85)) === true, "85% coverage is usable");
  ok(Phases.nakCovered(mkTotals(2000, 2300, 3000, 0.5)) === false, "half-covered is not");
  ok(Phases.nakCovered(mkTotals(2000, 2300, 0, 1.0)) === false, "zero potassium is not usable");
  ok(Phases.nakCovered({ count: 0 }) === false, "an empty day is not usable");

  // The key property: a thinly covered day must not be scored at all, because
  // missing potassium always biases the ratio upward (worse-looking).
  const goals = { ...GOALS, potassium: 3400, naK: 1.0 };
  const thin = Phases.scoreDayTotals(mkTotals(2000, 2300, 900, 0.3), goals);
  ok(thin.naK.status === "skip", "a thin day skips the ratio rather than reporting a bad one");
  ok(thin.potassium.status === "skip", "and skips potassium too");

  const full = Phases.scoreDayTotals(mkTotals(2000, 2300, 4200, 1.0), goals);
  approx(full.naK.actual, Phases.naKRatio(2300, 4200), 0.001, "a covered day reports the ratio");
  ok(full.naK.status === "hit", "2300 Na with 4200 K is on target", `ratio ${full.naK.actual.toFixed(2)}`);
  ok(full.potassium.status === "hit", "and potassium clears its floor");

  // Same sodium, low potassium -> over.
  const lowK = Phases.scoreDayTotals(mkTotals(2000, 2300, 2000, 1.0), goals);
  ok(lowK.naK.status === "over", "same sodium with low potassium is over", `ratio ${lowK.naK.actual.toFixed(2)}`);
  ok(lowK.potassium.status === "under", "and potassium is short");
}

console.log("\n[26b] Macro coverage (Design Phase 2)");
{
  const goals = { ...GOALS };
  const base = {
    count: 2,
    kcal: { mean: 1000 }, p: { mean: 20 }, c: { mean: 80 }, f: { mean: 30 }, fb: { mean: 5 },
    na: { mean: 1500 }, naCoverage: 1, naItems: 2,
    k: { mean: 2500 }, kCoverage: 1, kItems: 2,
    naKCoverage: 1, naKNa: { mean: 1500 }, naKK: { mean: 2500 },
  };
  const full = { ...base, macroCoverage: 1, macroItems: 2 };
  const thin = { ...base, macroCoverage: 0.4, macroItems: 1 };
  ok(Phases.macrosCovered(full) && !Phases.macrosCovered(thin),
    "macrosCovered mirrors the mineral 0.8 threshold");
  const scoredThin = Phases.scoreDayTotals(thin, goals);
  ok(scoredThin.kcal.status !== "skip" && scoredThin.protein.status === "skip" &&
      scoredThin.carbs.status === "skip" && scoredThin.fat.status === "skip" &&
      scoredThin.fiber.status === "skip",
    "thin macroCoverage skips P/C/F/fiber but still scores calories");
  const scoredFull = Phases.scoreDayTotals(full, goals);
  ok(scoredFull.protein.status !== "skip", "full macroCoverage scores protein");

  const dayKey = "2019-03-01";
  const rows = Analytics.buildDays({
    keys: [dayKey],
    totalsForDay: () => thin,
    goalsForDay: () => goals,
    weightKgForDay: () => 80,
  });
  ok(rows[0].kcal === 1000 && rows[0].protein == null && rows[0].carbs == null &&
      rows[0].fat == null && rows[0].fiber == null && rows[0].macrosCovered === false,
    "buildDays keeps kcal and nulls macros when coverage fails");

  // TDEE intake must stay byte-identical whether macros are covered or not.
  const keys = [dayKey, "2019-03-02", "2019-03-03"];
  const weights = { [dayKey]: 80, "2019-03-02": 79.9, "2019-03-03": 79.8 };
  const mkRows = (macroCoverage) => Analytics.buildDays({
    keys,
    totalsForDay: () => ({ ...full, macroCoverage, macroItems: macroCoverage >= 0.8 ? 2 : 1 }),
    goalsForDay: () => goals,
    weightKgForDay: (d) => weights[d],
  });
  const tdeeFull = Analytics.estimateTdee(mkRows(1));
  const tdeeThin = Analytics.estimateTdee(mkRows(0.3));
  ok(tdeeFull.intakeAvg === tdeeThin.intakeAvg && tdeeFull.tdee === tdeeThin.tdee,
    "TDEE intake/tdee unchanged when macros are incomplete",
    `full=${tdeeFull.intakeAvg}/${tdeeFull.tdee} thin=${tdeeThin.intakeAvg}/${tdeeThin.tdee}`);

  const macroNote = Analytics.observations(mkRows(0.3), {}).find((o) => o.id === "macro-incomplete");
  ok(!!macroNote && /without complete macros/.test(macroNote.text) && macroNote.priority === 0 &&
      macroNote.panel === "#today-day-detail" && macroNote.jumpDay === dayKey,
    "observations emit macro-incomplete honesty note that opens Today contribution",
    macroNote && JSON.stringify(macroNote));
  ok(!Analytics.observations(mkRows(1), {}).some((o) => o.id === "macro-incomplete"),
    "fully covered macros emit no macro-incomplete note");
}

console.log("\n[26b] Mark incomplete excludes day from averages / TDEE / consistency");
{
  const keys = ["2019-04-01", "2019-04-02", "2019-04-03"];
  const weights = { "2019-04-01": 80, "2019-04-02": 79.9, "2019-04-03": 79.8 };
  const totals = (kcal) => ({
    count: 2,
    kcal: { mean: kcal }, p: { mean: 120 }, c: { mean: 200 }, f: { mean: 60 },
    fb: { mean: 25 }, na: { mean: 1800 }, naCoverage: 1, naItems: 2,
    k: { mean: 3000 }, kCoverage: 1, kItems: 2,
    macroCoverage: 1, macroItems: 2,
    naKCoverage: 1, naKItems: 2, naKNa: { mean: 1800 }, naKK: { mean: 3000 },
  });
  const goals = { ...GOALS };
  const dayGoals = {
    "2019-04-02": { incomplete: true, excludeReason: "incomplete", updatedAt: 1 },
  };
  const rows = Analytics.buildDays({
    keys,
    totalsForDay: (d) => totals(d === "2019-04-02" ? 400 : 2000),
    goalsForDay: () => goals,
    weightKgForDay: (d) => weights[d],
    dayPlanForDay: (d) => dayGoals[d] || null,
  });
  ok(rows[1].excluded === true && rows[1].excludeReason === "incomplete" && rows[1].logged,
    "buildDays sets excluded from incomplete dayGoal while keeping logged");
  ok(rows[0].excluded !== true && rows[2].excluded !== true,
    "unmarked days are not excluded");

  const stats = Analytics.summaryStats(rows, "kcal");
  ok(stats.n === 2 && Math.round(stats.avg) === 2000,
    "summaryStats drops marked-incomplete days",
    JSON.stringify(stats));

  const tdee = Analytics.estimateTdee(rows);
  ok(tdee.rangeDays === 2 && tdee.loggedDays === 2 && Math.round(tdee.intakeAvg) === 2000,
    "estimateTdee drops excluded days from intake and coverage calendar",
    JSON.stringify({ rangeDays: tdee.rangeDays, loggedDays: tdee.loggedDays, intakeAvg: tdee.intakeAvg }));

  const cons = Analytics.consistency(rows);
  ok(cons.totalDays === 2 && cons.loggedDays === 2 && !cons.missedDays.includes("2019-04-02"),
    "consistency leaves excluded days out of the scored calendar",
    JSON.stringify(cons));

  const note = Analytics.observations(rows, {}).find((o) => o.id === "excluded-days");
  ok(!!note && /marked incomplete/.test(note.text) && note.priority === 0,
    "observations disclose excluded days",
    note && note.text);

  const scorecard = Phases.scoreRange(
    keys,
    (d) => totals(d === "2019-04-02" ? 400 : 2000),
    { goals, dayGoals, phases: [] },
  );
  ok(scorecard.logged === 2,
    "scoreRange skips incomplete days",
    JSON.stringify({ logged: scorecard.logged }));
}

console.log("\n[27] Exactly one mineral-composite slot");
{
  const keys = keysEndingAt(END, 14);
  const goals = { ...GOALS, potassium: 3400, naK: 1.0 };
  const build = (kMg, kCoverage, jointCoverage) => Analytics.buildDays({
    keys,
    totalsForDay: () => ({
      count: 4,
      kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 },
      fb: { mean: 30 }, na: { mean: 2000 }, naCoverage: 1, naItems: 4,
      k: { mean: kMg }, kCoverage, kItems: kCoverage >= 0.8 ? 4 : 0,
      naKNa: { mean: 2000 }, naKK: { mean: kMg },
      naKCoverage: jointCoverage == null ? Math.min(1, kCoverage) : jointCoverage,
      naKItems: jointCoverage >= 0.8 ? 4 : 2,
    }),
    goalsForDay: () => goals,
    weightKgForDay: () => null,
  });

  const covered = Analytics.nutritionScore(build(3600, 1.0, 1.0), Phases.scoreDayTotals, { todayKey: END });
  const keys2 = covered.nutrients.map((n) => n.key);
  ok(keys2.includes("naK") && covered.nutrients.find((n) => n.key === "naK").mode === "joint",
    "joint-covered days score one composite requiring ratio plus both absolutes");
  ok(!keys2.includes("sodium") && !keys2.includes("potassium"),
    "sodium and potassium do not create extra headline slots");

  const uncovered = Analytics.nutritionScore(build(0, 0, 0), Phases.scoreDayTotals, { todayKey: END });
  const keys3 = uncovered.nutrients.map((n) => n.key);
  ok(!keys3.includes("naK") && !keys3.includes("sodium") && !keys3.includes("potassium"),
    "one incomplete absolute mineral skips the composite instead of awarding sodium alone");

  const absolute = Analytics.nutritionScore(build(3600, 1.0, 0.5), Phases.scoreDayTotals, { todayKey: END });
  const absoluteRow = absolute.nutrients.find((n) => n.key === "naK");
  ok(absoluteRow && absoluteRow.mode === "absolute" && absoluteRow.hit === absoluteRow.n,
    "without joint coverage, both independently complete absolutes can earn the same single slot");

  // Weights renormalize to 1 either way.
  const sum = (r) => r.nutrients.reduce((a, n) => a + n.weight, 0);
  approx(sum(covered), 1, 0.0001, "covered weights sum to 1");
  approx(sum(uncovered), 0.9, 0.0001, "skipped mineral slot is absent from the raw breakdown");
  ok(uncovered.score === 100, "remaining target weights are renormalized when mineral coverage is incomplete");
  approx(sum(absolute), 1, 0.0001, "absolute-mineral weights sum to 1");
}

console.log("\n[28] Potassium is nullable end to end");
{
  globalThis.FOOD_DB = require("../js/data-foods.js");
  globalThis.FoodMatch = require("../js/foodmatch.js");
  const FoodMatch = globalThis.FoodMatch;
  const Ledger3 = require("../js/ledger.js");

  // computeMacros must propagate null, never coerce it to 0.
  const known = FoodMatch.computeMacros({ kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 200, k: 300 }, 200);
  ok(known.k === 600, "known potassium scales with grams", `got ${known.k}`);
  const unknown = FoodMatch.computeMacros({ kcal: 100, p: 5, c: 10, f: 2, fb: 1, na: 200 }, 200);
  ok(unknown.k === null, "absent potassium stays null, not 0", `got ${JSON.stringify(unknown.k)}`);
  const explicitZero = FoodMatch.computeMacros({ kcal: 900, p: 0, c: 0, f: 100, fb: 0, na: 0, k: 0 }, 100);
  ok(explicitZero.k === 0, "a genuine zero stays zero (oil really has none)");

  // Ledger coverage: a day of half-known foods must report ~50%.
  Ledger3.clearAll(); Ledger3._resetCacheForTests();
  const day = "2026-07-20";
  Ledger3.addEntry(day, { name: "Known", grams: 100, displayQty: "100 g", sd: 0.1, macros: { kcal: 500, p: 10, c: 50, f: 10, fb: 5, na: 300, k: 400 } });
  Ledger3.addEntry(day, { name: "Unknown", grams: 100, displayQty: "100 g", sd: 0.1, macros: { kcal: 500, p: 10, c: 50, f: 10, fb: 5, na: 300, k: null } });
  const t = Ledger3.totalsFor(day);
  ok(t.k.mean === 400, "potassium sums only the known entries", `got ${t.k.mean}`);
  approx(t.kCoverage, 0.5, 0.001, "coverage is the calorie share with known potassium");
  ok(t.kItems === 1, "and counts the known items");
  ok(Phases.nakCovered(t) === false, "a half-covered day is refused");
  ok(t.na.mean === 600, "sodium still totals every entry");
  Ledger3.clearAll(); Ledger3._resetCacheForTests();
}

console.log("\n[29] Catalog potassium sanity");
{
  const DB = require("../js/data-foods.js");
  ok(DB.every((f) => Number.isFinite(f.per100.k)), "every catalog food has a potassium value");
  ok(DB.every((f) => f.per100.k >= 0 && f.per100.k <= 2000), "all values are within a physically plausible range");

  const by = (id) => DB.find((f) => f.id === id).per100.k;
  // Directional checks against well-established relationships. These would
  // catch a transposed or misplaced value without asserting false precision.
  ok(by("spinach") > 400, "cooked spinach is potassium-dense");
  ok(by("potato") > 350 && by("sweet-potato") > 350, "potatoes are potassium-dense");
  ok(by("banana") > 300, "banana is potassium-dense");
  ok(by("dates") > 500 && by("raisins") > 600, "dried fruit concentrates potassium");
  ok(by("white-rice") < 60, "white rice is nearly potassium-free");
  ok(by("olive-oil") < 10 && by("ghee") < 20, "pure fats carry almost none");
  ok(by("lentils") > 300 && by("kidney-beans") > 350, "legumes are a strong source");
  ok(by("almonds") > 600 && by("peanut-butter") > 500, "nuts and nut butters are dense");
  ok(by("chicken-breast") > 200 && by("salmon") > 300, "meat and fish carry meaningful amounts");

  // The point of the whole feature: rice dilutes the ratio, beans improve it.
  ok(Phases.naKRatio(by("white-rice") * 0 + 1, by("white-rice")) > 0, "rice ratio computable");
  const riceK = by("white-rice"), beanK = by("kidney-beans");
  ok(beanK > riceK * 5, "beans carry many times the potassium of rice per 100 g");
}


console.log("\n[30] Which lever to pull");
{
  // Sodium and potassium milligrams are not interchangeable units of effort:
  // adding a food is easier to sustain than stripping salt out of meals you
  // already eat. So "whichever number is smaller" is the wrong rule, and the
  // deciding question is whether sodium is acceptable on its own terms.
  const naGoal = 2300;
  const ok2 = (na) => Phases.classify(na, naGoal, Phases.BANDS.sodium) === "hit";
  ok(ok2(2100), "2100 mg is within the sodium ceiling");
  ok(!ok2(3400), "3400 mg is not");

  const F = Phases.NAK_MASS_TO_MOLAR;
  const raiseK = (na, k) => Math.max(0, na * F / 1.0 - k);
  const cutNa = (na, k) => Math.max(0, na - k * 1.0 / F);

  // The user's own case: sodium fine, potassium short. The raw mg gap is
  // LARGER on the potassium side (972 vs 571), so a naive smaller-number rule
  // would wrongly tell them to cut sodium.
  approx(raiseK(2100, 2600), 972, 5, "potassium gap in the real-world case");
  approx(cutNa(2100, 2600), 571, 5, "sodium gap looks smaller in raw mg");
  ok(raiseK(2100, 2600) > cutNa(2100, 2600),
    "the naive rule would pick the wrong lever here — hence the sodium-first check");

  // Both routes genuinely land on the target.
  approx(Phases.naKRatio(2100, 2600 + raiseK(2100, 2600)), 1.0, 0.01, "raising potassium reaches 1.0");
  approx(Phases.naKRatio(2100 - cutNa(2100, 2600), 2600), 1.0, 0.01, "cutting sodium also reaches 1.0");
}

console.log("\n[31] Honest sodium completeness and exact ratio boundary");
{
  ok(Phases.naKRatio(null, 3000) === null, "unknown sodium cannot become a 0.00 ratio");
  ok(Phases.naKRatio("", 3000) === null, "blank sodium cannot become a 0.00 ratio");
  ok(Phases.naKRatio(-1, 3000) === null, "negative sodium is invalid");
  ok(Phases.classify(1.0, 1.0, Phases.BANDS.naK) === "hit", "ratio target boundary is inclusive");
  ok(Phases.classify(1.001, 1.0, Phases.BANDS.naK) === "over", "ratio above target is over without a hidden 10% grace band");

  const totals = {
    count: 2,
    kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 },
    na: { mean: 0 }, naCoverage: 0, naItems: 0,
    k: { mean: 3600 }, kCoverage: 1, kItems: 2,
  };
  ok(!Phases.sodiumCovered(totals), "explicitly unknown sodium is not covered");
  ok(!Phases.nakCovered(totals), "ratio requires sodium as well as potassium coverage");
  const scored = Phases.scoreDayTotals(totals, { ...GOALS, potassium: 3400, naK: 1 });
  ok(scored.sodium.status === "skip" && scored.naK.status === "skip", "unknown sodium skips both sodium and ratio scoring");
  ok(scored.potassium.status === "hit", "independently covered potassium still scores its floor");

  const legacy = { ...totals, na: { mean: 2000 } };
  delete legacy.naCoverage;
  ok(Phases.sodiumCovered(legacy), "legacy numeric totals without a coverage field remain compatible");

  const callout = Phases.callouts({
    logged: 4,
    nutrients: [{ key: "potassium", label: "Potassium", hit: 0, under: 4, over: 0, avgDelta: -900, n: 4 }],
  });
  ok(/900 mg short/.test(callout.need || ""), "potassium callouts use milligrams, not grams", callout.need);
}

console.log("\n[32] Shared sodium score slot and current-day grace");
{
  const keys = keysEndingAt(END, 10);
  const goals = { ...GOALS, potassium: 3400, naK: 1 };
  const days = Analytics.buildDays({
    keys,
    totalsForDay: (day) => {
      const jointMiss = day === keys[0];
      return {
        count: 4,
        kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 },
        na: { mean: 2000 }, naCoverage: 1, naItems: 4,
        k: { mean: jointMiss ? 1000 : 4000 }, kCoverage: 1, kItems: 4,
        naKNa: { mean: 2000 }, naKK: { mean: jointMiss ? 1000 : 4000 },
        naKCoverage: jointMiss ? 1 : 0.5, naKItems: jointMiss ? 4 : 2,
      };
    },
    goalsForDay: () => goals,
  });
  const mixed = Analytics.nutritionScore(days, Phases.scoreDayTotals, {});
  const handling = mixed.nutrients.find((n) => n.key === "naK" || n.key === "sodium");
  ok(handling && handling.mode === "mixed", "mixed ranges expose one mineral-composite row");
  ok(handling && handling.n === 10 && handling.hit === 9, "one shared tally spans joint and both-absolute days");
  approx(mixed.nutrients.reduce((sum, n) => sum + n.weight, 0), 1, 0.0001,
    "mixed ranges count the 0.10 sodium slot only once");
  ok(mixed.score === 99, "one sodium-handling miss costs about one point", `got ${mixed.score}`);

  const highBoth = Analytics.buildDays({
    keys,
    totalsForDay: () => ({
      count: 4,
      kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 },
      // The ratio is favorable (~0.85) only because potassium is also huge;
      // absolute sodium still exceeds its independent ceiling.
      na: { mean: 4000 }, naCoverage: 1, naItems: 4,
      k: { mean: 8000 }, kCoverage: 1, kItems: 4,
      naKNa: { mean: 4000 }, naKK: { mean: 8000 }, naKCoverage: 1, naKItems: 4,
    }),
    goalsForDay: () => goals,
  });
  const strict = Analytics.nutritionScore(highBoth, Phases.scoreDayTotals, {});
  const strictHandling = strict.nutrients.find((n) => n.key === "naK");
  ok(strictHandling && strictHandling.ratioHits === 10, "covered days record that the ratio itself cleared");
  ok(strictHandling && strictHandling.hit === 0 && strictHandling.absoluteSodiumHits === 0 && strictHandling.potassiumHits === 10,
    "a favorable ratio cannot mask an exceeded absolute sodium ceiling");
  approx(strict.nutrients.reduce((sum, n) => sum + n.weight, 0), 1, 0.0001,
    "strict ratio+sodium safety still occupies one shared score slot");

  const mineralDays = (dayGoals, overrides) => Analytics.buildDays({
    keys,
    totalsForDay: () => ({
      count: 4,
      kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 },
      na: { mean: 4000 }, naCoverage: 1, naItems: 4,
      k: { mean: 8000 }, kCoverage: 1, kItems: 4,
      naKNa: { mean: 4000 }, naKK: { mean: 8000 }, naKCoverage: 1, naKItems: 4,
      ...(overrides || {}),
    }),
    goalsForDay: () => dayGoals,
  });
  const sodiumDisabled = Analytics.nutritionScore(
    mineralDays({ ...goals, sodium: 0 }), Phases.scoreDayTotals, {});
  const sodiumDisabledRow = sodiumDisabled.nutrients.find((n) => n.key === "naK");
  ok(sodiumDisabledRow && sodiumDisabledRow.hit === sodiumDisabledRow.n,
    "a zero sodium target stays disabled instead of becoming a permanent composite miss");

  const potassiumDisabled = Analytics.nutritionScore(
    mineralDays({ ...goals, potassium: 0 }, {
      na: { mean: 2000 }, naKNa: { mean: 2000 },
    }), Phases.scoreDayTotals, {});
  const potassiumDisabledRow = potassiumDisabled.nutrients.find((n) => n.key === "naK");
  ok(potassiumDisabledRow && potassiumDisabledRow.hit === potassiumDisabledRow.n,
    "a zero potassium target stays disabled instead of becoming a permanent composite miss");

  const allMineralsDisabled = Analytics.nutritionScore(
    mineralDays({ ...goals, sodium: 0, potassium: 0, naK: 0 }), Phases.scoreDayTotals, {});
  ok(!allMineralsDisabled.nutrients.some((n) => n.key === "naK"),
    "the composite drops out when every mineral constraint is explicitly disabled");

  const enabledPotassiumUncovered = Analytics.nutritionScore(
    mineralDays({ ...goals, sodium: 0 }, {
      kCoverage: 0.5, kItems: 2, naKCoverage: 0.5, naKItems: 2,
    }), Phases.scoreDayTotals, {});
  ok(!enabledPotassiumUncovered.nutrients.some((n) => n.key === "naK"),
    "an enabled but uncovered mineral skips the composite coherently");

  const partialToday = makeDays(keysEndingAt(END, 7), (day) => day === END
    ? { kcal: 300, protein: 10, carbs: 30, fat: 5, fiber: 2, sodium: 200, items: 1 }
    : { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, items: 4 });
  const withGrace = Analytics.nutritionScore(partialToday, Phases.scoreDayTotals, { todayKey: END });
  const withoutGrace = Analytics.nutritionScore(partialToday, Phases.scoreDayTotals, {});
  ok(withGrace.consistency.loggedDays === 7, "logged today still counts toward consistency");
  ok(withGrace.nutrients.find((n) => n.key === "protein").n === 6, "today is excluded from target misses until complete");
  ok(withGrace.score > withoutGrace.score, "an unfinished current day does not depress adherence");
  const todayHeatmap = Analytics.heatmapCells(partialToday, "protein", Phases.scoreDayTotals, { todayKey: END });
  ok(todayHeatmap[todayHeatmap.length - 1].status === "logged",
    "heatmap audit shows today as logged without grading it hit/under/over");
  const scoreTotals = Object.fromEntries(partialToday.map((d) => [d.day, {
    count: d.itemCount,
    kcal: { mean: d.kcal }, p: { mean: d.protein }, c: { mean: d.carbs },
    f: { mean: d.fat }, fb: { mean: d.fiber }, na: { mean: d.sodium },
  }]));
  const currentExcluded = Phases.scoreRange(
    partialToday.map((d) => d.day),
    (day) => scoreTotals[day],
    { goals: GOALS, phases: [], dayGoals: {}, weights: {} },
    { excludeDay: END }
  );
  const currentProtein = currentExcluded.nutrients.find((n) => n.key === "protein");
  ok(currentExcluded.logged === 6 && currentProtein.n === 6 && currentProtein.hit === 6,
    "scorecard target ranges also exclude a logged current day consistently");
}

console.log("\n[33] Phase overlap and revision conflict safety");
{
  const settings = { goals: { ...GOALS }, phases: [], dayGoals: {}, weights: {} };
  const replacement = Phases.startPhase(settings, {
    kind: "cut", goals: { ...GOALS, kcal: 1800 }, startDay: "2026-08-03", copyGoals: false,
  });
  const active = settings.phases.filter((p) => !p.archived && p.endDay == null);
  ok(active.length === 1 && active[0].id === replacement.id, "starting again on the same day leaves one active phase");
  ok(Phases.phaseForDay(settings.phases, "2026-08-03").id === replacement.id, "same-day replacement owns that date");

  const base = {
    id: "ph-sync", name: "Maintain v1.1", kind: "maintain", startDay: "2026-07-01", endDay: null,
    createdAt: 1, updatedAt: 20, revisions: [
      { id: "r1", effectiveFrom: "2026-07-01", goals: { ...GOALS, kcal: 2000 }, createdAt: 1, updatedAt: 10 },
      { id: "r2", effectiveFrom: "2026-07-15", goals: { ...GOALS, kcal: 2100 }, createdAt: 2, updatedAt: 20 },
    ],
  };
  const staleRemote = JSON.parse(JSON.stringify(base));
  const localSettings = { goals: { ...GOALS }, phases: [JSON.parse(JSON.stringify(base))], dayGoals: {}, weights: {} };
  Phases.deleteRevision(localSettings, "ph-sync", "r2", "2026-08-03");
  const mergedDeleted = Phases.mergePhases(localSettings.phases, [staleRemote])[0];
  ok(!mergedDeleted.revisions.some((r) => r.id === "r2"), "revision tombstone prevents stale remote resurrection");

  const older = { ...base, revisions: [{ ...base.revisions[0], goals: { ...GOALS, kcal: 1900 }, updatedAt: 30 }] };
  const newer = { ...base, revisions: [{ ...base.revisions[0], goals: { ...GOALS, kcal: 2300 }, updatedAt: 40 }] };
  const mergedLww = Phases.mergePhases([older], [newer])[0];
  ok(mergedLww.revisions.find((r) => r.id === "r1").goals.kcal === 2300,
    "same-id revision merge uses revision-level last-write-wins");
}

console.log("\n[34] Day-intent: reduced-day retargeting and the protein exemption");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300, potassium: 3510 };

  ok(Phases.proteinScorableOnPlan(1425, 150) === true && Phases.proteinScorableOnPlan(1424, 150) === false,
    "150 g protein floor is scorable at 1425 kcal and unscored one kcal below");
  ok(Phases.proteinScorableOnPlan(1140, 120) === true && Phases.proteinScorableOnPlan(1139, 120) === false,
    "120 g protein floor is scorable at 1140 kcal and unscored one kcal below");

  // 1200 kcal on a 2000/P150 phase: protein floor needs 570 kcal, the plan
  // allows only 480 (1200 * 0.40) — protein is unscored, but carbs/fat still
  // retarget (well above MIN_AUTOMATED_KCAL) and land Atwater-consistent.
  const settings1200 = { goals: phaseGoals, phases: [], dayGoals: {
    "2026-08-01": { targetKcal: 1200, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true },
  } };
  const g1200 = Phases.goalsForDay("2026-08-01", settings1200);
  ok(g1200._unscored && g1200._unscored.protein && !g1200._unscored.carbs && !g1200._unscored.fat,
    "1200 kcal plan unscores protein but still retargets carbs and fat");
  const atwater1200 = g1200.protein * 4 + g1200.carbs * 4 + g1200.fat * 9;
  ok(atwater1200 <= g1200.kcal && g1200.kcal - atwater1200 <= 3,
    "reduced-day carbs/fat stay within retargetForKcal's own Atwater tolerance");
  ok(g1200.protein === phaseGoals.protein, "the displayed protein target does not change on a reduced day");

  // retargetForKcal rounds to the nearest 10, so a target that is not itself a
  // multiple of 10 derives macros that can overshoot it by up to 5 kcal. New
  // plans are rounded at the save boundary in app.js so this cannot arise, but
  // an already-stored legacy record is never rewritten to make it go away —
  // pin the tolerance instead of pretending it is exact.
  const settings1505 = { goals: phaseGoals, phases: [], dayGoals: {
    "2026-08-09": { targetKcal: 1505, baseKcal: 2000, updatedAt: 1 },
  } };
  const g1505 = Phases.goalsForDay("2026-08-09", settings1505);
  const atwater1505 = g1505.protein * 4 + g1505.carbs * 4 + g1505.fat * 9;
  ok(Math.abs(atwater1505 - 1505) <= 5,
    "a non-round legacy plan stays within the documented 5 kcal Atwater tolerance",
    `macros ${atwater1505} vs 1505`);
  const settings1500 = { goals: phaseGoals, phases: [], dayGoals: {
    "2026-08-10": { targetKcal: 1500, baseKcal: 2000, updatedAt: 1 },
  } };
  const g1500 = Phases.goalsForDay("2026-08-10", settings1500);
  const atwater1500 = g1500.protein * 4 + g1500.carbs * 4 + g1500.fat * 9;
  ok(atwater1500 <= 1500 && 1500 - atwater1500 <= 3,
    "a rounded plan — what the save boundary now produces — is exact to within 3 kcal",
    `macros ${atwater1500} vs 1500`);

  // 500 kcal is below MIN_AUTOMATED_KCAL, so retargetForKcal itself returns
  // null — carbs and fat are unscored too, alongside protein. Only kcal,
  // fiber and minerals remain meaningful claims at this energy.
  const settings500 = { goals: phaseGoals, phases: [], dayGoals: {
    "2026-08-05": { targetKcal: 500, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true },
  } };
  const g500 = Phases.goalsForDay("2026-08-05", settings500);
  ok(g500._unscored.protein && g500._unscored.carbs && g500._unscored.fat,
    "a 500 kcal plan unscores protein, carbs and fat");
  ok(g500.fiber === phaseGoals.fiber && g500.sodium === phaseGoals.sodium && g500.potassium === phaseGoals.potassium,
    "fiber, sodium and potassium hold at their phase value and stay scored at 500 kcal");

  // scoreDayTotals: the unscored cells carry skipReason "unscored-plan"; a
  // coverage skip (no potassium logged, nothing to do with the plan) never
  // does — the two facts must never be conflated.
  const totals500 = {
    count: 3, kcal: { mean: 500 }, p: { mean: 60 }, c: { mean: 50 }, f: { mean: 15 }, fb: { mean: 20 },
    na: { mean: 1500 },
  };
  const scored500 = Phases.scoreDayTotals(totals500, g500);
  ok(scored500.protein.status === "skip" && scored500.protein.skipReason === "unscored-plan",
    "protein cell skips with skipReason unscored-plan on a 500 kcal day");
  ok(scored500.potassium.status === "skip" && scored500.potassium.skipReason === undefined,
    "a missing-coverage skip (no potassium logged) never carries the unscored-plan reason");

  // Part VII.1 regression: healLoggedDayGoals writes a {targetKcal ===
  // baseKcal, locked: true} record for every logged day, even when the plan
  // changed nothing. dayPlanForDay returns a non-null record for that day, so
  // without the resolved.kcal === fromPhase.kcal gate in goalsForDay, this
  // would silently retarget carbs/fat (and evaluate the protein floor)
  // against a healed no-op — drifting past hit rates the user never planned.
  // This must be exercised with the real Analytics.retargetForKcal wired in
  // (globalThis.Analytics, set at the top of this file) — the "Analytics
  // absent" fallback used to make this gate look correct without ever
  // calling retargetForKcal at all (Part VII.8).
  const settingsLockedNoOp = { goals: phaseGoals, phases: [], dayGoals: {
    "2026-08-06": { targetKcal: 2000, baseKcal: 2000, updatedAt: 1, locked: true },
  } };
  const gLockedNoOp = Phases.goalsForDay("2026-08-06", settingsLockedNoOp);
  ok(gLockedNoOp.kcal === phaseGoals.kcal && gLockedNoOp.carbs === phaseGoals.carbs &&
      gLockedNoOp.fat === phaseGoals.fat && gLockedNoOp.protein === phaseGoals.protein &&
      gLockedNoOp._unscored === null,
    "a locked no-op healed record resolves byte-identically to the phase goals, with no exemption");
}

console.log("\n[35] Day-intent: nutritionScore exemption reporting");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 10);
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const k of keys) settings.dayGoals[k] = { targetKcal: 1200, baseKcal: 2000, updatedAt: 1, veryLowCalorieAcknowledged: true };
  const planGoals = Phases.goalsForDay(keys[0], settings); // identical plan every day
  ok(planGoals._unscored && planGoals._unscored.protein, "fixture sanity: the 1200 kcal plan exempts protein");

  // Fiber deliberately falls short every day so the targets component is not
  // already pinned at a ceiling — otherwise "never credits" would be trivially
  // true just because both scores hit the same 100% cap.
  const totalsFor = () => ({
    count: 3, kcal: { mean: 1200 }, p: { mean: 60 }, c: { mean: planGoals.carbs },
    f: { mean: planGoals.fat }, fb: { mean: 20 }, na: { mean: 2000 },
  });
  const exemptDays = Analytics.buildDays({
    keys, totalsForDay: totalsFor, goalsForDay: (day) => Phases.goalsForDay(day, settings),
  });
  const exemptScore = Analytics.nutritionScore(exemptDays, Phases.scoreDayTotals, {});
  const proteinRow = exemptScore.nutrients.find((n) => n.key === "protein");
  ok(proteinRow && proteinRow.n === 0 && proteinRow.exemptN === keys.length,
    "a range where protein is exempt every day still emits a protein row, with n === 0 and exemptN set");
  ok(proteinRow.hitRate === null,
    "an exempt-only row reports hitRate null, not 0 — indistinguishable from a real miss otherwise");
  ok(!exemptScore.nutrients.some((n) => n.n === 0 && exemptScore.gap && exemptScore.gap.key === n.key),
    "biggestGap never returns a nutrient whose n === 0");
  ok(exemptScore.gap == null || exemptScore.gap.key !== "protein",
    "the exempt protein row is never surfaced as the biggest gap");

  // Mineral composite gets the same disclosure (Part VII.6). A real fast day
  // has near-zero mineral coverage by nature — black coffee carries no logged
  // sodium or potassium — so naK skips on coverage before it ever reaches the
  // plan exemption, and the coverage-skip guard (Part VII.10) refuses to
  // stamp skipReason on a cell that would have skipped anyway. Both facts
  // genuinely apply here (Part VIII.4): the row must still surface with
  // exemptN even though nothing in this fixture hand-supplies coverage.
  const fastKeys = keysEndingAt(END, 3);
  const fastSettings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const k of fastKeys) {
    fastSettings.dayGoals[k] = { targetKcal: 0, baseKcal: 2000, updatedAt: 1, intent: "fast", fastAcknowledged: true };
  }
  const fastGoals = Phases.goalsForDay(fastKeys[0], fastSettings);
  ok(fastGoals._unscored && fastGoals._unscored.naK, "fixture sanity: a declared fast exempts naK");
  const fastDays = Analytics.buildDays({
    keys: fastKeys,
    // Black coffee: logged (count > 0) but with no known sodium/potassium at
    // all — naCoverage 0 is what a real fast day looks like, not the naCoverage
    // 1 the old fixture hand-supplied to dodge the coverage-skip path.
    totalsForDay: () => ({
      count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 },
      na: { mean: 0 }, naCoverage: 0,
    }),
    goalsForDay: (day) => Phases.goalsForDay(day, fastSettings),
  });
  const fastScore = Analytics.nutritionScore(fastDays, Phases.scoreDayTotals, {});
  const mineralRow = fastScore.nutrients.find((n) => n.key === "naK");
  ok(mineralRow && mineralRow.n === 0 && mineralRow.exemptN === fastKeys.length,
    "the mineral composite still emits a row on an all-fast range with real (zero) mineral coverage, exemptN set by the plan fact even though coverage also skipped");
  ok(mineralRow.hitRate === null,
    "the mineral composite's exempt-only row reports hitRate null, not 0");
  // Part VIII.3: every scored-key row on this range is exempt (n === 0), so
  // parts.targets is null with exempt rows present. Consistency alone must
  // not be allowed to carry the score to a perfect 100/grade A — that would
  // be an unjustified perfect for a range with zero scored target cells.
  ok(fastScore.parts.targets == null, "fixture sanity: an all-fast range has no scored target cells");
  ok(fastScore.score === null && fastScore.grade === "No data yet",
    "an all-exempt range scores null with the grade suppressed, not 100/grade A from zero scored targets");

  // Same totals, but protein is scored (not exempt) against a target the
  // actual genuinely meets — "exemption removes, never credits" means this
  // must score at least as high as the exempt version, never lower.
  const hitDays = Analytics.buildDays({
    keys, totalsForDay: totalsFor,
    goalsForDay: () => ({ kcal: 1200, protein: 60, carbs: planGoals.carbs, fat: planGoals.fat, fiber: 30, sodium: 2300, _unscored: null }),
  });
  const hitScore = Analytics.nutritionScore(hitDays, Phases.scoreDayTotals, {});
  ok(hitScore.score > exemptScore.score,
    "scoring the identical days with protein actually hit outscores exempting it — exemption never credits a phantom hit");
}

console.log("\n[36] Day-intent: a declared fast scores no target cells");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const settings = { goals: phaseGoals, phases: [], dayGoals: {
    "2026-08-01": { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 },
  } };
  const fastGoals = Phases.goalsForDay("2026-08-01", settings);
  const fastTotals = {
    count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 },
  };
  // scoreDayTotals mechanism only — buildDays does not yet know a fast from
  // an ordinary day (that day-accounting layer is Slice 3, out of scope
  // here). This confirms the *scoring* half of the contract in isolation.
  const scoredFast = Phases.scoreDayTotals(fastTotals, fastGoals);
  for (const key of ["kcal", "protein", "carbs", "fat", "fiber", "naK"]) {
    ok(scoredFast[key].status === "skip", `a declared fast's ${key} cell is skip, not a miss`);
  }

  const keys = keysEndingAt(END, 5);
  const normalTotals = () => ({
    count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 },
  });
  const mixedDays = Analytics.buildDays({
    keys,
    totalsForDay: (day) => (day === keys[0] ? fastTotals : normalTotals()),
    goalsForDay: (day) => (day === keys[0] ? fastGoals : phaseGoals),
  });
  const allNormalDays = Analytics.buildDays({
    keys, totalsForDay: normalTotals, goalsForDay: () => phaseGoals,
  });
  const mixedScore = Analytics.nutritionScore(mixedDays, Phases.scoreDayTotals, {});
  const normalScore = Analytics.nutritionScore(allNormalDays, Phases.scoreDayTotals, {});
  ok(mixedScore.parts.targets === normalScore.parts.targets,
    "swapping one ordinary day for a fully-unscored fast day does not move the targets component");
}

console.log("\n[37] Day-intent: HUD and Insights resolve a fast identically (Part VIII.5)");
{
  // ui.js's updateHUD and Phases.scoreDayTotals used to each decide for
  // themselves whether a declared fast that recorded food should still read
  // as unscored — scoreDayTotals could see the totals and reconcile it,
  // updateHUD could not. Phases.effectiveGoals is now the one implementation
  // both call, so testing it directly proves the two tabs cannot disagree.
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300, potassium: 3510 };
  const settings = { goals: phaseGoals, phases: [], dayGoals: {
    "2026-08-12": { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 },
  } };
  const fastGoals = Phases.goalsForDay("2026-08-12", settings);

  const scenarios = {
    // (a) declared fast, no food at all.
    noFood: { count: 0, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 } },
    // (b) declared fast, zero-kcal coffee only — logged, but still a fast.
    coffee: { count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 } },
    // (c) declared fast, 1800 kcal actually eaten — the data beats the plan.
    ateBig: { count: 3, kcal: { mean: 1800 }, p: { mean: 90 }, c: { mean: 180 }, f: { mean: 60 }, fb: { mean: 20 }, na: { mean: 1500 } },
  };

  const noFoodGoals = Phases.effectiveGoals(scenarios.noFood, fastGoals);
  ok(noFoodGoals === fastGoals, "no food: the HUD's resolved goals are the declared-fast goals, unscored intact");
  ok(Phases.scoreDayTotals(scenarios.noFood, fastGoals) === null,
    "no food: Insights never reaches the per-day scoring loop (count 0) — nothing to disagree about");

  const coffeeGoals = Phases.effectiveGoals(scenarios.coffee, fastGoals);
  ok(coffeeGoals === fastGoals, "coffee only: the HUD's resolved goals stay the declared-fast goals");
  const coffeeScored = Phases.scoreDayTotals(scenarios.coffee, fastGoals);
  ok(coffeeScored.protein.status === "skip" && coffeeScored.protein.exemptByPlan === true,
    "coffee only: Insights also keeps every non-kcal cell an exempt skip — the two tabs agree it is still a fast");

  const ateGoals = Phases.effectiveGoals(scenarios.ateBig, fastGoals);
  ok(ateGoals === fastGoals._phase && ateGoals._unscored == null,
    "ate on a fast: the HUD's resolved goals revert to the phase targets, with no unscored reason left");
  const ateScored = Phases.scoreDayTotals(scenarios.ateBig, fastGoals);
  ok(ateScored.protein.status !== "skip" && !ateScored.protein.exemptByPlan &&
      ateScored.protein.target === fastGoals._phase.protein,
    "ate on a fast: Insights scores protein against the real phase target too — the two tabs agree");
  ok(ateScored.kcal.target === fastGoals._phase.kcal,
    "ate on a fast: the kcal target itself reverts to the phase number in both places, not the declared 0");
}

console.log("\n[38] Day-intent: the kcal cell gets the same exemption disclosure as every other nutrient (Part IX.3)");
{
  // §9.2 used to read "every non-kcal key" — kcal relied on classify()'s own
  // zero-target skip and never got exemptByPlan, so nutritionScore counted it
  // in neither n nor exempt. On a mixed range that just silently under-counts
  // kcal's n; on an all-fast range the row disappears outright, the same
  // §VI.2 failure VII.6 closed for the mineral composite, one nutrient over.
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 5);
  const fastDaySet = new Set([keys[0], keys[1]]); // 2 fasts, 3 ordinary days
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const k of fastDaySet) {
    settings.dayGoals[k] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  const normalTotals = () => ({
    count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 },
  });
  const fastTotals = () => ({
    count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 },
  });
  const mixedDays = Analytics.buildDays({
    keys,
    totalsForDay: (day) => (fastDaySet.has(day) ? fastTotals() : normalTotals()),
    goalsForDay: (day) => Phases.goalsForDay(day, settings),
  });
  const mixedScore = Analytics.nutritionScore(mixedDays, Phases.scoreDayTotals, {});
  const kcalRow = mixedScore.nutrients.find((n) => n.key === "kcal");
  ok(kcalRow && kcalRow.exemptN === 2,
    "on a mixed range (3 normal + 2 fasts), the kcal row discloses exemptN like every other nutrient");
  ok(kcalRow && kcalRow.n === 3, "kcal is still scored on the 3 ordinary days");

  const allFastKeys = keysEndingAt(END, 2);
  const allFastSettings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const k of allFastKeys) {
    allFastSettings.dayGoals[k] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  const allFastDays = Analytics.buildDays({
    keys: allFastKeys, totalsForDay: fastTotals,
    goalsForDay: (day) => Phases.goalsForDay(day, allFastSettings),
  });
  const allFastScore = Analytics.nutritionScore(allFastDays, Phases.scoreDayTotals, {});
  const allFastKcalRow = allFastScore.nutrients.find((n) => n.key === "kcal");
  ok(allFastKcalRow && allFastKcalRow.n === 0 && allFastKcalRow.exemptN === allFastKeys.length,
    "an all-fast range still emits a kcal row instead of dropping it, with n 0 and exemptN set");
  ok(allFastKcalRow && allFastKcalRow.hitRate === null,
    "the all-exempt kcal row reports hitRate null, not 0");
}

console.log("\n[39] Day-intent X.1: a floor under the score (VIII.3 one day short)");
{
  // VIII.3 only suppresses the grade when parts.targets is null, i.e. zero
  // scored days. A range that is mostly declared fasts plus a single real
  // eating day has n:1 on every weighted row — one real day, not zero — so
  // VIII.3's own gate does not fire, and a single perfect day drags the
  // whole range to a false 100 while nine fasts ride along for free on the
  // 30% consistency component. This reproduces that exact shape through the
  // real Phases.goalsForDay + Analytics.buildDays + Analytics.nutritionScore
  // pipeline, not a hand-built fixture.
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 10);
  const eatingDay = keys[keys.length - 1];
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const k of keys) {
    if (k === eatingDay) continue;
    settings.dayGoals[k] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  const fastTotals = { count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 } };
  const perfectTotals = { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  const days = Analytics.buildDays({
    keys,
    totalsForDay: (day) => (day === eatingDay ? perfectTotals : fastTotals),
    goalsForDay: (day) => Phases.goalsForDay(day, settings),
  });
  const score = Analytics.nutritionScore(days, Phases.scoreDayTotals, {});
  ok(score.score !== 100, "9 declared fasts plus a single perfect eating day must not grade a perfect 100 off n:1 evidence per nutrient", `got ${score.score}`);
  ok(score.grade !== "Dialed in", "the top grade is not earned on a single real day propped up by fasted consistency credit", `got ${score.grade}`);

  // A range with real evidence at or above the floor must be unaffected —
  // this is not a blanket "exempt ranges never score" rule, only a minimum
  // evidence bar per weighted row.
  const threeEatingKeys = new Set(keys.slice(-3));
  const settings2 = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const k of keys) {
    if (threeEatingKeys.has(k)) continue;
    settings2.dayGoals[k] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  const days2 = Analytics.buildDays({
    keys,
    totalsForDay: (day) => (threeEatingKeys.has(day) ? perfectTotals : fastTotals),
    goalsForDay: (day) => Phases.goalsForDay(day, settings2),
  });
  const score2 = Analytics.nutritionScore(days2, Phases.scoreDayTotals, {});
  ok(score2.score === 100, "3 real perfect days clear the evidence floor and still grade 100", `got ${score2.score}`);
}

console.log("\n[40] Day-intent: consistency credits fasts (§11)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 10);
  // Two true (zero-food) fasts, one coffee-only fast, one reduced day, six
  // normal logged days, one genuinely missed day.
  const trueFastDays = new Set([keys[0], keys[1]]);
  const coffeeFastDay = keys[2];
  const reducedDay = keys[3];
  const missedDay = keys[4];
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const d of [...trueFastDays, coffeeFastDay]) {
    settings.dayGoals[d] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  settings.dayGoals[reducedDay] = { targetKcal: 500, baseKcal: 2000, veryLowCalorieAcknowledged: true, updatedAt: 1 };
  const normalTotals = { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  const reducedTotals = { count: 2, kcal: { mean: 480 }, p: { mean: 40 }, c: { mean: 40 }, f: { mean: 15 }, fb: { mean: 10 }, na: { mean: 600 } };
  const coffeeTotals = { count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 } };
  const totalsForDay = (day) => {
    if (trueFastDays.has(day)) return { count: 0 };
    if (day === coffeeFastDay) return coffeeTotals;
    if (day === reducedDay) return reducedTotals;
    if (day === missedDay) return { count: 0 };
    return normalTotals;
  };
  const days = Analytics.buildDays({
    keys, totalsForDay, goalsForDay: (day) => Phases.goalsForDay(day, settings),
  });

  // buildDays itself: intent and accounted per §11's table.
  const rowFor = (d) => days.find((r) => r.day === d);
  ok(rowFor(keys[0]).intent === "fast" && rowFor(keys[0]).accounted === true && rowFor(keys[0]).logged === false,
    "a true fast is accounted but not logged");
  ok(rowFor(coffeeFastDay).intent === "fast" && rowFor(coffeeFastDay).accounted === true && rowFor(coffeeFastDay).logged === true,
    "a zero-kcal-item fast is both accounted and logged");
  ok(rowFor(reducedDay).intent === "reduced" && rowFor(reducedDay).accounted === true,
    "a reduced day is accounted");
  ok(rowFor(missedDay).intent === null && rowFor(missedDay).accounted === false,
    "an undeclared blank day is neither logged nor accounted");
  ok(Analytics.accountedRows(days).length === 9, "accountedRows includes both fasts and the reduced day, excludes the miss",
    `got ${Analytics.accountedRows(days).length}`);
  ok(Analytics.loggedRows(days).length === 7, "loggedRows is unchanged: still means has-food only",
    `got ${Analytics.loggedRows(days).length}`);

  const cons = Analytics.consistency(days, {});
  ok(cons.totalDays === 10, "all ten days are scored (no grace day in range)");
  ok(cons.loggedDays === 9, "consistency's loggedDays now counts accounted days", `got ${cons.loggedDays}`);
  ok(cons.missedDays.length === 1 && cons.missedDays[0] === missedDay, "only the truly blank day is missed");
  ok(cons.fastedDays === 3, "fastedDays counts both true fasts and the coffee-only fast", `got ${cons.fastedDays}`);
  approx(cons.rate, 0.9, 0.001, "consistency rate credits fasts");
}

console.log("\n[41] Day-intent: estimateTdee includes fasts at 0 kcal and in coverage (§11)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 21);
  const fastDays = new Set([keys[3], keys[10], keys[17]]);
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const d of fastDays) {
    settings.dayGoals[d] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  const normalTotals = { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  const days = Analytics.buildDays({
    keys,
    totalsForDay: (day) => (fastDays.has(day) ? { count: 0 } : normalTotals),
    goalsForDay: (day) => Phases.goalsForDay(day, settings),
    weightKgForDay: (day, i) => 80 - keys.indexOf(day) * 0.02,
  });
  const tdee = Analytics.estimateTdee(days, {});
  ok(tdee.loggedDays === 18, "estimateTdee's loggedDays field stays literal food-logged days", `got ${tdee.loggedDays}`);
  approx(tdee.coverage, 21 / 21, 0.001, "coverage counts accounted days (18 logged + 3 fasts) over the full range");
  // 18 real days at 2000 plus 3 fasts at 0 must pull the average down from
  // 2000 — if the fasts were merely excluded (not added as 0) the average
  // would stay exactly 2000.
  ok(tdee.intakeAvg < 2000 && tdee.intakeAvg > 1000,
    "intakeAvg is dragged down by fasts counted as 0, not left at the eating-day average", `got ${tdee.intakeAvg}`);
  approx(tdee.intakeAvg, (2000 * 18) / 21, 1, "intakeAvg matches 18 real days plus 3 zeros over 21");
}

console.log("\n[42] Day-intent: partialDays excludes every declared day (H3)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 14);
  // A 5:2 pattern: two declared 500 kcal days per week, single-item logs,
  // which is exactly the shape partialDays used to flag as a forgotten log.
  const reducedDays = new Set([keys[2], keys[5], keys[9], keys[12]]);
  const undeclaredStub = keys[7]; // a genuinely forgotten log — still flagged
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const d of reducedDays) {
    settings.dayGoals[d] = { targetKcal: 500, baseKcal: 2000, veryLowCalorieAcknowledged: true, updatedAt: 1 };
  }
  const normalTotals = { count: 4, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  const reducedTotals = { count: 1, kcal: { mean: 480 }, p: { mean: 30 }, c: { mean: 40 }, f: { mean: 15 }, fb: { mean: 8 }, na: { mean: 500 } };
  const stubTotals = { count: 1, kcal: { mean: 260 }, p: { mean: 10 }, c: { mean: 30 }, f: { mean: 8 }, fb: { mean: 2 }, na: { mean: 300 } };
  const days = Analytics.buildDays({
    keys,
    totalsForDay: (day) => {
      if (reducedDays.has(day)) return reducedTotals;
      if (day === undeclaredStub) return stubTotals;
      return normalTotals;
    },
    goalsForDay: (day) => Phases.goalsForDay(day, settings),
  });
  const p = Analytics.partialDays(days);
  ok(p.flagged.length === 1 && p.flagged[0].day === undeclaredStub,
    "only the undeclared single-item day is flagged; the four declared 5:2 days are not",
    JSON.stringify(p.flagged));

  // This is what unblocks estimateTdee's actionProblems for a 5:2 user.
  const tdee = Analytics.estimateTdee(days, {});
  ok(tdee.partialLogDays === 1, "estimateTdee sees only the one real partial day, not the declared plan");

  // healLoggedDayGoals writes {targetKcal === baseKcal, locked: true} for every
  // logged day. That must not masquerade as intent "reduced" and silence the gate.
  for (const d of keys) {
    if (reducedDays.has(d)) continue;
    settings.dayGoals[d] = {
      targetKcal: 2000, baseKcal: 2000, updatedAt: 1, locked: true, lockedByEventId: `e-${d}`,
    };
  }
  const healedDays = Analytics.buildDays({
    keys,
    totalsForDay: (day) => {
      if (reducedDays.has(day)) return reducedTotals;
      if (day === undeclaredStub) return stubTotals;
      return normalTotals;
    },
    goalsForDay: (day) => Phases.goalsForDay(day, settings),
  });
  const stubRow = healedDays.find((r) => r.day === undeclaredStub);
  ok(stubRow && stubRow.intent == null,
    "a healed no-op lock is not a reduced-day declaration",
    stubRow && stubRow.intent);
  const healedPartial = Analytics.partialDays(healedDays);
  ok(healedPartial.flagged.length === 1 && healedPartial.flagged[0].day === undeclaredStub,
    "after heal, the undeclared stub is still flagged; locked no-ops do not blind partialDays",
    JSON.stringify(healedPartial.flagged));
  ok(healedDays.filter((r) => reducedDays.has(r.day)).every((r) => r.intent === "reduced"),
    "real energy plans still resolve as intent reduced after neighbouring days are healed");
}

console.log("\n[43] Day-intent: dayPlanAudit separates fasts from energy adjustments (H4)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 8);
  const reducedDay = keys[1];   // real +/- kcal adjustment
  const fastDay = keys[3];      // declared fast, on time
  const lateFastDay = keys[5];  // declared fast, after the day ended
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  settings.dayGoals[reducedDay] = {
    targetKcal: 2500, baseKcal: 2000, plannedAt: 1, updatedAt: 1,
  };
  settings.dayGoals[fastDay] = {
    targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true,
    plannedAt: 1, updatedAt: 1,
  };
  settings.dayGoals[lateFastDay] = {
    targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true,
    plannedAt: Phases.endOfLocalDayMs(lateFastDay) + 1,
    updatedAt: Phases.endOfLocalDayMs(lateFastDay) + 1,
    declaredAfterDay: true,
  };
  const totalsForDay = (day) => {
    if (day === fastDay || day === lateFastDay) return { count: 0 };
    return { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  };
  const days = Analytics.buildDays({
    keys, totalsForDay, goalsForDay: (day) => Phases.goalsForDay(day, settings),
    dayPlanForDay: (day) => settings.dayGoals[day] || null,
  });
  const audit = Analytics.dayPlanAudit(days);
  ok(audit.total === 1, "only the reduced day counts as an energy adjustment", `got ${audit.total}`);
  ok(audit.kcalTotal === 500, "a fast's delta is never summed into kcalTotal — no -2200 per fast", `got ${audit.kcalTotal}`);
  ok(audit.fasts === 2, "both fasts are counted, separately from adjustments", `got ${audit.fasts}`);
  ok(audit.fastsDeclaredAfterDay === 1, "exactly one fast was declared after its day ended", `got ${audit.fastsDeclaredAfterDay}`);
  ok(audit.fastDays.find((f) => f.day === lateFastDay).provenance === "declaredLate",
    "late fast provenance comes from dayPlanProvenance as declaredLate");
  ok(audit.fastDays.find((f) => f.day === fastDay).provenance === "planned",
    "on-time fast provenance is planned");
  // Mixed fixture: reduced has plannedAt but no firstAddAt in this builder → unlogged.
  ok(audit.days[0].provenance === "unlogged",
    "reduced day without firstAddAt classifies as unlogged via the shared helper");

  const obs = Analytics.observations(days, {});
  const bumpObs = obs.find((o) => o.id === "bumps");
  ok(bumpObs && bumpObs.text.indexOf("2") === -1 || !/2 days? used a day plan/.test((bumpObs || {}).text || ""),
    "the bumps observation does not call a fast a day plan", (bumpObs || {}).text);
  const fastObs = obs.find((o) => o.id === "fasts");
  ok(!!fastObs, "a separate fasts observation is surfaced");
  ok(/2 declared fasts/.test(fastObs.text), "the fasts observation names the count", fastObs.text);
  ok(/1 of these were declared after the day ended/.test(fastObs.text), "the fasts observation surfaces the late one", fastObs.text);
}

console.log("\n[44] Day-intent: scoreRange/callouts wording does not overclaim (H1)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300, potassium: 3510 };
  const keys = keysEndingAt(END, 13);
  const fastDays = new Set([keys[2], keys[5], keys[8], keys[11]]);
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  for (const d of fastDays) {
    settings.dayGoals[d] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  const totalsForDay = (day) => fastDays.has(day)
    ? { count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 } }
    : { count: 3, kcal: { mean: 1500 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  const scorecard = Phases.scoreRange(keys, totalsForDay, settings, {});
  ok(scorecard.logged === 13, "the header count includes the 4 coffee-only fasts (they did log something)");
  const kcalRow = scorecard.nutrients.find((n) => n.key === "kcal");
  ok(kcalRow.n === 9 && kcalRow.exemptN === 4,
    "kcal is only scored on the 9 real eating days; the 4 fasts are disclosed as exempt, not silently dropped",
    JSON.stringify(kcalRow));
  const calls = Phases.callouts(scorecard);
  ok(/scored days/.test(calls.need) && !/logged days/.test(calls.need),
    "the callout names the scored-day count, not the logged-day count it doesn't match", calls.need);
  ok(/9 of 9 scored days/.test(calls.need), "the sentence is now internally consistent: 9 of 9 scored", calls.need);
}

console.log("\n[45] Day-intent: kcalBalance references the phase target and includes fasts at 0 (H2/Q6)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 3);
  const trueFastDay = keys[0];
  const refeedDay = keys[1];
  const normalDay = keys[2];
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  settings.dayGoals[trueFastDay] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  // A +500 refeed, planned and eaten exactly to plan.
  settings.dayGoals[refeedDay] = { targetKcal: 2500, baseKcal: 2000, plannedAt: 1, updatedAt: 1 };
  const totalsForDay = (day) => {
    if (day === trueFastDay) return { count: 0 };
    if (day === refeedDay) return { count: 3, kcal: { mean: 2500 }, p: { mean: 150 }, c: { mean: 260 }, f: { mean: 80 }, fb: { mean: 30 }, na: { mean: 2000 } };
    return { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  };
  const bal = Phases.kcalBalance(keys, totalsForDay, settings);
  ok(bal.n === 3, "the true fast is now included (accounted, not just logged)", `n=${bal.n}`);
  // Old bug: refeed contributed (2500-2500)=0, hiding a real +500 surplus.
  // New: references _phase.kcal (2000), so it contributes the true +500.
  // Fast contributes (0 - 2000) = -2000. Normal day contributes 0.
  // sum = 0 (fast) + 500 (refeed) + 0 (normal) = -2000 + 500 + 0 = -1500.
  ok(bal.sum === -1500, "sum reflects phase-referenced deltas: fast -2000, refeed +500, normal 0", `got ${bal.sum}`);
}

console.log("\n[46] Day-intent: heatmap marks fasts; typical target uses phase kcal (H7/H9)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 5);
  const fastDay = keys[1];
  const coffeeFast = keys[2];
  const reducedDay = keys[3];
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  settings.dayGoals[fastDay] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  settings.dayGoals[coffeeFast] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  settings.dayGoals[reducedDay] = { targetKcal: 1200, baseKcal: 2000, veryLowCalorieAcknowledged: true, updatedAt: 1 };
  const totalsForDay = (day) => {
    if (day === fastDay) return { count: 0 };
    if (day === coffeeFast) return { count: 1, kcal: { mean: 0 }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 } };
    if (day === reducedDay) return { count: 2, kcal: { mean: 1200 }, p: { mean: 80 }, c: { mean: 80 }, f: { mean: 40 }, fb: { mean: 20 }, na: { mean: 1000 } };
    return { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } };
  };
  const days = Analytics.buildDays({
    keys, totalsForDay, goalsForDay: (day) => Phases.goalsForDay(day, settings),
  });
  const cells = Analytics.heatmapCells(days, "kcal", Phases.scoreDayTotals);
  const byDay = Object.fromEntries(cells.map((c) => [c.day, c]));
  ok(byDay[fastDay].status === "fast", "true empty fast is hm-fast, not empty/not-logged", byDay[fastDay].status);
  ok(byDay[coffeeFast].status === "fast", "zero-kcal logged fast is still hm-fast", byDay[coffeeFast].status);
  ok(byDay[keys[0]].status !== "fast" && byDay[keys[0]].status !== "empty", "ordinary eating day is graded, not fast");

  // Without phaseKcalOf, the range mean would be dragged by the 0-kcal fast targets.
  const rawMean = Analytics.mean(days.map((d) => (d.goals || {}).kcal));
  const phaseMean = Analytics.mean(days.map((d) => Analytics.phaseKcalOf(d)));
  ok(rawMean < 2000, "sanity: raw resolved kcal averages below phase because of 0-kcal fasts", `got ${rawMean}`);
  approx(phaseMean, 2000, 0.5, "phaseKcalOf keeps the typical-target average at the phase baseline");
  const summary = Analytics.rangeSummary(days, Phases.scoreDayTotals, {});
  approx(summary.kcalGoal, 2000, 0.5, "rangeSummary.kcalGoal uses the phase reference, not the 0 plan target");
}

console.log("\n[47] Day-intent: reverted fast keeps marker; observations + TDEE disclose (§11)");
{
  const phaseGoals = { kcal: 2000, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2300 };
  const keys = keysEndingAt(END, 6);
  const emptyFast = keys[1];
  const ateFast = keys[2];
  const settings = { goals: phaseGoals, phases: [], dayGoals: {} };
  settings.dayGoals[emptyFast] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  settings.dayGoals[ateFast] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  const totalsForDay = (day) => {
    if (day === emptyFast) return { count: 0 };
    if (day === ateFast) {
      return {
        count: 2, kcal: { mean: 3000 }, p: { mean: 150 }, c: { mean: 300 }, f: { mean: 100 }, fb: { mean: 30 },
        na: { mean: 5200 }, naCoverage: 1, k: { mean: 3510 }, kCoverage: 1, naKCoverage: 1,
        naKNa: { mean: 5200 }, naKK: { mean: 3510 },
      };
    }
    return {
      count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 },
      na: { mean: 2000 }, naCoverage: 1, k: { mean: 3510 }, kCoverage: 1, naKCoverage: 1,
      naKNa: { mean: 2000 }, naKK: { mean: 3510 },
    };
  };
  const days = Analytics.buildDays({
    keys, totalsForDay, goalsForDay: (day) => Phases.goalsForDay(day, settings),
    dayPlanForDay: (day) => settings.dayGoals[day] || null,
  });
  const cells = Analytics.heatmapCells(days, "kcal", Phases.scoreDayTotals);
  const ateCell = cells.find((c) => c.day === ateFast);
  ok(ateCell.fasted === true && ateCell.status !== "fast",
    "a reverted fast keeps the declaration marker while grading as an ordinary day",
    JSON.stringify({ status: ateCell.status, fasted: ateCell.fasted }));

  // effectiveGoals path that Na:K card must use: ate-fast is NOT unscored.
  const ateGoals = Phases.goalsForDay(ateFast, settings);
  const ateTotals = Analytics.toTotalsLike(days.find((d) => d.day === ateFast));
  const resolved = Phases.effectiveGoals(ateTotals, ateGoals);
  ok(!(resolved && resolved._unscored && resolved._unscored.sodium),
    "effectiveGoals clears sodium unscored on a declared fast that recorded food");
  const emptyGoals = Phases.goalsForDay(emptyFast, settings);
  ok(emptyGoals._unscored && emptyGoals._unscored.sodium,
    "sanity: an empty honoured fast still has sodium unscored");

  const obs = Analytics.observations(days, {});
  const fastObs = obs.find((o) => o.id === "fasts");
  ok(fastObs && /recorded food/.test(fastObs.text),
    "observations names declared fasts that recorded food", fastObs && fastObs.text);

  const allFastKeys = [keys[0], keys[1], keys[2]];
  for (const d of allFastKeys) {
    settings.dayGoals[d] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  const allFastDays = Analytics.buildDays({
    keys: allFastKeys,
    totalsForDay: () => ({ count: 0 }),
    goalsForDay: (day) => Phases.goalsForDay(day, settings),
    dayPlanForDay: (day) => settings.dayGoals[day] || null,
  });
  const allFastObs = Analytics.observations(allFastDays, {});
  ok(allFastObs.some((o) => o.id === "fasts"),
    "an all-fast range still emits the fasts observation", JSON.stringify(allFastObs));

  // Restore mixed settings for TDEE field check via a fresh range with weights.
  const tdeeKeys = keysEndingAt(END, 14);
  const tdeeSettings = { goals: phaseGoals, phases: [], dayGoals: {}, weights: {} };
  const tdeeFasts = new Set([tdeeKeys[2], tdeeKeys[5]]);
  for (const d of tdeeFasts) {
    tdeeSettings.dayGoals[d] = { targetKcal: 0, baseKcal: 2000, intent: "fast", fastAcknowledged: true, updatedAt: 1 };
  }
  for (let i = 0; i < tdeeKeys.length; i++) {
    tdeeSettings.weights[tdeeKeys[i]] = { kg: 80 - i * 0.05, updatedAt: 1 };
  }
  const tdeeDays = Analytics.buildDays({
    keys: tdeeKeys,
    totalsForDay: (day) => tdeeFasts.has(day)
      ? { count: 0 }
      : { count: 3, kcal: { mean: 2000 }, p: { mean: 150 }, c: { mean: 200 }, f: { mean: 65 }, fb: { mean: 30 }, na: { mean: 2000 } },
    goalsForDay: (day) => Phases.goalsForDay(day, tdeeSettings),
    weightKgForDay: (day) => (tdeeSettings.weights[day] && tdeeSettings.weights[day].kg) || null,
  });
  const tdee = Analytics.estimateTdee(tdeeDays, {});
  ok(tdee.fastedDays === 2, "estimateTdee exposes fastedDays for the TDEE card byline", `got ${tdee.fastedDays}`);
  ok(tdee.loggedDays === 12, "loggedDays stays eating-day count", `got ${tdee.loggedDays}`);
}

console.log("\n[onceDays] One-off / quick disclosure (Step 9)");
{
  const keys = ["2024-01-01", "2024-01-02", "2024-01-03"];
  const byDay = {
    "2024-01-01": [
      { source: "once", macros: { kcal: 400 } },
      { source: "label", macros: { kcal: 600 } },
    ],
    "2024-01-02": [
      { source: "quick", macros: { kcal: 250 } },
    ],
    "2024-01-03": [
      { source: "library", macros: { kcal: 1800 } },
    ],
  };
  const r = Analytics.onceDays(keys, (day) => byDay[day] || []);
  ok(r.n === 2, "counts days with once or quick entries", `got ${r.n}`);
  ok(r.onceKcal === 650 && r.dayKcal === 1250, "sums once kcal vs day kcal on those days",
    `once=${r.onceKcal} day=${r.dayKcal}`);
  approx(r.share, 0.52, 0.01, "share is onceKcal / dayKcal across flagged days");
  ok(r.days[0].share === 0.4, "per-day share for mixed once+library day");
  ok(Analytics.onceDays(keys, () => [{ source: "library", macros: { kcal: 100 } }]).n === 0,
    "library-only range reports n:0");
  ok(Analytics.onceDays([], () => []).n === 0, "empty keys → empty result");
  ok(Analytics.onceDays(keys, (day) => byDay[day] || [], { excludeDay: "2024-01-02" }).n === 1,
    "onceDays opts.excludeDay skips that day from the disclosure set");

  const days = Analytics.buildDays({
    keys,
    totalsForDay: (day) => {
      const kcal = (byDay[day] || []).reduce((s, e) => s + e.macros.kcal, 0);
      return kcal
        ? { count: 1, kcal: { mean: kcal }, p: { mean: 0 }, c: { mean: 0 }, f: { mean: 0 }, fb: { mean: 0 }, na: { mean: 0 } }
        : { count: 0 };
    },
    goalsForDay: () => ({ ...GOALS }),
  });
  const withNote = Analytics.observations(days, { entriesForDay: (day) => byDay[day] || [] });
  const note = withNote.find((o) => o.id === "once-days");
  ok(!!note && note.priority === 0 && /2 days include one-off/.test(note.text),
    "observations emit honesty once-days note when entriesForDay is provided",
    note && note.text);
  ok(!Analytics.observations(days, {}).some((o) => o.id === "once-days"),
    "without entriesForDay, once-days note is omitted");
  const stats = Analytics.summaryStats(days, "kcal");
  ok(stats.n === 3, "once/quick days remain in underlying stats (disclose, never drop)");
}

console.log(`\nanalytics: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
