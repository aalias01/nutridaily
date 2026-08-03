/* NutriDaily analytics tests — run with: node tests/test-analytics.js
 * Covers the derived layer: trend weight, adaptive TDEE, rollups, consistency,
 * scoring, breakdowns. Everything here is pure, so fixtures are hand-checkable.
 */
const Analytics = require("../js/analytics.js");
const Phases = require("../js/phases.js");

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
  approx(sLowP.parts.protein, 0, 0.001, "protein component zero when always short");

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
    return { kcal: weekend ? 3000 : 1900, protein: 150, carbs: 200, fat: 65, fiber: 30, sodium: 2000, weightKg: 75 };
  });
  const obs = Analytics.observations(days, { todayKey: END });
  ok(obs.some((o) => o.id === "weekend-kcal"), "surfaces the weekend calorie gap");
  ok(obs.some((o) => o.id === "protein-per-kg"), "surfaces protein per kg");
  ok(obs.every((o) => o.text && o.tone), "every observation has text and a tone");
  ok(obs.every((o) => !/should|bad|failed|too much/i.test(o.text)), "observations stay descriptive, not scolding");

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
  ok(sHigh.parts.protein === 1, "score: high protein is full marks");
  ok(sHigh.score >= sModest.score - 1, "score: exceeding floors is not penalised versus hitting them exactly",
    `high ${sHigh.score} vs modest ${sModest.score}`);
}

console.log(`\nanalytics: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
