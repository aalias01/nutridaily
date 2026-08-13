#!/usr/bin/env node
/**
 * Generate js/sample-seed.js — synthetic ~90-day Sample profile for first-run demo.
 * Run: node scripts/generate-sample-seed.js
 * Does not use personal exports. Dates are relative to an anchor day; runtime
 * shifts them so the log ends on "today".
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

function loadBrowserModule(rel, assignName) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  const sandbox = { console, module: { exports: {} }, exports: {} };
  vm.createContext(sandbox);
  vm.runInContext(src + `\nthis.__export = (typeof ${assignName} !== "undefined") ? ${assignName} : module.exports;`, sandbox);
  return sandbox.__export;
}

const FOOD_DB = loadBrowserModule("js/data-foods.js", "FOOD_DB");
const FoodMatch = loadBrowserModule("js/foodmatch.js", "FoodMatch");

const CATALOG_IDS = [
  "egg", "banana", "apple", "oatmeal", "bread-ww", "bread-white", "peanut-butter",
  "coffee-black", "greek-yogurt-nonfat", "chicken-breast", "chicken-thigh",
  "white-rice", "brown-rice", "broccoli", "spinach", "potato", "sweet-potato",
  "salmon", "tuna-canned", "ground-beef", "pasta", "tortilla-flour", "black-beans",
  "avocado", "olive-oil", "milk-2", "cheddar", "whey-protein", "cottage-cheese",
  "cereal", "orange", "strawberries", "almonds", "soda", "beer", "hummus",
  "turkey-breast", "bagel", "latte", "mayo", "butter", "corn", "grapes",
  "coffee-milk",
];

function dayKeyFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(dayKey, n) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dayKeyFromDate(new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uid(rand, prefix) {
  return `${prefix}-${Math.floor(rand() * 1e9).toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function macrosFromPer100(per100, grams) {
  return FoodMatch.computeMacros(per100, grams);
}

function buildPersonalFoods(rand, resetEpoch, createdAt) {
  const foods = [];
  const byCatalog = Object.create(null);
  for (const id of CATALOG_IDS) {
    const db = FOOD_DB.find((f) => f.id === id);
    if (!db) continue;
    const pf = {
      id: `pf-sample-${id}`,
      name: db.name,
      aliases: [...(db.aliases || [])],
      cat: db.cat || "dish",
      per100: { ...db.per100 },
      units: { ...(db.units || {}) },
      logAs: db.units && +db.units.piece > 0 ? "piece" : "grams",
      countLabel: db.units && +db.units.piece > 0 ? "piece" : null,
      batch: null,
      recipe: { ingredients: [], prep: "", notes: "Sample catalog copy" },
      confidence: "high",
      sd: 0.08,
      version: 1,
      history: [],
      raw: "",
      createdAt,
      updatedAt: createdAt,
      lastUsedAt: 0,
      useCount: 0,
      source: "personal",
      catalogId: db.id,
      deleted: false,
      resetEpoch,
    };
    foods.push(pf);
    byCatalog[id] = pf;
  }
  // One homemade-style dish for My Foods richness
  const chili = {
    id: "pf-sample-homemade-chili",
    name: "homemade turkey chili",
    aliases: ["chili", "turkey chili"],
    cat: "dish",
    per100: { kcal: 118, p: 11, c: 10, f: 3.5, fb: 3.2, na: 310, k: 380 },
    units: { bowl: 300, cup: 240 },
    logAs: "grams",
    countLabel: null,
    batch: { grams: 1200, servings: 4 },
    recipe: {
      ingredients: ["ground turkey", "beans", "tomato", "onion", "spices"],
      prep: "Simmer 40 min",
      notes: "Sample homemade dish",
    },
    confidence: "medium",
    sd: 0.12,
    version: 1,
    history: [],
    raw: "",
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: 0,
    useCount: 0,
    source: "personal",
    deleted: false,
    resetEpoch,
  };
  foods.push(chili);
  byCatalog.__chili = chili;
  return { foods, byCatalog, rand };
}

function entryFromFood(food, qty, unit, meal, rand) {
  const u = String(unit || "g").toLowerCase();
  let grams;
  if (u === "g" || u === "grams") grams = Math.round(qty);
  else {
    const conv = FoodMatch.toGrams(food, qty, u);
    grams = Math.round(conv.grams);
  }
  const macros = macrosFromPer100(food.per100, grams);
  const displayQty = FoodMatch.displayQty(qty, u === "grams" ? "g" : u, grams, food);
  return {
    id: uid(rand, "en"),
    name: food.name,
    foodId: food.id,
    foodVersion: food.version || 1,
    per100: { ...food.per100 },
    cat: food.cat || "dish",
    grams,
    displayQty,
    macros,
    sd: typeof food.sd === "number" ? food.sd : 0.1,
    meal,
    source: "personal",
    qty,
    unit: u,
  };
}

function onceEntry(name, grams, macros, meal, rand, note) {
  return {
    id: uid(rand, "en"),
    name,
    foodId: null,
    foodVersion: 1,
    grams,
    displayQty: `${grams} g`,
    macros: {
      kcal: macros.kcal,
      p: macros.p,
      c: macros.c,
      f: macros.f,
      fb: macros.fb != null ? macros.fb : 0,
      na: macros.na != null ? macros.na : null,
      k: macros.k != null ? macros.k : null,
    },
    sd: 0.2,
    meal,
    source: "once",
    qty: grams,
    unit: "g",
    note: note || "",
  };
}

function addEvent(events, day, entry, ts, resetEpoch, dayGoalLock) {
  const ev = {
    id: uid(() => Math.random() * 0.99 + Number((ts % 1000) / 10000), "ev").replace("undefined", "ev"),
    ts,
    day,
    type: "add",
    causal: { entryId: entry.id, seq: 0, parentEventId: null },
    resetEpoch,
    entry,
  };
  // Stable id without Math.random in hot path — rebuild with counter
  events.push(ev);
  if (dayGoalLock) ev.dayGoalLock = dayGoalLock;
  return ev;
}

function main() {
  const DAYS = 90;
  const anchorDay = "2026-08-13"; // seed end day; runtime shifts to today
  const startDay = addDays(anchorDay, -(DAYS - 1));
  const resetEpoch = Date.UTC(2026, 5, 1); // fixed privacy epoch for sample
  const createdAt = resetEpoch;
  const rand = mulberry32(0x4e55d1a1);
  const { foods, byCatalog } = buildPersonalFoods(rand, resetEpoch, createdAt);

  let evSeq = 0;
  function nextId(prefix) {
    evSeq += 1;
    return `${prefix}-s${evSeq.toString(36)}`;
  }

  const goals = {
    kcal: 2200,
    protein: 140,
    carbs: 240,
    fat: 70,
    fiber: 28,
    sodium: 2300,
    potassium: 3510,
  };

  const phase1Id = "ph-sample-cut";
  const phase2Id = "ph-sample-maintain";
  const phase1Start = startDay;
  const phase2Start = addDays(startDay, 45);
  const phases = [
    {
      id: phase1Id,
      name: "Cut v1.0",
      kind: "cut",
      versionMajor: 1,
      versionMinor: 0,
      startDay: phase1Start,
      endDay: addDays(phase2Start, -1),
      createdAt: resetEpoch,
      updatedAt: resetEpoch,
      archived: false,
      revisionTombstones: {},
      revisions: [{
        id: "rv-sample-cut-1",
        effectiveFrom: phase1Start,
        goals: { ...goals, kcal: 2000, carbs: 200, fat: 60 },
        kind: "cut",
        createdAt: resetEpoch,
        updatedAt: resetEpoch,
        resetEpoch,
        note: "",
        version: "1.0",
        label: "Cut v1.0",
      }],
    },
    {
      id: phase2Id,
      name: "Maintain v1.0",
      kind: "maintain",
      versionMajor: 1,
      versionMinor: 0,
      startDay: phase2Start,
      endDay: null,
      createdAt: resetEpoch + 1,
      updatedAt: resetEpoch + 1,
      archived: false,
      revisionTombstones: {},
      revisions: [{
        id: "rv-sample-maintain-1",
        effectiveFrom: phase2Start,
        goals: { ...goals },
        kind: "maintain",
        createdAt: resetEpoch + 1,
        updatedAt: resetEpoch + 1,
        resetEpoch,
        note: "",
        version: "1.0",
        label: "Maintain v1.0",
      }],
    },
  ];

  const weights = {};
  const dayGoals = {};
  const events = [];

  // Mild cut then slight regain — ~0.3 kg/week down for first 6 weeks, then flat
  let kg = 82.5;
  const breakfasts = [
    [{ id: "coffee-black", qty: 1, unit: "cup" }, { id: "oatmeal", qty: 1, unit: "bowl" }, { id: "banana", qty: 1, unit: "piece" }],
    [{ id: "coffee-black", qty: 1, unit: "cup" }, { id: "egg", qty: 2, unit: "piece" }, { id: "bread-ww", qty: 2, unit: "slice" }, { id: "peanut-butter", qty: 1, unit: "tbsp" }],
    [{ id: "latte", qty: 1, unit: "cup" }, { id: "greek-yogurt-nonfat", qty: 1, unit: "cup" }, { id: "strawberries", qty: 1, unit: "cup" }],
    [{ id: "coffee-black", qty: 1, unit: "cup" }, { id: "cereal", qty: 1, unit: "bowl" }, { id: "milk-2", qty: 1, unit: "cup" }, { id: "banana", qty: 1, unit: "piece" }],
    [{ id: "coffee-milk", qty: 1, unit: "cup" }, { id: "bagel", qty: 1, unit: "piece" }, { id: "cheddar", qty: 1, unit: "slice" }],
  ];
  const lunches = [
    [{ id: "chicken-breast", qty: 150, unit: "g" }, { id: "white-rice", qty: 1, unit: "cup" }, { id: "broccoli", qty: 1, unit: "cup" }],
    [{ id: "turkey-breast", qty: 120, unit: "g" }, { id: "bread-ww", qty: 2, unit: "slice" }, { id: "avocado", qty: 0.5, unit: "piece" }],
    [{ id: "tuna-canned", qty: 1, unit: "can" }, { id: "tortilla-flour", qty: 1, unit: "piece" }, { id: "spinach", qty: 80, unit: "g" }],
    [{ id: "black-beans", qty: 1, unit: "cup" }, { id: "brown-rice", qty: 1, unit: "cup" }, { id: "avocado", qty: 0.5, unit: "piece" }],
    [{ id: "cottage-cheese", qty: 1, unit: "cup" }, { id: "apple", qty: 1, unit: "piece" }, { id: "almonds", qty: 1, unit: "handful" }],
  ];
  const dinners = [
    [{ id: "salmon", qty: 1, unit: "fillet" }, { id: "potato", qty: 1, unit: "piece" }, { id: "broccoli", qty: 1, unit: "cup" }, { id: "olive-oil", qty: 1, unit: "tsp" }],
    [{ id: "chicken-thigh", qty: 160, unit: "g" }, { id: "pasta", qty: 1, unit: "cup" }, { id: "spinach", qty: 1, unit: "cup" }],
    [{ id: "ground-beef", qty: 140, unit: "g" }, { id: "sweet-potato", qty: 1, unit: "piece" }, { id: "corn", qty: 1, unit: "cup" }],
    [{ id: "__chili", qty: 1, unit: "bowl" }, { id: "bread-ww", qty: 1, unit: "slice" }],
    [{ id: "chicken-breast", qty: 180, unit: "g" }, { id: "white-rice", qty: 1.2, unit: "cup" }, { id: "broccoli", qty: 1.5, unit: "cup" }],
  ];
  const snacks = [
    [{ id: "greek-yogurt-nonfat", qty: 1, unit: "container" }],
    [{ id: "apple", qty: 1, unit: "piece" }, { id: "peanut-butter", qty: 1, unit: "tbsp" }],
    [{ id: "whey-protein", qty: 1, unit: "scoop" }, { id: "milk-2", qty: 1, unit: "cup" }],
    [{ id: "almonds", qty: 1, unit: "handful" }],
    [{ id: "grapes", qty: 1, unit: "cup" }],
    [{ id: "orange", qty: 1, unit: "piece" }],
  ];

  for (let i = 0; i < DAYS; i++) {
    const day = addDays(startDay, i);
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 Sun
    const isWeekend = dow === 0 || dow === 6;
    const dayTsBase = Date.parse(`${day}T12:00:00Z`) || (resetEpoch + i * 86400000);

    // Weight every day with noise
    const week = i / 7;
    if (i < 45) kg -= 0.045 + (rand() - 0.5) * 0.08;
    else kg += (rand() - 0.5) * 0.06;
    const dayKg = round1(kg + (rand() - 0.5) * 0.35);
    weights[day] = {
      kg: dayKg,
      lb: round1(dayKg * 2.20462),
      updatedAt: dayTsBase + 6 * 3600000,
      resetEpoch,
    };

    // Special day intents
    const isFast = i === 20 || i === 62;
    const isReduced = i === 12 || i === 35 || i === 70;
    const isIncomplete = i === 40;
    const skipLog = i === 55; // one gap day for coverage honesty

    const phaseKcal = i < 45 ? 2000 : 2200;
    const lock = { targetKcal: phaseKcal, baseKcal: phaseKcal };

    if (isFast) {
      dayGoals[day] = {
        targetKcal: 0,
        baseKcal: phaseKcal,
        updatedAt: dayTsBase - 3600000,
        resetEpoch,
        plannedAt: dayTsBase - 3600000,
        intent: "fast",
        fastAcknowledged: true,
      };
      lock.targetKcal = 0;
      lock.intent = "fast";
      lock.fastAcknowledged = true;
      lock.plannedAt = dayTsBase - 3600000;
      continue;
    }
    if (isReduced) {
      dayGoals[day] = {
        targetKcal: 1500,
        baseKcal: phaseKcal,
        updatedAt: dayTsBase - 3600000,
        resetEpoch,
        plannedAt: dayTsBase - 3600000,
        veryLowCalorieAcknowledged: false,
      };
      lock.targetKcal = 1500;
      lock.plannedAt = dayTsBase - 3600000;
    }
    if (isIncomplete) {
      dayGoals[day] = {
        ...(dayGoals[day] || {}),
        incomplete: true,
        excludeReason: "incomplete",
        updatedAt: dayTsBase + 20 * 3600000,
        resetEpoch,
      };
    }
    if (skipLog) continue;

    function pushMeal(items, meal, hour) {
      let seq = 0;
      for (const item of items) {
        const food = item.id === "__chili" ? byCatalog.__chili : byCatalog[item.id];
        if (!food) continue;
        const entry = entryFromFood(food, item.qty, item.unit, meal, rand);
        entry.id = nextId("en");
        const ev = {
          id: nextId("ev"),
          ts: dayTsBase + hour * 3600000 + seq * 60000,
          day,
          type: "add",
          causal: { entryId: entry.id, seq: 0, parentEventId: null },
          resetEpoch,
          dayGoalLock: { ...lock },
          entry,
        };
        events.push(ev);
        seq += 1;
      }
    }

    pushMeal(breakfasts[i % breakfasts.length], "breakfast", 7);
    pushMeal(lunches[i % lunches.length], "lunch", 12);
    pushMeal(dinners[(i + (isWeekend ? 2 : 0)) % dinners.length], "dinner", 18);
    if (rand() > 0.25) pushMeal(snacks[i % snacks.length], "snack", 15);

    // Occasional takeout once-entry (weekends)
    if (isWeekend && rand() > 0.45) {
      const entry = onceEntry(
        "restaurant burrito bowl",
        520,
        { kcal: 780, p: 38, c: 82, f: 28, fb: 11, na: 980, k: 920 },
        "dinner",
        rand,
        "Sample takeout"
      );
      entry.id = nextId("en");
      // Replace last dinner sometimes — just add as extra snack-sized evening
      events.push({
        id: nextId("ev"),
        ts: dayTsBase + 19.5 * 3600000,
        day,
        type: "add",
        causal: { entryId: entry.id, seq: 0, parentEventId: null },
        resetEpoch,
        dayGoalLock: { ...lock },
        entry,
      });
    }
    if (isWeekend && rand() > 0.6) {
      const food = byCatalog.beer || byCatalog.soda;
      if (food) {
        const entry = entryFromFood(food, 1, food.units.can ? "can" : "cup", "snack", rand);
        entry.id = nextId("en");
        events.push({
          id: nextId("ev"),
          ts: dayTsBase + 21 * 3600000,
          day,
          type: "add",
          causal: { entryId: entry.id, seq: 0, parentEventId: null },
          resetEpoch,
          dayGoalLock: { ...lock },
          entry,
        });
      }
    }
  }

  const settings = {
    goals: { ...goals },
    goalsUpdatedAt: resetEpoch,
    goalsResetEpoch: resetEpoch,
    imperial: true,
    weightUnit: "lb",
    theme: "light",
    dayGoals,
    dayPlans: {},
    gapDrafts: {},
    dayPlanPresets: [],
    phases,
    weights,
    profile: {
      dob: "1990-06-15",
      sex: "male",
      heightCm: 178,
      activity: "moderate",
      notes: "",
      updatedAt: resetEpoch,
      resetEpoch,
    },
  };

  const seed = {
    version: 3,
    seedId: "sample-v1",
    seedLabel: "Sample",
    anchorDay,
    dayCount: DAYS,
    exportedAt: "2026-08-13T00:00:00.000Z",
    resetAt: resetEpoch,
    settings,
    personalFoods: foods,
    events,
  };

  const outPath = path.join(root, "js/sample-seed.js");
  const body = `/* Auto-generated by scripts/generate-sample-seed.js — do not hand-edit. */
const SAMPLE_SEED = ${JSON.stringify(seed)};
if (typeof module !== "undefined") module.exports = SAMPLE_SEED;
`;
  fs.writeFileSync(outPath, body);
  console.log(`Wrote ${outPath}`);
  console.log(`events=${events.length} foods=${foods.length} days=${DAYS} weights=${Object.keys(weights).length}`);
}

main();
