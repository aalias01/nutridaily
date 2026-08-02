/* NutriDaily — diary bootstrap, state, event wiring. */
const App = (() => {
  const SETTINGS_KEY = "nd_settings_v1";
  const PERSONAL_KEY = "nd_personal_v1";
  const ONB_KEY = "nd_onboarded_v1";
  const FIRST_SEEN_KEY = "nd_first_seen_at";
  const SIGNIN_SEEN_KEY = "nd_signin_banner_seen";
  const RECONNECT_HIDE_DAY_KEY = "nd_reconnect_hide_day";
  const DEFAULT_GOALS = Phases.DEFAULT_GOALS;

  const state = {
    settings: {
      goals: { ...DEFAULT_GOALS },
      goalsUpdatedAt: 0,
      imperial: false,
      weightUnit: "lb",
      theme: "light",
      dayGoals: {},
      dayPlans: {},
      gapDrafts: {}, // day -> { selected: [{foodId,catalogId,name}], step, updatedAt }
      phases: [],
      weights: {},
      profile: {},
    },
    personalFoods: [],
    viewDay: null, // YYYY-MM-DD
    pickFood: null,
    editEntryId: null,
    editEntryDay: null, // day the entry belongs to (survives overnight viewDay roll)
    pendingCatalogFood: null, // catalog copy not yet committed to My Foods
    reviewParsed: null,
    updateFoodId: null,
    saveAsNew: false,
    editFoodDirect: false, // opened review without AI paste step
    foodSaveIntent: "library", // "library" | "log" — after paste save
    detailMode: "library", // food detail CTA mode
    insightDays: 14, // number or "phase"
    insightNutrient: "kcal",
    insightPhaseId: null, // null = active phase when daysBack is "phase"
    lastCalendarToday: null, // for overnight day roll without yanking past-day browsing
    yesterdayKey: null,
    // Close-the-gap sheet
    gapSelected: {}, // key -> food object (personal or catalog copy)
    gapPendingItemId: null, // plan item id while qty sheet open
    gapPendingDay: null, // day the pending item belongs to (survives midnight roll)
    gapNutriPending: null, // NutriParse results from last paste
    gapParsed: null, // last GapPrompt.parseGapBlock result (multi-option)
    gapStep: "select",
    gapPortionCache: null, // Map foodId -> portionStats for select list
  };

  function parseAmount(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : NaN;
  }

  function editDay() {
    return state.editEntryDay || state.viewDay;
  }

  function dayGoalOverride(day) {
    const ov = state.settings.dayGoals && state.settings.dayGoals[day || state.viewDay];
    if (!ov || ov.cleared) return null;
    return ov;
  }

  function refreshDayGoalsLink() {
    const btn = UI.$("#btn-day-goals");
    if (!btn) return;
    const g = Phases.goalsForDay(state.viewDay, state.settings);
    const bumps = g && g._bumps;
    const summary = Phases.formatBumpSummary(bumps);
    btn.classList.toggle("has-override", !!summary);
    btn.textContent = summary ? `Day bump · ${summary}` : "Day bump";
  }

  let deferredInstall = null;
  let installHintOpen = false;

  const activeFoods = () => Foods.active(state.personalFoods);
  const findFood = (id) => state.personalFoods.find((f) => f.id === id && !f.deleted);

  /** One-time migrate from NutriChat (nc_*) keys if present. */
  function migrateFromNutriChat() {
    const pairs = [
      ["nc_settings_v1", SETTINGS_KEY],
      ["nc_personal_v1", PERSONAL_KEY],
      ["nc_onboarded_v1", ONB_KEY],
      ["nc_events_v1", "nd_events_v1"],
      ["nc_gclient", "nd_gclient"],
      ["nc_sync_enabled", "nd_sync_enabled"],
      ["nc_sync_email", "nd_sync_email"],
    ];
    for (const [from, to] of pairs) {
      if (localStorage.getItem(to) == null && localStorage.getItem(from) != null) {
        localStorage.setItem(to, localStorage.getItem(from));
      }
    }
    const oldTok = sessionStorage.getItem("nc_gtoken_v1");
    if (oldTok && !sessionStorage.getItem("nd_gtoken_v1")) sessionStorage.setItem("nd_gtoken_v1", oldTok);
  }

  function applyTheme() {
    const t = state.settings.theme || "light";
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }

  function loadState() {
    migrateFromNutriChat();
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      Object.assign(state.settings, s);
      delete state.settings.key;
      delete state.settings.model;
    } catch (e) {}
    state.settings.goals = { ...DEFAULT_GOALS, ...(state.settings.goals || {}) };
    if (!state.settings.theme) state.settings.theme = "light";
    if (state.settings.weightUnit !== "kg" && state.settings.weightUnit !== "lb") {
      state.settings.weightUnit = "lb";
    }
    if (!state.settings.dayGoals || typeof state.settings.dayGoals !== "object") state.settings.dayGoals = {};
    if (!state.settings.dayPlans || typeof state.settings.dayPlans !== "object") state.settings.dayPlans = {};
    if (!state.settings.gapDrafts || typeof state.settings.gapDrafts !== "object") state.settings.gapDrafts = {};
    if (!state.settings.weights || typeof state.settings.weights !== "object") state.settings.weights = {};
    Phases.ensureProfile(state.settings);
    try { state.personalFoods = JSON.parse(localStorage.getItem(PERSONAL_KEY) || "[]"); }
    catch (e) { state.personalFoods = []; }
    state.viewDay = Ledger.todayKey();
    state.lastCalendarToday = state.viewDay;
    const hadPhases = Array.isArray(state.settings.phases) && state.settings.phases.length;
    Phases.ensureMigrated(
      state.settings,
      Phases.earliestDayFromEvents(Ledger.allEvents()),
      state.viewDay
    );
    if (!hadPhases && state.settings.phases && state.settings.phases.length) {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    }
    if (!localStorage.getItem(FIRST_SEEN_KEY)) localStorage.setItem(FIRST_SEEN_KEY, String(Date.now()));
    applyTheme();
  }

  // ---------- PWA install (Daycells-style, Settings card) ----------
  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function canNativeInstall() { return !!deferredInstall; }
  function showInstallUi() { return !isStandalone(); }

  async function triggerInstall() {
    if (!deferredInstall) return false;
    const ev = deferredInstall;
    deferredInstall = null;
    ev.prompt();
    try { await ev.userChoice; } catch (e) {}
    refreshInstallCard();
    return true;
  }

  function appShareUrl() {
    try { return new URL("./", location.href).href; }
    catch (e) { return location.href.split("#")[0]; }
  }

  async function shareApp() {
    const url = appShareUrl();
    const payload = {
      title: "NutriDaily",
      text: "Personal nutrition tracker. Data stays in your browser and your own Google Drive.",
      url,
    };
    try {
      if (navigator.share) { await navigator.share(payload); return; }
    } catch (e) { /* cancelled */ }
    try {
      await navigator.clipboard.writeText(url);
      UI.toast("Link copied");
    } catch (e) {
      UI.toast(url);
    }
  }

  /** Share an AI prompt as plain text only (no url) so LLM apps get the body. */
  async function sharePromptText(text, { okToast = "Prompt copied", onClipboardFail } = {}) {
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return "shared";
      }
    } catch (err) {
      if (err && err.name === "AbortError") return "cancelled";
    }
    try {
      await navigator.clipboard.writeText(text);
      UI.toast(okToast);
      return "copied";
    } catch (_) {
      if (typeof onClipboardFail === "function") onClipboardFail(text);
      else window.prompt("Select all and copy (Cmd/Ctrl+C):", text);
      return "fallback";
    }
  }

  function canSharePrompt() {
    return typeof navigator.share === "function";
  }

  function refreshPromptShareButtons() {
    const show = canSharePrompt();
    [
      "#btn-share-prompt",
      "#btn-settings-share-prompt",
      "#btn-share-phase-prompt",
      "#btn-gap-share-prompt",
    ].forEach((sel) => {
      const el = UI.$(sel);
      if (el) el.hidden = !show;
    });
    document.querySelectorAll("[data-prompt-share-hint]").forEach((el) => {
      el.hidden = !show;
    });
  }

  function refreshInstallCard() {
    const root = UI.$("#install-card");
    if (!root) return;
    const shareBtn = `<button type="button" class="btn ghost" id="shareapp">Share link</button>`;
    if (!showInstallUi()) {
      root.innerHTML = `<h3>Home screen</h3>
        <p class="muted small">Running as an installed app on this device.</p>
        <div class="btnrow">${shareBtn}</div>`;
    } else if (canNativeInstall()) {
      root.innerHTML = `<h3>Home screen</h3>
        <p>Add NutriDaily like an app for one-tap access. Works offline after install.</p>
        <div class="btnrow"><button type="button" class="btn" id="installbtn">Install NutriDaily</button>${shareBtn}</div>`;
    } else if (isIos()) {
      root.innerHTML = `<h3>Home screen</h3>
        <p>On iPhone/iPad, Safari cannot show a one-tap install dialog. Use Safari Share → Add to Home Screen.</p>
        <div class="btnrow"><button type="button" class="btn" id="installhint">How to add</button>${shareBtn}</div>
        ${installHintOpen ? `<ol class="installsteps">
          <li>Tap the <b>Share</b> button in Safari.</li>
          <li>Scroll and tap <b>Add to Home Screen</b>.</li>
          <li>Tap <b>Add</b>. Open NutriDaily from your home screen next time.</li>
        </ol>` : ""}`;
    } else {
      root.innerHTML = `<h3>Home screen</h3>
        <p>Use your browser menu: <b>Install app</b> or <b>Add to Home screen</b>.</p>
        <div class="btnrow"><button type="button" class="btn ghost" id="installhint">Show tips</button>${shareBtn}</div>
        ${installHintOpen ? `<ol class="installsteps">
          <li>Open the browser menu (⋮).</li>
          <li>Tap <b>Install app</b> or <b>Add to Home screen</b>.</li>
          <li>Confirm. Launch from the home screen icon afterward.</li>
        </ol>` : ""}`;
    }
    const btn = UI.$("#installbtn");
    if (btn) btn.addEventListener("click", () => { triggerInstall(); });
    const hint = UI.$("#installhint");
    if (hint) hint.addEventListener("click", () => { installHintOpen = !installHintOpen; refreshInstallCard(); });
    const share = UI.$("#shareapp");
    if (share) share.addEventListener("click", () => { shareApp(); });
  }

  // ---------- Info banners (reconnect once/day hide; optional sign-in nudge) ----------
  function shouldShowReconnectBanner() {
    const st = Sync.state();
    if (!st.enabled || st.status !== "auth") return false;
    if (localStorage.getItem(RECONNECT_HIDE_DAY_KEY) === Ledger.todayKey()) return false;
    return true;
  }

  function shouldShowSigninBanner() {
    if (Sync.state().enabled) return false;
    if (localStorage.getItem(SIGNIN_SEEN_KEY)) return false;
    if (!activeFoods().length && !Ledger.allEvents().length) return false;
    const first = +(localStorage.getItem(FIRST_SEEN_KEY) || 0);
    if (!first) return false;
    // Daycells-style: wait a day so local-first use isn’t interrupted immediately
    return (Date.now() - first) >= 86400000;
  }

  function refreshInfoBanner() {
    const el = UI.$("#info-banner");
    if (!el) return;
    const kind = shouldShowReconnectBanner() ? "reconnect" : (shouldShowSigninBanner() ? "signin" : null);
    if (!kind) {
      el.hidden = true;
      el.innerHTML = "";
      document.body.classList.remove("has-info-banner");
      return;
    }
    const title = kind === "reconnect" ? "Drive sync paused" : "Keep your log safe";
    const body = kind === "reconnect"
      ? "Meals still save on this device. Tap Reconnect to resume Google Drive."
      : "Optional: Sign in with Google in Settings to keep your nutrition log in your Drive if this browser is cleared.";
    el.hidden = false;
    el.dataset.kind = kind;
    el.innerHTML = `<div class="info-banner-text"><strong>${title}</strong><span>${body}</span></div>
      <div class="info-banner-actions">
        ${kind === "reconnect" ? '<button type="button" class="btn" id="banner-reconnect">Reconnect</button>' : '<button type="button" class="btn" id="banner-settings">Settings</button>'}
        <button type="button" class="btn ghost" id="banner-hide">Hide</button>
      </div>`;
    document.body.classList.add("has-info-banner");
    const hide = UI.$("#banner-hide");
    if (hide) hide.addEventListener("click", () => {
      if (kind === "reconnect") localStorage.setItem(RECONNECT_HIDE_DAY_KEY, Ledger.todayKey());
      else localStorage.setItem(SIGNIN_SEEN_KEY, "1");
      refreshInfoBanner();
      refreshSettingsTabNudge();
    });
    const recon = UI.$("#banner-reconnect");
    if (recon) recon.addEventListener("click", () => connectDrive());
    const go = UI.$("#banner-settings");
    if (go) go.addEventListener("click", () => switchView("settings"));
  }

  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  const savePersonal = () => {
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(state.personalFoods));
    Sync.schedulePush();
  };

  /** Mirror only (Drive apply / import). Does not append a phase revision. */
  function setGoals(goals, updatedAt) {
    state.settings.goals = Phases.normalizeGoals(goals);
    state.settings.goalsUpdatedAt = updatedAt || Date.now();
    saveSettings();
  }

  function goalsForView() {
    return Phases.goalsForDay(state.viewDay, state.settings);
  }

  function refreshInsights() {
    if (!document.querySelector("#view-insights.active")) return;
    const opts = {
      daysBack: state.insightDays,
      nutrient: state.insightNutrient || "kcal",
      phaseId: state.insightPhaseId,
      settings: state.settings,
      todayKey: Ledger.todayKey(),
      goalsForDay: (day) => Phases.goalsForDay(day, state.settings),
    };
    UI.renderTrends(opts);
    UI.renderWeightTrend(opts);
  }

  const LB_PER_KG = 1 / 0.45359237;
  const KG_PER_LB = 0.45359237;

  function bodyWeightUnit() {
    return state.settings.weightUnit === "kg" ? "kg" : "lb";
  }

  function kgToDisplay(kg) {
    if (kg == null || !Number.isFinite(Number(kg))) return null;
    const n = Number(kg);
    return bodyWeightUnit() === "kg"
      ? Math.round(n * 10) / 10
      : Math.round(n * LB_PER_KG * 10) / 10;
  }

  function displayToKg(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return bodyWeightUnit() === "kg" ? n : n * KG_PER_LB;
  }

  function syncWeightField() {
    const input = UI.$("#day-weight");
    const unit = UI.$("#weight-unit");
    if (!input) return;
    const kg = Phases.weightForDay(state.settings, state.viewDay);
    if (unit) unit.textContent = bodyWeightUnit();
    if (kg == null) { input.value = ""; return; }
    const shown = kgToDisplay(kg);
    input.value = bodyWeightUnit() === "kg" ? String(shown) : shown.toFixed(1);
  }

  function saveWeightFromField() {
    const raw = UI.$("#day-weight").value.trim();
    if (!state.settings.weights) state.settings.weights = {};
    if (raw === "") {
      state.settings.weights[state.viewDay] = { cleared: true, updatedAt: Date.now() };
      saveSettings();
      Sync.schedulePush();
      UI.toast("Weight cleared");
      return;
    }
    const entered = parseAmount(raw);
    const kg = displayToKg(entered);
    if (kg == null) { UI.toast("Enter a valid weight"); return; }
    if (kg < 25 || kg > 400) { UI.toast("Weight looks out of range"); return; }
    const lb = Math.round(kg * LB_PER_KG * 10) / 10;
    state.settings.weights[state.viewDay] = {
      kg: Math.round(kg * 100) / 100,
      lb,
      updatedAt: Date.now(),
    };
    saveSettings();
    Sync.schedulePush();
    UI.toast("Weight saved");
    refreshInsights();
  }

  function isToday() { return state.viewDay === Ledger.todayKey(); }

  function yesterdayKey() {
    const d = new Date(state.viewDay + "T12:00:00");
    d.setDate(d.getDate() - 1);
    return Ledger.todayKey(d);
  }

  function refreshHUD() {
    UI.updateHUD(Ledger.totalsFor(state.viewDay), goalsForView());
    UI.setDayLabel(state.viewDay, isToday());
  }

  function refreshDay() {
    refreshHUD();
    refreshDayGoalsLink();
    refreshGapChip();
    syncWeightField();
    UI.renderDayLog(state.viewDay, Ledger.entriesFor(state.viewDay));
  }

  // ---------- Close the gap ----------
  function dayPlan(day) {
    const d = day || state.viewDay;
    const map = state.settings.dayPlans || {};
    return map[d] || null;
  }

  function pendingPlanCount(day) {
    const plan = dayPlan(day);
    if (!plan || !Array.isArray(plan.items)) return 0;
    return plan.items.filter((it) => it && it.status === "pending").length;
  }

  function refreshGapChip() {
    const chip = UI.$("#btn-gap-plan");
    if (!chip) return;
    const n = pendingPlanCount(state.viewDay);
    if (n > 0) {
      chip.hidden = false;
      chip.textContent = `Plan: ${n} left`;
    } else {
      chip.hidden = true;
    }
  }

  function pruneDayPlans(keepDays) {
    const map = state.settings.dayPlans || {};
    const keys = Object.keys(map).sort();
    const keep = Math.max(7, keepDays || 45);
    while (keys.length > keep) {
      const old = keys.shift();
      delete map[old];
    }
  }

  function saveDayPlan(day, plan) {
    if (!state.settings.dayPlans || typeof state.settings.dayPlans !== "object") state.settings.dayPlans = {};
    const d = day || state.viewDay;
    if (!plan) {
      delete state.settings.dayPlans[d];
    } else {
      const { raw: _drop, ...rest } = plan;
      state.settings.dayPlans[d] = { ...rest, updatedAt: Date.now() };
    }
    pruneDayPlans(45);
    saveSettings();
    Sync.schedulePush();
    refreshGapChip();
  }

  function gapFoodKey(food) {
    if (!food) return "";
    if (food.catalogId) return `cat:${food.catalogId}`;
    if (food.id) return `id:${food.id}`;
    return `name:${String(food.name || "").toLowerCase()}`;
  }

  function buildGapCandidatesFromSelection() {
    return Object.values(state.gapSelected).map((food) => {
      const portion = food.id ? Ledger.portionStats(food.id) : { n: 0 };
      const prov = Foods.provenance(food);
      return {
        id: food.id || null,
        name: food.name,
        per100: food.per100 || {},
        logAs: food.logAs || (FoodMatch.prefersPieceLog(food) ? "piece" : "grams"),
        pieceGrams: FoodMatch.pieceGrams(food),
        portion: portion.n ? portion : null,
        provenance: prov && prov.kind === "ref" ? "ref" : (prov && prov.kind === "ai" ? "ai" : "yours"),
        refine: !!(prov && prov.kind === "ref"),
        food,
      };
    });
  }

  function persistGapDraft(step) {
    if (!state.settings.gapDrafts || typeof state.settings.gapDrafts !== "object") {
      state.settings.gapDrafts = {};
    }
    const selected = Object.values(state.gapSelected).map((f) => ({
      foodId: f.id || null,
      catalogId: f.catalogId || null,
      name: f.name,
    }));
    if (!selected.length) {
      delete state.settings.gapDrafts[state.viewDay];
    } else {
      state.settings.gapDrafts[state.viewDay] = {
        selected,
        step: step || state.gapStep || "select",
        updatedAt: Date.now(),
      };
    }
    saveSettings();
    Sync.schedulePush();
  }

  function clearGapDraft(day) {
    if (!state.settings.gapDrafts) return;
    delete state.settings.gapDrafts[day || state.viewDay];
    saveSettings();
  }

  function restoreGapDraft() {
    const draft = state.settings.gapDrafts && state.settings.gapDrafts[state.viewDay];
    if (!draft || !Array.isArray(draft.selected) || !draft.selected.length) return null;
    state.gapSelected = {};
    const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
    for (const c of draft.selected) {
      let food = c.foodId ? findFood(c.foodId) : null;
      if (!food && c.catalogId) {
        food = state.personalFoods.find((f) => !f.deleted && f.catalogId === c.catalogId) || null;
        if (!food) {
          const db = DB.find((f) => f.id === c.catalogId);
          if (db) food = Foods.fromCatalog(db);
        }
      }
      if (!food && c.name) food = Foods.findByName(state.personalFoods, c.name);
      if (food) state.gapSelected[gapFoodKey(food)] = food;
    }
    return Object.keys(state.gapSelected).length ? draft : null;
  }

  function buildGapPromptText() {
    const day = state.viewDay;
    const entries = Ledger.entriesFor(day);
    const totals = Ledger.totalsFor(day);
    const goals = goalsForView();
    const means = GapPrompt.totalsMeans(totals);
    const remaining = GapPrompt.remainingFrom(means, goals);
    const candidates = buildGapCandidatesFromSelection().map(({ food, ...rest }) => rest);
    return GapPrompt.buildGapPrompt({
      day,
      logged: entries.map((e) => ({
        name: e.name,
        grams: e.grams,
        displayQty: e.displayQty,
        meal: e.meal,
        macros: e.macros,
      })),
      totals,
      goals,
      remaining,
      candidates,
    });
  }

  function refreshGapRemainingBlurb() {
    const el = UI.$("#gap-remaining-blurb");
    if (!el) return;
    const totals = Ledger.totalsFor(state.viewDay);
    const goals = goalsForView();
    const remaining = GapPrompt.remainingFrom(GapPrompt.totalsMeans(totals), goals);
    el.textContent = UI.formatGapRemaining(remaining, goals);
  }

  function gapPortionFor(foodId) {
    if (!foodId) return { n: 0 };
    if (!state.gapPortionCache) state.gapPortionCache = new Map();
    if (state.gapPortionCache.has(foodId)) return state.gapPortionCache.get(foodId);
    const stats = Ledger.portionStats(foodId);
    state.gapPortionCache.set(foodId, stats);
    return stats;
  }

  function refreshGapSelectList() {
    const q = (UI.$("#gap-food-search") && UI.$("#gap-food-search").value) || "";
    const needle = String(q).trim().toLowerCase();
    const personal = activeFoods();
    const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
    const byCatalogId = new Map(personal.filter((f) => f.catalogId).map((f) => [f.catalogId, f]));
    const ownedCatalogIds = new Set(byCatalogId.keys());
    const rows = [];

    const match = (name, aliases) => {
      if (!needle) return true;
      if (FoodMatch.scoreMatch(needle, name) >= 0.35) return true;
      return (aliases || []).some((a) => FoodMatch.scoreMatch(needle, a) >= 0.35);
    };

    // Prefer personal library copy whenever selection key matches a catalogId
    for (const [key, sel] of Object.entries(state.gapSelected)) {
      if (sel && sel.catalogId && byCatalogId.has(sel.catalogId)) {
        state.gapSelected[key] = byCatalogId.get(sel.catalogId);
      }
    }

    const personalMatched = [];
    for (const f of Foods.sortForPicker(personal)) {
      if (!match(f.name, f.aliases)) continue;
      personalMatched.push(f);
    }
    // Cap rendered rows; still include every currently selected food
    const selectedKeys = new Set(Object.keys(state.gapSelected));
    const personalRows = personalMatched.filter((f) => selectedKeys.has(gapFoodKey(f)) || personalMatched.indexOf(f) < 40);
    // Ensure selected foods not in the first 40 still appear
    for (const f of personalMatched) {
      const key = gapFoodKey(f);
      if (selectedKeys.has(key) && !personalRows.includes(f)) personalRows.push(f);
    }

    for (const f of personalRows.slice(0, 60)) {
      const key = gapFoodKey(f);
      const stats = gapPortionFor(f.id);
      const prov = Foods.provenance(f);
      const hist = stats.n
        ? GapPrompt.portionLine(stats)
        : `${UI.fmt(f.per100.kcal)} kcal/100g`;
      const tag = prov && prov.kind === "ref" ? "Reference · USDA avg · " : "";
      rows.push({ key, name: f.name, sub: `${tag}${hist}`, selected: !!state.gapSelected[key], food: f, kind: "personal" });
    }

    const personalNames = new Set(personal.map((f) => String(f.name || "").toLowerCase()));
    const catalogPool = needle
      ? DB.filter((f) =>
          !ownedCatalogIds.has(f.id) &&
          !personalNames.has(String(f.name || "").toLowerCase()) &&
          match(f.name, f.aliases)
        )
        .sort((a, b) => FoodMatch.scoreMatch(needle, b.name) - FoodMatch.scoreMatch(needle, a.name))
        .slice(0, 25)
      : (typeof FOOD_COMMON_IDS !== "undefined" ? FOOD_COMMON_IDS : [])
        .map((id) => DB.find((f) => f.id === id))
        .filter((f) => f && !ownedCatalogIds.has(f.id) && !personalNames.has(String(f.name || "").toLowerCase()));

    for (const db of catalogPool) {
      const key = `cat:${db.id}`;
      const existing = state.gapSelected[key];
      const food = existing || Foods.fromCatalog(db);
      rows.push({
        key,
        name: db.name,
        sub: `Reference · USDA avg · ${UI.fmt(db.per100.kcal)} kcal/100g`,
        selected: !!existing,
        food,
        kind: "catalog",
      });
    }

    UI.renderGapSelectList(rows.map((r) => ({ key: r.key, name: r.name, sub: r.sub, selected: r.selected })));
    refreshGapSelectList._rows = rows;
    const btn = UI.$("#btn-gap-to-prompt");
    if (btn) btn.disabled = Object.keys(state.gapSelected).length < 1;
  }

  function toggleGapSelect(key) {
    const rows = refreshGapSelectList._rows || [];
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    if (state.gapSelected[key]) delete state.gapSelected[key];
    else state.gapSelected[key] = row.food;
    persistGapDraft("select");
    refreshGapSelectList();
  }

  function showGapSheetStep(step) {
    state.gapStep = step;
    UI.showGapStep(step);
    if (step === "select") {
      refreshGapRemainingBlurb();
      refreshGapSelectList();
    } else if (step === "prompt") {
      persistGapDraft("prompt");
      const hint = UI.$("#gap-prompt-hint");
      if (hint) {
        hint.textContent =
          "Copy the prompt into ChatGPT / Claude / any LLM. Ask for 2–3 options with different tradeoffs, then paste the GAP v1 … END reply. " +
          "Optional NUTRI v1 blocks refine Reference catalog foods or add brand-new dishes.";
      }
    } else if (step === "choose") {
      renderGapChooseStep();
    } else if (step === "plan") {
      renderGapPlanStep();
    }
  }

  function optionSummary(opt) {
    const p = opt && opt.projected;
    if (p && p.kcal != null) {
      return `${UI.fmt(p.kcal)} kcal · P ${UI.fmt(p.protein)} · C ${UI.fmt(p.carbs)} · F ${UI.fmt(p.fat)} · Na ${UI.fmt(p.sodium)}`;
    }
    const n = (opt && opt.items && opt.items.length) || 0;
    return `${n} food${n === 1 ? "" : "s"}`;
  }

  function renderGapChooseStep() {
    const parsed = state.gapParsed;
    const banner = UI.$("#gap-choose-nutri");
    if (banner) {
      const pending = state.gapNutriPending;
      if (pending && pending.length) {
        const names = pending.map((r) => (r.food && r.food.name) || "food").join(", ");
        banner.hidden = false;
        banner.innerHTML = `Also found ${pending.length} NUTRI block(s) (${UI.esc(names)}). ` +
          `<button type="button" class="linkbtn" id="btn-gap-import-nutri-choose">Import / refine first</button>`;
        const btn = UI.$("#btn-gap-import-nutri-choose");
        if (btn) btn.onclick = () => importGapNutriFoods();
      } else {
        banner.hidden = true;
        banner.innerHTML = "";
      }
    }
    if (!parsed || !parsed.options) {
      UI.renderGapOptions([]);
      return;
    }
    const cards = parsed.options.map((o) => ({
      index: o.index,
      label: o.label,
      reachable: o.reachable,
      note: o.note,
      summary: optionSummary(o),
      itemLines: (o.items || []).map((it) => {
        const g = it.grams != null ? `${UI.fmt(it.grams)} g` : `${it.qty} ${it.unit || "g"}`;
        return `${it.name}: ${g} · ${it.meal || "snack"}`;
      }),
    }));
    UI.renderGapOptions(cards);
  }

  function restoreGapSelectionFromPlan(plan, pendingOnly) {
    state.gapSelected = {};
    if (!plan) return;
    if (pendingOnly) {
      for (const it of plan.items || []) {
        if (it.status !== "pending") continue;
        const food = resolveGapFood(it);
        if (food) state.gapSelected[gapFoodKey(food)] = food;
      }
      return;
    }
    for (const c of plan.candidates || []) {
      let food = c.foodId ? findFood(c.foodId) : null;
      if (!food && c.name) food = Foods.findByName(state.personalFoods, c.name);
      if (food) state.gapSelected[gapFoodKey(food)] = food;
    }
  }

  function openGapSheet(opts) {
    const preferPlan = opts && opts.plan;
    const plan = dayPlan(state.viewDay);
    state.gapNutriPending = null;
    state.gapPortionCache = null;

    // Resume paste step after leaving for an LLM (selection is persisted)
    if (!preferPlan) {
      const draft = restoreGapDraft();
      if (draft && draft.step === "prompt" && Object.keys(state.gapSelected).length) {
        UI.openSheet("sheet-gap", { noAutofocus: true });
        showGapSheetStep("prompt");
        return;
      }
    }

    if (preferPlan && plan && pendingPlanCount(state.viewDay) > 0) {
      restoreGapSelectionFromPlan(plan, true);
      UI.openSheet("sheet-gap", { noAutofocus: true });
      showGapSheetStep("plan");
      return;
    }
    if (!Object.keys(state.gapSelected).length) {
      if (!restoreGapDraft() && plan) restoreGapSelectionFromPlan(plan, false);
    }
    UI.openSheet("sheet-gap", { noAutofocus: true });
    showGapSheetStep("select");
  }

  function copyGapPrompt() {
    persistGapDraft("prompt");
    const text = buildGapPromptText();
    navigator.clipboard.writeText(text).then(() => UI.toast("Gap prompt copied — paste back here when ready")).catch(() => {
      window.prompt("Select all and copy (Cmd/Ctrl+C):", text);
    });
  }

  async function shareGapPrompt() {
    persistGapDraft("prompt");
    const text = buildGapPromptText();
    await sharePromptText(text, {
      okToast: "Gap prompt copied — paste back here when ready",
    });
  }

  function renderGapPlanStep() {
    const plan = dayPlan(state.viewDay);
    const noteEl = UI.$("#gap-plan-note");
    const banner = UI.$("#gap-nutri-banner");
    if (!plan) {
      if (noteEl) noteEl.textContent = "No plan saved for this day yet.";
      UI.renderGapPlanList([]);
      if (banner) banner.hidden = true;
      return;
    }
    if (noteEl) {
      const reach = plan.reachable === false ? "May not fully hit targets. " : "";
      noteEl.textContent = `${reach}${plan.note || ""}`.trim() || "Tap a food to log the suggested amount (you can edit grams).";
    }
    if (banner) {
      const pending = state.gapNutriPending;
      if (pending && pending.length) {
        const names = pending.map((r) => (r.food && r.food.name) || "food").join(", ");
        banner.hidden = false;
        banner.innerHTML = `Also found ${pending.length} NUTRI block(s) (${UI.esc(names)}). ` +
          `Use to refine Reference catalog foods or add new dishes. ` +
          `<button type="button" class="linkbtn" id="btn-gap-import-nutri">Import / refine</button>`;
        const btn = UI.$("#btn-gap-import-nutri");
        if (btn) btn.onclick = () => importGapNutriFoods();
      } else {
        banner.hidden = true;
        banner.innerHTML = "";
      }
    }
    const items = (plan.items || []).slice().sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === "pending" ? -1 : 1;
    }).map((it) => {
      const macros = it.foodId || it.name
        ? (() => {
          const food = resolveGapFood(it);
          if (!food) return null;
          return FoodMatch.computeMacros(food.per100, it.grams || it.suggestedGrams || 0);
        })()
        : null;
      const g = it.grams != null ? it.grams : it.suggestedGrams;
      const qtyLabel = g != null
        ? (it.unit && it.unit !== "g"
          ? `${it.qty} ${it.unit} (≈ ${UI.fmt(g)} g)`
          : `${UI.fmt(g)} g`)
        : `${it.qty} ${it.unit || "g"}`;
      const sub = macros
        ? `${it.meal || "snack"} · ${UI.fmt(macros.kcal)} kcal · P ${UI.fmt(macros.p)}`
        : (it.meal || "snack");
      return { id: it.id, name: it.name, qtyLabel, sub, status: it.status };
    });
    UI.renderGapPlanList(items);
  }

  function resolveGapFood(item) {
    if (!item) return null;
    if (item.foodId) {
      const f = findFood(item.foodId);
      if (f) return f;
    }
    const fromSel = Object.values(state.gapSelected).find((f) =>
      f.id === item.foodId || String(f.name).toLowerCase() === String(item.name || "").toLowerCase()
    );
    if (fromSel) return fromSel;
    return Foods.findByName(state.personalFoods, item.name);
  }

  function applyGapOption(opt, parsedMeta) {
    const candidates = buildGapCandidatesFromSelection();
    if (!candidates.length) {
      UI.toast("Select at least one food first");
      return;
    }
    if (!opt || !opt.items || !opt.items.length) {
      UI.toast("That option has no foods");
      return;
    }
    const dayLabel = parsedMeta && parsedMeta.day;
    if (dayLabel && dayLabel !== state.viewDay) {
      if (!confirm(`This plan is labeled ${dayLabel}, but you're viewing ${state.viewDay}. Apply it to ${state.viewDay} anyway?`)) {
        return;
      }
    }
    const prev = dayPlan(state.viewDay);
    const prevLogged = (prev && prev.items || []).filter((it) => it && it.status === "logged");
    if (prevLogged.length) {
      if (!confirm(`Replace the current plan? ${prevLogged.length} already-logged suggestion(s) will stay listed as done.`)) {
        return;
      }
    }
    const items = opt.items.map((it) => {
      const cand = candidates.find((c) => c.id && c.id === it.foodId)
        || candidates.find((c) => String(c.name).toLowerCase() === String(it.name).toLowerCase())
        || null;
      let food = cand ? cand.food : resolveGapFood(it);
      if (food && food.catalogId) {
        const existing = state.personalFoods.find((f) => !f.deleted && f.catalogId === food.catalogId);
        if (existing) food = existing;
        else if (!findFood(food.id)) {
          state.personalFoods.push(food);
          savePersonal();
        }
      }
      let grams = it.grams;
      const qty = it.qty;
      const unit = it.unit || "g";
      if (food && unit !== "g" && grams == null) {
        const entry = Foods.entryFromQty(food, qty, unit, it.meal);
        if (entry) grams = entry.grams;
      }
      return {
        id: Ledger.uid(),
        foodId: food ? food.id : (it.foodId || null),
        name: food ? food.name : it.name,
        grams: grams != null ? grams : null,
        suggestedGrams: grams != null ? grams : null,
        qty,
        unit,
        meal: it.meal || "snack",
        status: "pending",
        loggedEntryId: null,
      };
    });
    const carried = prevLogged.map((it) => ({ ...it }));
    const noteBits = [opt.label, opt.note].filter(Boolean).join(" · ");
    const plan = {
      updatedAt: Date.now(),
      reachable: opt.reachable !== false,
      note: noteBits,
      optionLabel: opt.label || "",
      candidates: candidates.map((c) => ({ foodId: c.id, name: c.name })),
      items: [...items, ...carried],
      projected: opt.projected || null,
    };
    saveDayPlan(state.viewDay, plan);
    clearGapDraft(state.viewDay);
    state.gapParsed = null;
    showGapSheetStep("plan");
    UI.toast(`Using ${opt.label || "plan"}`);
  }

  function importGapPaste() {
    if (Object.keys(state.gapSelected).length < 1) {
      UI.toast("Select at least one food first");
      showGapSheetStep("select");
      return;
    }
    const text = (UI.$("#gap-paste") && UI.$("#gap-paste").value) || "";
    const candidates = buildGapCandidatesFromSelection().map(({ food, ...rest }) => rest);
    const scorer = (q, name) => FoodMatch.scoreMatch(q, name);
    const parsed = GapPrompt.parseGapBlock(text, candidates, scorer);
    if (!parsed.ok) {
      UI.toast(parsed.error || "Could not parse GAP block");
      return;
    }
    const nutri = NutriParse.parse(text);
    state.gapNutriPending = (nutri && nutri.found)
      ? (nutri.results || []).filter((r) => r && r.ok && r.canSave)
      : null;
    state.gapParsed = parsed;
    if (parsed.warnings && parsed.warnings.length) {
      UI.toast(parsed.warnings[0]);
    }
    const opts = parsed.options || [];
    if (opts.length === 1) {
      applyGapOption(opts[0], parsed);
      return;
    }
    showGapSheetStep("choose");
  }

  function importGapNutriFoods() {
    const pending = state.gapNutriPending || [];
    if (!pending.length) return;
    let added = 0;
    let updated = 0;
    for (const r of pending) {
      if (!r.food || !r.canSave) continue;
      const draft = { ...r.food, raw: (r.raw || r.food.raw || "").slice(0, 12000) };
      // Prefer updating a selected / library food with the same name (catalog refine)
      let existing = Object.values(state.gapSelected).find((f) =>
        String(f.name || "").toLowerCase() === String(draft.name || "").toLowerCase()
      ) || null;
      if (existing && existing.id) existing = findFood(existing.id) || existing;
      if (!existing) existing = Foods.findByName(state.personalFoods, draft.name);
      if (existing && existing.id && !String(existing.id).startsWith("orphan-")) {
        const idx = state.personalFoods.findIndex((f) => f.id === existing.id);
        const next = Foods.applyUpdate(existing, draft);
        if (idx >= 0) state.personalFoods[idx] = next;
        else state.personalFoods.push(next);
        state.gapSelected[gapFoodKey(next)] = next;
        // Refresh plan item foodIds that pointed at the old copy
        const plan = dayPlan(state.viewDay);
        if (plan && Array.isArray(plan.items)) {
          const items = plan.items.map((it) => {
            if (String(it.name || "").toLowerCase() !== String(next.name).toLowerCase()) return it;
            return { ...it, foodId: next.id, name: next.name };
          });
          saveDayPlan(state.viewDay, { ...plan, items });
        }
        updated += 1;
        continue;
      }
      const food = Foods.createFromDraft(draft);
      state.personalFoods.push(food);
      state.gapSelected[gapFoodKey(food)] = food;
      added += 1;
    }
    savePersonal();
    Sync.schedulePush();
    state.gapNutriPending = null;
    refreshFoods();
    renderGapPlanStep();
    const bits = [];
    if (updated) bits.push(`updated ${updated}`);
    if (added) bits.push(`added ${added}`);
    UI.toast(bits.length ? `My Foods: ${bits.join(", ")}` : "No foods to import");
  }

  function openGapItemQty(itemId) {
    const day = state.viewDay;
    const plan = dayPlan(day);
    if (!plan) return;
    const item = (plan.items || []).find((it) => it.id === itemId);
    if (!item || item.status === "logged") return;
    const food = resolveGapFood(item);
    if (!food) {
      UI.toast("Food not in library — import it first or pick again");
      return;
    }
    const unit = item.unit === "piece" && FoodMatch.pieceGrams(food) ? "piece" : "g";
    const qty = unit === "piece" ? item.qty : (item.grams != null ? item.grams : (item.suggestedGrams != null ? item.suggestedGrams : item.qty));
    UI.closeSheet("sheet-gap");
    // openQty clears any stale gapPendingItemId; set after
    openQty(food, { qty, unit, meal: item.meal || Foods.inferMeal() });
    state.gapPendingItemId = item.id;
    state.gapPendingDay = day;
  }

  function markGapItemLogged(entryId) {
    if (!state.gapPendingItemId) return;
    const day = state.gapPendingDay || state.viewDay;
    const plan = dayPlan(day);
    if (!plan) {
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
      return;
    }
    const items = (plan.items || []).map((it) => {
      if (it.id !== state.gapPendingItemId) return it;
      return { ...it, status: "logged", loggedEntryId: entryId || null };
    });
    saveDayPlan(day, { ...plan, items });
    state.gapPendingItemId = null;
    state.gapPendingDay = null;
  }

  function clearGapPlan() {
    if (!dayPlan(state.viewDay) && !(state.settings.gapDrafts && state.settings.gapDrafts[state.viewDay])) return;
    if (!confirm("Clear this day’s gap plan?")) return;
    saveDayPlan(state.viewDay, null);
    clearGapDraft(state.viewDay);
    state.gapNutriPending = null;
    state.gapSelected = {};
    state.gapPendingItemId = null;
    state.gapPendingDay = null;
    UI.closeSheet("sheet-gap");
    UI.toast("Plan cleared");
  }

  function startGapRecalc() {
    const plan = dayPlan(state.viewDay);
    // Pending items only — do not re-propose foods already logged from this plan
    restoreGapSelectionFromPlan(plan, true);
    if (Object.keys(state.gapSelected).length < 1) {
      UI.toast("Pick foods to recalculate");
      showGapSheetStep("select");
      return;
    }
    if (UI.$("#gap-paste")) UI.$("#gap-paste").value = "";
    showGapSheetStep("prompt");
  }

  function refreshFoods() {
    UI.renderFoods(state.personalFoods, UI.$("#foods-search").value);
  }

  function refreshAll() {
    refreshDay();
    refreshFoods();
    refreshInsights();
  }

  function switchView(name) {
    document.querySelectorAll(".bottom-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    document.querySelectorAll("main .view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    const onToday = name === "today";
    const hud = UI.$("#hud");
    if (hud) hud.hidden = !onToday;
    const dayControls = UI.$("#day-controls");
    if (dayControls) dayControls.hidden = !onToday;
    if (name === "foods") refreshFoods();
    if (name === "insights") refreshInsights();
    if (name === "today") refreshDay();
    if (name === "settings") {
      syncSettingsForm();
      refreshDriveStatus();
      refreshInstallCard();
      refreshSettingsTabNudge();
    }
  }

  function isSettingsView() {
    return !!document.querySelector("#view-settings.active");
  }

  function openQuickKcal(prefill) {
    UI.closeSheet("sheet-add");
    UI.closeSheet("sheet-qty");
    UI.$("#kcal-name").value = (prefill && prefill.name) || "";
    UI.$("#kcal-amount").value = prefill && prefill.kcal != null ? prefill.kcal : "";
    UI.fillMealChips("#kcal-meals", (prefill && prefill.meal) || undefined);
    if (prefill && prefill.editId) {
      state.editEntryId = prefill.editId;
      state.editEntryDay = prefill.editDay || state.viewDay;
    } else if (!(prefill && prefill.keepEdit)) {
      state.editEntryId = null;
      state.editEntryDay = null;
    }
    const rem = UI.$("#kcal-remove");
    if (rem) rem.hidden = !state.editEntryId;
    UI.openSheet("sheet-kcal");
  }

  function jumpToToday() {
    state.viewDay = Ledger.todayKey();
    state.lastCalendarToday = state.viewDay;
    refreshDay();
    switchView("today");
  }

  function shiftDay(delta) {
    const d = new Date(state.viewDay + "T12:00:00");
    d.setDate(d.getDate() + delta);
    const key = Ledger.todayKey(d);
    if (key > Ledger.todayKey()) return;
    state.viewDay = key;
    refreshDay();
  }

  function openAddSheet() {
    state.pickFood = null;
    state.editEntryId = null;
    state.editEntryDay = null;
    state.pendingCatalogFood = null;
    UI.$("#pick-search").value = "";
    state.yesterdayKey = yesterdayKey();
    const yEntries = Ledger.entriesFor(state.yesterdayKey);
    UI.renderPicker(state.personalFoods, "", true, {
      yesterday: yEntries,
      yesterdayLabel: isToday() ? "Yesterday" : "Previous day",
    });
    UI.openSheet("sheet-add");
  }

  function resetQtyState() {
    state.pickFood = null;
    state.editEntryId = null;
    state.editEntryDay = null;
    state.pendingCatalogFood = null;
  }

  function openQty(food, prefill) {
    // New log (not editing an existing entry) must not inherit a stale amend target
    if (!(prefill && prefill.allowRemove)) {
      state.editEntryId = null;
      state.editEntryDay = null;
    }
    // Always clear gap pending on any qty open; openGapItemQty sets it after
    state.gapPendingItemId = null;
    state.gapPendingDay = null;
    state.pickFood = food;
    UI.fillQtySheet(food, !!state.settings.imperial, {
      ...(prefill || {}),
      allowRemove: !!(prefill && prefill.allowRemove),
    });
    UI.closeSheet("sheet-add");
    UI.openSheet("sheet-qty");
    setTimeout(() => {
      const inp = UI.$("#qty-input");
      if (!inp) return;
      inp.focus();
      inp.select();
    }, 50);
  }

  function cancelQty() {
    UI.closeSheet("sheet-qty");
    state.gapPendingItemId = null;
    state.gapPendingDay = null;
    resetQtyState();
  }

  function defaultQtyForUnit(food, unit) {
    const u = String(unit || "g").toLowerCase();
    if (u === "serving" || u === "piece" || u === "batch") return 1;
    const OZ = 28.349523125;
    let grams = 100;
    if (food && food.id) {
      const stats = Ledger.portionStats(food.id);
      if (stats.median != null) grams = Math.round(stats.median);
      else if (stats.last != null) grams = Math.round(stats.last);
    }
    const pieceG = FoodMatch.pieceGrams(food);
    if (pieceG && FoodMatch.prefersPieceLog(food) && u === "g") {
      // switching away from piece: show one piece in grams
      return Math.round(pieceG);
    }
    if (u === "oz") return Math.round((grams / OZ) * 10) / 10;
    return grams;
  }

  function ensureViewDayCurrent() {
    const today = Ledger.todayKey();
    const prevToday = state.lastCalendarToday || today;
    let rolled = false;
    if (state.viewDay === prevToday && prevToday !== today) {
      state.viewDay = today;
      rolled = true;
    } else if (!state.viewDay || state.viewDay > today) {
      state.viewDay = today;
      rolled = true;
    }
    state.lastCalendarToday = today;
    return rolled;
  }

  /** Open the food editor (macros / name / units) for a personal food. */
  function openEditFood(food) {
    if (!food) return;
    state.editEntryId = null;
    state.editEntryDay = null;
    if (!food.id || String(food.id).startsWith("orphan-")) {
      UI.toast("This log's food was deleted — edit macros on a library copy instead");
      return;
    }
    let target = findFood(food.id);
    if (!target && state.pendingCatalogFood && state.pendingCatalogFood.id === food.id) {
      state.personalFoods.push(food);
      state.pendingCatalogFood = null;
      savePersonal();
      target = food;
    }
    if (!target && food.per100) {
      const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
      const catId = food.catalogId || (DB.some((f) => f.id === food.id) ? food.id : null);
      if (catId) {
        const existing = state.personalFoods.find((f) => !f.deleted && f.catalogId === catId);
        if (existing) target = existing;
        else {
          target = Foods.fromCatalog({
            id: catId,
            name: food.name,
            aliases: food.aliases || [],
            cat: food.cat,
            per100: food.per100,
            units: food.units || {},
          });
          state.personalFoods.push(target);
          savePersonal();
        }
      } else {
        target = Foods.createFromDraft({
          name: food.name,
          aliases: food.aliases || [],
          cat: food.cat || "dish",
          per100: { ...food.per100 },
          units: { ...(food.units || {}) },
          logAs: food.logAs || (food.units && food.units.piece ? "piece" : "grams"),
          countLabel: food.countLabel || null,
          batch: food.batch || null,
          recipe: food.recipe || { ingredients: [], prep: "", notes: "" },
          confidence: food.confidence || "medium",
          sd: food.sd || 0.12,
          raw: food.raw || "",
        });
        state.personalFoods.push(target);
        savePersonal();
      }
    }
    if (!target) { UI.toast("Can't edit this food"); return; }

    state.updateFoodId = target.id;
    state.saveAsNew = false;
    state.editFoodDirect = true;
    state.reviewParsed = {
      canSave: true,
      food: {
        name: target.name,
        aliases: target.aliases || [],
        cat: target.cat || "dish",
        per100: { ...target.per100 },
        units: { ...(target.units || {}) },
        logAs: target.logAs || (target.units && target.units.piece ? "piece" : "grams"),
        countLabel: target.countLabel || null,
        batch: target.batch ? { ...target.batch } : null,
        recipe: {
          ingredients: (target.recipe && target.recipe.ingredients) || [],
          prep: (target.recipe && target.recipe.prep) || "",
          notes: (target.recipe && target.recipe.notes) || "",
        },
        confidence: target.confidence || "medium",
        sd: target.sd || 0.12,
        raw: target.raw || "",
      },
      warnings: [],
      rejects: [],
    };
    UI.closeSheet("sheet-qty");
    UI.closeSheet("sheet-detail");
    UI.closeSheet("sheet-add");
    UI.openSheet("sheet-paste");
    UI.showReview(state.reviewParsed, { updateId: target.id, forceEnable: true, title: "Edit food" });
    validateReviewSave();
  }

  function openQtyFromEntry(entry, opts) {
    if (!entry) return;
    if (opts && opts.allowRemove) {
      state.editEntryId = entry.id;
      state.editEntryDay = state.viewDay;
    } else {
      state.editEntryId = null;
      state.editEntryDay = null;
    }
    if (entry.source === "quick" || entry.unit === "kcal") {
      openQuickKcal({
        name: entry.name,
        kcal: (entry.macros && entry.macros.kcal) || entry.qty || 0,
        meal: entry.meal,
        editId: (opts && opts.allowRemove) ? entry.id : null,
        editDay: state.viewDay,
      });
      return;
    }
    let food = entry.foodId ? findFood(entry.foodId) : null;
    if (!food) {
      // Ephemeral shell for qty edit — never write orphan-* into the ledger
      food = {
        id: null,
        name: entry.name,
        per100: entry.per100 || { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0 },
        units: {},
        batch: null,
        sd: entry.sd,
        version: entry.foodVersion || 1,
        cat: entry.cat || "dish",
        _orphan: true,
        _keptFoodId: entry.foodId || null,
      };
    }
    state.pendingCatalogFood = null;
    openQty(food, {
      qty: entry.qty || entry.grams,
      unit: entry.unit || "g",
      meal: entry.meal || Foods.inferMeal(),
      allowRemove: !!(opts && opts.allowRemove),
    });
  }

  function removeEntryWithUndo(day, entryId) {
    const entry = Ledger.entriesFor(day).find((e) => e.id === entryId);
    if (!entry) return;
    const snapshot = {
      ...entry,
      macros: { ...entry.macros },
      per100: entry.per100 ? { ...entry.per100 } : null,
    };
    Ledger.removeEntry(day, entryId, "removed");
    Sync.schedulePush();
    if (state.viewDay === day) refreshDay();
    UI.toast("Removed", {
      ms: 5000,
      action: {
        label: "Undo",
        onClick: () => {
          const { addedTs, history, ...rest } = snapshot;
          Ledger.addEntry(day, rest); // keeps rest.id
          Sync.schedulePush();
          if (state.viewDay === day) {
            refreshDay();
            UI.toast("Restored");
          } else {
            UI.toast("Restored on " + day);
          }
        },
      },
    });
  }

  function saveQty() {
    const food = state.pickFood;
    if (!food) return;
    const entry = UI.updateQtyPreview(food);
    if (!entry) { UI.toast("Enter a valid amount"); return; }
    entry.meal = UI.selectedMeal();
    if (food._orphan) {
      entry.foodId = food._keptFoodId || null;
    }
    const warns = FoodMatch.plausibility(entry);
    if (warns.length && !confirm(warns[0] + "\n\nLog it anyway?")) return;

    const day = editDay();
    let loggedEntryId = null;
    if (state.editEntryId) {
      Ledger.amendEntry(day, state.editEntryId, {
        name: entry.name,
        foodId: entry.foodId,
        cat: entry.cat,
        grams: entry.grams,
        displayQty: entry.displayQty,
        macros: entry.macros,
        sd: entry.sd,
        meal: entry.meal,
        qty: entry.qty,
        unit: entry.unit,
        per100: entry.per100,
        foodVersion: entry.foodVersion,
      }, "quantity edited");
      loggedEntryId = state.editEntryId;
    } else {
      if (state.pendingCatalogFood && state.pendingCatalogFood.id === food.id) {
        if (!state.personalFoods.some((f) => f.id === food.id)) {
          state.personalFoods.push(food);
        }
        state.pendingCatalogFood = null;
      }
      if (!entry.foodId && food.id && !food._orphan) entry.foodId = food.id;
      if (food._orphan) entry.foodId = null;
      // Ensure gap-selected catalog foods land in My Foods
      if (food.id && !food._orphan && !state.personalFoods.some((f) => f.id === food.id)) {
        state.personalFoods.push(food);
      }
      const ev = Ledger.addEntry(state.viewDay, entry);
      loggedEntryId = ev && ev.entry ? ev.entry.id : null;
      const idx = state.personalFoods.findIndex((f) => f.id === food.id);
      if (idx >= 0) {
        state.personalFoods[idx] = Foods.touchUse(state.personalFoods[idx]);
        savePersonal();
      } else {
        savePersonal();
      }
    }
    if (state.gapPendingItemId) markGapItemLogged(loggedEntryId);
    Sync.schedulePush();
    UI.closeSheet("sheet-qty");
    resetQtyState();
    refreshDay();
    UI.toast("Logged");
  }

  function openPaste(opts) {
    state.updateFoodId = (opts && opts.updateId) || null;
    state.saveAsNew = false;
    state.editFoodDirect = false;
    state.reviewParsed = null;
    // Library unless explicitly logging (Today Add → AI paste)
    state.foodSaveIntent = (opts && opts.intent === "log") ? "log" : "library";
    UI.$("#paste-text").value = "";
    UI.showPastePrompt();
    if (state.updateFoodId) UI.$("#paste-title").textContent = "Update from AI paste";
    else UI.$("#paste-title").textContent = "Add food from AI paste";
    UI.openSheet("sheet-paste");
  }

  function currentNutriPromptText() {
    let text = NutriParse.PROMPT;
    if (state.updateFoodId) {
      const f = findFood(state.updateFoodId);
      if (f) text = NutriParse.foodUpdatePrompt(f);
    }
    return text;
  }

  function copyPrompt() {
    const text = currentNutriPromptText();
    navigator.clipboard.writeText(text).then(() => UI.toast("Prompt copied")).catch(() => {
      UI.showPromptFallback(text);
      UI.toast("Select the prompt below, then copy");
    });
  }

  async function sharePrompt() {
    const text = currentNutriPromptText();
    await sharePromptText(text, {
      okToast: "Prompt copied",
      onClipboardFail: (t) => {
        UI.showPromptFallback(t);
        UI.toast("Select the prompt below, then copy");
      },
    });
  }

  function importPaste() {
    const text = UI.$("#paste-text").value;
    const parsed = NutriParse.parse(text);
    if (!parsed.found) {
      UI.toast(parsed.error);
      return;
    }
    if (parsed.results.length > 1) {
      UI.toast(`Found ${parsed.results.length} foods — importing the first. Paste one dish at a time.`);
    }
    const result = parsed.results[0];
    result.food.raw = text.slice(0, 12000);
    state.reviewParsed = result;
    state.editFoodDirect = false;
    const dup = !state.updateFoodId ? Foods.findByName(state.personalFoods, result.food.name) : null;
    UI.showReview(result, {
      updateId: state.updateFoodId,
      duplicate: dup && (!state.updateFoodId || dup.id !== state.updateFoodId) ? dup : null,
      forceEnable: true,
    });
    validateReviewSave();
  }

  function openManualReview() {
    // Don't overwrite an existing food via leftover updateFoodId from "Update from AI paste"
    const updating = state.updateFoodId ? findFood(state.updateFoodId) : null;
    state.editFoodDirect = !!updating;
    if (updating) {
      state.reviewParsed = {
        canSave: true,
        food: {
          name: updating.name,
          aliases: updating.aliases || [],
          cat: updating.cat || "dish",
          per100: { ...updating.per100 },
          units: { ...(updating.units || {}) },
          batch: updating.batch ? { ...updating.batch } : null,
          recipe: {
            ingredients: (updating.recipe && updating.recipe.ingredients) || [],
            prep: (updating.recipe && updating.recipe.prep) || "",
            notes: (updating.recipe && updating.recipe.notes) || "",
          },
          confidence: updating.confidence || "medium",
          sd: updating.sd || 0.12,
          raw: updating.raw || "",
        },
        warnings: [],
        rejects: [],
      };
      UI.showReview(state.reviewParsed, { updateId: updating.id, forceEnable: true, title: "Edit food" });
    } else {
      state.updateFoodId = null;
      state.reviewParsed = {
        canSave: true,
        food: {
          name: "",
          aliases: [],
          cat: "dish",
          per100: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0 },
          units: {},
          batch: null,
          recipe: { ingredients: [], prep: "", notes: "" },
          confidence: "medium",
          sd: 0.12,
          raw: UI.$("#paste-text").value || "",
        },
        warnings: [],
        rejects: [],
      };
      UI.showReview(state.reviewParsed, { forceEnable: true });
    }
    validateReviewSave();
  }

  function validateReviewSave() {
    const draft = UI.readReviewDraft(state.reviewParsed && state.reviewParsed.food);
    const reasons = [];
    if (!draft.name) reasons.push("Name is required.");
    if (draft.per100.kcal < 0) reasons.push("Calories can't be negative.");
    if (draft.per100.kcal > 920) reasons.push("kcal per 100 g looks impossibly high.");
    if (draft.per100.p + draft.per100.c + draft.per100.f > 105) reasons.push("Protein + carbs + fat can't exceed 105 g per 100 g.");
    UI.setReviewErrors(reasons);
    UI.$("#btn-review-save").disabled = reasons.length > 0;
    return reasons.length === 0;
  }

  function saveReview() {
    if (!validateReviewSave()) { UI.toast("Fix the highlighted fields"); return; }
    const draft = UI.readReviewDraft(state.reviewParsed && state.reviewParsed.food);
    let updateId = state.updateFoodId;
    if (!updateId && !state.saveAsNew) {
      const dup = Foods.findByName(state.personalFoods, draft.name);
      if (dup) updateId = dup.id;
    }

    let savedFood = null;
    if (updateId) {
      const idx = state.personalFoods.findIndex((f) => f.id === updateId);
      if (idx < 0) { UI.toast("Food not found"); return; }
      const prev = state.personalFoods[idx];
      state.personalFoods[idx] = Foods.applyUpdate(prev, draft);
      savedFood = state.personalFoods[idx];
      // amend logs on the day being viewed (not always calendar today)
      const day = state.viewDay || Ledger.todayKey();
      const dayEntries = Ledger.entriesFor(day).filter((e) => e.foodId === updateId);
      const dayLabel = day === Ledger.todayKey() ? "today" : "this day";
      if (dayEntries.length && confirm(`Update ${dayEntries.length} log(s) ${dayLabel} to the new recipe numbers?`)) {
        const food = savedFood;
        for (const e of dayEntries) {
          const qty = e.qty || e.grams;
          const unit = e.unit || "g";
          const fresh = Foods.entryFromQty(food, qty, unit, e.meal);
          Ledger.amendEntry(day, e.id, {
            macros: fresh.macros,
            sd: fresh.sd,
            per100: fresh.per100,
            foodVersion: fresh.foodVersion,
            grams: fresh.grams,
            displayQty: fresh.displayQty,
          }, `recipe updated to v${food.version}`);
        }
      }
      UI.toast("Food updated");
    } else {
      savedFood = Foods.createFromDraft(draft);
      state.personalFoods.push(savedFood);
      UI.toast("Food saved");
    }
    const wasDirect = state.editFoodDirect;
    const intent = state.foodSaveIntent === "log" ? "log" : "library";
    savePersonal();
    state.updateFoodId = null;
    state.saveAsNew = false;
    state.editFoodDirect = false;
    state.foodSaveIntent = "library";
    UI.closeSheet("sheet-paste");
    refreshFoods();
    if (!savedFood) return;
    // Library path: Foods + detail (building database). Log path: Today + qty.
    if (wasDirect || intent === "library" || updateId) {
      switchView("foods");
      openDetail(savedFood.id, "library");
    } else {
      switchView("today");
      openQty(savedFood);
    }
  }

  function openDetail(id, mode) {
    const food = findFood(id);
    if (!food) return;
    state.detailMode = mode === "log" ? "log" : "library";
    UI.renderFoodDetail(food, { mode: state.detailMode });
    UI.openSheet("sheet-detail");
  }

  function selectedPhaseKind() {
    const on = UI.$("#phase-kind-seg button.on");
    return Phases.normalizeKind(on && on.dataset.phaseKind);
  }

  function selectedNewPhaseKind() {
    const on = UI.$("#np-kind-seg button.on");
    return Phases.normalizeKind(on && on.dataset.npKind);
  }

  function setKindSeg(segSel, kind, dataAttr) {
    const k = Phases.normalizeKind(kind);
    UI.$$(`${segSel} button`).forEach((b) => {
      const val = dataAttr === "np" ? b.dataset.npKind : b.dataset.phaseKind;
      b.classList.toggle("on", val === k);
    });
  }

  function renderPhaseRevisionList() {
    const list = UI.$("#phase-revision-list");
    if (!list) return;
    const phase = Phases.activePhase(state.settings.phases);
    const rows = Phases.revisionHistoryRows(phase);
    if (!rows.length) {
      list.innerHTML = `<p class="muted small">No target versions yet.</p>`;
      return;
    }
    const canDelete = rows.length > 1;
    list.innerHTML = rows.map((r) => {
      const when = r.effectiveFrom ? Phases.shortDate(r.effectiveFrom) : "";
      const cur = r.current ? `<span class="rev-badge">current</span>` : "";
      const del = canDelete
        ? `<button type="button" class="linkbtn danger rev-del" data-rev-id="${r.id}">Delete</button>`
        : "";
      return `<div class="rev-row" data-rev-id="${r.id}">
        <div class="rev-main">
          <div class="rev-label">${r.label || "Version"} ${cur}</div>
          <div class="muted small">${when} · ${r.summary}</div>
        </div>
        ${del}
      </div>`;
    }).join("");
  }

  function syncSettingsForm() {
    Phases.ensureMigrated(state.settings, Phases.earliestDayFromEvents(Ledger.allEvents()), Ledger.todayKey());
    const phase = Phases.activePhase(state.settings.phases);
    const g = state.settings.goals;
    UI.$("#set-kcal").value = g.kcal;
    UI.$("#set-protein").value = g.protein;
    UI.$("#set-carbs").value = g.carbs;
    UI.$("#set-fat").value = g.fat;
    UI.$("#set-fiber").value = g.fiber;
    if (UI.$("#set-sodium")) UI.$("#set-sodium").value = g.sodium != null ? g.sodium : DEFAULT_GOALS.sodium;
    if (phase) {
      Phases.applyPhaseLabel(phase);
      setKindSeg("#phase-kind-seg", phase.kind, "phase");
      if (UI.$("#phase-current-label")) UI.$("#phase-current-label").textContent = phase.name;
      const hint = UI.$("#phase-save-hint");
      if (hint) {
        const n = (phase.revisions || []).length;
        hint.textContent = n > 1
          ? `${n} target versions on file. Open Target history to review or delete.`
          : "Pick Cut, Maintain, or Bulk. Saving changed numbers bumps the version from today.";
      }
    }
    if (UI.$("#set-phase-major")) UI.$("#set-phase-major").checked = false;
    const profile = Phases.ensureProfile(state.settings);
    if (UI.$("#set-dob")) UI.$("#set-dob").value = profile.dob || "";
    if (UI.$("#set-sex")) UI.$("#set-sex").value = profile.sex || "";
    if (UI.$("#set-height")) UI.$("#set-height").value = profile.heightCm != null ? profile.heightCm : "";
    if (UI.$("#set-activity")) UI.$("#set-activity").value = profile.activity || "";
    if (UI.$("#set-profile-notes")) UI.$("#set-profile-notes").value = profile.notes || "";
    const ageHint = UI.$("#profile-age-hint");
    if (ageHint) {
      const age = Phases.ageFromDob(profile.dob, Ledger.todayKey());
      ageHint.textContent = age != null
        ? `Age today: ${age}. Log weight on Today so AI targets can use it.`
        : "Add date of birth, sex, height, and activity. Log weight on Today.";
    }
    UI.$("#set-imperial").checked = !!state.settings.imperial;
    const wu = bodyWeightUnit();
    UI.$$("#weight-unit-seg [data-weight-unit]").forEach((b) => b.classList.toggle("on", b.dataset.weightUnit === wu));
    UI.$("#set-gclient").value = localStorage.getItem("nd_gclient") || "";
    const theme = state.settings.theme || "light";
    UI.$$("#theme-seg [data-theme-opt]").forEach((b) => b.classList.toggle("on", b.dataset.themeOpt === theme));
    const baked = ((window.ND_CONFIG || {}).googleClientId || "").trim();
    const override = (localStorage.getItem("nd_gclient") || "").trim();
    UI.$("#client-id-hint").textContent = override
      ? "Using your override Client ID."
      : baked
        ? "Using the deploy default Client ID. Paste below only to override."
        : "No deploy Client ID yet. Paste a Web Client ID here, or set GOOGLE_CLIENT_ID on Vercel.";
    if (!baked && !override) UI.$("#client-id-details").open = true;
  }

  function persistProfile(profile) {
    state.settings.profile = Phases.normalizeProfile({ ...profile, updatedAt: Date.now() });
    saveSettings();
    Sync.schedulePush();
  }

  function saveProfileFromSettingsFields() {
    const height = Number(UI.$("#set-height") && UI.$("#set-height").value);
    persistProfile({
      dob: (UI.$("#set-dob") && UI.$("#set-dob").value) || "",
      sex: (UI.$("#set-sex") && UI.$("#set-sex").value) || "",
      heightCm: Number.isFinite(height) ? height : null,
      activity: (UI.$("#set-activity") && UI.$("#set-activity").value) || "",
      notes: (UI.$("#set-profile-notes") && UI.$("#set-profile-notes").value) || "",
    });
    syncSettingsForm();
  }

  function saveProfileFromAiSheet() {
    const height = Number(UI.$("#ai-height") && UI.$("#ai-height").value);
    persistProfile({
      dob: (UI.$("#ai-dob") && UI.$("#ai-dob").value) || "",
      sex: (UI.$("#ai-sex") && UI.$("#ai-sex").value) || "",
      heightCm: Number.isFinite(height) ? height : null,
      activity: (UI.$("#ai-activity") && UI.$("#ai-activity").value) || "",
      notes: (UI.$("#ai-notes") && UI.$("#ai-notes").value) || "",
    });
  }

  function sheetWeightKg() {
    const el = UI.$("#ai-weight");
    const n = el ? Number(el.value) : NaN;
    if (Number.isFinite(n) && n > 0) {
      const kg = displayToKg(n);
      if (kg != null) return kg;
    }
    return Phases.latestWeightKg(state.settings, Ledger.todayKey());
  }

  function refreshAiCopyGate() {
    const btn = UI.$("#btn-copy-phase-prompt");
    const shareBtn = UI.$("#btn-share-phase-prompt");
    const hint = UI.$("#ai-missing-hint");
    if (!btn && !shareBtn) return;
    const height = Number(UI.$("#ai-height") && UI.$("#ai-height").value);
    const profile = Phases.normalizeProfile({
      dob: (UI.$("#ai-dob") && UI.$("#ai-dob").value) || "",
      sex: (UI.$("#ai-sex") && UI.$("#ai-sex").value) || "",
      heightCm: Number.isFinite(height) ? height : null,
      activity: (UI.$("#ai-activity") && UI.$("#ai-activity").value) || "",
      notes: (UI.$("#ai-notes") && UI.$("#ai-notes").value) || "",
      updatedAt: Date.now(),
    });
    const ready = Phases.profileReadyForAi(
      { ...state.settings, profile },
      { todayKey: Ledger.todayKey(), weightKg: sheetWeightKg() }
    );
    [btn, shareBtn].forEach((el) => {
      if (!el) return;
      el.disabled = !ready.ok;
      el.setAttribute("aria-disabled", ready.ok ? "false" : "true");
    });
    if (hint) {
      hint.textContent = ready.ok
        ? "Ready to copy or share. Paste into ChatGPT or Claude, then paste the PHASE reply below."
        : `Copy is disabled until you add: ${ready.missing.join(", ")}.`;
    }
    return ready;
  }

  function buildPhasePromptFromSheet() {
    const ready = refreshAiCopyGate();
    if (!ready || !ready.ok) return null;
    saveProfileFromAiSheet();
    return PhasePrompt.buildTargetPrompt({
      kind: selectedPhaseKind(),
      age: ready.age,
      profile: ready.profile,
      weightKg: ready.weightKg,
      weightUnit: bodyWeightUnit(),
      notes: (UI.$("#ai-notes") && UI.$("#ai-notes").value) || "",
    });
  }

  function openAiTargetsSheet() {
    const profile = Phases.ensureProfile(state.settings);
    if (UI.$("#ai-dob")) UI.$("#ai-dob").value = profile.dob || "";
    if (UI.$("#ai-sex")) UI.$("#ai-sex").value = profile.sex || "";
    if (UI.$("#ai-height")) UI.$("#ai-height").value = profile.heightCm != null ? profile.heightCm : "";
    if (UI.$("#ai-activity")) UI.$("#ai-activity").value = profile.activity || "";
    if (UI.$("#ai-notes")) UI.$("#ai-notes").value = profile.notes || "";
    const w = Phases.latestWeightKg(state.settings, Ledger.todayKey());
    const wu = bodyWeightUnit();
    if (UI.$("#ai-weight-label")) UI.$("#ai-weight-label").textContent = `Weight (${wu})`;
    if (UI.$("#ai-weight")) {
      const shown = w != null ? kgToDisplay(w) : null;
      UI.$("#ai-weight").value = shown == null ? "" : (wu === "kg" ? String(shown) : shown.toFixed(1));
    }
    const kind = selectedPhaseKind();
    if (UI.$("#ai-kind-label")) UI.$("#ai-kind-label").textContent = Phases.KIND_LABEL[kind] || kind;
    if (UI.$("#ai-phase-paste")) UI.$("#ai-phase-paste").value = "";
    if (UI.$("#ai-phase-options")) UI.$("#ai-phase-options").innerHTML = "";
    refreshAiCopyGate();
    UI.openSheet("sheet-phase-targets");
  }

  function renderAiPhaseOptions(parsed) {
    const box = UI.$("#ai-phase-options");
    if (!box) return;
    if (!parsed || !parsed.ok) {
      box.innerHTML = "";
      return;
    }
    box.innerHTML = parsed.options.map((o, i) => {
      const g = o.goals;
      return `<div class="phase-option">
        <h4>${UI.esc(o.label)} · ${Math.round(g.kcal)} kcal</h4>
        <p class="muted small">P${Math.round(g.protein)} · C${Math.round(g.carbs)} · F${Math.round(g.fat)} · Fiber ${Math.round(g.fiber)} · Na ${Math.round(g.sodium)}</p>
        <p class="muted small">${UI.esc(o.reason)}</p>
        <p class="muted small">${UI.esc(o.sources)}</p>
        <button type="button" class="btn full ai-apply-opt" data-opt="${i}">Apply to phase targets</button>
      </div>`;
    }).join("");
    box._parsed = parsed;
  }

  let pendingSharedFood = null;

  function openImportSharedSheet(prefill) {
    pendingSharedFood = null;
    const ta = UI.$("#shared-import-text");
    const prev = UI.$("#shared-import-preview");
    const save = UI.$("#btn-shared-save");
    if (ta) ta.value = prefill || "";
    if (prev) { prev.hidden = true; prev.innerHTML = ""; }
    if (save) save.disabled = true;
    UI.closeSheet("sheet-add");
    UI.openSheet("sheet-import-shared");
    if (prefill) previewSharedImport();
  }

  function previewSharedImport() {
    const raw = (UI.$("#shared-import-text") && UI.$("#shared-import-text").value) || "";
    const parsed = Share.unpack(raw);
    const prev = UI.$("#shared-import-preview");
    const save = UI.$("#btn-shared-save");
    if (!prev || !save) return;
    if (!parsed.ok) {
      pendingSharedFood = null;
      prev.hidden = false;
      prev.innerHTML = `<p class="muted small">${UI.esc(parsed.err || "Could not read that code.")}</p>`;
      save.disabled = true;
      return;
    }
    pendingSharedFood = parsed.food;
    const p = parsed.food.per100;
    const serv = parsed.food.units && parsed.food.units.serving;
    prev.hidden = false;
    prev.innerHTML = `<b>${UI.esc(parsed.food.name)}</b>
      <p class="muted small">Per 100 g: ${Math.round(p.kcal)} kcal · P ${p.p} · C ${p.c} · F ${p.f}</p>
      ${serv ? `<p class="muted small">Serving: ${serv} g</p>` : ""}
      <p class="muted small">Review numbers before adding. You can edit anytime after import.</p>`;
    save.disabled = false;
  }

  function saveSharedImport() {
    if (!pendingSharedFood) {
      UI.toast("Preview a valid code first");
      return;
    }
    const name = pendingSharedFood.name;
    const dup = activeFoods().find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (dup && !confirm(`You already have “${dup.name}”. Add another copy anyway?`)) return;
    const food = Foods.createFromDraft({
      name: pendingSharedFood.name,
      aliases: pendingSharedFood.aliases || [],
      cat: pendingSharedFood.cat || "dish",
      per100: pendingSharedFood.per100,
      units: pendingSharedFood.units || {},
      recipe: pendingSharedFood.recipe || { ingredients: [], prep: "", notes: "" },
      confidence: "medium",
      sd: 0.15,
      raw: "",
    });
    food.source = "shared";
    state.personalFoods.push(food);
    savePersonal();
    Sync.schedulePush();
    pendingSharedFood = null;
    UI.closeSheet("sheet-import-shared");
    switchView("foods");
    refreshFoods();
    openDetail(food.id, "library");
    UI.toast("Food added to My Foods");
  }

  async function shareFoodById(id) {
    const food = findFood(id);
    if (!food) return;
    // url = clean app home (OG/favicon icon in chat); text = short NCR1 code.
    const data = Share.shareData(food);
    const clipboard = Share.shareText(food);
    try {
      if (navigator.share) {
        await navigator.share(data);
        UI.toast("Share sheet opened");
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(clipboard);
      UI.toast("Food code copied");
    } catch (_) {
      window.prompt("Copy this food code:", clipboard);
    }
  }

  function consumeRecipeHash() {
    const hash = String(location.hash || "");
    const m = hash.match(/[#&?]recipe=(NCR1\.[A-Za-z0-9\-_]+)/i)
      || hash.match(/(NCR1\.[A-Za-z0-9\-_]+)/);
    if (!m) return;
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (_) { /* ignore */ }
    openImportSharedSheet(m[1]);
  }

  function openSettings() {
    switchView("settings");
  }

  function refreshSettingsTabNudge() {
    const tab = document.querySelector('.bottom-tabs .tab[data-view="settings"]');
    if (!tab) return;
    const st = Sync.state();
    const nudge = !st.enabled && !localStorage.getItem(SIGNIN_SEEN_KEY);
    tab.classList.toggle("tab-nudge", nudge);
  }

  function refreshDriveStatus() {
    const st = Sync.state();
    const el = UI.$("#drive-status");
    const hint = UI.$("#drive-reconnect-hint");
    const connect = UI.$("#btn-drive-connect");
    const syncBtn = UI.$("#btn-drive-sync");
    const disconnect = UI.$("#btn-drive-disconnect");
    if (st.enabled) {
      el.textContent = st.email
        ? `Connected as ${st.email}. Folder: NutriDaily / nutridaily-data.json`
        : "Connected. Folder: NutriDaily / nutridaily-data.json";
      if (st.status === "auth") el.textContent += " — sync paused; tap Reconnect or Sync now.";
      connect.style.display = st.status === "auth" ? "" : "none";
      connect.textContent = st.status === "auth" ? "Reconnect" : "Sign in with Google";
      syncBtn.style.display = "";
      disconnect.style.display = "";
      if (hint) hint.hidden = false;
    } else {
      el.textContent = GDrive.unavailableReason() || "Not connected. Tracking without sign-in still works.";
      connect.style.display = "";
      connect.textContent = "Sign in with Google";
      syncBtn.style.display = "none";
      disconnect.style.display = "none";
      if (hint) hint.hidden = true;
    }
  }

  function authErrMsg(e, fallback) {
    const m = (e && e.message) || "";
    if (m === GDrive.NEEDS_AUTH || m === "needs-auth") {
      return "Could not finish Google Drive connect. Tap Sign in again.";
    }
    return m || fallback || "Connect failed";
  }

  async function connectDrive() {
    try {
      const email = await Sync.connect();
      if (email == null && !GDrive.cachedToken()) return; // BFF redirect in progress
      localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
      localStorage.setItem(SIGNIN_SEEN_KEY, "1");
      refreshDriveStatus();
      refreshInfoBanner();
      UI.toast("Drive connected");
    } catch (err) {
      UI.toast(authErrMsg(err));
      refreshDriveStatus();
      refreshInfoBanner();
    }
  }

  async function syncNowInteractive() {
    try {
      const r = await Sync.fullSync(true);
      if (r && r.busy) { UI.toast("Sync already running"); return; }
      if (!r || !r.ok) { UI.toast((r && r.error && r.error.message) || "Sync failed"); return; }
      localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
      UI.toast("Synced");
    } catch (err) {
      UI.toast(err.message || "Sync failed");
    }
    refreshDriveStatus();
    refreshInfoBanner();
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({
      version: 3,
      exportedAt: new Date().toISOString(),
      resetAt: Sync.getResetAt(),
      settings: state.settings,
      personalFoods: state.personalFoods,
      events: Ledger.allEvents(),
    }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nutridaily-export-${Ledger.todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1500);
  }

  function importData(file) {
    if (!confirm("Import replaces all foods and logs on this device (and the next Drive sync). Continue?")) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        Sync.markReset(Date.now());
        Ledger.replaceAll(Array.isArray(data.events) ? data.events : []);
        state.personalFoods = Array.isArray(data.personalFoods) ? data.personalFoods : [];
        if (data.settings) {
          Object.assign(state.settings, data.settings);
          delete state.settings.key;
          delete state.settings.model;
          state.settings.goals = { ...DEFAULT_GOALS, ...(state.settings.goals || {}) };
          if (!state.settings.weights || typeof state.settings.weights !== "object") state.settings.weights = {};
          Phases.ensureProfile(state.settings);
          Phases.ensureMigrated(
            state.settings,
            Phases.earliestDayFromEvents(Ledger.allEvents()),
            Ledger.todayKey()
          );
        }
        saveSettings();
        savePersonal();
        refreshAll();
        Sync.fullSync(false).catch(() => {});
        UI.toast("Imported");
      } catch (e) {
        UI.toast("Import failed");
      }
    };
    reader.readAsText(file);
  }

  function wire() {
    document.querySelectorAll(".bottom-tabs .tab").forEach((t) => {
      t.addEventListener("click", () => switchView(t.dataset.view));
    });
    UI.$("#btn-day-prev").addEventListener("click", () => shiftDay(-1));
    UI.$("#btn-day-next").addEventListener("click", () => shiftDay(1));
    UI.$("#fab-add").addEventListener("click", openAddSheet);

    if (UI.$("#btn-close-gap")) {
      UI.$("#btn-close-gap").addEventListener("click", () => openGapSheet({ plan: false }));
    }
    if (UI.$("#btn-gap-plan")) {
      UI.$("#btn-gap-plan").addEventListener("click", () => openGapSheet({ plan: true }));
    }
    if (UI.$("#btn-gap-to-prompt")) {
      UI.$("#btn-gap-to-prompt").addEventListener("click", () => {
        if (Object.keys(state.gapSelected).length < 1) {
          UI.toast("Select at least one food");
          return;
        }
        if (UI.$("#gap-paste")) UI.$("#gap-paste").value = "";
        showGapSheetStep("prompt");
      });
    }
    if (UI.$("#btn-gap-select-cancel")) {
      UI.$("#btn-gap-select-cancel").addEventListener("click", () => UI.closeSheet("sheet-gap"));
    }
    if (UI.$("#btn-gap-copy-prompt")) {
      UI.$("#btn-gap-copy-prompt").addEventListener("click", copyGapPrompt);
    }
    if (UI.$("#btn-gap-share-prompt")) {
      UI.$("#btn-gap-share-prompt").addEventListener("click", () => { shareGapPrompt(); });
    }
    if (UI.$("#btn-gap-parse")) {
      UI.$("#btn-gap-parse").addEventListener("click", importGapPaste);
    }
    if (UI.$("#btn-gap-back-select")) {
      UI.$("#btn-gap-back-select").addEventListener("click", () => showGapSheetStep("select"));
    }
    if (UI.$("#btn-gap-choose-back")) {
      UI.$("#btn-gap-choose-back").addEventListener("click", () => showGapSheetStep("prompt"));
    }
    if (UI.$("#gap-option-list")) {
      UI.$("#gap-option-list").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action='apply-gap-option']");
        if (!btn) return;
        const i = Number(btn.dataset.opt);
        const opts = state.gapParsed && state.gapParsed.options;
        if (!opts || !opts[i]) {
          UI.toast("Option missing — parse again");
          return;
        }
        applyGapOption(opts[i], state.gapParsed);
      });
    }
    if (UI.$("#btn-gap-recalc")) {
      UI.$("#btn-gap-recalc").addEventListener("click", startGapRecalc);
    }
    if (UI.$("#btn-gap-add-foods")) {
      UI.$("#btn-gap-add-foods").addEventListener("click", () => showGapSheetStep("select"));
    }
    if (UI.$("#btn-gap-clear-plan")) {
      UI.$("#btn-gap-clear-plan").addEventListener("click", clearGapPlan);
    }
    if (UI.$("#btn-gap-plan-close")) {
      UI.$("#btn-gap-plan-close").addEventListener("click", () => UI.closeSheet("sheet-gap"));
    }
    if (UI.$("#gap-food-search")) {
      UI.$("#gap-food-search").addEventListener("input", () => refreshGapSelectList());
    }
    if (UI.$("#gap-select-list")) {
      UI.$("#gap-select-list").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action='gap-toggle']");
        if (!btn) return;
        toggleGapSelect(btn.dataset.key);
      });
    }
    if (UI.$("#gap-plan-list")) {
      UI.$("#gap-plan-list").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action='log-gap-item']");
        if (!btn || btn.disabled) return;
        openGapItemQty(btn.dataset.id);
      });
    }
    UI.$("#btn-add-food").addEventListener("click", () => openPaste({ intent: "library" }));
    UI.$("#btn-paste-new").addEventListener("click", () => {
      UI.closeSheet("sheet-add");
      openPaste({ intent: "log" });
    });
    const openShared = () => openImportSharedSheet();
    if (UI.$("#btn-import-shared")) UI.$("#btn-import-shared").addEventListener("click", openShared);
    if (UI.$("#btn-import-shared-add")) UI.$("#btn-import-shared-add").addEventListener("click", openShared);
    if (UI.$("#btn-shared-cancel")) {
      UI.$("#btn-shared-cancel").addEventListener("click", () => UI.closeSheet("sheet-import-shared"));
    }
    if (UI.$("#btn-shared-parse")) UI.$("#btn-shared-parse").addEventListener("click", previewSharedImport);
    if (UI.$("#btn-shared-save")) UI.$("#btn-shared-save").addEventListener("click", saveSharedImport);
    if (UI.$("#shared-import-text")) {
      UI.$("#shared-import-text").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) previewSharedImport();
      });
    }
    UI.$("#theme-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-theme-opt]");
      if (!btn) return;
      state.settings.theme = btn.dataset.themeOpt;
      saveSettings();
      applyTheme();
      syncSettingsForm();
    });
    UI.$("#btn-clear-gclient").addEventListener("click", () => {
      localStorage.removeItem("nd_gclient");
      UI.$("#set-gclient").value = "";
      syncSettingsForm();
      UI.toast("Override cleared");
    });
    const persistClientId = () => {
      const gc = (UI.$("#set-gclient") && UI.$("#set-gclient").value.trim()) || "";
      if (gc) localStorage.setItem("nd_gclient", gc);
      else localStorage.removeItem("nd_gclient");
      syncSettingsForm();
    };
    if (UI.$("#set-gclient")) {
      UI.$("#set-gclient").addEventListener("change", persistClientId);
      UI.$("#set-gclient").addEventListener("blur", persistClientId);
    }
    if (UI.$("#set-imperial")) {
      UI.$("#set-imperial").addEventListener("change", () => {
        state.settings.imperial = UI.$("#set-imperial").checked;
        saveSettings();
        UI.toast(state.settings.imperial ? "Food ounces on" : "Food grams only");
      });
    }
    if (UI.$("#weight-unit-seg")) {
      UI.$("#weight-unit-seg").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-weight-unit]");
        if (!btn) return;
        state.settings.weightUnit = btn.dataset.weightUnit === "kg" ? "kg" : "lb";
        saveSettings();
        syncSettingsForm();
        syncWeightField();
        refreshInsights();
        UI.toast(state.settings.weightUnit === "kg" ? "Body weight in kg" : "Body weight in lb");
      });
    }
    UI.$("#btn-save-settings").addEventListener("click", () => {
      const today = Ledger.todayKey();
      Phases.ensureMigrated(state.settings, Phases.earliestDayFromEvents(Ledger.allEvents()), today);
      const nextGoals = {
        kcal: Number(UI.$("#set-kcal").value) || DEFAULT_GOALS.kcal,
        protein: Number(UI.$("#set-protein").value) || 0,
        carbs: Number(UI.$("#set-carbs").value) || 0,
        fat: Number(UI.$("#set-fat").value) || 0,
        fiber: Number(UI.$("#set-fiber").value) || 0,
        sodium: Number(UI.$("#set-sodium") && UI.$("#set-sodium").value) || 0,
      };
      const forceMajor = !!(UI.$("#set-phase-major") && UI.$("#set-phase-major").checked);
      const result = Phases.appendRevision(state.settings, nextGoals, today, "", {
        kind: selectedPhaseKind(),
        magnitude: forceMajor ? "major" : undefined,
      });
      saveSettings();
      Sync.schedulePush();
      refreshAll();
      syncSettingsForm();
      if (!result) UI.toast("No changes");
      else if (result.changed) UI.toast(`Saved ${result.label}`);
      else UI.toast(`Updated to ${result.label}`);
    });

    if (UI.$("#phase-kind-seg")) {
      UI.$("#phase-kind-seg").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-phase-kind]");
        if (!btn) return;
        setKindSeg("#phase-kind-seg", btn.dataset.phaseKind, "phase");
      });
    }

    if (UI.$("#btn-phase-history")) {
      UI.$("#btn-phase-history").addEventListener("click", () => {
        renderPhaseRevisionList();
        UI.openSheet("sheet-phase-revisions");
      });
    }
    if (UI.$("#rev-close")) {
      UI.$("#rev-close").addEventListener("click", () => UI.closeSheet("sheet-phase-revisions"));
    }
    if (UI.$("#phase-revision-list")) {
      UI.$("#phase-revision-list").addEventListener("click", (e) => {
        const btn = e.target.closest(".rev-del");
        if (!btn) return;
        const phase = Phases.activePhase(state.settings.phases);
        if (!phase) return;
        if (!confirm("Delete this target version? Days that used it will fall back to the previous version.")) return;
        const res = Phases.deleteRevision(state.settings, phase.id, btn.dataset.revId, Ledger.todayKey());
        if (!res.ok) {
          UI.toast(res.reason === "last" ? "Keep at least one version" : "Could not delete");
          return;
        }
        saveSettings();
        Sync.schedulePush();
        refreshAll();
        syncSettingsForm();
        renderPhaseRevisionList();
        UI.toast("Version deleted");
      });
    }

    UI.$("#btn-start-phase").addEventListener("click", () => {
      const g = state.settings.goals;
      const phase = Phases.activePhase(state.settings.phases);
      setKindSeg("#np-kind-seg", phase && phase.kind === "cut" ? "bulk" : phase && phase.kind === "bulk" ? "cut" : "bulk", "np");
      UI.$("#np-copy").checked = true;
      UI.$("#np-kcal").value = g.kcal;
      UI.$("#np-protein").value = g.protein;
      UI.$("#np-carbs").value = g.carbs;
      UI.$("#np-fat").value = g.fat;
      UI.$("#np-fiber").value = g.fiber;
      UI.$("#np-sodium").value = g.sodium;
      UI.$("#np-goals").hidden = true;
      UI.openSheet("sheet-new-phase");
    });
    if (UI.$("#np-kind-seg")) {
      UI.$("#np-kind-seg").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-np-kind]");
        if (!btn) return;
        setKindSeg("#np-kind-seg", btn.dataset.npKind, "np");
      });
    }
    UI.$("#np-copy").addEventListener("change", () => {
      UI.$("#np-goals").hidden = UI.$("#np-copy").checked;
    });
    UI.$("#np-cancel").addEventListener("click", () => {
      UI.closeSheet("sheet-new-phase");
    });
    UI.$("#np-save").addEventListener("click", () => {
      const today = Ledger.todayKey();
      const copy = UI.$("#np-copy").checked;
      const goals = copy ? null : {
        kcal: Number(UI.$("#np-kcal").value) || DEFAULT_GOALS.kcal,
        protein: Number(UI.$("#np-protein").value) || 0,
        carbs: Number(UI.$("#np-carbs").value) || 0,
        fat: Number(UI.$("#np-fat").value) || 0,
        fiber: Number(UI.$("#np-fiber").value) || 0,
        sodium: Number(UI.$("#np-sodium").value) || 0,
      };
      const started = Phases.startPhase(state.settings, {
        kind: selectedNewPhaseKind(),
        goals,
        startDay: today,
        copyGoals: copy,
      });
      saveSettings();
      Sync.schedulePush();
      UI.closeSheet("sheet-new-phase");
      refreshAll();
      syncSettingsForm();
      UI.toast(`Started ${started.name}`);
    });

    const profileFields = ["#set-dob", "#set-sex", "#set-height", "#set-activity", "#set-profile-notes"];
    for (const sel of profileFields) {
      const el = UI.$(sel);
      if (!el) continue;
      el.addEventListener("change", saveProfileFromSettingsFields);
      if (el.tagName === "TEXTAREA" || el.type === "text" || el.type === "number") {
        el.addEventListener("blur", saveProfileFromSettingsFields);
      }
    }

    if (UI.$("#btn-ai-targets")) {
      UI.$("#btn-ai-targets").addEventListener("click", openAiTargetsSheet);
    }
    if (UI.$("#ai-targets-close")) {
      UI.$("#ai-targets-close").addEventListener("click", () => UI.closeSheet("sheet-phase-targets"));
    }
    const aiFields = ["#ai-dob", "#ai-sex", "#ai-height", "#ai-activity", "#ai-weight", "#ai-notes"];
    for (const sel of aiFields) {
      const el = UI.$(sel);
      if (!el) continue;
      el.addEventListener("input", refreshAiCopyGate);
      el.addEventListener("change", () => {
        if (sel !== "#ai-weight") saveProfileFromAiSheet();
        refreshAiCopyGate();
        syncSettingsForm();
      });
    }
    if (UI.$("#btn-copy-phase-prompt")) {
      UI.$("#btn-copy-phase-prompt").addEventListener("click", () => {
        const text = buildPhasePromptFromSheet();
        if (!text) {
          UI.toast("Fill the required profile fields first");
          return;
        }
        navigator.clipboard.writeText(text).then(() => UI.toast("AI targets prompt copied")).catch(() => {
          window.prompt("Select all and copy (Cmd/Ctrl+C):", text);
        });
      });
    }
    if (UI.$("#btn-share-phase-prompt")) {
      UI.$("#btn-share-phase-prompt").addEventListener("click", async () => {
        const text = buildPhasePromptFromSheet();
        if (!text) {
          UI.toast("Fill the required profile fields first");
          return;
        }
        await sharePromptText(text, { okToast: "AI targets prompt copied" });
      });
    }
    if (UI.$("#btn-parse-phase")) {
      UI.$("#btn-parse-phase").addEventListener("click", () => {
        const raw = (UI.$("#ai-phase-paste") && UI.$("#ai-phase-paste").value) || "";
        const parsed = PhasePrompt.parsePhaseBlock(raw);
        if (!parsed.ok) {
          UI.toast(parsed.error || "Could not parse");
          renderAiPhaseOptions(null);
          return;
        }
        renderAiPhaseOptions(parsed);
        UI.toast(`${parsed.options.length} options ready`);
      });
    }
    if (UI.$("#ai-phase-options")) {
      UI.$("#ai-phase-options").addEventListener("click", (e) => {
        const btn = e.target.closest(".ai-apply-opt");
        if (!btn) return;
        const parsed = UI.$("#ai-phase-options")._parsed;
        const opt = parsed && parsed.options[Number(btn.dataset.opt)];
        if (!opt) return;
        const g = opt.goals;
        UI.$("#set-kcal").value = g.kcal;
        UI.$("#set-protein").value = g.protein;
        UI.$("#set-carbs").value = g.carbs;
        UI.$("#set-fat").value = g.fat;
        UI.$("#set-fiber").value = g.fiber;
        if (UI.$("#set-sodium")) UI.$("#set-sodium").value = g.sodium;
        if (parsed.kind) setKindSeg("#phase-kind-seg", parsed.kind, "phase");
        UI.closeSheet("sheet-phase-targets");
        UI.toast(`Applied ${opt.label}. Tap Save phase to keep it.`);
      });
    }

    UI.$("#btn-weight-save").addEventListener("click", saveWeightFromField);
    UI.$("#day-weight").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveWeightFromField(); }
    });

    UI.$("#foods-search").addEventListener("input", refreshFoods);
    UI.$("#pick-search").addEventListener("input", (e) => {
      UI.renderPicker(state.personalFoods, e.target.value, true, {
        yesterday: Ledger.entriesFor(state.yesterdayKey || yesterdayKey()),
        yesterdayLabel: isToday() ? "Yesterday" : "Previous day",
      });
    });
    UI.$("#day-label").addEventListener("click", jumpToToday);
    const refreshBumpPreview = () => {
      const phaseBase = Phases.goalsForDay(state.viewDay, { ...state.settings, dayGoals: {} });
      const read = (id) => {
        const v = UI.$(id).value.trim();
        if (v === "") return 0;
        const n = parseAmount(v);
        return Number.isFinite(n) ? n : 0;
      };
      const bumps = {
        kcal: read("#dg-kcal"),
        protein: read("#dg-protein"),
        carbs: read("#dg-carbs"),
        fat: read("#dg-fat"),
        fiber: read("#dg-fiber"),
        sodium: read("#dg-sodium"),
      };
      const kcal = Math.max(0, phaseBase.kcal + bumps.kcal);
      const p = Math.max(0, phaseBase.protein + bumps.protein);
      const prev = UI.$("#day-bump-preview");
      if (prev) {
        const any = Object.values(bumps).some((n) => n !== 0);
        prev.textContent = any
          ? `Effective today: ${Math.round(kcal)} kcal · P ${Math.round(p)} (phase ${phaseBase.kcal} / ${phaseBase.protein})`
          : `Phase targets: ${phaseBase.kcal} kcal · P ${phaseBase.protein}`;
      }
    };
    UI.$("#btn-day-goals").addEventListener("click", () => {
      const g = Phases.goalsForDay(state.viewDay, state.settings);
      const bumps = (g && g._bumps) || {};
      UI.$("#dg-kcal").value = bumps.kcal != null ? bumps.kcal : "";
      UI.$("#dg-protein").value = bumps.protein != null ? bumps.protein : "";
      UI.$("#dg-carbs").value = bumps.carbs != null ? bumps.carbs : "";
      UI.$("#dg-fat").value = bumps.fat != null ? bumps.fat : "";
      UI.$("#dg-fiber").value = bumps.fiber != null ? bumps.fiber : "";
      UI.$("#dg-sodium").value = bumps.sodium != null ? bumps.sodium : "";
      const phase = Phases.phaseForDay(state.settings.phases, state.viewDay);
      const phaseBit = phase ? ` (${phase.name})` : "";
      const phaseBase = g._phase || g;
      UI.$("#day-goals-blurb").textContent = `Phase${phaseBit}: ${phaseBase.kcal} kcal · P ${phaseBase.protein}. Enter deltas only (+500, −200). Blank = no bump.`;
      refreshBumpPreview();
      UI.openSheet("sheet-day-goals");
    });
    ["#dg-kcal", "#dg-protein", "#dg-carbs", "#dg-fat", "#dg-fiber", "#dg-sodium"].forEach((sel) => {
      const el = UI.$(sel);
      if (el) el.addEventListener("input", refreshBumpPreview);
    });
    UI.$("#dg-save").addEventListener("click", () => {
      const num = (id) => {
        const v = UI.$(id).value.trim();
        if (v === "") return null;
        const n = parseAmount(v);
        return Number.isFinite(n) ? n : null;
      };
      const bumps = {};
      [["kcal", "#dg-kcal"], ["protein", "#dg-protein"], ["carbs", "#dg-carbs"], ["fat", "#dg-fat"], ["fiber", "#dg-fiber"], ["sodium", "#dg-sodium"]]
        .forEach(([k, sel]) => {
          const n = num(sel);
          if (n != null && n !== 0) bumps[k] = n;
        });
      if (!state.settings.dayGoals) state.settings.dayGoals = {};
      if (Object.keys(bumps).length) {
        state.settings.dayGoals[state.viewDay] = { bumps, updatedAt: Date.now() };
      } else {
        state.settings.dayGoals[state.viewDay] = { cleared: true, updatedAt: Date.now() };
      }
      saveSettings();
      Sync.schedulePush();
      UI.closeSheet("sheet-day-goals");
      refreshDay();
      UI.toast(Object.keys(bumps).length ? "Day bump saved" : "Bump cleared");
    });
    UI.$("#dg-clear").addEventListener("click", () => {
      if (!state.settings.dayGoals) state.settings.dayGoals = {};
      state.settings.dayGoals[state.viewDay] = { cleared: true, updatedAt: Date.now() };
      saveSettings();
      Sync.schedulePush();
      UI.closeSheet("sheet-day-goals");
      refreshDay();
      UI.toast("Bump cleared");
    });

    UI.$("#btn-quick-kcal").addEventListener("click", () => openQuickKcal());
    UI.$("#kcal-cancel").addEventListener("click", () => {
      resetQtyState();
      UI.closeSheet("sheet-kcal");
    });
    UI.$("#kcal-meals").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-meal]");
      if (!btn) return;
      UI.$("#kcal-meals").querySelectorAll(".uchip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
    });
    UI.$("#kcal-save").addEventListener("click", () => {
      const name = UI.$("#kcal-name").value.trim() || "Quick kcal";
      const kcal = parseAmount(UI.$("#kcal-amount").value);
      if (!Number.isFinite(kcal) || kcal <= 0) { UI.toast("Enter calories"); return; }
      const meal = UI.selectedMealIn("#kcal-meals");
      const payload = {
        name,
        displayQty: `${Math.round(kcal)} kcal`,
        grams: 0,
        macros: { kcal: Math.round(kcal), p: 0, c: 0, f: 0, fb: 0, na: 0 },
        sd: 0.25,
        meal,
        source: "quick",
        cat: "snack",
        foodId: null,
        qty: kcal,
        unit: "kcal",
      };
      const day = editDay();
      if (state.editEntryId) {
        Ledger.amendEntry(day, state.editEntryId, payload, "quick kcal edited");
      } else {
        Ledger.addEntry(state.viewDay, payload);
      }
      Sync.schedulePush();
      UI.closeSheet("sheet-kcal");
      resetQtyState();
      refreshDay();
      UI.toast("Logged");
    });
    UI.$("#kcal-remove").addEventListener("click", () => {
      if (!state.editEntryId) return;
      const id = state.editEntryId;
      const day = editDay();
      UI.closeSheet("sheet-kcal");
      resetQtyState();
      removeEntryWithUndo(day, id);
    });

    UI.$("#qty-input").addEventListener("input", () => state.pickFood && UI.updateQtyPreview(state.pickFood));
    UI.$("#qty-units").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-unit]");
      if (!btn) return;
      const prev = UI.selectedUnit();
      const next = btn.dataset.unit;
      UI.$("#qty-units").querySelectorAll(".uchip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      if (state.pickFood && next !== prev) {
        UI.$("#qty-input").value = defaultQtyForUnit(state.pickFood, next);
        UI.$("#qty-input").select();
      }
      if (state.pickFood) UI.updateQtyPreview(state.pickFood);
    });
    UI.$("#qty-meals").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-meal]");
      if (!btn) return;
      UI.$("#qty-meals").querySelectorAll(".uchip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
    });
    UI.$("#qty-save").addEventListener("click", saveQty);
    UI.$("#qty-cancel").addEventListener("click", cancelQty);
    UI.$("#qty-edit-food").addEventListener("click", () => {
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
      openEditFood(state.pickFood);
    });
    UI.$("#qty-remove").addEventListener("click", () => {
      if (!state.editEntryId) return;
      const id = state.editEntryId;
      const day = editDay();
      cancelQty();
      removeEntryWithUndo(day, id);
    });

    const revLogAs = UI.$("#rev-log-as");
    if (revLogAs) {
      revLogAs.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-log-as]");
        if (!btn) return;
        revLogAs.querySelectorAll(".uchip").forEach((c) => c.classList.remove("active"));
        btn.classList.add("active");
        UI.syncReviewLogAsUI();
      });
    }

    UI.$("#btn-copy-prompt").addEventListener("click", copyPrompt);
    if (UI.$("#btn-share-prompt")) {
      UI.$("#btn-share-prompt").addEventListener("click", () => { sharePrompt(); });
    }
    UI.$("#btn-settings-copy-prompt").addEventListener("click", () => {
      navigator.clipboard.writeText(NutriParse.PROMPT).then(() => UI.toast("Prompt copied")).catch(() => {
        window.prompt("Select all and copy (Cmd/Ctrl+C):", NutriParse.PROMPT);
      });
    });
    if (UI.$("#btn-settings-share-prompt")) {
      UI.$("#btn-settings-share-prompt").addEventListener("click", () => {
        sharePromptText(NutriParse.PROMPT, { okToast: "Prompt copied" });
      });
    }
    UI.$("#btn-clipboard").addEventListener("click", async () => {
      try {
        const t = await navigator.clipboard.readText();
        UI.$("#paste-text").value = t;
      } catch (e) {
        UI.$("#paste-text").focus();
        UI.toast("Long-press the box and choose Paste");
      }
    });
    UI.$("#btn-import-paste").addEventListener("click", importPaste);
    UI.$("#btn-manual-food").addEventListener("click", openManualReview);
    UI.$("#btn-review-back").addEventListener("click", () => {
      if (state.editFoodDirect) {
        UI.closeSheet("sheet-paste");
        state.editFoodDirect = false;
        state.updateFoodId = null;
        return;
      }
      UI.showPastePrompt();
    });
    UI.$("#btn-review-save").addEventListener("click", saveReview);
    ["#rev-name", "#rev-kcal", "#rev-p", "#rev-c", "#rev-f"].forEach((sel) => {
      UI.$(sel).addEventListener("input", validateReviewSave);
    });
    UI.$("#rev-cat-filter").addEventListener("input", (e) => UI.filterCategories(e.target.value));

    UI.$("#insight-range").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-days]");
      if (!btn) return;
      const next = btn.dataset.days === "phase" ? "phase" : Number(btn.dataset.days);
      state.insightDays = next;
      if (next !== "phase") state.insightPhaseId = null;
      UI.$("#insight-range").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      refreshInsights();
    });
    const histList = UI.$("#phase-history-list");
    if (histList) {
      histList.addEventListener("click", (e) => {
        const row = e.target.closest("[data-phase-id]");
        if (!row) return;
        state.insightPhaseId = row.dataset.phaseId;
        state.insightDays = "phase";
        UI.$("#insight-range").querySelectorAll("button").forEach((b) =>
          b.classList.toggle("active", b.dataset.days === "phase")
        );
        const details = UI.$("#phase-history");
        if (details) details.open = false;
        refreshInsights();
      });
    }
    const backPhase = UI.$("#btn-phase-current");
    if (backPhase) {
      backPhase.addEventListener("click", () => {
        state.insightPhaseId = null;
        state.insightDays = "phase";
        UI.$("#insight-range").querySelectorAll("button").forEach((b) =>
          b.classList.toggle("active", b.dataset.days === "phase")
        );
        refreshInsights();
      });
    }
    const nutPills = UI.$("#insight-nutrient");
    if (nutPills) {
      nutPills.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-nutrient]");
        if (!btn) return;
        state.insightNutrient = btn.dataset.nutrient;
        nutPills.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
        refreshInsights();
      });
    }
    const canvas = UI.$("#trend-canvas");
    if (canvas) {
      canvas.style.cursor = "pointer";
      canvas.addEventListener("click", (e) => {
        const day = UI.trendDayAtClientX(e.clientX);
        if (day) UI.renderDayDetail(day);
      });
    }
    const wCanvas = UI.$("#weight-canvas");
    if (wCanvas) {
      wCanvas.style.cursor = "pointer";
      wCanvas.addEventListener("click", (e) => {
        const hit = UI.weightDayAtClientX(e.clientX);
        const sum = UI.$("#weight-summary");
        if (!hit || !sum) return;
        const d = new Date(hit.day + "T12:00:00");
        const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        sum.textContent = `${label} · ${hit.value.toFixed(1)} ${hit.unit}`;
        UI.renderDayDetail(hit.day);
      });
    }
    let resizeT = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => refreshInsights(), 150);
    });

    document.body.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close]");
      if (close) {
        const sheetId = close.dataset.close;
        UI.closeSheet(sheetId);
        if (sheetId === "sheet-qty" || sheetId === "sheet-kcal") {
          if (sheetId === "sheet-qty") {
            state.gapPendingItemId = null;
            state.gapPendingDay = null;
          }
          resetQtyState();
        }
        if (sheetId === "sheet-gap") {
          state.gapNutriPending = null;
          state.gapPortionCache = null;
        }
      }

      const actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id;

      if (action === "pick-food") {
        state.pendingCatalogFood = null;
        const food = findFood(id);
        if (food) openQty(food);
      } else if (action === "pick-catalog") {
        const db = (typeof FOOD_DB !== "undefined" ? FOOD_DB : []).find((f) => f.id === id);
        if (!db) return;
        const existing = state.personalFoods.find((f) => !f.deleted && f.catalogId === db.id);
        const food = existing || Foods.fromCatalog(db);
        state.pendingCatalogFood = existing ? null : food;
        openQty(food);
      } else if (action === "toggle-entry") {
        UI.toggleEntryExpand(id);
        UI.renderDayLog(state.viewDay, Ledger.entriesFor(state.viewDay));
      } else if (action === "edit-entry") {
        const entry = Ledger.entriesFor(state.viewDay).find((x) => x.id === id);
        if (!entry) return;
        openQtyFromEntry(entry, { allowRemove: true });
      } else if (action === "log-again") {
        e.preventDefault();
        e.stopPropagation();
        const entry = Ledger.entriesFor(state.viewDay).find((x) => x.id === id);
        if (!entry) return;
        openQtyFromEntry(entry);
      } else if (action === "repeat-yesterday") {
        const entry = Ledger.entriesFor(state.yesterdayKey || yesterdayKey()).find((x) => x.id === id);
        if (!entry) return;
        UI.closeSheet("sheet-add");
        openQtyFromEntry(entry);
      } else if (action === "goto-day") {
        state.viewDay = actionEl.dataset.day;
        switchView("today");
        refreshDay();
      } else if (action === "scale-batch") {
        const food = findFood(id);
        if (!food) return;
        const curG = (food.batch && food.batch.grams) || (food.units && food.units.serving) || 500;
        const curS = (food.batch && food.batch.servings) || 1;
        const gStr = prompt("Batch weight in grams", String(curG));
        if (gStr == null) return;
        const grams = Number(gStr);
        if (!Number.isFinite(grams) || grams <= 0) { UI.toast("Enter a valid weight"); return; }
        const sStr = prompt("Number of servings", String(curS));
        if (sStr == null) return;
        const servings = Number(sStr);
        if (!Number.isFinite(servings) || servings <= 0) { UI.toast("Enter valid servings"); return; }
        const idx = state.personalFoods.findIndex((f) => f.id === id);
        if (idx < 0) return;
        const next = {
          ...food,
          batch: { grams, servings, weighed: true },
          units: { ...(food.units || {}) },
          updatedAt: Date.now(),
          version: (food.version || 1) + 1,
        };
        state.personalFoods[idx] = next;
        savePersonal();
        UI.renderFoodDetail(next, { mode: state.detailMode || "library" });
        UI.toast(`Batch → ${Math.round(grams)} g / ${servings} serv`);
      } else if (action === "enable-count-log") {
        const food = findFood(id);
        if (!food) return;
        const grams = Number(actionEl.dataset.grams);
        const next = Foods.enableCountLogging(food, grams, FoodMatch.countNoun(food));
        const idx = state.personalFoods.findIndex((f) => f.id === id);
        if (idx < 0) return;
        state.personalFoods[idx] = next;
        savePersonal();
        Sync.schedulePush();
        UI.renderFoodDetail(next, { mode: state.detailMode || "library" });
        refreshFoods();
        UI.toast(`Logs by count: 1 ${next.countLabel || "piece"} = ${Math.round(next.units.piece)} g`);
      } else if (action === "food-detail") {
        openDetail(id, "library");
      } else if (action === "log-this") {
        UI.closeSheet("sheet-detail");
        state.pendingCatalogFood = null;
        openQty(findFood(id));
      } else if (action === "share-food") {
        shareFoodById(id);
      } else if (action === "edit-food") {
        openEditFood(findFood(id));
      } else if (action === "update-food") {
        UI.closeSheet("sheet-detail");
        openPaste({ updateId: id, intent: "library" });
      } else if (action === "copy-update-prompt") {
        const f = findFood(id);
        if (!f) return;
        const text = NutriParse.foodUpdatePrompt(f);
        navigator.clipboard.writeText(text).then(() => UI.toast("Update prompt copied")).catch(() => {
          UI.closeSheet("sheet-detail");
          openPaste({ updateId: id, intent: "library" });
          UI.showPromptFallback(text);
          UI.toast("Select the prompt below, then copy");
        });
      } else if (action === "share-update-prompt") {
        const f = findFood(id);
        if (!f) return;
        const text = NutriParse.foodUpdatePrompt(f);
        sharePromptText(text, {
          okToast: "Update prompt copied",
          onClipboardFail: (t) => {
            UI.closeSheet("sheet-detail");
            openPaste({ updateId: id, intent: "library" });
            UI.showPromptFallback(t);
            UI.toast("Select the prompt below, then copy");
          },
        });
      } else if (action === "delete-food") {
        if (!confirm("Delete this food from your library? Past logs stay as they are.")) return;
        const idx = state.personalFoods.findIndex((f) => f.id === id);
        if (idx >= 0) {
          state.personalFoods[idx] = Foods.tombstone(state.personalFoods[idx]);
          savePersonal();
          UI.closeSheet("sheet-detail");
          refreshFoods();
          UI.toast("Deleted");
        }
      } else if (action === "update-dup") {
        state.updateFoodId = id;
        state.saveAsNew = false;
        UI.$("#review-dup").hidden = true;
      } else if (action === "save-new-anyway") {
        state.saveAsNew = true;
        state.updateFoodId = null;
        UI.$("#review-dup").hidden = true;
      }
    });

    // swipe day log to change days
    let touchX = 0, touchY = 0;
    UI.$("#day-log").addEventListener("touchstart", (e) => {
      const t = e.changedTouches[0];
      touchX = t.clientX; touchY = t.clientY;
    }, { passive: true });
    UI.$("#day-log").addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - touchX, dy = t.clientY - touchY;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy)) return;
      if (dx > 0) shiftDay(-1);
      else shiftDay(1);
    }, { passive: true });

    UI.$("#day-log").addEventListener("contextmenu", (e) => {
      const row = e.target.closest("[data-action='toggle-entry']");
      if (!row) return;
      e.preventDefault();
      removeEntryWithUndo(state.viewDay, row.dataset.id);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const top = UI.topSheetId();
      if (!top) return;
      UI.closeSheet(top);
      if (top === "sheet-qty") {
        state.gapPendingItemId = null;
        state.gapPendingDay = null;
        resetQtyState();
      }
      if (top === "sheet-paste") { state.editFoodDirect = false; state.updateFoodId = null; }
      if (top === "sheet-gap") {
        state.gapNutriPending = null;
        state.gapPortionCache = null;
      }
    });

    UI.$("#btn-export").addEventListener("click", exportData);
    UI.$("#import-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = "";
    });
    UI.$("#btn-clear").addEventListener("click", () => {
      if (!confirm("Clear foods and meal logs on this device? Phases, weight, and settings stay. If Drive sync is on, the cloud copy of logs/foods will be wiped on the next sync.")) return;
      Sync.markReset(Date.now());
      Ledger.clearAll();
      state.personalFoods = [];
      savePersonal();
      state.settings.dayPlans = {};
      state.settings.gapDrafts = {};
      state.gapSelected = {};
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
      state.gapNutriPending = null;
      state.gapPortionCache = null;
      saveSettings();
      refreshAll();
      Sync.fullSync(false).catch(() => {});
      UI.toast("Logs cleared");
    });

    UI.$("#btn-factory-reset").addEventListener("click", () => {
      if (!confirm("Start completely fresh? This deletes meal logs, foods, phases, day bumps, weight history, and resets goals.")) return;
      if (!confirm("Last chance. Export first if you want a backup. This cannot be undone. Continue?")) return;
      Sync.markReset(Date.now());
      Ledger.clearAll();
      state.personalFoods = [];
      savePersonal();
      state.settings = {
        goals: { ...DEFAULT_GOALS },
        goalsUpdatedAt: Date.now(),
        imperial: false,
        weightUnit: "lb",
        theme: "light",
        dayGoals: {},
        dayPlans: {},
        gapDrafts: {},
        phases: [],
        weights: {},
        profile: {},
      };
      state.gapSelected = {};
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
      state.gapNutriPending = null;
      state.gapPortionCache = null;
      state.viewDay = Ledger.todayKey();
      state.lastCalendarToday = state.viewDay;
      state.insightDays = 14;
      state.insightNutrient = "kcal";
      state.insightPhaseId = null;
      Phases.ensureMigrated(state.settings, null, state.viewDay);
      saveSettings();
      applyTheme();
      localStorage.removeItem(ONB_KEY);
      localStorage.removeItem(SIGNIN_SEEN_KEY);
      localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
      localStorage.setItem(FIRST_SEEN_KEY, String(Date.now()));
      // Keep Drive connection and Client ID override so the wipe can sync up
      refreshAll();
      syncSettingsForm();
      refreshDriveStatus();
      refreshInstallCard();
      refreshSettingsTabNudge();
      refreshInfoBanner();
      Sync.fullSync(false).catch(() => {});
      switchView("today");
      UI.showOnboarding(true);
      UI.toast("Started fresh");
    });

    UI.$("#btn-drive-connect").addEventListener("click", () => connectDrive());
    UI.$("#btn-drive-sync").addEventListener("click", () => syncNowInteractive());
    UI.$("#btn-drive-disconnect").addEventListener("click", () => {
      Sync.disconnect();
      refreshDriveStatus();
      refreshInfoBanner();
      UI.setSyncPill("local", "local only");
    });
    UI.$("#sync-pill").addEventListener("click", async () => {
      const st = Sync.state();
      if (st.enabled && (st.status === "auth" || !GDrive.cachedToken())) {
        await connectDrive();
        return;
      }
      if (st.enabled) {
        await syncNowInteractive();
        return;
      }
      openSettings();
    });

    UI.$("#btn-onb-start").addEventListener("click", () => {
      localStorage.setItem(ONB_KEY, "1");
      UI.showOnboarding(false);
      openAddSheet();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const rolled = ensureViewDayCurrent();
      if (rolled) refreshDay();
      /* Drive resume on foreground is wired inside Sync.init */
    });
    UI.$("#btn-onb-skip").addEventListener("click", () => {
      localStorage.setItem(ONB_KEY, "1");
      UI.showOnboarding(false);
    });
  }

  function initSync() {
    Sync.init({
      getPersonal: () => state.personalFoods,
      setPersonal: (list) => { state.personalFoods = list; localStorage.setItem(PERSONAL_KEY, JSON.stringify(list)); },
      getGoals: () => state.settings.goals,
      getGoalsUpdatedAt: () => state.settings.goalsUpdatedAt || 0,
      setGoals: (g, at) => setGoals(g, at),
      getDayGoals: () => state.settings.dayGoals || {},
      setDayGoals: (dg) => {
        state.settings.dayGoals = dg && typeof dg === "object" ? dg : {};
        saveSettings();
      },
      getDayPlans: () => state.settings.dayPlans || {},
      setDayPlans: (dp) => {
        state.settings.dayPlans = dp && typeof dp === "object" ? dp : {};
        saveSettings();
      },
      getPhases: () => state.settings.phases || [],
      setPhases: (list) => {
        state.settings.phases = Array.isArray(list) ? list : [];
        Phases.ensureMigrated(state.settings, Phases.earliestDayFromEvents(Ledger.allEvents()), Ledger.todayKey());
        saveSettings();
      },
      getWeights: () => state.settings.weights || {},
      setWeights: (w) => {
        state.settings.weights = w && typeof w === "object" ? w : {};
        saveSettings();
      },
      getProfile: () => Phases.ensureProfile(state.settings),
      setProfile: (p) => {
        state.settings.profile = Phases.normalizeProfile(p);
        saveSettings();
      },
      onStatus: (s, detail) => {
        if (s === "ok") {
          localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
          UI.setSyncPill("ok", Sync.state().email ? Sync.state().email.split("@")[0] : "synced");
        } else if (s === "pending" || s === "syncing") UI.setSyncPill("pending", detail || "syncing…");
        else if (s === "auth") UI.setSyncPill("warn", "reconnect");
        else if (s === "error" || s === "warn") UI.setSyncPill("warn", detail || "sync issue");
        else UI.setSyncPill("local", "local only");
        refreshInfoBanner();
        refreshSettingsTabNudge();
        if (isSettingsView()) refreshDriveStatus();
      },
      onRemoteApplied: () => refreshAll(),
    });
    /* OAuth BFF return: /?auth=ok|error&err=... — finish before resume to avoid races. */
    (async function bootSync() {
      let params;
      try { params = new URLSearchParams(location.search); } catch (e) { params = null; }
      const auth = params && params.get("auth");
      if (auth) {
        const err = params.get("err") || "";
        params.delete("auth");
        params.delete("err");
        const q = params.toString();
        try {
          history.replaceState(null, "", location.pathname + (q ? "?" + q : "") + location.hash);
        } catch (e) {}
        if (auth === "error") {
          UI.toast(err || "Google sign-in failed");
        } else if (auth === "ok") {
          try {
            await Sync.finishConnect();
            localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
            localStorage.setItem(SIGNIN_SEEN_KEY, "1");
            refreshDriveStatus();
            refreshInfoBanner();
            UI.toast("Drive connected");
            return;
          } catch (e) {
            UI.toast(authErrMsg(e, "Could not finish Google Drive connect"));
            /* Fall through to resume so Reconnect status/banner can appear. */
          }
        }
      }
      await Sync.resume();
    })().catch(() => {});
  }

  function boot() {
    loadState();
    wire();
    refreshPromptShareButtons();
    window.addEventListener("beforeinstallprompt", (ev) => {
      ev.preventDefault();
      deferredInstall = ev;
      if (isSettingsView()) refreshInstallCard();
    });
    window.addEventListener("appinstalled", () => {
      deferredInstall = null;
      if (isSettingsView()) refreshInstallCard();
    });
    window.addEventListener("online", () => {
      if (Sync.state().enabled) Sync.schedulePush();
    });
    initSync();
    refreshAll();
    refreshInfoBanner();
    refreshSettingsTabNudge();
    consumeRecipeHash();
    window.addEventListener("hashchange", () => consumeRecipeHash());
    if (!localStorage.getItem(ONB_KEY) && !activeFoods().length && !Ledger.allEvents().length) {
      UI.showOnboarding(true);
    }
  }

  return { boot, state };
})();

document.addEventListener("DOMContentLoaded", () => App.boot());
