/* NutriDaily — diary bootstrap, state, event wiring. */
const App = (() => {
  const SETTINGS_KEY = "nd_settings_v1";
  const PERSONAL_KEY = "nd_personal_v1";
  const ONB_KEY = "nd_onboarded_v1";
  const FIRST_SEEN_KEY = "nd_first_seen_at";
  const SIGNIN_SEEN_KEY = "nd_signin_banner_seen";
  const RECONNECT_HIDE_DAY_KEY = "nd_reconnect_hide_day";
  const DEFAULT_GOALS = Phases.DEFAULT_GOALS;
  const PRODUCER_LIMITS = Object.freeze({
    text: Object.freeze({ name: 160, displayQty: 160, alias: 160, aliases: 50, ingredient: 500, prep: 5000, notes: 5000, raw: 12000, unit: 32, countLabel: 32 }),
    amount: 1e9,
    batchServings: 1e7,
    sd: 10,
  });

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
      dayPlanPresets: [], // Slice 6 §12 — max 5 active; LWW merge like personalFoods
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
    insightRollup: "day", // day | week — weekly smooths out single-day noise
    insightTopFoodMetric: "kcal", // kcal | protein | sodium | fiber
    dayContribMetric: null, // when set, Today shows contribution breakdown for viewDay
    lastCalendarToday: null, // for overnight day roll without yanking past-day browsing
    yesterdayKey: null,
    // Close-the-gap sheet
    gapSelected: {}, // key -> food object (personal or catalog copy)
    gapPendingItemId: null, // plan item id while qty sheet open
    gapPendingDay: null, // day the pending item belongs to (survives midnight roll)
    gapParsed: null, // last GapPrompt.parseGapBlock result (multi-option)
    gapStep: "select",
    gapPortionCache: null, // Map foodId -> portionStats for select list
  };

  function parseAmount(v) {
    const n = Number(String(v == null ? "" : v).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : NaN;
  }

  function producerText(value, max) {
    return typeof value === "string" && value.length <= max;
  }

  function producerNumber(value, opts) {
    const o = opts || {};
    if (value == null && o.nullable) return true;
    const n = Number(value);
    return Number.isFinite(n) && (o.min == null || n >= o.min) && (o.max == null || n <= o.max);
  }

  /** Validate an app-created ledger snapshot against the import/Drive schema. */
  function validateProducerEntry(entry) {
    const e = entry || {};
    if (!producerText(e.name, PRODUCER_LIMITS.text.name) || !String(e.name || "").trim()) return "Food name must be 160 characters or fewer";
    if (!producerText(e.displayQty, PRODUCER_LIMITS.text.displayQty)) return "Quantity label is too long";
    if (!producerNumber(e.grams, { min: 0, max: PRODUCER_LIMITS.amount }) ||
        !producerNumber(e.qty, { min: 0, max: PRODUCER_LIMITS.amount })) return "Amount is outside the supported range";
    if (!producerNumber(e.sd, { min: 0, max: PRODUCER_LIMITS.sd })) return "Uncertainty is outside the supported range";
    if (!producerText(String(e.unit || ""), PRODUCER_LIMITS.text.unit)) return "Unit label is too long";
    if (!IMPORT_MEALS.has(e.meal || "snack")) return "Meal is invalid";
    for (const key of ["kcal", "p", "c", "f", "fb", "na", "k"]) {
      const nullable = key === "na" || key === "k";
      if (!producerNumber(e.macros && e.macros[key], { nullable, min: 0, max: PRODUCER_LIMITS.amount })) {
        return "Nutrition values are outside the supported range";
      }
    }
    // §3.1 / §5.2: one-offs and quick-kcal must never carry per100.
    if ((e.source === "once" || e.source === "quick") && e.per100 != null) {
      return "One-off entries cannot carry per-100 nutrition";
    }
    return "";
  }

  /** Validate a review draft without truncating it into a different saved food. */
  function validateProducerFood(draft) {
    const f = draft || {};
    if (!producerText(f.name, PRODUCER_LIMITS.text.name) || !String(f.name || "").trim()) return "Name is required and must be 160 characters or fewer.";
    const aliases = Array.isArray(f.aliases) ? f.aliases : [];
    if (aliases.length > PRODUCER_LIMITS.text.aliases || aliases.some((alias) => !producerText(alias, PRODUCER_LIMITS.text.alias))) {
      return "Use at most 50 aliases, each 160 characters or fewer.";
    }
    const ingredients = f.recipe && Array.isArray(f.recipe.ingredients) ? f.recipe.ingredients : [];
    if (ingredients.some((item) => !producerText(String(item && item.text != null ? item.text : item || ""), PRODUCER_LIMITS.text.ingredient))) {
      return "Each ingredient must be 500 characters or fewer.";
    }
    if (!producerText(String(f.recipe && f.recipe.prep || ""), PRODUCER_LIMITS.text.prep) ||
        !producerText(String(f.recipe && f.recipe.notes || ""), PRODUCER_LIMITS.text.notes)) return "Prep and notes must be 5,000 characters or fewer.";
    if (!producerText(String(f.raw || ""), PRODUCER_LIMITS.text.raw)) return "AI source text must be 12,000 characters or fewer.";
    if (f.countLabel != null && !producerText(String(f.countLabel), PRODUCER_LIMITS.text.countLabel)) return "Count label must be 32 characters or fewer.";
    for (const [unit, value] of Object.entries(f.units || {})) {
      if (!producerText(String(unit), PRODUCER_LIMITS.text.unit) || !producerNumber(value, { min: 0.0001, max: PRODUCER_LIMITS.amount })) return "Serving and piece units are outside the supported range.";
    }
    if (f.batch && (!producerNumber(f.batch.grams, { min: 0.0001, max: PRODUCER_LIMITS.amount }) ||
        !producerNumber(f.batch.servings, { min: 0.0001, max: PRODUCER_LIMITS.batchServings }))) return "Batch values are outside the supported range.";
    for (const key of ["kcal", "p", "c", "f", "fb", "na", "k"]) {
      const nullable = key === "na" || key === "k";
      if (!producerNumber(f.per100 && f.per100[key], { nullable, min: 0, max: PRODUCER_LIMITS.amount })) return "Nutrition values are outside the supported range.";
    }
    return "";
  }

  /**
   * Last local guard before a staged settings/food transaction can write.
   * It deliberately reuses the Drive/import normalizer so producer paths cannot
   * drift away from the schema that the next outbound sync must satisfy.
   */
  function validateStagedLocalData(candidate) {
    const staged = candidate || {};
    const settings = cloneLocalData(staged.settings || state.settings || {});
    const resetAt = safeResetEpoch(staged.resetAt == null ? Sync.getResetAt() : staged.resetAt);
    const generationSchemaVersion = importedGeneration(
      localStorage.getItem(Sync.GENERATION_SCHEMA_KEY) || 0,
      "Local generationSchemaVersion"
    );
    const raw = {
      version: Sync.DOC_VERSION,
      generationSchemaVersion,
      updatedAt: Date.now(),
      resetAt,
      events: cloneLocalData(staged.events || Ledger.allEvents()),
      personalFoods: cloneLocalData(staged.personalFoods || state.personalFoods || []),
      dayGoals: settings.dayGoals || {},
      dayPlans: settings.dayPlans || {},
      gapDrafts: settings.gapDrafts || {},
      dayPlanPresets: settings.dayPlanPresets || [],
      phases: settings.phases || [],
      weights: settings.weights || {},
      profile: settings.profile || {},
      goals: settings.goals || {},
      goalsUpdatedAt: settings.goalsUpdatedAt || 0,
      goalsResetEpoch: settings.goalsResetEpoch == null ? resetAt : settings.goalsResetEpoch,
    };
    try {
      const normalized = normalizeRemoteSyncDoc(raw);
      if (generationSchemaVersion >= Sync.GENERATION_SCHEMA_VERSION) {
        Sync.validateDocGenerations(normalized);
      }
      Ledger.validateEvents(normalized.events || []);
      return true;
    } catch (cause) {
      const error = new Error(`This change cannot be saved safely. ${cause.message || "Local data is invalid."}`);
      error.name = "LocalCandidateError";
      error.code = "local-candidate-invalid";
      error.cause = cause;
      throw error;
    }
  }

  function stagedSaveMessage(error, fallback) {
    return error && error.code === "local-candidate-invalid" ? error.message : fallback;
  }

  function installPersistenceErrorUx() {
    if (window.__ndPersistenceErrorUx) return;
    window.__ndPersistenceErrorUx = true;
    const show = (err) => {
      const code = err && err.code;
      if (code !== "ledger-persistence-failed" && code !== "sync-persistence-failed") return false;
      const message = code === "ledger-persistence-failed"
        ? "Save failed — browser storage may be full or blocked. Your last diary change was not saved."
        : "Sync state could not be saved locally. Cloud status may be stale; export a backup before continuing.";
      UI.toast(message, { ms: 8000 });
      if (code === "sync-persistence-failed") UI.setSyncPill("warn", "storage issue");
      return true;
    };
    window.addEventListener("error", (event) => {
      if (show(event.error)) event.preventDefault();
    });
    window.addEventListener("unhandledrejection", (event) => {
      if (show(event.reason)) event.preventDefault();
    });
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
    const resolved = Phases.goalsForDay(state.viewDay, state.settings);
    const bumps = resolved && resolved._dayPlan;
    const isFast = !!(bumps && bumps.intent === "fast");
    const kcal = Number(bumps && bumps.kcal);
    const hasPlan = isFast || (Number.isFinite(kcal) && kcal !== 0);
    const reducedWin = Phases.dayIntentWindow(state.viewDay, {
      todayKey: Ledger.todayKey(),
      intent: "reduced",
      hasEverAdded: (day) => Ledger.hasEverAdded(day),
    });
    const fastWin = Phases.dayIntentWindow(state.viewDay, {
      todayKey: Ledger.todayKey(),
      intent: "fast",
      hasEverAdded: (day) => Ledger.hasEverAdded(day),
    });
    // Locked labels follow the plan already on the day. An existing reduced
    // plan that locked after the first food must read locked even though a
    // never-started day could still declare a Fast in its grace window.
    const locked = isFast
      ? !fastWin.ok
      : hasPlan
        ? !reducedWin.ok
        : !(reducedWin.ok || fastWin.ok);
    const lockReason = isFast
      ? (fastWin.reason || "")
      : hasPlan
        ? (reducedWin.reason || "")
        : (reducedWin.reason || fastWin.reason || "");
    let label = "Day plan";
    if (isFast) label = "Fast · declared";
    else if (hasPlan) label = `Planned calories · ${Math.round(resolved.kcal)} kcal`;
    // Late disclosure parity with Insights (S3). Same classifier as the
    // observation audit — reported, not punished; no colour or warning icon.
    const ov = dayGoalOverride(state.viewDay);
    const late = !!(hasPlan && ov && typeof Analytics !== "undefined" &&
      typeof Analytics.dayPlanProvenance === "function" &&
      Analytics.dayPlanProvenance({ dayPlan: ov,
        firstAddAt: Ledger.firstAddAt(state.viewDay),
        intent: isFast ? "fast" : "reduced",
      }) === "declaredLate");
    btn.classList.toggle("has-override", hasPlan);
    btn.classList.toggle("is-locked", locked);
    btn.textContent = `${label}${late ? " · late" : ""}${locked ? " · locked" : ""}`;
    // Title must name the fact that made it late. Persisted declaredAfterDay
    // means after local midnight; derived declaredLate means after first add.
    // Same-day post-log fasts leave kcal unscored — do not claim they are
    // "scored against the adjusted target" (R2-a).
    const afterDay = !!(ov && ov.declaredAfterDay === true);
    const lateTitle = afterDay
      ? "Declared after the day ended — reported, not punished."
      : (isFast
        ? "Set after logging began — reported, not punished."
        : "Set after logging began — still scored against the adjusted target.");
    const idleTitle = isFast
      ? "Declared fast for this day"
      : (hasPlan
        ? "Edit or clear this day's calorie plan"
        : "Plan a reduced-energy day or declare a fast");
    const lockTitle = lockReason || reducedWin.reason || fastWin.reason || "This day plan cannot be changed right now.";
    btn.title = locked
      ? (late ? `${lateTitle} ${lockTitle}` : lockTitle)
      : (late ? `${lateTitle} ${idleTitle}` : idleTitle);
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
    if (!Array.isArray(state.settings.dayPlanPresets)) state.settings.dayPlanPresets = [];
    state.settings.dayPlanPresets = Sync.normalizeDayPlanPresets(state.settings.dayPlanPresets);
    if (!state.settings.weights || typeof state.settings.weights !== "object") state.settings.weights = {};
    Phases.ensureProfile(state.settings);
    try { state.personalFoods = JSON.parse(localStorage.getItem(PERSONAL_KEY) || "[]"); }
    catch (e) { state.personalFoods = []; }
    if (!Array.isArray(state.personalFoods)) state.personalFoods = [];
    if (typeof Foods !== "undefined" && typeof Foods.migrateCatalogCopies === "function") {
      const migrated = Foods.migrateCatalogCopies(
        state.personalFoods,
        typeof FOOD_DB !== "undefined" ? FOOD_DB : []
      );
      if (migrated && Array.isArray(migrated.foods)) state.personalFoods = migrated.foods;
      if (migrated && migrated.changed) {
        localStorage.setItem(PERSONAL_KEY, JSON.stringify(state.personalFoods));
      }
    }
    state.viewDay = Ledger.todayKey();
    state.lastCalendarToday = state.viewDay;
    const beforeTargetMigration = JSON.stringify(state.settings);
    Phases.ensureMigrated(
      state.settings,
      Phases.earliestDayFromEvents(Ledger.allEvents()),
      state.viewDay
    );
    if (JSON.stringify(state.settings) !== beforeTargetMigration) {
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
      "#btn-rev-share-refine",
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
    const targetReview = state.settings && state.settings.targetReview &&
      state.settings.targetReview.required ? state.settings.targetReview : null;
    const kind = targetReview ? "targets" :
      (shouldShowReconnectBanner() ? "reconnect" : (shouldShowSigninBanner() ? "signin" : null));
    if (!kind) {
      el.hidden = true;
      el.innerHTML = "";
      document.body.classList.remove("has-info-banner");
      return;
    }
    const title = kind === "targets" ? "Review your nutrition targets" :
      (kind === "reconnect" ? "Drive sync paused" : "Keep your log safe");
    const body = kind === "targets"
      ? (targetReview.fallback === "generic-default"
        ? "An imported target did not meet the persistent safety checks. It is kept only for audit, and NutriDaily is temporarily using the generic default. Open Settings and save reviewed targets."
        : "An imported current or future target did not meet the persistent safety checks. It is kept only for audit while NutriDaily uses the nearest earlier valid target. Open Settings to review and save a replacement.")
      : (kind === "reconnect"
        ? "Meals still save on this device. Tap Reconnect to resume Google Drive."
        : "Optional: Sign in with Google in Settings to keep your nutrition log in your Drive if this browser is cleared.");
    el.hidden = false;
    el.dataset.kind = kind;
    el.innerHTML = `<div class="info-banner-text"><strong>${title}</strong><span>${body}</span></div>
      <div class="info-banner-actions">
        ${kind === "reconnect" ? '<button type="button" class="btn" id="banner-reconnect">Reconnect</button>' : '<button type="button" class="btn" id="banner-settings">Settings</button>'}
        ${kind === "targets" ? "" : '<button type="button" class="btn ghost" id="banner-hide">Hide</button>'}
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

  const safeResetEpoch = (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };

  function storedJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch (error) { return fallback; }
  }

  function stampRecordMap(nextMap, previousMap, epoch, rebase) {
    const out = nextMap && typeof nextMap === "object" ? nextMap : {};
    const prev = previousMap && typeof previousMap === "object" ? previousMap : {};
    for (const [key, record] of Object.entries(out)) {
      if (!record || typeof record !== "object") continue;
      const old = prev[key];
      record.resetEpoch = rebase
        ? epoch
        : (old && typeof old === "object" ? safeResetEpoch(old.resetEpoch) : epoch);
    }
    return out;
  }

  function stampSettingsGenerations(candidate, previous, epoch, rebase) {
    const next = candidate || {};
    const prev = previous || {};
    for (const key of ["dayGoals", "dayPlans", "gapDrafts", "weights"]) {
      next[key] = stampRecordMap(next[key], prev[key], epoch, rebase);
    }
    // Presets are an array keyed by id (like personalFoods), not a day map.
    const priorPresets = new Map(
      (prev.dayPlanPresets || []).filter(Boolean).map((preset) => [preset.id, preset])
    );
    for (const preset of next.dayPlanPresets || []) {
      if (!preset || typeof preset !== "object") continue;
      const old = priorPresets.get(preset.id);
      preset.resetEpoch = rebase
        ? epoch
        : (old ? safeResetEpoch(old.resetEpoch) : epoch);
    }
    const priorPhases = new Map((prev.phases || []).filter(Boolean).map((phase) => [phase.id, phase]));
    for (const phase of next.phases || []) {
      if (!phase || typeof phase !== "object") continue;
      const prior = priorPhases.get(phase.id);
      phase.resetEpoch = rebase ? epoch : (prior ? safeResetEpoch(prior.resetEpoch) : epoch);
      const priorRevisions = new Map(((prior && prior.revisions) || []).filter(Boolean).map((revision) => [revision.id, revision]));
      for (const revision of phase.revisions || []) {
        if (!revision || typeof revision !== "object") continue;
        const priorRevision = priorRevisions.get(revision.id);
        revision.resetEpoch = rebase
          ? epoch
          : (priorRevision ? safeResetEpoch(priorRevision.resetEpoch) : epoch);
      }
      const priorTombstoneEpochs = (prior && prior.revisionTombstoneEpochs) || {};
      phase.revisionTombstoneEpochs = phase.revisionTombstoneEpochs || {};
      for (const id of Object.keys(phase.revisionTombstones || {})) {
        phase.revisionTombstoneEpochs[id] = rebase
          ? epoch
          : (Object.prototype.hasOwnProperty.call(priorTombstoneEpochs, id)
            ? safeResetEpoch(priorTombstoneEpochs[id]) : epoch);
      }
    }
    const priorProfile = prev.profile && typeof prev.profile === "object" ? prev.profile : null;
    if (!next.profile || typeof next.profile !== "object") next.profile = {};
    next.profile.resetEpoch = rebase
      ? epoch
      : (priorProfile ? safeResetEpoch(priorProfile.resetEpoch) : epoch);
    next.goalsResetEpoch = rebase
      ? epoch
      : (Object.prototype.hasOwnProperty.call(prev, "goalsResetEpoch")
        ? safeResetEpoch(prev.goalsResetEpoch)
        : (prev.goals && typeof prev.goals === "object" ? 0 : epoch));
    return next;
  }

  function stampFoodsGenerations(foods, previous, epoch, rebase) {
    const prior = new Map((previous || []).filter(Boolean).map((food) => [food.id, food]));
    for (const food of foods || []) {
      if (!food || typeof food !== "object") continue;
      const old = prior.get(food.id);
      food.resetEpoch = rebase ? epoch : (old ? safeResetEpoch(old.resetEpoch) : epoch);
    }
    return foods;
  }

  function saveSettings(options) {
    const opts = options || {};
    let next = cloneLocalData(state.settings);
    if (!opts.inbound) {
      next = stampSettingsGenerations(
        next,
        storedJson(SETTINGS_KEY, {}),
        safeResetEpoch(Sync.getResetAt()),
        false
      );
      validateStagedLocalData({ settings: next });
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    state.settings = next;
  }

  /** Persist a detached settings candidate without exposing partial in-memory state. */
  function commitSettingsCandidate(candidate, options) {
    const opts = options || {};
    let nextSettings = cloneLocalData(candidate || {});
    if (!opts.inbound) {
      nextSettings = stampSettingsGenerations(
        nextSettings,
        storedJson(SETTINGS_KEY, {}),
        safeResetEpoch(Sync.getResetAt()),
        false
      );
    }
    validateStagedLocalData({ settings: nextSettings });
    const nextSettingsRaw = JSON.stringify(nextSettings);
    const transaction = beginLocalDataTransaction();
    try {
      localStorage.setItem(SETTINGS_KEY, nextSettingsRaw);
      state.settings = nextSettings;
      transaction.commit();
      return nextSettings;
    } catch (error) {
      try { transaction.rollback(); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
  }

  function persistentGoalError(goals) {
    const result = PhasePrompt.validateGoals(goals);
    return result.ok ? "" : (result.errors[0] || "Targets are not valid");
  }

  const savePersonal = () => {
    const next = stampFoodsGenerations(
      cloneLocalData(state.personalFoods),
      storedJson(PERSONAL_KEY, []),
      safeResetEpoch(Sync.getResetAt()),
      false
    );
    validateStagedLocalData({ personalFoods: next });
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(next));
    state.personalFoods = next;
    Sync.schedulePush();
  };

  /** Commit personal-food changes, plus any linked ledger events, as one unit. */
  function commitFoodChanges(nextFoods, ledgerMutation) {
    // Clone and serialize before the first event/storage mutation so malformed
    // drafts cannot leave a half-written log.
    const nextPersonal = stampFoodsGenerations(
      cloneLocalData(nextFoods || []),
      storedJson(PERSONAL_KEY, []),
      safeResetEpoch(Sync.getResetAt()),
      false
    );
    validateStagedLocalData({ personalFoods: nextPersonal });
    const nextPersonalRaw = JSON.stringify(nextPersonal);
    const transaction = beginLocalDataTransaction();
    try {
      const result = typeof ledgerMutation === "function" ? ledgerMutation() : undefined;
      localStorage.setItem(PERSONAL_KEY, nextPersonalRaw);
      state.personalFoods = nextPersonal;
      transaction.commit();
      return result;
    } catch (error) {
      try { transaction.rollback(); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
  }

  /** Mirror only (Drive apply / import). Does not append a phase revision. */
  function setGoals(goals, updatedAt, resetEpoch) {
    state.settings.goals = Phases.normalizeGoals(goals);
    state.settings.goalsUpdatedAt = updatedAt || Date.now();
    state.settings.goalsResetEpoch = safeResetEpoch(resetEpoch);
    saveSettings({ inbound: true });
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
      rollup: state.insightRollup,
      // One-release alias: prefer nutrient; accept insightTopFoodMetric if a
      // caller still passes it through buildInsightContext.
      topFoodMetric: state.insightNutrient || state.insightTopFoodMetric,
    };
    UI.renderInsights(opts);
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

  let weightFieldEditing = false;

  function applyWeightFieldMode() {
    const input = UI.$("#day-weight");
    const btn = UI.$("#btn-weight-save");
    const row = UI.$("#weight-row");
    if (!input || !btn) return;
    const hasWeight = Phases.weightForDay(state.settings, state.viewDay) != null;
    const locked = hasWeight && !weightFieldEditing;
    input.readOnly = locked;
    input.classList.toggle("locked", locked);
    if (row) row.classList.toggle("locked", locked);
    btn.textContent = locked ? "Edit" : "Save";
  }

  function syncWeightField(opts) {
    const input = UI.$("#day-weight");
    const unit = UI.$("#weight-unit");
    if (!input) return;
    if (opts && opts.resetEditing) weightFieldEditing = false;
    const kg = Phases.weightForDay(state.settings, state.viewDay);
    if (unit) unit.textContent = bodyWeightUnit();
    if (kg == null) {
      input.value = "";
      weightFieldEditing = false;
      applyWeightFieldMode();
      refreshWeightTrendLine();
      return;
    }
    const shown = kgToDisplay(kg);
    input.value = bodyWeightUnit() === "kg" ? String(shown) : shown.toFixed(1);
    applyWeightFieldMode();
    refreshWeightTrendLine();
  }

  /** Trend weight next to the scale entry, so a water swing is not read as a week. */
  function refreshWeightTrendLine() {
    UI.renderWeightTrendLine({
      settings: state.settings,
      todayKey: state.viewDay,
      lookbackDays: 30,
    });
  }

  function saveWeightFromField() {
    const raw = UI.$("#day-weight").value.trim();
    const nextSettings = cloneLocalData(state.settings);
    if (!nextSettings.weights || typeof nextSettings.weights !== "object") nextSettings.weights = {};
    if (raw === "") {
      nextSettings.weights[state.viewDay] = { cleared: true, updatedAt: Date.now() };
      try { commitSettingsCandidate(nextSettings); }
      catch (error) { UI.toast("Couldn’t clear this weight — nothing changed"); return; }
      Sync.schedulePush();
      weightFieldEditing = false;
      syncWeightField();
      UI.toast("Weight cleared");
      return;
    }
    const entered = parseAmount(raw);
    const kg = displayToKg(entered);
    if (kg == null) { UI.toast("Enter a valid weight"); return; }
    if (kg < 25 || kg > 400) { UI.toast("Weight looks out of range"); return; }
    const lb = Math.round(kg * LB_PER_KG * 10) / 10;
    nextSettings.weights[state.viewDay] = {
      kg: Math.round(kg * 100) / 100,
      lb,
      updatedAt: Date.now(),
    };
    try { commitSettingsCandidate(nextSettings); }
    catch (error) { UI.toast("Couldn’t save this weight — nothing changed"); return; }
    Sync.schedulePush();
    weightFieldEditing = false;
    syncWeightField();
    UI.toast("Weight saved");
    refreshInsights();
  }

  function onWeightActionClick() {
    const input = UI.$("#day-weight");
    if (input && input.readOnly) {
      weightFieldEditing = true;
      applyWeightFieldMode();
      input.focus();
      input.select();
      return;
    }
    saveWeightFromField();
  }

  function isToday() { return state.viewDay === Ledger.todayKey(); }

  function yesterdayKey() {
    const d = new Date(state.viewDay + "T12:00:00");
    d.setDate(d.getDate() - 1);
    return Ledger.todayKey(d);
  }

  /** Calendar day after `from` (defaults to today) — the §10 plan-ahead horizon. */
  function dayAfter(from) {
    const d = new Date((from || Ledger.todayKey()) + "T12:00:00");
    d.setDate(d.getDate() + 1);
    return Ledger.todayKey(d);
  }

  function refreshHUD() {
    UI.updateHUD(Ledger.totalsFor(state.viewDay), goalsForView(), {
      viewDay: state.viewDay,
      todayKey: Ledger.todayKey(),
    });
    UI.setDayLabel(state.viewDay, isToday(), {
      disableNext: state.viewDay >= dayAfter(Ledger.todayKey()),
    });
  }

  function refreshTodayContrib() {
    if (!state.dayContribMetric) {
      UI.renderDayDetail(null, { root: "#today-day-detail" });
      return;
    }
    UI.renderDayDetail(state.viewDay, {
      metric: state.dayContribMetric,
      root: "#today-day-detail",
      goals: goalsForView(),
      settings: state.settings,
    });
  }

  function openDayContrib(metric, opts) {
    const o = opts || {};
    const day = o.day || state.viewDay;
    const root = o.root || "#today-day-detail";
    if (root === "#today-day-detail") state.dayContribMetric = metric;
    // Do not write insightNutrient from Today — that silently rewires the
    // Insights chart/heatmap/scorecard when the user was only asking about today.
    UI.renderDayDetail(day, {
      metric,
      root,
      goals: o.goals || (day === state.viewDay ? goalsForView() : Phases.goalsForDay(day, state.settings)),
      settings: state.settings,
    });
    const el = UI.$(root);
    if (el) {
      el.setAttribute("role", "region");
      el.setAttribute("aria-label", `Nutrition details for ${day}`);
      const reduceMotion = !!(window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
      if (o.focus) {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (_e) {} }
      }
    }
  }

  function refreshDay() {
    refreshHUD();
    refreshDayGoalsLink();
    refreshGapChip();
    syncWeightField({ resetEditing: true });
    UI.renderDayLog(state.viewDay, Ledger.entriesFor(state.viewDay));
    refreshTodayContrib();
  }

  // ---------- Close the gap ----------
  function dayPlan(day) {
    const d = day || state.viewDay;
    const map = state.settings.dayPlans || {};
    const plan = map[d];
    return plan && !plan.cleared ? plan : null;
  }

  function pendingPlanCount(day) {
    const plan = dayPlan(day);
    if (!plan || !Array.isArray(plan.items)) return 0;
    return plan.items.filter((it) => it && it.status === "pending").length;
  }

  function refreshGapChip() {
    const chip = UI.$("#btn-gap-plan");
    const closeBtn = UI.$("#btn-close-gap");
    const hasPlan = !!dayPlan(state.viewDay);
    const n = pendingPlanCount(state.viewDay);
    if (chip) {
      chip.hidden = !hasPlan;
      if (hasPlan) chip.textContent = `Plan: ${n} left`;
    }
    if (closeBtn) closeBtn.hidden = hasPlan;
  }

  function pruneDayPlans(keepDays, settings) {
    const map = (settings || state.settings).dayPlans || {};
    const keys = Object.keys(map).filter((day) => map[day] && !map[day].cleared).sort();
    const keep = Math.max(7, keepDays || 45);
    while (keys.length > keep) {
      const old = keys.shift();
      map[old] = { cleared: true, updatedAt: Date.now() };
    }
  }

  function saveDayPlan(day, plan) {
    const nextSettings = cloneLocalData(state.settings);
    if (!nextSettings.dayPlans || typeof nextSettings.dayPlans !== "object") nextSettings.dayPlans = {};
    const d = day || state.viewDay;
    if (!plan) {
      nextSettings.dayPlans[d] = { cleared: true, updatedAt: Date.now() };
    } else {
      const { raw: _drop, ...rest } = plan;
      nextSettings.dayPlans[d] = { ...rest, updatedAt: Date.now() };
    }
    pruneDayPlans(45, nextSettings);
    commitSettingsCandidate(nextSettings);
    Sync.schedulePush();
    refreshGapChip();
  }

  /** Save a GAP plan, clear its draft, and promote catalog foods as one unit. */
  function commitGapPlanAndFoods(day, plan, nextFoods) {
    const d = day || state.viewDay;
    let nextSettings = cloneLocalData(state.settings);
    let nextPersonal = cloneLocalData(nextFoods || state.personalFoods);
    if (!nextSettings.dayPlans || typeof nextSettings.dayPlans !== "object") nextSettings.dayPlans = {};
    const { raw: _drop, ...rest } = plan;
    nextSettings.dayPlans[d] = { ...rest, updatedAt: Date.now() };
    pruneDayPlans(45, nextSettings);
    if (nextSettings.gapDrafts && typeof nextSettings.gapDrafts === "object") {
      delete nextSettings.gapDrafts[d];
    }
    const epoch = safeResetEpoch(Sync.getResetAt());
    nextSettings = stampSettingsGenerations(
      nextSettings, storedJson(SETTINGS_KEY, {}), epoch, false
    );
    nextPersonal = stampFoodsGenerations(
      nextPersonal, storedJson(PERSONAL_KEY, []), epoch, false
    );

    // Serialize every candidate before the first durable write.
    validateStagedLocalData({ settings: nextSettings, personalFoods: nextPersonal });
    const nextPersonalRaw = JSON.stringify(nextPersonal);
    const nextSettingsRaw = JSON.stringify(nextSettings);
    const transaction = beginLocalDataTransaction();
    try {
      localStorage.setItem(PERSONAL_KEY, nextPersonalRaw);
      localStorage.setItem(SETTINGS_KEY, nextSettingsRaw);
      state.personalFoods = nextPersonal;
      state.settings = nextSettings;
      transaction.commit();
    } catch (error) {
      try { transaction.rollback(); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
    Sync.schedulePush();
    refreshGapChip();
  }

  function gapEntryPatch(entry) {
    return {
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
    };
  }

  /**
   * Commit the diary event, promoted foods, completed GAP item, and consumed
   * draft together. A write failure restores both durable and in-memory state.
   */
  function commitGapEntryChange(day, entry, editEntryId, nextFoods, itemId) {
    const d = day || state.viewDay;
    const pendingId = itemId || state.gapPendingItemId;
    let nextSettings = cloneLocalData(state.settings);
    let nextPersonal = cloneLocalData(nextFoods || state.personalFoods);
    const plan = nextSettings.dayPlans && nextSettings.dayPlans[d];
    const itemIndex = plan && !plan.cleared && Array.isArray(plan.items)
      ? plan.items.findIndex((item) => item && item.id === pendingId && item.status !== "logged")
      : -1;
    if (!pendingId || itemIndex < 0) throw new Error("The GAP item is no longer pending");

    const entryId = editEntryId || entry.id || Ledger.uid();
    const nextEntry = { ...entry, id: entryId };
    plan.items[itemIndex] = {
      ...plan.items[itemIndex],
      status: "logged",
      loggedEntryId: entryId,
    };
    plan.updatedAt = Date.now();
    if (nextSettings.gapDrafts && typeof nextSettings.gapDrafts === "object") {
      delete nextSettings.gapDrafts[d];
    }

    const epoch = safeResetEpoch(Sync.getResetAt());
    nextSettings = stampSettingsGenerations(
      nextSettings, storedJson(SETTINGS_KEY, {}), epoch, false
    );
    nextPersonal = stampFoodsGenerations(
      nextPersonal, storedJson(PERSONAL_KEY, []), epoch, false
    );

    validateStagedLocalData({ settings: nextSettings, personalFoods: nextPersonal });
    const nextPersonalRaw = JSON.stringify(nextPersonal);
    const nextSettingsRaw = JSON.stringify(nextSettings);
    const transaction = beginLocalDataTransaction();
    try {
      const event = editEntryId
        ? Ledger.amendEntry(d, editEntryId, gapEntryPatch(nextEntry), "quantity edited")
        : Ledger.addEntry(d, nextEntry);
      localStorage.setItem(PERSONAL_KEY, nextPersonalRaw);
      localStorage.setItem(SETTINGS_KEY, nextSettingsRaw);
      state.personalFoods = nextPersonal;
      state.settings = nextSettings;
      transaction.commit();
      return { event, entryId };
    } catch (error) {
      try { transaction.rollback(); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
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
        units: { ...(food.units || {}) },
        logAs: food.logAs || (FoodMatch.prefersPieceLog(food) ? "piece" : "grams"),
        pieceGrams: FoodMatch.pieceGrams(food),
        portion: portion.n ? portion : null,
        provenance: prov && prov.kind === "ref" ? "ref" : (prov && prov.kind === "ai" ? "ai" : "yours"),
        food,
      };
    });
  }

  function persistGapDraft(step) {
    const nextSettings = cloneLocalData(state.settings);
    if (!nextSettings.gapDrafts || typeof nextSettings.gapDrafts !== "object") {
      nextSettings.gapDrafts = {};
    }
    const selected = Object.values(state.gapSelected).map((f) => ({
      foodId: f.id || null,
      catalogId: f.catalogId || null,
      name: f.name,
    }));
    if (!selected.length) {
      delete nextSettings.gapDrafts[state.viewDay];
    } else {
      nextSettings.gapDrafts[state.viewDay] = {
        selected,
        step: step || state.gapStep || "select",
        updatedAt: Date.now(),
      };
    }
    try { commitSettingsCandidate(nextSettings); }
    catch (error) { UI.toast("Couldn’t save this GAP draft — nothing changed"); return false; }
    Sync.schedulePush();
    return true;
  }

  function clearGapDraft(day) {
    if (!state.settings.gapDrafts) return true;
    const nextSettings = cloneLocalData(state.settings);
    delete nextSettings.gapDrafts[day || state.viewDay];
    try { commitSettingsCandidate(nextSettings); }
    catch (error) { UI.toast("Couldn’t clear this GAP draft — nothing changed"); return false; }
    return true;
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
    const remaining = GapPrompt.remainingFrom(means, goals, totals);
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
    const resolved = typeof Phases !== "undefined" ? Phases.effectiveGoals(totals, goals) : goals;
    // An honoured fast has nothing to close — do not print P150 against 0 kcal.
    if (resolved && resolved._dayPlan && resolved._dayPlan.intent === "fast" && resolved._unscored) {
      el.textContent = "Declared fast — targets for this day are not scored, so Close the Gap has nothing to fill.";
      return;
    }
    const remaining = GapPrompt.remainingFrom(GapPrompt.totalsMeans(totals), goals, totals);
    el.textContent = UI.formatGapRemaining(remaining, resolved || goals, totals);
  }

  function gapPortionFor(foodId) {
    if (!foodId) return { n: 0 };
    if (!state.gapPortionCache) state.gapPortionCache = new Map();
    if (state.gapPortionCache.has(foodId)) return state.gapPortionCache.get(foodId);
    const stats = Ledger.portionStats(foodId);
    state.gapPortionCache.set(foodId, stats);
    return stats;
  }

  function gapSelectRowForFood(food, key, kind) {
    const k = key || gapFoodKey(food);
    if (kind === "catalog") {
      const kcal = food && food.per100 ? food.per100.kcal : 0;
      return {
        key: k,
        name: food.name,
        sub: `Reference · USDA avg · ${UI.fmt(kcal)} kcal/100g`,
        selected: !!state.gapSelected[k],
        food,
        kind: "catalog",
      };
    }
    const stats = food && food.id ? gapPortionFor(food.id) : { n: 0 };
    const prov = Foods.provenance(food);
    const hist = stats.n
      ? GapPrompt.portionLine(stats)
      : `${UI.fmt(food.per100 && food.per100.kcal)} kcal/100g`;
    const tag = prov && prov.kind === "ref" ? "Reference · USDA avg · " : "";
    return {
      key: k,
      name: food.name,
      sub: `${tag}${hist}`,
      selected: !!state.gapSelected[k],
      food,
      kind: "personal",
    };
  }

  function refreshGapSelectList() {
    const q = (UI.$("#gap-food-search") && UI.$("#gap-food-search").value) || "";
    const needle = String(q).trim().toLowerCase();
    const personal = activeFoods();
    const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
    const byCatalogId = new Map(personal.filter((f) => f.catalogId).map((f) => [f.catalogId, f]));
    const ownedCatalogIds = new Set(byCatalogId.keys());

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

    // Selected always pinned at bottom (even if they don't match the current query)
    const selectedRows = [];
    const seen = new Set();
    for (const [key, food] of Object.entries(state.gapSelected)) {
      if (!food) continue;
      const kind = food.catalogId && !personal.some((f) => f.id === food.id) ? "catalog" : "personal";
      selectedRows.push(gapSelectRowForFood(food, key, kind));
      seen.add(key);
    }

    const otherRows = [];
    for (const f of Foods.sortForPicker(personal)) {
      const key = gapFoodKey(f);
      if (seen.has(key) || !match(f.name, f.aliases)) continue;
      otherRows.push(gapSelectRowForFood(f, key, "personal"));
      seen.add(key);
      if (otherRows.length >= 40) break;
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
      if (seen.has(key)) continue;
      otherRows.push(gapSelectRowForFood(Foods.fromCatalog(db), key, "catalog"));
      seen.add(key);
    }

    const rows = otherRows.concat(selectedRows);
    UI.renderGapSelectList(
      rows.map((r) => ({ key: r.key, name: r.name, sub: r.sub, selected: r.selected })),
      { queryActive: !!needle }
    );
    refreshGapSelectList._rows = rows;
    const btn = UI.$("#btn-gap-to-prompt");
    if (btn) btn.disabled = Object.keys(state.gapSelected).length < 1;
  }

  function toggleGapSelect(key) {
    const rows = refreshGapSelectList._rows || [];
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    const selecting = !state.gapSelected[key];
    if (selecting) state.gapSelected[key] = row.food;
    else delete state.gapSelected[key];
    const search = UI.$("#gap-food-search");
    if (selecting) {
      // Clear search after a pick; remember query so undo can restore the hit list
      if (search && search.value) {
        refreshGapSelectList._lastQuery = search.value;
        search.value = "";
      }
    } else if (search && !search.value && refreshGapSelectList._lastQuery) {
      // Restore prior query so a just-deselected catalog hit doesn't vanish
      search.value = refreshGapSelectList._lastQuery;
    }
    persistGapDraft("select");
    refreshGapSelectList();
    if (selecting) {
      const selectedList = UI.$("#gap-selected-list");
      if (selectedList) {
        const row = UI.$$("#gap-selected-list [data-action='gap-toggle']")
          .find((el) => el.dataset.key === key);
        if (row && typeof row.scrollIntoView === "function") {
          row.scrollIntoView({ block: "nearest" });
        } else {
          selectedList.scrollTop = selectedList.scrollHeight;
        }
      }
    }
  }

  const GAP_INTRO_SEEN_KEY = "nutridaily.gapIntroSeen";

  function gapIntroSeen() {
    try { return sessionStorage.getItem(GAP_INTRO_SEEN_KEY) === "1"; }
    catch (_) { return true; }
  }

  function markGapIntroSeen() {
    try { sessionStorage.setItem(GAP_INTRO_SEEN_KEY, "1"); }
    catch (_) { /* private mode / blocked storage — skip next intros if mark fails */ }
  }

  function showGapSheetStep(step) {
    state.gapStep = step;
    UI.showGapStep(step);
    if (step === "select") {
      refreshGapRemainingBlurb();
      refreshGapSelectList();
    } else if (step === "prompt") {
      persistGapDraft("prompt");
    } else if (step === "choose") {
      renderGapChooseStep();
    } else if (step === "plan") {
      renderGapPlanStep();
    }
  }

  function optionSummary(opt) {
    const p = opt && (opt.localProjected || opt.projected);
    if (p && p.kcal != null) {
      return `${UI.fmt(p.kcal)} kcal · P ${UI.fmt(p.protein)} · C ${UI.fmt(p.carbs)} · F ${UI.fmt(p.fat)} · Na ${UI.fmt(p.sodium)} · K ${UI.fmt(p.potassium)}`;
    }
    const n = (opt && opt.items && opt.items.length) || 0;
    return `${n} food${n === 1 ? "" : "s"}`;
  }

  function renderGapChooseStep() {
    const parsed = state.gapParsed;
    const warnEl = UI.$("#gap-choose-warnings");
    if (warnEl) {
      const warns = (parsed && parsed.warnings) || [];
      if (warns.length) {
        warnEl.hidden = false;
        warnEl.textContent = warns.slice(0, 4).join(" · ");
      } else {
        warnEl.hidden = true;
        warnEl.textContent = "";
      }
    }
    if (!parsed || !parsed.options) {
      UI.renderGapOptions([]);
      return;
    }
    const rejectedReasons = (parsed.rejectedOptions || [])
      .flatMap((option) => option.reasons || []);
    const blockHasRejectedOptions = rejectedReasons.length > 0;
    const cards = parsed.options.map((o) => ({
      index: o.index,
      label: o.label,
      reachable: o.reachable,
      safe: o.safe === true,
      complete: o.complete === true,
      autoApply: o.autoApply === true && !blockHasRejectedOptions,
      requiresManualConfirm: o.requiresManualConfirm === true || blockHasRejectedOptions,
      reviewReasons: [...new Set([
        ...(o.manualConfirmReasons || []),
        ...rejectedReasons,
      ])].slice(0, 4),
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
    state.gapPortionCache = null;

    const totals = Ledger.totalsFor(state.viewDay);
    const goals = goalsForView();
    const resolved = Phases.effectiveGoals(totals, goals);
    if (resolved && resolved._dayPlan && resolved._dayPlan.intent === "fast" && resolved._unscored) {
      UI.toast("Declared fast — Close the Gap has nothing to fill while the day stays unscored.");
      return;
    }

    // Resume paste step after leaving for an LLM (selection is persisted)
    if (!preferPlan) {
      const draft = restoreGapDraft();
      if (draft && draft.step === "prompt" && Object.keys(state.gapSelected).length) {
        UI.openSheet("sheet-gap", { noAutofocus: true });
        showGapSheetStep("prompt");
        return;
      }
    }

    if (preferPlan && plan) {
      restoreGapSelectionFromPlan(plan, true);
      UI.openSheet("sheet-gap", { noAutofocus: true });
      showGapSheetStep("plan");
      return;
    }
    if (!Object.keys(state.gapSelected).length) {
      if (!restoreGapDraft() && plan) restoreGapSelectionFromPlan(plan, false);
    }
    UI.openSheet("sheet-gap", { noAutofocus: true });
    showGapSheetStep(gapIntroSeen() ? "select" : "intro");
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

  /** Split option label badge from explanatory note (supports older joined notes). */
  function gapPlanLabelAndNote(plan) {
    if (!plan) return { label: "", note: "" };
    let label = (plan.optionLabel || "").trim();
    let note = (plan.note || "").trim();
    if (label && note) {
      const pref = `${label} · `;
      const prefAlt = `${label} • `;
      if (note.startsWith(pref)) note = note.slice(pref.length).trim();
      else if (note.startsWith(prefAlt)) note = note.slice(prefAlt.length).trim();
      else if (note === label) note = "";
    }
    return { label, note };
  }

  function renderGapPlanStep() {
    const plan = dayPlan(state.viewDay);
    const noteEl = UI.$("#gap-plan-note");
    const labelEl = UI.$("#gap-plan-label");
    const statusEl = UI.$("#gap-plan-status");
    const hintEl = UI.$("#gap-plan-hint");
    const projEl = UI.$("#gap-plan-projection");
    if (!plan) {
      if (noteEl) {
        noteEl.hidden = false;
        noteEl.textContent = "No plan saved for this day yet.";
      }
      if (labelEl) { labelEl.hidden = true; labelEl.textContent = ""; }
      UI.renderGapPlanStatus(statusEl, []);
      if (projEl) { projEl.hidden = true; projEl.innerHTML = ""; }
      if (hintEl) hintEl.hidden = true;
      UI.renderGapPlanList([]);
      return;
    }
    const { label, note } = gapPlanLabelAndNote(plan);
    if (labelEl) {
      labelEl.hidden = !label;
      labelEl.textContent = label;
    }
    if (noteEl) {
      noteEl.hidden = !note;
      noteEl.textContent = note;
    }
    const rows = (plan.items || []).slice().sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === "pending" ? -1 : 1;
    }).map((it) => {
      const food = (it.foodId || it.name) ? resolveGapFood(it) : null;
      const g = it.grams != null ? it.grams : it.suggestedGrams;
      const macros = food ? FoodMatch.computeMacros(food.per100, g || 0) : null;
      return { it, g, macros };
    });
    const hasPending = rows.some((r) => r.it && r.it.status === "pending");
    if (hintEl) hintEl.hidden = !hasPending;
    renderGapPlanProjection(plan, rows);
    UI.renderGapPlanList(rows.map(({ it, g, macros }) => {
      const qtyLabel = g != null
        ? (it.unit && it.unit !== "g"
          ? `${it.qty} ${it.unit} (≈ ${UI.fmt(g)} g)`
          : `${UI.fmt(g)} g`)
        : `${it.qty} ${it.unit || "g"}`;
      return {
        id: it.id,
        name: UI.titleCaseName(it.name),
        meal: it.meal || "snack",
        qtyLabel,
        macros: macros
          ? `${UI.fmt(macros.kcal)} kcal · P ${UI.fmt(macros.p)} · C ${UI.fmt(macros.c)} · F ${UI.fmt(macros.f)}`
          : "",
        macrosExtra: macros
          ? `Fb ${UI.fmt(macros.fb)} · Na ${UI.fmt(macros.na || 0)}`
          : "",
        status: it.status,
      };
    }));
  }

  /** Live projection = logged day totals + macros of still-pending plan items. */
  function renderGapPlanProjection(plan, rows) {
    const el = UI.$("#gap-plan-projection");
    const statusEl = UI.$("#gap-plan-status");
    if (!el) return;
    const hide = () => {
      el.hidden = true;
      el.innerHTML = "";
    };
    const pending = (rows || []).filter((r) => r.it && r.it.status === "pending");
    const goals = goalsForView();
    const dayTotals = Ledger.totalsFor(state.viewDay);
    const sodiumCovered = !dayTotals.count || Phases.sodiumCovered(dayTotals);
    const projectionOpts = { sodiumCovered };
    const setStatus = (projected, unresolved) => {
      let flags = projected ? UI.planProjectionFlags(projected, goals, projectionOpts) : [];
      if (!projected && plan && plan.reachable === false) {
        flags = flags.concat([{ id: "fallback", label: "Targets missed" }]);
      }
      if (unresolved > 0) {
        flags = flags.concat([{ id: "unresolved", label: `${unresolved} food not in library` }]);
      }
      UI.renderGapPlanStatus(statusEl, flags);
    };
    if (!plan || !pending.length) {
      hide();
      setStatus(null, 0);
      return;
    }
    const resolved = pending.filter((r) => r.macros);
    if (!resolved.length) {
      if (plan.projected) {
        UI.renderPlanProjection(el, plan.projected, goals, { source: "ai", sodiumCovered });
        setStatus(plan.projected, pending.length);
      } else {
        hide();
        setStatus(null, pending.length);
      }
      return;
    }
    const means = GapPrompt.totalsMeans(Ledger.totalsFor(state.viewDay));
    const projected = GapPrompt.projectTotals(means, resolved.map((r) => GapPrompt.macroMeans(r.macros)));
    const unresolved = pending.length - resolved.length;
    UI.renderPlanProjection(el, projected, goals, projectionOpts);
    setStatus(projected, unresolved);
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
    if (!producerText(String(opt.label || ""), 160) || !producerText(String(opt.note || ""), 2000) ||
        opt.items.some((item) => !producerText(String(item && item.name || ""), 160) ||
          !producerNumber(item && item.qty, { min: 0, max: PRODUCER_LIMITS.amount }) ||
          !producerNumber(item && item.grams, { nullable: true, min: 0, max: PRODUCER_LIMITS.amount }))) {
      UI.toast("That GAP option exceeds the supported storage limits");
      return;
    }
    const projected = opt.localProjected || opt.projected;
    if ((opt.flags || []).includes("aggregate-out-of-range") ||
        (projected && Object.values(projected).some((value) =>
          !producerNumber(value, { min: 0, max: PRODUCER_LIMITS.amount })
        ))) {
      UI.toast("That GAP option’s combined nutrition exceeds the supported storage limits");
      return;
    }
    const rejectedReasons = (parsedMeta && parsedMeta.rejectedOptions || [])
      .flatMap((option) => option.reasons || []);
    const manuallyReviewed = opt.autoApply !== true || rejectedReasons.length > 0;
    if (manuallyReviewed) {
      const reasons = [...new Set([
        ...(opt.manualConfirmReasons || []),
        ...rejectedReasons,
      ].filter(Boolean))].slice(0, 5);
      const detail = reasons.length
        ? `\n\nLocal checks:\n- ${reasons.join("\n- ")}`
        : "\n\nLocal nutrition checks were incomplete or did not pass.";
      if (!confirm(
        `This option is not cleared for automatic use.${detail}\n\nUse the remaining resolved items anyway? You can edit each amount before logging.`
      )) return;
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
    const nextPersonal = cloneLocalData(state.personalFoods);
    const items = opt.items.map((it) => {
      const cand = candidates.find((c) => c.id && c.id === it.foodId)
        || candidates.find((c) => String(c.name).toLowerCase() === String(it.name).toLowerCase())
        || null;
      let food = cand ? cand.food : resolveGapFood(it);
      if (food && food.catalogId) {
        const existing = nextPersonal.find((f) => !f.deleted && f.catalogId === food.catalogId);
        if (existing) food = existing;
        else if (!nextPersonal.some((f) => f.id === food.id)) {
          const promoted = cloneLocalData(food);
          nextPersonal.push(promoted);
          food = promoted;
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
    const plan = {
      updatedAt: Date.now(),
      reachable: opt.reachable === true,
      safe: opt.safe === true,
      complete: opt.complete === true,
      reviewedManually: manuallyReviewed,
      reviewFlags: (opt.manualConfirmFlags || opt.flags || []).slice(),
      note: (opt.note || "").trim(),
      optionLabel: opt.label || "",
      candidates: candidates.map((c) => ({ foodId: c.id, name: c.name })),
      items: [...items, ...carried],
      projected: opt.localProjected || opt.projected || null,
    };
    try { commitGapPlanAndFoods(state.viewDay, plan, nextPersonal); }
    catch (error) { UI.toast("Couldn’t save this plan — nothing changed"); return; }
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
    const totals = Ledger.totalsFor(state.viewDay);
    const goals = goalsForView();
    const parsed = GapPrompt.parseGapBlock(text, candidates, scorer, { totals, goals });
    if (!parsed.ok) {
      UI.toast(parsed.error || "Could not parse GAP block");
      return;
    }
    state.gapParsed = parsed;
    if (parsed.warnings && parsed.warnings.length) {
      UI.toast(parsed.warnings.slice(0, 2).join(" · "));
    }
    const opts = parsed.options || [];
    // Only a complete option cleared by trusted local math may bypass review.
    if (opts.length === 1 && parsed.autoApply === true && opts[0].autoApply === true) {
      applyGapOption(opts[0], parsed);
      return;
    }
    showGapSheetStep("choose");
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

  function clearGapPlan() {
    if (!dayPlan(state.viewDay) && !(state.settings.gapDrafts && state.settings.gapDrafts[state.viewDay])) return;
    if (!confirm("Clear this day’s gap plan?")) return;
    const nextSettings = cloneLocalData(state.settings);
    if (!nextSettings.dayPlans || typeof nextSettings.dayPlans !== "object") nextSettings.dayPlans = {};
    nextSettings.dayPlans[state.viewDay] = { cleared: true, updatedAt: Date.now() };
    if (nextSettings.gapDrafts && typeof nextSettings.gapDrafts === "object") {
      delete nextSettings.gapDrafts[state.viewDay];
    }
    pruneDayPlans(45, nextSettings);
    try { commitSettingsCandidate(nextSettings); }
    catch (error) {
      UI.toast("Couldn’t clear this plan — nothing changed");
      return;
    }
    Sync.schedulePush();
    state.gapSelected = {};
    state.gapPendingItemId = null;
    state.gapPendingDay = null;
    refreshGapChip();
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
    // Foods is a library, not a dated diary view. New logs launched there
    // always belong to today; carrying a previously viewed date here made a
    // perfectly normal "Log this" action silently write into yesterday.
    if (name === "foods") {
      state.viewDay = Ledger.todayKey();
      state.lastCalendarToday = state.viewDay;
    }
    document.querySelectorAll(".bottom-tabs .tab").forEach((t) => {
      const on = t.dataset.view === name;
      t.classList.toggle("active", on);
      if (on) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    document.querySelectorAll("main .view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    const onToday = name === "today";
    const onInsights = name === "insights";
    const hud = UI.$("#hud");
    if (hud) hud.hidden = !onToday;
    const dayControls = UI.$("#day-controls");
    if (dayControls) dayControls.hidden = !onToday;
    const dock = UI.$("#insight-dock");
    if (dock) dock.hidden = !onInsights;
    document.body.classList.toggle("has-insight-dock", onInsights);
    wireDockIntakeObserver(onInsights);
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

  /** Dim the dock while #section-intake is offscreen (P6-T3). Opacity only. */
  let _dockIntakeObserver = null;
  function wireDockIntakeObserver(on) {
    const dock = UI.$("#insight-dock");
    const intake = UI.$("#section-intake");
    if (_dockIntakeObserver) {
      _dockIntakeObserver.disconnect();
      _dockIntakeObserver = null;
    }
    if (dock) dock.classList.remove("is-inactive");
    if (!on || !dock || !intake || typeof IntersectionObserver !== "function") return;
    _dockIntakeObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry || !dock) return;
      dock.classList.toggle("is-inactive", !entry.isIntersecting);
    }, { threshold: 0 });
    _dockIntakeObserver.observe(intake);
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

  /**
   * Open the one-off sheet for a new log or to edit/repeat an existing once entry.
   * Prefill via { from: entry, editId, editDay } — Step 3 routes openQtyFromEntry here.
   */
  function openOnceSheet(prefill) {
    UI.closeSheet("sheet-add");
    UI.closeSheet("sheet-qty");
    UI.closeSheet("sheet-kcal");
    const p = prefill || {};
    if (p.editId) {
      state.editEntryId = p.editId;
      state.editEntryDay = p.editDay || state.viewDay;
    } else if (!p.keepEdit) {
      state.editEntryId = null;
      state.editEntryDay = null;
    }
    UI.fillOnceSheet({
      from: p.from || null,
      meal: p.meal,
      imperial: !!state.settings.imperial,
      allowRemove: !!state.editEntryId,
      macrosOpened: p.macrosOpened,
      confidence: p.confidence,
    });
    UI.openSheet("sheet-once");
    setTimeout(() => {
      const inp = UI.$("#once-name");
      if (inp && !p.from) { inp.focus(); }
      else if (UI.$("#once-kcal")) UI.$("#once-kcal").focus();
    }, 50);
  }

  function saveOnce() {
    const read = UI.readOnceDraft();
    if (!read.ok) {
      UI.setOnceErrors(read.errors);
      return;
    }
    const entry = Foods.entryFromOnceDraft(read.draft, read.qty, read.unit, read.meal);
    if (!producerText(entry.name, PRODUCER_LIMITS.text.name)) {
      UI.setOnceErrors(["Name must be 160 characters or fewer"]);
      return;
    }
    const m = entry.macros || {};
    if (m.kcal > PRODUCER_LIMITS.amount
        || m.p > PRODUCER_LIMITS.amount || m.c > PRODUCER_LIMITS.amount
        || m.f > PRODUCER_LIMITS.amount || m.fb > PRODUCER_LIMITS.amount
        || (m.na != null && m.na > PRODUCER_LIMITS.amount)
        || (m.k != null && m.k > PRODUCER_LIMITS.amount)
        || entry.qty > PRODUCER_LIMITS.amount) {
      UI.setOnceErrors(["Amount exceeds the supported storage limits"]);
      return;
    }
    // Never derive or attach per100 — §3.1 / Ledger once-per100 guard.
    const producerError = validateProducerEntry(entry);
    if (producerError) { UI.setOnceErrors([producerError]); return; }
    const day = editDay();
    try {
      if (state.editEntryId) {
        Ledger.amendEntry(day, state.editEntryId, entry, "one-off edited");
      } else {
        Ledger.addEntry(day, entry);
      }
    } catch (error) {
      UI.toast("Couldn’t save this log — nothing changed");
      return;
    }
    Sync.schedulePush();
    UI.closeSheet("sheet-once");
    resetQtyState();
    refreshDay();
    UI.toast("Logged");
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
    // One day ahead is allowed so §10 reduced plan-ahead is reachable
    // (today → tomorrow's sheet → set tomorrow's plan before tomorrow arrives).
    if (key > dayAfter(Ledger.todayKey())) return;
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

  /**
   * Ensure a food exists in My Foods (promotes pending/catalog copies).
   * Returns the library food or null.
   */
  function ensureLibraryFood(food) {
    if (!food) return null;
    if (!food.id || String(food.id).startsWith("orphan-")) return null;
    let target = findFood(food.id);
    let candidate = null;
    let clearPending = false;
    if (!target && state.pendingCatalogFood && state.pendingCatalogFood.id === food.id) {
      candidate = food;
      clearPending = true;
    }
    if (!target && !candidate && food.per100) {
      const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
      const catId = food.catalogId || (DB.some((f) => f.id === food.id) ? food.id : null);
      if (catId) {
        const existing = state.personalFoods.find((f) => !f.deleted && f.catalogId === catId);
        if (existing) target = existing;
        else {
          candidate = Foods.fromCatalog({
            id: catId,
            name: food.name,
            aliases: food.aliases || [],
            cat: food.cat,
            per100: food.per100,
            units: food.units || {},
          });
        }
      } else {
        candidate = Foods.createFromDraft({
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
      }
    }
    if (candidate) {
      try {
        commitFoodChanges([...state.personalFoods, candidate]);
      } catch (error) {
        UI.toast(stagedSaveMessage(error, "Couldn’t add this food — nothing changed"));
        return null;
      }
      if (clearPending) state.pendingCatalogFood = null;
      target = findFood(candidate.id);
      Sync.schedulePush();
    }
    return target || null;
  }

  /** Open AI refine/update paste flow (works for catalog defaults after promote). */
  function openRefineFood(food) {
    if (!food) return;
    state.editEntryId = null;
    state.editEntryDay = null;
    if (!food.id || String(food.id).startsWith("orphan-")) {
      UI.toast("This log's food was deleted — refine a library copy instead");
      return;
    }
    const target = ensureLibraryFood(food);
    if (!target) { UI.toast("Can't refine this food"); return; }
    if (state.pickFood && (state.pickFood.id === food.id || state.pickFood.id === target.id)) {
      state.pickFood = target;
    }
    UI.closeSheet("sheet-qty");
    UI.closeSheet("sheet-detail");
    UI.closeSheet("sheet-add");
    openPaste({ updateId: target.id, intent: "library" });
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
    const target = ensureLibraryFood(food);
    if (!target) { UI.toast("Can't edit this food"); return; }
    if (state.pickFood && (state.pickFood.id === food.id || state.pickFood.id === target.id)) {
      state.pickFood = target;
    }

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
    // §3.3 / Correction C Guard 1: never build an orphan qty shell for a
    // one-off — missing per100 zeros the entry and rewrites source to personal.
    if (entry.source === "once") {
      openOnceSheet({
        from: entry,
        editId: (opts && opts.allowRemove) ? entry.id : null,
        editDay: state.viewDay,
      });
      return;
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
    // Carry per100 only when present. Normalising absence to `null` writes a
    // key onto one-offs on Undo (plan F3 / §3.2) — import drops nulls, but the
    // full-key-set contract and in-memory shape break.
    const snapshot = {
      ...entry,
      macros: { ...entry.macros },
    };
    if (entry.per100) snapshot.per100 = { ...entry.per100 };
    else delete snapshot.per100;
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
    // Correction C Guard 2: refuse qty writes against a one-off edit target so a
    // future refactor cannot silently zero macros / rewrite source (§3.3).
    if (state.editEntryId) {
      const target = Ledger.entriesFor(editDay()).find((e) => e.id === state.editEntryId);
      if (target && target.source === "once") {
        UI.toast("Edit this one-off from its own sheet");
        return;
      }
    }
    const entry = UI.updateQtyPreview(food);
    if (!entry) { UI.toast("Enter a valid amount"); return; }
    entry.meal = UI.selectedMeal();
    if (food._orphan) {
      entry.foodId = food._keptFoodId || null;
    }
    const producerError = validateProducerEntry(entry);
    if (producerError) { UI.toast(producerError); return; }
    const warns = FoodMatch.plausibility(entry);
    if (warns.length && !confirm(warns[0] + "\n\nLog it anyway?")) return;

    const gapItemId = state.gapPendingItemId;
    const day = gapItemId ? (state.gapPendingDay || editDay()) : editDay();
    let loggedEntryId = null;
    let nextPersonal = cloneLocalData(state.personalFoods);
    if (!state.editEntryId) {
      if (!entry.foodId && food.id && !food._orphan) entry.foodId = food.id;
      if (food._orphan) entry.foodId = null;
      // Ensure pending and gap-selected catalog foods land in My Foods in the
      // same transaction as the log that references them.
      if (food.id && !food._orphan && !nextPersonal.some((f) => f.id === food.id)) {
        nextPersonal.push(cloneLocalData(food));
      }
      const idx = nextPersonal.findIndex((f) => f.id === food.id);
      if (idx >= 0) nextPersonal[idx] = Foods.touchUse(nextPersonal[idx]);
    }

    if (gapItemId) {
      try {
        const result = commitGapEntryChange(day, entry, state.editEntryId, nextPersonal, gapItemId);
        loggedEntryId = result.entryId;
      } catch (error) {
        UI.toast("Couldn’t save this GAP item — nothing changed");
        return;
      }
    } else if (state.editEntryId) {
      try {
        Ledger.amendEntry(day, state.editEntryId, gapEntryPatch(entry), "quantity edited");
      } catch (error) {
        UI.toast("Couldn’t update this log — nothing changed");
        return;
      }
      loggedEntryId = state.editEntryId;
    } else {
      try {
        const ev = commitFoodChanges(nextPersonal, () => Ledger.addEntry(day, entry));
        loggedEntryId = ev && ev.entry ? ev.entry.id : null;
      } catch (error) {
        UI.toast("Couldn’t save this log — nothing changed");
        return;
      }
    }
    if (state.pendingCatalogFood && state.pendingCatalogFood.id === food.id) state.pendingCatalogFood = null;
    if (gapItemId) {
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
    }
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
    if (state.updateFoodId) {
      const f = findFood(state.updateFoodId);
      const prov = f && Foods.provenance(f);
      UI.$("#paste-title").textContent = (prov && prov.kind === "ref")
        ? "Refine reference food with AI"
        : "Update from AI paste";
    } else {
      UI.$("#paste-title").textContent = "Add food from AI paste";
    }
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

  function per100Same(a, b) {
    const keys = ["kcal", "p", "c", "f", "fb", "na", "k"];
    const x = a || {};
    const y = b || {};
    return keys.every((k) => {
      if (x[k] == null || y[k] == null) return x[k] == null && y[k] == null;
      return Number.isFinite(Number(x[k])) && Number.isFinite(Number(y[k])) && Number(x[k]) === Number(y[k]);
    });
  }

  /** Refine prompt for the food being edited, seeded with in-flight review edits. */
  function reviewRefinePromptText() {
    const saved = state.updateFoodId ? findFood(state.updateFoodId) : null;
    if (!saved) return null;
    const draft = UI.readReviewDraft(state.reviewParsed && state.reviewParsed.food);
    const merged = { ...saved, ...draft };
    if (!per100Same(saved.per100, draft.per100) || saved.name !== draft.name) merged.raw = "";
    return NutriParse.foodUpdatePrompt(merged);
  }

  function pickPasteResult(parsed) {
    const savable = (parsed.results || []).filter((r) => r && r.canSave);
    if (savable.length) return savable[savable.length - 1];
    const all = parsed.results || [];
    return all.length ? all[all.length - 1] : null;
  }

  function applyReviewRefinePaste() {
    const text = (UI.$("#rev-ai-paste") && UI.$("#rev-ai-paste").value) || "";
    const parsed = NutriParse.parse(text);
    if (!parsed.found) { UI.toast(parsed.error); return; }
    const result = pickPasteResult(parsed);
    if (!result || !result.food) { UI.toast("No usable NUTRI block"); return; }
    const saved = state.updateFoodId ? findFood(state.updateFoodId) : null;
    result.food.raw = String(result.raw || text).slice(0, 12000);
    state.reviewParsed = result;
    UI.showReview(result, {
      updateId: state.updateFoodId,
      forceEnable: true,
      title: "Edit food",
    });
    validateReviewSave();
    const renamed = saved &&
      String(saved.name || "").trim().toLowerCase() !== String(result.food.name || "").trim().toLowerCase();
    UI.toast(renamed
      ? `Fields updated — name changed to “${result.food.name}”`
      : "Fields updated — review, then Save food");
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
    // Prefer the last savable block (prompt templates / drafts often precede the reply).
    const result = pickPasteResult(parsed);
    if (!result) {
      UI.toast("No usable NUTRI block");
      return;
    }
    if ((parsed.results || []).length > 1) {
      UI.toast(`Found ${parsed.results.length} blocks — using the last complete one.`);
    }
    result.food.raw = String(result.raw || text).slice(0, 12000);
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
          logAs: updating.logAs || (updating.units && updating.units.piece ? "piece" : "grams"),
          countLabel: updating.countLabel || null,
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
          per100: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: null, k: null },
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
    const nutrientFields = [
      ["#rev-kcal", "Calories"], ["#rev-p", "Protein"], ["#rev-c", "Carbs"],
      ["#rev-f", "Fat"], ["#rev-fb", "Fiber"], ["#rev-na", "Sodium"],
      ["#rev-k", "Potassium"],
    ];
    for (const [sel, label] of nutrientFields) {
      const el = UI.$(sel);
      const parsed = UI.parseNutrientNumber(el && el.value, { nullable: sel === "#rev-na" || sel === "#rev-k" });
      if (!parsed.ok) reasons.push(`${label} must be a number.`);
      else if (parsed.value != null && parsed.value < 0) reasons.push(`${label} can't be negative.`);
    }
    for (const [sel, label, max] of [
      ["#rev-serving", "Serving grams", PRODUCER_LIMITS.amount],
      ["#rev-piece", "Piece grams", PRODUCER_LIMITS.amount],
      ["#rev-batch-g", "Batch grams", PRODUCER_LIMITS.amount],
      ["#rev-batch-s", "Batch servings", PRODUCER_LIMITS.batchServings],
    ]) {
      const raw = UI.$(sel) ? UI.$(sel).value.trim() : "";
      const amount = raw === "" ? null : parseAmount(raw);
      if (raw !== "" && (!Number.isFinite(amount) || amount < 0.0001 || amount > max)) {
        reasons.push(`${label} must be between 0.0001 and ${max}.`);
      }
    }
    if (draft.per100.kcal > 920) reasons.push("kcal per 100 g looks impossibly high.");
    if (draft.per100.p + draft.per100.c + draft.per100.f > 105) reasons.push("Protein + carbs + fat can't exceed 105 g per 100 g.");
    const producerError = validateProducerFood(draft);
    if (producerError && !reasons.includes(producerError)) reasons.push(producerError);
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

    const nextPersonal = cloneLocalData(state.personalFoods);
    let savedFood = null;
    let day = null;
    let dayEntries = [];
    let amendDayLogs = false;
    if (updateId) {
      const idx = nextPersonal.findIndex((f) => f.id === updateId);
      if (idx < 0) { UI.toast("Food not found"); return; }
      const prev = nextPersonal[idx];
      nextPersonal[idx] = Foods.applyUpdate(prev, draft);
      savedFood = nextPersonal[idx];
      // amend logs on the day being viewed (not always calendar today)
      day = state.viewDay || Ledger.todayKey();
      dayEntries = Ledger.entriesFor(day).filter((e) => e.foodId === updateId);
      const dayLabel = day === Ledger.todayKey() ? "today" : "this day";
      amendDayLogs = !!(dayEntries.length && confirm(`Update ${dayEntries.length} log(s) ${dayLabel} to the new recipe numbers?`));
    } else {
      savedFood = Foods.createFromDraft(draft);
      nextPersonal.push(savedFood);
    }
    try {
      commitFoodChanges(nextPersonal, amendDayLogs ? () => {
        for (const e of dayEntries) {
          const qty = e.qty || e.grams;
          const unit = e.unit || "g";
          const fresh = Foods.entryFromQty(savedFood, qty, unit, e.meal);
          Ledger.amendEntry(day, e.id, {
            macros: fresh.macros,
            sd: fresh.sd,
            per100: fresh.per100,
            foodVersion: fresh.foodVersion,
            grams: fresh.grams,
            displayQty: fresh.displayQty,
          }, `recipe updated to v${savedFood.version}`);
        }
      } : null);
    } catch (error) {
      UI.toast(stagedSaveMessage(error, "Couldn’t save this food — nothing changed"));
      return;
    }
    savedFood = findFood(savedFood.id);
    const wasDirect = state.editFoodDirect;
    const intent = state.foodSaveIntent === "log" ? "log" : "library";
    Sync.schedulePush();
    UI.toast(updateId ? "Food updated" : "Food saved");
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
      const on = val === k;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }

  function renderPhaseRevisionList() {
    const list = UI.$("#phase-revision-list");
    if (!list) return;
    const today = Ledger.todayKey();
    const phase = Phases.phaseForDay(state.settings.phases, today) || Phases.activePhase(state.settings.phases);
    const rows = Phases.revisionHistoryRows(phase, today);
    if (!rows.length) {
      list.innerHTML = `<p class="muted small">No target versions yet.</p>`;
      return;
    }
    list.innerHTML = rows.map((r) => {
      const when = r.effectiveFrom ? Phases.shortDate(r.effectiveFrom) : "";
      const cur = r.current ? `<span class="rev-badge">current</span>` :
        (r.auditOnly ? `<span class="rev-badge">audit only</span>` : "");
      const eligibility = Phases.revisionDeletionStatus(
        state.settings, phase.id, r.id, Ledger.allEvents()
      );
      const del = eligibility.ok
        ? `<button type="button" class="linkbtn danger rev-del" data-rev-id="${UI.esc(r.id)}">Delete</button>`
        : eligibility.reason === "governed"
          ? `<span class="rev-guard" title="A food was logged while this version governed the day.">Kept for logged history</span>`
          : `<span class="rev-guard">Keep at least one version</span>`;
      return `<div class="rev-row" data-rev-id="${UI.esc(r.id)}">
        <div class="rev-main">
          <div class="rev-label">${UI.esc(r.label || "Version")} ${cur}</div>
          <div class="muted small">${UI.esc(when)} · ${UI.esc(r.summary || "")}${r.auditOnly && r.validationErrors.length ? ` · ${UI.esc(r.validationErrors[0])}` : ""}</div>
        </div>
        ${del}
      </div>`;
    }).join("");
  }

  function syncSettingsForm() {
    Phases.ensureMigrated(state.settings, Phases.earliestDayFromEvents(Ledger.allEvents()), Ledger.todayKey());
    const today = Ledger.todayKey();
    const phase = Phases.phaseForDay(state.settings.phases, today) || Phases.activePhase(state.settings.phases);
    const g = Phases.goalsForDay(today, state.settings);
    const targetReview = state.settings.targetReview && state.settings.targetReview.required
      ? state.settings.targetReview : null;
    const targetWarning = UI.$("#target-review-warning");
    if (targetWarning) {
      targetWarning.hidden = !targetReview;
      targetWarning.textContent = !targetReview ? "" :
        (targetReview.fallback === "generic-default"
          ? "Imported targets failed the persistent safety policy. The original version is audit-only; generic recovery targets are active until you review and save replacements."
          : "An imported current/future target is audit-only because it failed the persistent safety policy. The nearest earlier valid version is active; review and save a replacement.");
    }
    // The phase editor sets the PERSISTENT phase target, not today's live
    // number. When a day plan is active, g.kcal is today's frozen
    // override — g._phase.kcal is always the real, unadjusted phase value
    // (goalsForDay guarantees _phase is populated either way). Using g.kcal
    // here would let an unrelated today-only adjustment silently overwrite
    // the phase's calorie target the next time someone hits Save phase.
    const phaseGoals = g._phase || g;
    UI.$("#set-kcal").value = phaseGoals.kcal;
    UI.$("#set-protein").value = g.protein;
    UI.$("#set-carbs").value = g.carbs;
    UI.$("#set-fat").value = g.fat;
    UI.$("#set-fiber").value = g.fiber;
    if (UI.$("#set-sodium")) UI.$("#set-sodium").value = g.sodium != null ? g.sodium : DEFAULT_GOALS.sodium;
    if (UI.$("#set-potassium")) UI.$("#set-potassium").value = g.potassium != null ? g.potassium : DEFAULT_GOALS.potassium;
    if (phase) {
      setKindSeg("#phase-kind-seg", Phases.kindForDay(phase, today), "phase");
      if (UI.$("#phase-current-label")) {
        UI.$("#phase-current-label").textContent = targetReview &&
          targetReview.fallback === "generic-default"
          ? "Recovery targets · review required"
          : Phases.labelForDay(phase, today);
      }
      const hint = UI.$("#phase-save-hint");
      if (hint) {
        const n = (phase.revisions || []).length;
        const effective = Ledger.hasEverAdded(Ledger.todayKey()) ? "tomorrow" : "today";
        hint.textContent = n > 1
          ? `${n} target versions on file. Open Target history to review or delete.`
          : `Pick Cut, Maintain, Bulk, or Recomp. Saving changed numbers bumps the version from ${effective}.`;
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
        ? age < 18
          ? `Age today: ${age}. Automated targets are unavailable under 18; ask a pediatric clinician or registered dietitian.`
          : `Age today: ${age}. Log weight on Today so AI targets can use it.`
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
    const nextSettings = cloneLocalData(state.settings);
    nextSettings.profile = Phases.normalizeProfile({ ...profile, updatedAt: Date.now() });
    try { commitSettingsCandidate(nextSettings); }
    catch (error) {
      UI.toast("Couldn’t save profile — nothing changed");
      return false;
    }
    Sync.schedulePush();
    return true;
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
        : ready.message || (ready.under18
          ? "Automated targets are not available for users under 18. Ask a pediatric clinician or registered dietitian for appropriate targets."
          : `Copy is disabled until you add: ${ready.missing.join(", ")}.`);
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
        <p class="muted small">P${Math.round(g.protein)} · C${Math.round(g.carbs)} · F${Math.round(g.fat)} · Fiber ${Math.round(g.fiber)} · Na ${Math.round(g.sodium)}${g.potassium != null ? ` · K ${Math.round(g.potassium)}` : " · K unchanged"}</p>
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
    const piece = parsed.food.units && parsed.food.units.piece;
    const logging = parsed.food.logAs === "piece"
      ? `Logs by ${UI.esc(parsed.food.countLabel || "piece")}${piece ? ` (${piece} g each)` : ""}`
      : "Logs by weight";
    const batch = parsed.food.batch;
    prev.hidden = false;
    prev.innerHTML = `<b>${UI.esc(parsed.food.name)}</b>
      <p class="muted small">Per 100 g: ${Math.round(p.kcal)} kcal · P ${p.p} · C ${p.c} · F ${p.f}</p>
      <p class="muted small">Na ${p.na == null ? "unknown" : `${p.na} mg`} · K ${p.k == null ? "unknown" : `${p.k} mg`}</p>
      ${serv ? `<p class="muted small">Serving: ${serv} g</p>` : ""}
      <p class="muted small">${logging}${batch ? ` · Batch: ${batch.grams} g / ${batch.servings} servings` : ""}</p>
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
      logAs: pendingSharedFood.logAs || "grams",
      countLabel: pendingSharedFood.countLabel || null,
      batch: pendingSharedFood.batch || null,
      recipe: pendingSharedFood.recipe || { ingredients: [], prep: "", notes: "" },
      confidence: "medium",
      sd: 0.15,
      raw: "",
    });
    food.source = "shared";
    try {
      commitFoodChanges([...state.personalFoods, food]);
    } catch (error) {
      UI.toast(stagedSaveMessage(error, "Couldn’t add this food — nothing changed"));
      return;
    }
    Sync.schedulePush();
    const savedFood = findFood(food.id);
    pendingSharedFood = null;
    UI.closeSheet("sheet-import-shared");
    switchView("foods");
    refreshFoods();
    openDetail(savedFood ? savedFood.id : food.id, "library");
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
        ? `Connected as ${st.email}. Folder: NutriDaily / writer shards`
        : "Connected. Folder: NutriDaily / writer shards";
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

  const IMPORT_WIDE_OBJECT_PATHS = new Set([
    "settings.weights", "settings.dayGoals", "settings.dayPlans", "settings.gapDrafts",
    "weights", "dayGoals", "dayPlans", "gapDrafts",
  ]);

  function safeImportedJson(value, depth, path) {
    const d = depth || 0;
    const currentPath = path || "";
    if (d > 12) throw new Error("Import is nested too deeply");
    if (value == null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Import contains a non-finite number");
      return value;
    }
    if (typeof value === "string") {
      if (value.length > 12000) throw new Error("Import contains an oversized text field");
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > 100000) throw new Error("Import contains too many records");
      return value.map((v) => safeImportedJson(v, d + 1, `${currentPath}[]`));
    }
    if (typeof value !== "object") throw new Error("Import contains an unsupported value");
    const keys = Object.keys(value);
    const maxKeys = IMPORT_WIDE_OBJECT_PATHS.has(currentPath) ? 20000 : 250;
    if (keys.length > maxKeys) throw new Error("Import object has too many fields");
    const out = {};
    for (const key of keys) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      if (key.length > 80) throw new Error("Import contains an oversized field name");
      const childPath = currentPath ? `${currentPath}.${key}` : key;
      out[key] = safeImportedJson(value[key], d + 1, childPath);
    }
    return out;
  }

  const IMPORT_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const IMPORT_MEALS = new Set(["breakfast", "lunch", "dinner", "snack"]);
  const IMPORT_GOAL_KEYS = ["kcal", "protein", "carbs", "fat", "fiber", "sodium", "potassium"];
  const IMPORT_MACRO_KEYS = ["kcal", "p", "c", "f", "fb"];

  function importedObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value;
  }

  function importedString(value, label, opts) {
    const o = opts || {};
    if (value == null) {
      if (o.required) throw new Error(`${label} is required`);
      return o.fallback == null ? "" : o.fallback;
    }
    if (typeof value !== "string") throw new Error(`${label} must be text`);
    const text = o.trim === false ? value : value.trim();
    if (o.required && !text) throw new Error(`${label} is required`);
    if (text.length > (o.max || 500)) throw new Error(`${label} is too long`);
    return text;
  }

  function importedNumber(value, label, opts) {
    const o = opts || {};
    if (value == null || value === "") {
      if (o.nullable) return null;
      if (o.optional) return undefined;
      throw new Error(`${label} is required`);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number`);
    if (o.integer && !Number.isInteger(n)) throw new Error(`${label} must be a whole number`);
    if (o.min != null && n < o.min) throw new Error(`${label} is out of range`);
    if (o.max != null && n > o.max) throw new Error(`${label} is out of range`);
    return n;
  }

  /**
   * A planned day's calories cannot be expressed as one min/max pair:
   * {0} ∪ [200, 6000]. 0 is a declared fast; nothing between 1 and 199 is a
   * real protocol, it is a typo (see MIN_PLANNED_KCAL in phases.js).
   */
  function importedPlannedKcal(value, label, intent) {
    const n = importedNumber(value, label, { min: 0, max: 6000 });
    if (intent === "fast") {
      if (n !== 0) throw new Error(`${label} must be 0 on a declared fast`);
      return 0;
    }
    if (n < 200) throw new Error(`${label} must be 0 for a fast or at least 200 kcal`);
    return n;
  }

  function importedTimestamp(value, label) {
    if (value == null || value === "") return 0;
    return importedNumber(value, label, { min: 0, max: Number.MAX_SAFE_INTEGER });
  }

  function importedGeneration(value, label) {
    if (value == null || value === "") return 0;
    return importedNumber(value, label, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      integer: true,
    });
  }

  function importedDay(value, label) {
    const day = importedString(value, label, { required: true, max: 10 });
    if (!IMPORT_DAY_RE.test(day)) throw new Error(`${label} is invalid`);
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
      throw new Error(`${label} is invalid`);
    }
    return day;
  }

  function normalizeImportedNutrition(value, label, { per100 } = {}) {
    const raw = importedObject(value, label);
    const out = {};
    for (const key of IMPORT_MACRO_KEYS) {
      out[key] = importedNumber(raw[key], `${label}.${key}`, { min: 0, max: 1e9 });
    }
    for (const key of ["na", "k"]) {
      out[key] = importedNumber(raw[key], `${label}.${key}`, { nullable: true, min: 0, max: 1e9 });
    }
    if (per100) {
      // Physical-plausibility bounds for per100 catalog/personal food values only
      // (kept in sync with js/parse.js and js/share.js). Absolute, quantity-scaled
      // `macros` values are intentionally exempt — see call sites.
      if (out.kcal > 920) throw new Error(`${label}.kcal is out of range`);
      if ((out.p + out.c + out.f) > 105) throw new Error(`${label}.p+c+f is out of range`);
      if (out.na != null && out.na > 40000) throw new Error(`${label}.na is out of range`);
      if (out.k != null && out.k > 60000) throw new Error(`${label}.k is out of range`);
    }
    return out;
  }

  function normalizeImportedEntry(value, label, full) {
    const raw = importedObject(value, label);
    const out = {};
    const putText = (key, max, required) => {
      if (required || raw[key] != null) out[key] = importedString(raw[key], `${label}.${key}`, { required, max });
    };
    const putNum = (key, opts) => {
      if ((opts && opts.required) || raw[key] != null) {
        const n = importedNumber(raw[key], `${label}.${key}`, { ...(opts || {}), optional: !(opts && opts.required) });
        if (n !== undefined) out[key] = n;
      }
    };
    if (full) putText("id", 160, true);
    else if (raw.id != null) putText("id", 160, true);
    putText("name", 160, !!full);
    putText("displayQty", 160, !!full);
    putNum("grams", { required: !!full, min: 0, max: 1e9 });
    if (full || raw.macros != null) out.macros = normalizeImportedNutrition(raw.macros, `${label}.macros`);
    if (raw.per100 != null) out.per100 = normalizeImportedNutrition(raw.per100, `${label}.per100`, { per100: true });
    putNum("sd", { min: 0, max: 10 });
    putNum("qty", { min: 0, max: 1e9 });
    putNum("foodVersion", { min: 1, max: 1e9, integer: true });
    if (raw.meal != null) {
      const meal = importedString(raw.meal, `${label}.meal`, { required: true, max: 20 });
      if (!IMPORT_MEALS.has(meal)) throw new Error(`${label}.meal is invalid`);
      out.meal = meal;
    } else if (full) out.meal = "snack";
    for (const [key, max] of [["source", 40], ["cat", 40], ["unit", 32]]) {
      if (raw[key] != null) out[key] = importedString(raw[key], `${label}.${key}`, { max });
    }
    if (raw.foodId != null) out.foodId = importedString(raw.foodId, `${label}.foodId`, { max: 160 });
    else if (full) out.foodId = null;
    return out;
  }

  /**
   * Preserve the ledger's explicit per-entry causal link at every untrusted
   * boundary. Older exports legitimately omit this object; Ledger's validator
   * and replay layer provide their deterministic legacy fallback.
   */
  function normalizeImportedCausal(value, label) {
    const raw = importedObject(value, label);
    const seq = importedNumber(raw.seq, `${label}.seq`, {
      integer: true,
      min: 0,
      max: 1000000000,
    });
    const out = {
      entryId: importedString(raw.entryId, `${label}.entryId`, { required: true, max: 160 }),
      seq,
      parentEventId: null,
    };
    if (raw.parentEventId != null) {
      out.parentEventId = importedString(raw.parentEventId, `${label}.parentEventId`, {
        required: true,
        max: 160,
      });
    }
    return out;
  }

  function normalizeImportedEvents(list) {
    if (!Array.isArray(list)) throw new Error("Backup events must be an array");
    const ids = new Set();
    const events = list.map((value, i) => {
      const label = `events[${i}]`;
      const raw = importedObject(value, label);
      const id = importedString(raw.id, `${label}.id`, { required: true, max: 160 });
      if (ids.has(id)) throw new Error("Backup contains duplicate event ids");
      ids.add(id);
      const type = importedString(raw.type, `${label}.type`, { required: true, max: 12 });
      if (!["add", "remove", "amend"].includes(type)) throw new Error(`${label}.type is invalid`);
      const out = {
        id,
        ts: importedTimestamp(raw.ts, `${label}.ts`),
        day: importedDay(raw.day, `${label}.day`),
        type,
        resetEpoch: importedGeneration(raw.resetEpoch, `${label}.resetEpoch`),
      };
      if (type === "add") {
        out.entry = normalizeImportedEntry(raw.entry, `${label}.entry`, true);
        if (raw.dayGoalLock != null) {
          const lock = importedObject(raw.dayGoalLock, `${label}.dayGoalLock`);
          // targetKcal is a planned day ({0} ∪ [200, 6000]); baseKcal is a
          // frozen phase target and keeps its own unrelated [800, 6000] floor.
          const lockTargetKcal = importedNumber(lock.targetKcal, `${label}.dayGoalLock.targetKcal`, { min: 0, max: 6000 });
          // A 0 target is only ever a real declaration, never bare arithmetic
          // — an event lock that recorded targetKcal 0 with no intent/
          // fastAcknowledged of its own is the one shape the rest of the
          // system refuses to honour (Part VIII.1), and this site was the
          // fifth one still capable of writing it: rebuilding the lock from a
          // fixed field list that dropped intent/fastAcknowledged, exactly
          // mirroring Ledger._normalizedDayGoalLock now (Part IX.1). The
          // reverse combination — intent "fast" riding along on a nonzero
          // target — is equally incoherent (Part IX.2) and must not survive
          // either; requiring targetKcal 0 here keeps this site in exact
          // agreement with the ledger's own validator instead of writing a
          // lock none of the other three validators would accept.
          const lockDeclaredFast = lock.intent === "fast" && lock.fastAcknowledged === true &&
            lockTargetKcal === 0;
          if (lockTargetKcal === 0) {
            if (!lockDeclaredFast) {
              throw new Error(`${label}.dayGoalLock.targetKcal of 0 requires intent "fast" and fastAcknowledged`);
            }
          } else if (lockTargetKcal < 200) {
            throw new Error(`${label}.dayGoalLock.targetKcal must be 0 or at least 200`);
          }
          out.dayGoalLock = {
            targetKcal: lockTargetKcal,
            baseKcal: importedNumber(lock.baseKcal, `${label}.dayGoalLock.baseKcal`, { min: 800, max: 6000 }),
          };
          if (lock.plannedAt != null) {
            out.dayGoalLock.plannedAt = importedTimestamp(lock.plannedAt, `${label}.dayGoalLock.plannedAt`);
          }
          if (lock.veryLowCalorieAcknowledged === true) {
            out.dayGoalLock.veryLowCalorieAcknowledged = true;
          }
          if (lockDeclaredFast) {
            out.dayGoalLock.intent = "fast";
            out.dayGoalLock.fastAcknowledged = true;
            if (lock.declaredAfterDay === true) out.dayGoalLock.declaredAfterDay = true;
          }
        }
      }
      else {
        out.target = importedString(raw.target, `${label}.target`, { required: true, max: 160 });
        if (type === "amend") out.patch = normalizeImportedEntry(raw.patch, `${label}.patch`, false);
        if (raw.label != null) out.label = importedString(raw.label, `${label}.label`, { max: 300 });
      }
      if (raw.causal != null) out.causal = normalizeImportedCausal(raw.causal, `${label}.causal`);
      return out;
    });
    // This is intentionally detached: every object above is a fresh whitelist
    // copy, and causal/state validation completes before import or Drive apply
    // is allowed to touch localStorage or App/Ledger memory.
    Ledger.validateEvents(events);
    return events.sort((a, b) => (a.ts - b.ts) || a.id.localeCompare(b.id));
  }

  function normalizeImportedUnits(value, label) {
    if (value == null) return {};
    const raw = importedObject(value, label);
    const out = {};
    for (const [key, amount] of Object.entries(raw)) {
      const unit = importedString(key, `${label} key`, { required: true, max: 32 });
      out[unit] = importedNumber(amount, `${label}.${unit}`, { min: 0.0001, max: 1e9 });
    }
    return out;
  }

  function normalizeImportedBatch(value, label) {
    if (value == null) return null;
    const raw = importedObject(value, label);
    return {
      grams: importedNumber(raw.grams, `${label}.grams`, { min: 0.0001, max: 1e9 }),
      servings: importedNumber(raw.servings == null ? 1 : raw.servings, `${label}.servings`, { min: 0.0001, max: 1e7 }),
      weighed: raw.weighed === true,
    };
  }

  function normalizeImportedRecipe(value, label) {
    if (value == null) return { ingredients: [], prep: "", notes: "" };
    const raw = importedObject(value, label);
    if (raw.ingredients != null && !Array.isArray(raw.ingredients)) throw new Error(`${label}.ingredients must be an array`);
    const ingredients = (raw.ingredients || []).map((item, i) => {
      if (typeof item === "string") return { text: importedString(item, `${label}.ingredients[${i}]`, { max: 500 }) };
      const row = importedObject(item, `${label}.ingredients[${i}]`);
      const out = { text: importedString(row.text, `${label}.ingredients[${i}].text`, { required: true, max: 500 }) };
      if (row.grams != null) out.grams = importedNumber(row.grams, `${label}.ingredients[${i}].grams`, { min: 0, max: 1e9 });
      return out;
    });
    return {
      ingredients,
      prep: importedString(raw.prep, `${label}.prep`, { max: 5000, trim: false }),
      notes: importedString(raw.notes, `${label}.notes`, { max: 5000, trim: false }),
    };
  }

  function normalizeImportedHistory(value, label) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} must be an array`);
    return value.map((row, i) => {
      const raw = importedObject(row, `${label}[${i}]`);
      const out = {
        version: importedNumber(raw.version == null ? 1 : raw.version, `${label}[${i}].version`, { min: 1, max: 1e9, integer: true }),
        per100: normalizeImportedNutrition(raw.per100, `${label}[${i}].per100`, { per100: true }),
        units: normalizeImportedUnits(raw.units, `${label}[${i}].units`),
        batch: normalizeImportedBatch(raw.batch, `${label}[${i}].batch`),
        ts: importedTimestamp(raw.ts, `${label}[${i}].ts`),
        raw: importedString(raw.raw, `${label}[${i}].raw`, { max: 12000, trim: false }),
      };
      return out;
    });
  }

  function normalizeImportedFoods(list, sourceLabel) {
    if (!Array.isArray(list)) throw new Error(`${sourceLabel || "Backup foods"} must be an array`);
    const ids = new Set();
    return list.map((value, i) => {
      const label = `${sourceLabel || "personalFoods"}[${i}]`;
      const raw = importedObject(value, label);
      const id = importedString(raw.id, `${label}.id`, { required: true, max: 160 });
      if (ids.has(id)) throw new Error("Food ids must be unique");
      ids.add(id);
      if (raw.aliases != null && !Array.isArray(raw.aliases)) throw new Error(`${label}.aliases must be an array`);
      const aliases = (raw.aliases || []).slice(0, 50).map((a, j) =>
        importedString(a, `${label}.aliases[${j}]`, { max: 160 }).toLowerCase()
      );
      const logAs = raw.logAs === "piece" ? "piece" : "grams";
      const out = {
        id,
        name: importedString(raw.name, `${label}.name`, { required: true, max: 160 }),
        aliases,
        cat: importedString(raw.cat, `${label}.cat`, { max: 40, fallback: "dish" }) || "dish",
        per100: normalizeImportedNutrition(raw.per100, `${label}.per100`, { per100: true }),
        units: normalizeImportedUnits(raw.units, `${label}.units`),
        logAs,
        countLabel: logAs === "piece" && raw.countLabel != null
          ? importedString(raw.countLabel, `${label}.countLabel`, { max: 32 }).toLowerCase() || null
          : null,
        batch: normalizeImportedBatch(raw.batch, `${label}.batch`),
        recipe: normalizeImportedRecipe(raw.recipe, `${label}.recipe`),
        confidence: ["low", "medium", "high"].includes(raw.confidence) ? raw.confidence : "medium",
        sd: importedNumber(raw.sd == null ? 0.12 : raw.sd, `${label}.sd`, { min: 0, max: 10 }),
        version: importedNumber(raw.version == null ? 1 : raw.version, `${label}.version`, { min: 1, max: 1e9, integer: true }),
        history: normalizeImportedHistory(raw.history, `${label}.history`),
        raw: importedString(raw.raw, `${label}.raw`, { max: 12000, trim: false }),
        createdAt: importedTimestamp(raw.createdAt, `${label}.createdAt`),
        updatedAt: importedTimestamp(raw.updatedAt, `${label}.updatedAt`),
        lastUsedAt: importedTimestamp(raw.lastUsedAt, `${label}.lastUsedAt`),
        useCount: importedNumber(raw.useCount == null ? 0 : raw.useCount, `${label}.useCount`, { min: 0, max: 1e9, integer: true }),
        source: importedString(raw.source, `${label}.source`, { max: 40, fallback: "personal" }) || "personal",
        deleted: raw.deleted === true,
        resetEpoch: importedGeneration(raw.resetEpoch, `${label}.resetEpoch`),
      };
      if (raw.catalogId != null) out.catalogId = importedString(raw.catalogId, `${label}.catalogId`, { max: 160 });
      return out;
    });
  }

  function normalizeImportedGoals(value, label) {
    if (value == null) return { ...DEFAULT_GOALS };
    const raw = importedObject(value, label);
    for (const key of IMPORT_GOAL_KEYS) {
      if (raw[key] != null) importedNumber(raw[key], `${label}.${key}`, { min: 0, max: 1e9 });
    }
    return Phases.normalizeGoals(raw);
  }

  function normalizeImportedPhases(value, events) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 1000) throw new Error("settings.phases must be an array");
    const phaseIds = new Set();
    const phases = value.map((item, i) => {
      const label = `settings.phases[${i}]`;
      const raw = importedObject(item, label);
      const id = importedString(raw.id, `${label}.id`, { required: true, max: 160 });
      if (phaseIds.has(id)) throw new Error("Phase ids must be unique");
      phaseIds.add(id);
      if (!Array.isArray(raw.revisions) || !raw.revisions.length) throw new Error(`${label}.revisions must contain a target version`);
      const revisionIds = new Set();
      const revisions = raw.revisions.map((item2, j) => {
        const rlabel = `${label}.revisions[${j}]`;
        const rev = importedObject(item2, rlabel);
        const rid = importedString(rev.id, `${rlabel}.id`, { required: true, max: 160 });
        if (revisionIds.has(rid)) throw new Error(`${label} has duplicate revision ids`);
        revisionIds.add(rid);
        return {
          id: rid,
          effectiveFrom: importedDay(rev.effectiveFrom, `${rlabel}.effectiveFrom`),
          goals: normalizeImportedGoals(rev.goals, `${rlabel}.goals`),
          kind: Phases.normalizeKind(rev.kind == null ? raw.kind : rev.kind),
          createdAt: importedTimestamp(rev.createdAt, `${rlabel}.createdAt`),
          updatedAt: importedTimestamp(rev.updatedAt == null ? rev.createdAt : rev.updatedAt, `${rlabel}.updatedAt`),
          resetEpoch: importedGeneration(rev.resetEpoch, `${rlabel}.resetEpoch`),
          note: importedString(rev.note, `${rlabel}.note`, { max: 1000, trim: false }),
          version: importedString(rev.version, `${rlabel}.version`, { max: 32 }),
          label: importedString(rev.label, `${rlabel}.label`, { max: 160 }),
        };
      });
      const tombRaw = raw.revisionTombstones == null ? {} : importedObject(raw.revisionTombstones, `${label}.revisionTombstones`);
      const revisionTombstones = {};
      const tombEpochRaw = raw.revisionTombstoneEpochs == null
        ? {} : importedObject(raw.revisionTombstoneEpochs, `${label}.revisionTombstoneEpochs`);
      const revisionTombstoneEpochs = {};
      for (const [rid, stamp] of Object.entries(tombRaw)) {
        const cleanId = importedString(rid, `${label}.revisionTombstones id`, { required: true, max: 160 });
        revisionTombstones[cleanId] = importedTimestamp(stamp, `${label}.revisionTombstones.${cleanId}`);
        revisionTombstoneEpochs[cleanId] = importedGeneration(
          tombEpochRaw[cleanId], `${label}.revisionTombstoneEpochs.${cleanId}`
        );
      }
      const startDay = importedDay(raw.startDay, `${label}.startDay`);
      const endDay = raw.endDay == null ? null : importedDay(raw.endDay, `${label}.endDay`);
      if (endDay != null && endDay < startDay && !raw.archived) throw new Error(`${label} ends before it starts`);
      return {
        id,
        name: importedString(raw.name, `${label}.name`, { max: 160 }),
        kind: Phases.normalizeKind(raw.kind),
        syntheticLegacy: raw.syntheticLegacy === true,
        versionMajor: importedNumber(raw.versionMajor == null ? 1 : raw.versionMajor, `${label}.versionMajor`, { min: 1, max: 1e6, integer: true }),
        versionMinor: importedNumber(raw.versionMinor == null ? 0 : raw.versionMinor, `${label}.versionMinor`, { min: 0, max: 1e6, integer: true }),
        startDay,
        endDay,
        createdAt: importedTimestamp(raw.createdAt, `${label}.createdAt`),
        updatedAt: importedTimestamp(raw.updatedAt, `${label}.updatedAt`),
        resetEpoch: importedGeneration(raw.resetEpoch, `${label}.resetEpoch`),
        archived: raw.archived === true,
        revisionTombstones,
        revisionTombstoneEpochs,
        revisions,
      };
    });
    return Phases.mergePhases([], phases, events);
  }

  function normalizeImportedWeights(value) {
    if (value == null) return {};
    const raw = importedObject(value, "settings.weights");
    const out = {};
    for (const [key, item] of Object.entries(raw)) {
      const day = importedDay(key, "settings.weights day");
      const row = importedObject(item, `settings.weights.${day}`);
      const updatedAt = importedTimestamp(row.updatedAt, `settings.weights.${day}.updatedAt`);
      const resetEpoch = importedGeneration(row.resetEpoch, `settings.weights.${day}.resetEpoch`);
      if (row.cleared) out[day] = { cleared: true, updatedAt, resetEpoch };
      else {
        const kg = importedNumber(row.kg, `settings.weights.${day}.kg`, { min: 25, max: 400 });
        out[day] = { kg, lb: Math.round(kg * 2.2046226218 * 10) / 10, updatedAt, resetEpoch };
      }
    }
    return out;
  }

  function normalizeImportedProjected(value, label) {
    if (value == null) return null;
    const raw = importedObject(value, label);
    const out = {};
    for (const key of IMPORT_GOAL_KEYS) {
      if (raw[key] != null) out[key] = importedNumber(raw[key], `${label}.${key}`, { min: 0, max: 1e9 });
    }
    return out;
  }

  function normalizeImportedDayPlans(value) {
    if (value == null) return {};
    const raw = importedObject(value, "settings.dayPlans");
    const out = {};
    for (const [key, item] of Object.entries(raw)) {
      const day = importedDay(key, "settings.dayPlans day");
      const label = `settings.dayPlans.${day}`;
      const plan = importedObject(item, label);
      const updatedAt = importedTimestamp(plan.updatedAt, `${label}.updatedAt`);
      const resetEpoch = importedGeneration(plan.resetEpoch, `${label}.resetEpoch`);
      if (plan.cleared) {
        out[day] = { cleared: true, updatedAt, resetEpoch };
        continue;
      }
      if (plan.items != null && !Array.isArray(plan.items)) throw new Error(`${label}.items must be an array`);
      if (plan.candidates != null && !Array.isArray(plan.candidates)) throw new Error(`${label}.candidates must be an array`);
      const candidates = (plan.candidates || []).map((candidate, i) => {
        const row = importedObject(candidate, `${label}.candidates[${i}]`);
        return {
          foodId: row.foodId == null ? null : importedString(row.foodId, `${label}.candidates[${i}].foodId`, { max: 160 }),
          name: importedString(row.name, `${label}.candidates[${i}].name`, { required: true, max: 160 }),
        };
      });
      const items = (plan.items || []).map((entry, i) => {
        const ilabel = `${label}.items[${i}]`;
        const row = importedObject(entry, ilabel);
        const status = row.status === "logged" ? "logged" : "pending";
        const meal = row.meal == null ? "snack" : importedString(row.meal, `${ilabel}.meal`, { max: 20 });
        if (!IMPORT_MEALS.has(meal)) throw new Error(`${ilabel}.meal is invalid`);
        return {
          id: importedString(row.id, `${ilabel}.id`, { required: true, max: 160 }),
          foodId: row.foodId == null ? null : importedString(row.foodId, `${ilabel}.foodId`, { max: 160 }),
          name: importedString(row.name, `${ilabel}.name`, { required: true, max: 160 }),
          grams: importedNumber(row.grams, `${ilabel}.grams`, { nullable: true, min: 0, max: 1e9 }),
          suggestedGrams: importedNumber(row.suggestedGrams, `${ilabel}.suggestedGrams`, { nullable: true, min: 0, max: 1e9 }),
          qty: importedNumber(row.qty, `${ilabel}.qty`, { nullable: true, min: 0, max: 1e9 }),
          unit: importedString(row.unit, `${ilabel}.unit`, { max: 32, fallback: "g" }) || "g",
          meal,
          status,
          loggedEntryId: row.loggedEntryId == null ? null : importedString(row.loggedEntryId, `${ilabel}.loggedEntryId`, { max: 160 }),
        };
      });
      out[day] = {
        updatedAt,
        resetEpoch,
        reachable: plan.reachable !== false,
        note: importedString(plan.note, `${label}.note`, { max: 2000, trim: false }),
        optionLabel: importedString(plan.optionLabel, `${label}.optionLabel`, { max: 160 }),
        candidates,
        items,
        projected: normalizeImportedProjected(plan.projected, `${label}.projected`),
      };
    }
    return out;
  }

  function normalizeImportedGapDrafts(value) {
    if (value == null) return {};
    const raw = importedObject(value, "settings.gapDrafts");
    const out = {};
    for (const [key, item] of Object.entries(raw)) {
      const day = importedDay(key, "settings.gapDrafts day");
      const label = `settings.gapDrafts.${day}`;
      const draft = importedObject(item, label);
      if (!Array.isArray(draft.selected)) throw new Error(`${label}.selected must be an array`);
      const selected = draft.selected.map((candidate, i) => {
        const row = importedObject(candidate, `${label}.selected[${i}]`);
        return {
          foodId: row.foodId == null ? null : importedString(row.foodId, `${label}.selected[${i}].foodId`, { max: 160 }),
          catalogId: row.catalogId == null ? null : importedString(row.catalogId, `${label}.selected[${i}].catalogId`, { max: 160 }),
          name: importedString(row.name, `${label}.selected[${i}].name`, { required: true, max: 160 }),
        };
      });
      const step = ["select", "prompt", "choose", "plan"].includes(draft.step) ? draft.step : "select";
      out[day] = {
        selected,
        step,
        updatedAt: importedTimestamp(draft.updatedAt, `${label}.updatedAt`),
        resetEpoch: importedGeneration(draft.resetEpoch, `${label}.resetEpoch`),
      };
    }
    return out;
  }

  function normalizeImportedDayPlanPresets(value) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new Error("settings.dayPlanPresets must be an array");
    // Cap-overage degrades via Sync.enforceDayPlanPresetCap (tombstone losers)
    // rather than throwing — presets must never brick Drive sync / import.
    // Tombstones omit targetKcal/intent by design (Sync.normalizeDayPlanPreset);
    // accept that shape before reading active-only fields, or delete/sync round-trips throw.
    return Sync.normalizeDayPlanPresets(value.map((item, i) => {
      const row = importedObject(item, `settings.dayPlanPresets[${i}]`);
      const id = importedString(row.id, `settings.dayPlanPresets[${i}].id`, { required: true, max: 160 });
      const createdAt = importedTimestamp(row.createdAt, `settings.dayPlanPresets[${i}].createdAt`);
      const updatedAt = importedTimestamp(row.updatedAt, `settings.dayPlanPresets[${i}].updatedAt`);
      const resetEpoch = importedGeneration(row.resetEpoch, `settings.dayPlanPresets[${i}].resetEpoch`);
      if (row.deleted === true) {
        return { id, deleted: true, createdAt, updatedAt, resetEpoch };
      }
      const label = row.label == null ? "" : importedString(row.label, `settings.dayPlanPresets[${i}].label`, { max: 80 });
      const intent = row.intent === "fast" ? "fast" : "reduced";
      const targetKcal = importedNumber(row.targetKcal, `settings.dayPlanPresets[${i}].targetKcal`);
      const out = {
        id,
        label,
        intent,
        targetKcal,
        createdAt,
        updatedAt,
        resetEpoch,
      };
      if (intent === "fast" && row.fastAcknowledged === true) out.fastAcknowledged = true;
      if (row.veryLowCalorieAcknowledged === true) out.veryLowCalorieAcknowledged = true;
      if (row.lastUsedAt != null) {
        out.lastUsedAt = importedTimestamp(row.lastUsedAt, `settings.dayPlanPresets[${i}].lastUsedAt`);
      }
      return out;
    }));
  }

  function normalizeImportedDayGoals(value, settings) {
    if (value == null) return {};
    const raw = importedObject(value, "settings.dayGoals");
    const out = {};
    for (const [key, item] of Object.entries(raw)) {
      const day = importedDay(key, "settings.dayGoals day");
      const label = `settings.dayGoals.${day}`;
      const record = importedObject(item, label);
      const updatedAt = importedTimestamp(record.updatedAt, `${label}.updatedAt`);
      const resetEpoch = importedGeneration(record.resetEpoch, `${label}.resetEpoch`);
      const common = { updatedAt, resetEpoch };
      if (record.plannedAt != null) common.plannedAt = importedTimestamp(record.plannedAt, `${label}.plannedAt`);
      if (record.veryLowCalorieAcknowledged === true) common.veryLowCalorieAcknowledged = true;
      if (record.cleared) {
        out[day] = { cleared: true, ...common };
        continue;
      }

      // Absent on every record generation that predates this feature; a
      // missing intent is an ordinary planned day, not a fast nobody
      // declared. A record naming intent "fast" without a coherent zero
      // target is not a fast either — it's an ordinary planned day with a
      // stray label. Downgrading it here (drop intent, keep whatever numeric
      // plan the record actually has) mirrors Ledger._normalizedDayGoalLock
      // and normalizeImportedEvent's event-lock path: both already do this,
      // and rejecting the entire import over one mismatched record fails a
      // whole backup restore for no reason (Part X.5). An explicit zero with
      // no acknowledgement still falls through to importedPlannedKcal below,
      // which rejects 0 under intent "reduced" — the undeclared-zero
      // protection (Part VIII.1) survives as a consequence of the ordinary
      // range check, not a special case here.
      const rawTargetKcal = record.targetKcal == null ? NaN : Number(record.targetKcal);
      const declaredFast = record.intent === "fast" && record.fastAcknowledged === true &&
        rawTargetKcal === 0;
      const intent = declaredFast ? "fast" : "reduced";

      if (record.targetKcal != null || record.baseKcal != null) {
        const targetKcal = importedPlannedKcal(record.targetKcal, `${label}.targetKcal`, intent);
        const baseKcal = importedNumber(record.baseKcal, `${label}.baseKcal`, { min: 800, max: 6000 });
        const locked = record.locked === true || record.lockedByEventId != null;
        if (targetKcal === baseKcal && !locked) {
          out[day] = { cleared: true, ...common };
        } else {
          if (targetKcal > 0 && targetKcal < 1200 && !common.veryLowCalorieAcknowledged) {
            throw new Error(`${label}.targetKcal is below 1200 and requires veryLowCalorieAcknowledged`);
          }
          out[day] = { targetKcal, baseKcal, ...common };
          if (intent === "fast") {
            out[day].intent = "fast";
            out[day].fastAcknowledged = true;
            // Modern branch only (Part VII) — never into `common`, so a clear
            // tombstone or legacy absolute never carries a late-fast stamp.
            if (record.declaredAfterDay === true) out[day].declaredAfterDay = true;
          }
          if (locked) {
            out[day].locked = true;
            if (record.lockedByEventId != null) {
              out[day].lockedByEventId = importedString(
                record.lockedByEventId, `${label}.lockedByEventId`, { required: true, max: 160 }
              );
            }
          }
        }
        continue;
      }
      // A fast only ever takes the frozen modern shape above — a delta bump or
      // a legacy absolute target cannot express a zero-calorie day explicitly.
      if (intent === "fast") {
        throw new Error(`${label}.intent is "fast" but no targetKcal was provided`);
      }
      const base = Phases.goalsForDay(day, { ...settings, dayGoals: {} });
      const baseKcal = Number(base && base.kcal);
      if (!Number.isFinite(baseKcal) || baseKcal < 800 || baseKcal > 6000) {
        throw new Error(`${label} cannot resolve against a valid 800–6000 kcal phase target`);
      }
      if (record.bumps != null) {
        const bumps = importedObject(record.bumps, `${label}.bumps`);
        if (bumps.kcal == null || bumps.kcal === "") {
          out[day] = { cleared: true, ...common };
          continue;
        }
        const kcal = importedNumber(bumps.kcal, `${label}.bumps.kcal`, { min: -5200, max: 5200 });
        const targetKcal = baseKcal + kcal;
        // A delta can coincidentally land on 0, but intent must always be
        // explicit — a fast is only ever declared via the frozen modern shape.
        if (targetKcal === 0) {
          throw new Error(`${label} resolves to 0 kcal — declare a fast explicitly instead of a calorie delta`);
        }
        if (targetKcal < 200 || targetKcal > 6000) {
          throw new Error(`${label} resolves outside the supported 200–6000 kcal range`);
        }
        if (kcal !== 0 && targetKcal < 1200 && !common.veryLowCalorieAcknowledged) {
          throw new Error(`${label}.targetKcal is below 1200 and requires veryLowCalorieAcknowledged`);
        }
        out[day] = kcal === 0 ? { cleared: true, ...common } : { bumps: { kcal }, ...common };
      } else if (record.kcal != null && record.kcal !== "") {
        // Legacy absolute overrides predate the fast concept and can never be 0.
        const absolute = importedNumber(record.kcal, `${label}.kcal`, { min: 200, max: 6000 });
        if (absolute !== baseKcal && absolute < 1200 && !common.veryLowCalorieAcknowledged) {
          throw new Error(`${label}.targetKcal is below 1200 and requires veryLowCalorieAcknowledged`);
        }
        out[day] = absolute === baseKcal
          ? { cleared: true, ...common }
          : { targetKcal: absolute, baseKcal, ...common };
      } else {
        out[day] = { cleared: true, ...common };
      }
    }
    return out;
  }

  function validateImportData(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Backup must be a JSON object");
    if (![1, 2, 3].includes(Number(raw.version))) throw new Error("Unsupported backup version");
    if (!Array.isArray(raw.events) || !Array.isArray(raw.personalFoods)) throw new Error("Backup is missing foods or events");
    if (!raw.settings || typeof raw.settings !== "object" || Array.isArray(raw.settings)) throw new Error("Backup is missing settings");
    const clean = safeImportedJson(raw);
    Sync.validateDocClocks(clean);
    const events = normalizeImportedEvents(clean.events);
    const personalFoods = normalizeImportedFoods(clean.personalFoods, "personalFoods");
    const input = clean.settings;
    const theme = input.theme == null ? "light" : importedString(input.theme, "settings.theme", { max: 10 });
    if (!["light", "dark", "auto"].includes(theme)) throw new Error("settings.theme is invalid");
    const weightUnit = input.weightUnit == null ? "lb" : importedString(input.weightUnit, "settings.weightUnit", { max: 4 });
    if (!["kg", "lb"].includes(weightUnit)) throw new Error("settings.weightUnit is invalid");
    if (input.imperial != null && typeof input.imperial !== "boolean") throw new Error("settings.imperial must be true or false");
    if (input.profile != null) importedObject(input.profile, "settings.profile");
    const settings = {
      goals: normalizeImportedGoals(input.goals, "settings.goals"),
      goalsUpdatedAt: importedTimestamp(input.goalsUpdatedAt, "settings.goalsUpdatedAt"),
      goalsResetEpoch: importedGeneration(input.goalsResetEpoch, "settings.goalsResetEpoch"),
      theme,
      imperial: input.imperial === true,
      weightUnit,
      weights: normalizeImportedWeights(input.weights),
      profile: Phases.normalizeProfile(input.profile),
      phases: normalizeImportedPhases(input.phases, events),
      dayGoals: {},
      dayPlans: normalizeImportedDayPlans(input.dayPlans),
      gapDrafts: normalizeImportedGapDrafts(input.gapDrafts),
      dayPlanPresets: normalizeImportedDayPlanPresets(input.dayPlanPresets),
    };
    Phases.ensureMigrated(settings, Phases.earliestDayFromEvents(events), Ledger.todayKey());
    settings.dayGoals = normalizeImportedDayGoals(input.dayGoals, settings);
    return { events, personalFoods, settings };
  }

  /** Fully detach and normalize untrusted Drive JSON before sync mutates state. */
  function normalizeRemoteSyncDoc(raw) {
    const clean = safeImportedJson(raw);
    Sync.validateDocClocks(clean);
    const events = normalizeImportedEvents(clean.events || []);
    // Generation migration runs before this normalizer. Preserve a singleton
    // it deliberately filtered to null; recreating defaults here would attach
    // epoch zero to a now-marked reset document and could also synthesize a
    // competing default phase before the aggregate merge.
    const hasGoals = clean.goals != null;
    const hasProfile = clean.profile != null;
    const settings = {
      goals: hasGoals ? normalizeImportedGoals(clean.goals, "Drive goals") : null,
      goalsUpdatedAt: importedTimestamp(clean.goalsUpdatedAt, "Drive goalsUpdatedAt"),
      goalsResetEpoch: importedGeneration(clean.goalsResetEpoch, "Drive goalsResetEpoch"),
      phases: normalizeImportedPhases(clean.phases, events),
      weights: normalizeImportedWeights(clean.weights),
      profile: hasProfile ? Phases.normalizeProfile(clean.profile) : null,
      dayPlans: normalizeImportedDayPlans(clean.dayPlans),
      gapDrafts: normalizeImportedGapDrafts(clean.gapDrafts),
      dayPlanPresets: normalizeImportedDayPlanPresets(clean.dayPlanPresets),
      dayGoals: {},
    };
    // Legacy settings become a deterministic phase before any shard merge, so
    // a fresh device's default can never win merely because it migrated first.
    if (settings.phases.length || hasGoals) {
      Phases.ensureMigrated(settings, Phases.earliestDayFromEvents(events), Ledger.todayKey());
    }
    // ensureMigrated normalizes its complete App settings object and therefore
    // may materialize profile/goals while sanitizing a phase timeline. At this
    // per-shard boundary, null has stronger meaning: the generation rollout
    // already proved that the shard's singleton predates its reset. Keep it
    // absent until aggregate merge chooses a current singleton.
    if (!hasProfile) settings.profile = null;
    if (!hasGoals) {
      settings.goals = null;
      settings.goalsUpdatedAt = 0;
    }
    settings.dayGoals = normalizeImportedDayGoals(clean.dayGoals, settings);
    return {
      version: Number(clean.version || 1),
      generationSchemaVersion: importedGeneration(
        clean.generationSchemaVersion, "Drive generationSchemaVersion"
      ),
      updatedAt: importedTimestamp(clean.updatedAt, "Drive updatedAt"),
      resetAt: importedTimestamp(clean.resetAt, "Drive resetAt"),
      events,
      personalFoods: normalizeImportedFoods(clean.personalFoods || [], "Drive personalFoods"),
      dayGoals: settings.dayGoals,
      dayPlans: settings.dayPlans,
      gapDrafts: settings.gapDrafts,
      dayPlanPresets: settings.dayPlanPresets,
      phases: settings.phases,
      weights: settings.weights,
      profile: settings.profile,
      goals: settings.goals,
      goalsUpdatedAt: settings.goalsUpdatedAt,
      goalsResetEpoch: settings.goalsResetEpoch,
    };
  }

  function restoreImportedStorage(key, raw) {
    if (raw == null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
  }

  function cloneLocalData(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function beginLocalDataTransaction(extraKeys) {
    const keys = [...new Set([
      "nd_events_v1", PERSONAL_KEY, SETTINGS_KEY, "nd_reset_at", "nd_generation_schema_version",
      ...(extraKeys || []),
    ])];
    const raw = Object.create(null);
    for (const key of keys) raw[key] = localStorage.getItem(key);
    const stateSnapshot = {
      ...state,
      settings: cloneLocalData(state.settings),
      personalFoods: cloneLocalData(state.personalFoods),
      gapSelected: cloneLocalData(state.gapSelected),
    };
    let active = true;
    return {
      commit() { active = false; },
      rollback() {
        if (!active) return;
        active = false;
        let firstError = null;
        for (const key of keys) {
          try { restoreImportedStorage(key, raw[key]); }
          catch (error) { if (!firstError) firstError = error; }
        }
        if (typeof Ledger._resetCacheForTests === "function") {
          Ledger._resetCacheForTests();
          try { Ledger.allEvents(); }
          catch (error) { if (!firstError) firstError = error; }
        }
        for (const key of Object.keys(stateSnapshot)) state[key] = stateSnapshot[key];
        if (firstError) throw firstError;
      },
    };
  }

  function commitLocalData(data, options) {
    const opts = options || {};
    const storageMutations = opts.storageMutations || [];
    const resetAt = safeResetEpoch(opts.resetAt == null ? Date.now() : opts.resetAt);
    // Serialize every detached candidate before the first durable mutation.
    const nextEvents = cloneLocalData(data.events || []).map((event) => ({ ...event, resetEpoch: resetAt }));
    const nextSettings = stampSettingsGenerations(
      cloneLocalData(data.settings || {}), {}, resetAt, true
    );
    const nextPersonal = stampFoodsGenerations(
      cloneLocalData(data.personalFoods || []), [], resetAt, true
    );
    validateStagedLocalData({
      events: nextEvents,
      personalFoods: nextPersonal,
      settings: nextSettings,
      resetAt,
    });
    const nextSettingsRaw = JSON.stringify(nextSettings);
    const nextPersonalRaw = JSON.stringify(nextPersonal);
    const transaction = beginLocalDataTransaction(storageMutations.map((item) => item.key));
    try {
      Ledger.replaceAll(nextEvents);
      localStorage.setItem(PERSONAL_KEY, nextPersonalRaw);
      localStorage.setItem(SETTINGS_KEY, nextSettingsRaw);
      for (const mutation of storageMutations) {
        if (mutation.value == null) localStorage.removeItem(mutation.key);
        else localStorage.setItem(mutation.key, String(mutation.value));
      }
      // Privacy epoch is deliberately the final durable write. Until it lands,
      // a failed clear/import cannot label the previous records as deleted.
      Sync.markReset(resetAt);
      state.settings = nextSettings;
      state.personalFoods = nextPersonal;
      transaction.commit();
    } catch (error) {
      try { transaction.rollback(); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
      throw error;
    }
  }

  function commitImportedData(data) {
    commitLocalData(data, { resetAt: Date.now() });
  }

  function importData(file) {
    if (!confirm("Import replaces all foods and logs on this device (and the next Drive sync). Continue?")) return;
    if (!file || file.size > 20 * 1024 * 1024) { UI.toast("Import failed: file is too large"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = validateImportData(JSON.parse(reader.result));
        commitImportedData(data);
      } catch (e) {
        UI.toast(`Import failed: ${e.message || "invalid backup"}`);
        return;
      }
      // The durable replacement succeeded. Rendering is deliberately handled
      // separately so a theme/chart failure cannot claim the data was rejected.
      try {
        applyTheme();
        syncSettingsForm();
        refreshAll();
        UI.toast("Imported");
      } catch (e) {
        UI.toast("Imported, but the screen could not refresh. Reload NutriDaily.");
      }
      Sync.fullSync(false).catch(() => {});
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
    if (UI.$("#btn-gap-intro-ok")) {
      UI.$("#btn-gap-intro-ok").addEventListener("click", () => {
        markGapIntroSeen();
        showGapSheetStep("select");
      });
    }
    if (UI.$("#btn-gap-intro-cancel")) {
      UI.$("#btn-gap-intro-cancel").addEventListener("click", () => UI.closeSheet("sheet-gap"));
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
    const gapBuckets = UI.$(".gap-select-buckets");
    if (gapBuckets) {
      gapBuckets.addEventListener("click", (e) => {
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
      const nextSettings = cloneLocalData(state.settings);
      nextSettings.theme = btn.dataset.themeOpt;
      try { commitSettingsCandidate(nextSettings); }
      catch (error) {
        syncSettingsForm();
        UI.toast("Couldn’t save theme — nothing changed");
        return;
      }
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
        const nextSettings = cloneLocalData(state.settings);
        nextSettings.imperial = UI.$("#set-imperial").checked;
        try { commitSettingsCandidate(nextSettings); }
        catch (error) {
          syncSettingsForm();
          UI.toast("Couldn’t save unit preference — nothing changed");
          return;
        }
        UI.toast(state.settings.imperial ? "Food ounces on" : "Food grams only");
      });
    }
    if (UI.$("#weight-unit-seg")) {
      UI.$("#weight-unit-seg").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-weight-unit]");
        if (!btn) return;
        const nextSettings = cloneLocalData(state.settings);
        nextSettings.weightUnit = btn.dataset.weightUnit === "kg" ? "kg" : "lb";
        try { commitSettingsCandidate(nextSettings); }
        catch (error) {
          syncSettingsForm();
          UI.toast("Couldn’t save weight units — nothing changed");
          return;
        }
        syncSettingsForm();
        syncWeightField();
        refreshInsights();
        UI.toast(state.settings.weightUnit === "kg" ? "Body weight in kg" : "Body weight in lb");
      });
    }
    UI.$("#btn-save-settings").addEventListener("click", () => {
      const today = Ledger.todayKey();
      const nextSettings = cloneLocalData(state.settings);
      Phases.ensureMigrated(nextSettings, Phases.earliestDayFromEvents(Ledger.allEvents()), today);
      const readGoal = (sel, fallback, min, max) => {
        const el = UI.$(sel);
        const raw = el ? String(el.value || "").trim() : "";
        if (!raw) return fallback;
        const n = parseAmount(raw);
        return Number.isFinite(n) && n >= (min || 0) && (max == null || n <= max) ? n : null;
      };
      const current = Phases.goalsForDay(today, nextSettings);
      const nextGoals = {
        kcal: readGoal("#set-kcal", current.kcal ?? DEFAULT_GOALS.kcal, ...PhasePrompt.BOUNDS.kcal),
        protein: readGoal("#set-protein", current.protein ?? 0, ...PhasePrompt.BOUNDS.protein),
        carbs: readGoal("#set-carbs", current.carbs ?? 0, ...PhasePrompt.BOUNDS.carbs),
        fat: readGoal("#set-fat", current.fat ?? 0, ...PhasePrompt.BOUNDS.fat),
        fiber: readGoal("#set-fiber", current.fiber ?? 0, ...PhasePrompt.BOUNDS.fiber),
        sodium: readGoal("#set-sodium", current.sodium ?? 0, ...PhasePrompt.BOUNDS.sodium),
        potassium: readGoal("#set-potassium", current.potassium ?? DEFAULT_GOALS.potassium, ...PhasePrompt.BOUNDS.potassium),
      };
      if (Object.values(nextGoals).some((n) => n == null)) {
        UI.toast("Targets are outside the supported ranges");
        return;
      }
      const goalError = persistentGoalError(nextGoals);
      if (goalError) {
        UI.toast(goalError);
        return;
      }
      const effectiveDay = Ledger.hasEverAdded(today) ? Analytics.addDays(today, 1) : today;
      const forceMajor = !!(UI.$("#set-phase-major") && UI.$("#set-phase-major").checked);
      const result = Phases.appendRevision(nextSettings, nextGoals, effectiveDay, "", {
        kind: selectedPhaseKind(),
        magnitude: forceMajor ? "major" : undefined,
      });
      try { commitSettingsCandidate(nextSettings); }
      catch (error) { UI.toast("Couldn’t save phase targets — nothing changed"); return; }
      Sync.schedulePush();
      refreshAll();
      syncSettingsForm();
      if (!result) UI.toast("No changes");
      else if (result.changed) UI.toast(`Saved ${result.label}${effectiveDay !== today ? " · effective tomorrow" : ""}`);
      else UI.toast(`Updated to ${result.label}${effectiveDay !== today ? " · effective tomorrow" : ""}`);
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
        const today = Ledger.todayKey();
        const phase = Phases.phaseForDay(state.settings.phases, today) || Phases.activePhase(state.settings.phases);
        if (!phase) return;
        const events = Ledger.allEvents();
        const eligibility = Phases.revisionDeletionStatus(state.settings, phase.id, btn.dataset.revId, events);
        if (!eligibility.ok) {
          UI.toast(eligibility.reason === "governed"
            ? "This version governs logged history and can’t be deleted"
            : eligibility.reason === "last" ? "Keep at least one version" : "Could not delete");
          renderPhaseRevisionList();
          return;
        }
        if (!confirm("Delete this unused target version?")) return;
        const nextSettings = cloneLocalData(state.settings);
        const res = Phases.deleteRevision(nextSettings, phase.id, btn.dataset.revId, Ledger.todayKey(), events);
        if (!res.ok) {
          UI.toast(res.reason === "governed"
            ? "This version governs logged history and can’t be deleted"
            : res.reason === "last" ? "Keep at least one version" : "Could not delete");
          return;
        }
        try { commitSettingsCandidate(nextSettings); }
        catch (error) { UI.toast("Couldn’t delete this version — nothing changed"); return; }
        Sync.schedulePush();
        refreshAll();
        syncSettingsForm();
        renderPhaseRevisionList();
        UI.toast("Version deleted");
      });
    }

    UI.$("#btn-start-phase").addEventListener("click", () => {
      const g = Phases.goalsForDay(Ledger.todayKey(), state.settings);
      const phase = Phases.phaseForDay(state.settings.phases, Ledger.todayKey()) ||
        Phases.activePhase(state.settings.phases);
      const currentKind = phase ? Phases.kindForDay(phase, Ledger.todayKey()) : "maintain";
      setKindSeg("#np-kind-seg", currentKind === "cut" ? "bulk" : currentKind === "bulk" ? "cut" : "bulk", "np");
      UI.$("#np-copy").checked = true;
      UI.$("#np-kcal").value = g.kcal;
      UI.$("#np-protein").value = g.protein;
      UI.$("#np-carbs").value = g.carbs;
      UI.$("#np-fat").value = g.fat;
      UI.$("#np-fiber").value = g.fiber;
      UI.$("#np-sodium").value = g.sodium;
      UI.$("#np-potassium").value = g.potassium;
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
      const startDay = Ledger.hasEverAdded(today) ? Analytics.addDays(today, 1) : today;
      const nextSettings = cloneLocalData(state.settings);
      Phases.ensureMigrated(nextSettings, Phases.earliestDayFromEvents(Ledger.allEvents()), today);
      const goals = copy ? null : {
        kcal: parseAmount(UI.$("#np-kcal").value),
        protein: parseAmount(UI.$("#np-protein").value),
        carbs: parseAmount(UI.$("#np-carbs").value),
        fat: parseAmount(UI.$("#np-fat").value),
        fiber: parseAmount(UI.$("#np-fiber").value),
        sodium: parseAmount(UI.$("#np-sodium").value),
        potassium: parseAmount(UI.$("#np-potassium").value),
      };
      const previousPhase = Phases.phaseForDay(nextSettings.phases, startDay) ||
        Phases.activePhase(nextSettings.phases);
      const copiedGoals = previousPhase
        ? ((Phases.revisionForDay(previousPhase, startDay) || {}).goals || nextSettings.goals)
        : nextSettings.goals;
      const goalError = persistentGoalError(goals || copiedGoals);
      if (goalError) {
        UI.toast(goalError);
        return;
      }
      const started = Phases.startPhase(nextSettings, {
        kind: selectedNewPhaseKind(),
        goals,
        startDay,
        copyGoals: copy,
      });
      try { commitSettingsCandidate(nextSettings); }
      catch (error) { UI.toast("Couldn’t start this phase — nothing changed"); return; }
      Sync.schedulePush();
      UI.closeSheet("sheet-new-phase");
      refreshAll();
      syncSettingsForm();
      UI.toast(`Started ${started.name}${startDay !== today ? " · effective tomorrow" : ""}`);
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
        const ready = refreshAiCopyGate();
        if (ready && ready.under18) {
          UI.toast(ready.message || "Under-18 targets require a pediatric clinician or dietitian");
          renderAiPhaseOptions(null);
          return;
        }
        const raw = (UI.$("#ai-phase-paste") && UI.$("#ai-phase-paste").value) || "";
        const currentGoals = {};
        for (const [key, sel] of [
          ["fiber", "#set-fiber"], ["sodium", "#set-sodium"], ["potassium", "#set-potassium"],
        ]) {
          const el = UI.$(sel);
          const value = el && el.value !== "" ? Number(el.value) : NaN;
          if (Number.isFinite(value) && value >= 0) currentGoals[key] = value;
        }
        const parsed = PhasePrompt.parsePhaseBlock(raw, currentGoals);
        if (!parsed.ok) {
          UI.toast(parsed.error || "Could not parse");
          renderAiPhaseOptions(null);
          return;
        }
        renderAiPhaseOptions(parsed);
        if (parsed.warnings && parsed.warnings.length) {
          UI.toast(`${parsed.options.length} options · ${parsed.warnings[0]}`);
        } else {
          UI.toast(`${parsed.options.length} options ready`);
        }
      });
    }
    if (UI.$("#ai-phase-options")) {
      UI.$("#ai-phase-options").addEventListener("click", (e) => {
        const btn = e.target.closest(".ai-apply-opt");
        if (!btn) return;
        const ready = refreshAiCopyGate();
        if (ready && !ready.canApply) {
          UI.toast(ready.message || "Profile review is required before applying automated targets");
          return;
        }
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
        if (UI.$("#set-potassium") && g.potassium != null) UI.$("#set-potassium").value = g.potassium;
        // Only flip kind when the paste actually included Kind: (null means leave user's selection).
        if (parsed.kind) setKindSeg("#phase-kind-seg", parsed.kind, "phase");
        UI.closeSheet("sheet-phase-targets");
        UI.toast(`Applied ${opt.label}. Tap Save phase to keep it.`);
      });
    }

    UI.$("#btn-weight-save").addEventListener("click", onWeightActionClick);
    UI.$("#day-weight").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.target.readOnly) return;
        saveWeightFromField();
      }
    });

    UI.$("#foods-search").addEventListener("input", refreshFoods);
    UI.$("#pick-search").addEventListener("input", (e) => {
      UI.renderPicker(state.personalFoods, e.target.value, true, {
        yesterday: Ledger.entriesFor(state.yesterdayKey || yesterdayKey()),
        yesterdayLabel: isToday() ? "Yesterday" : "Previous day",
      });
    });
    UI.$("#day-label").addEventListener("click", jumpToToday);
    const guardDayIntent = (intent) => {
      const win = Phases.dayIntentWindow(state.viewDay, {
        todayKey: Ledger.todayKey(),
        intent: intent === "fast" ? "fast" : "reduced",
        hasEverAdded: (day) => Ledger.hasEverAdded(day),
      });
      if (win.ok) return win;
      return win;
    };
    const toastIfBlocked = (intent) => {
      const win = guardDayIntent(intent);
      if (win.ok) return true;
      UI.closeSheet("sheet-day-goals");
      refreshDayGoalsLink();
      UI.toast(win.reason || "This day plan cannot be changed right now.");
      return false;
    };
    const canAuthorAnyIntent = () =>
      guardDayIntent("reduced").ok || guardDayIntent("fast").ok;
    const escHtml = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    // Round to the nearest 10 (Analytics.retargetForKcal's own precision) and
    // clamp at the ceiling: 6004 already rounds down to 6000, but 6005 sits
    // exactly on the tie and Math.round breaks ties up, landing on 6010 and
    // getting rejected as over budget when it was, at most, a rounding
    // artifact away from the max — the one boundary a symmetric value on the
    // low side does not hit, since a typed 195 rounds up into the 200 floor
    // instead of being rejected for landing on the wrong side of its own tie.
    // Shared by the preview and the save handler so neither can disagree with
    // the other about what a typed value becomes.
    const roundPlannedKcal = (typed) => {
      if (!Number.isFinite(typed)) return typed;
      let rounded = Math.round(typed / 10) * 10;
      if (rounded > 6000 && typed <= 6005) rounded = 6000;
      return rounded;
    };
    const selectedDayIntent = () => {
      const on = UI.$("#dg-intent-seg button.on");
      const v = on && on.dataset.dgIntent;
      return v === "fast" || v === "reduced" || v === "normal" ? v : "normal";
    };
    const setDayIntentSeg = (intent) => {
      const want = intent === "fast" || intent === "reduced" || intent === "normal" ? intent : "normal";
      UI.$$("#dg-intent-seg button").forEach((b) => {
        const on = b.dataset.dgIntent === want;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
      const showReduced = want === "reduced";
      const showFast = want === "fast";
      const showNormal = want === "normal";
      const panelN = UI.$("#dg-panel-normal");
      const panelR = UI.$("#dg-panel-reduced");
      const panelF = UI.$("#dg-panel-fast");
      if (panelN) panelN.hidden = !showNormal;
      if (panelR) panelR.hidden = !showReduced;
      if (panelF) panelF.hidden = !showFast;
      if (showFast) {
        const copy = UI.$("#dg-fast-copy");
        if (copy) copy.textContent = Phases.FAST_DECLARATION_COPY;
      }
      if (showReduced) refreshDayPlanPreview();
      // Presets sit outside the intent panels so Reduced and Fast both see them.
      refreshPresetChips();
    };
    const refreshPlanDisclosure = () => {
      const el = UI.$("#dg-plan-disclosure");
      if (!el) return;
      const phaseBase = Phases.goalsForDay(state.viewDay, { ...state.settings, dayGoals: {} });
      const raw = UI.$("#dg-kcal").value.trim();
      const target = roundPlannedKcal(raw === "" ? null : parseAmount(raw));
      if (!Number.isFinite(target) || target < 200 || target > 6000) {
        el.textContent = "";
        return;
      }
      const lines = [];
      if (!Phases.proteinScorableOnPlan(target, phaseBase.protein)) {
        const share = Math.round((4 * Number(phaseBase.protein) / target) * 100);
        lines.push(
          `At ${target} kcal your ${Math.round(phaseBase.protein)} g protein floor would need ${share}% of the day, so protein won't be scored. The target itself doesn't change.`
        );
      }
      const retarget = typeof Analytics !== "undefined" && typeof Analytics.retargetForKcal === "function"
        ? Analytics.retargetForKcal(phaseBase, target)
        : null;
      if (!retarget) {
        lines.push("Carbs and fat aren't scored at this energy.");
      }
      el.textContent = lines.join(" ");
    };
    const refreshDayPlanPreview = () => {
      const phaseBase = Phases.goalsForDay(state.viewDay, { ...state.settings, dayGoals: {} });
      const raw = UI.$("#dg-kcal").value.trim();
      const typed = raw === "" ? null : parseAmount(raw);
      const target = roundPlannedKcal(typed);
      const prev = UI.$("#energy-adjustment-preview");
      const input = UI.$("#dg-kcal");
      if (prev) {
        if (raw === "") {
          input.removeAttribute("aria-invalid");
          prev.textContent = `Phase calorie target: ${phaseBase.kcal} kcal.`;
        } else if (!Number.isFinite(target) || target < 200 || target > 6000) {
          input.setAttribute("aria-invalid", "true");
          prev.textContent = "Target must be 200–6000 kcal.";
        } else {
          input.removeAttribute("aria-invalid");
          const delta = target - phaseBase.kcal;
          const caution = target < 1200
            ? " Very-low-calorie targets require clinician supervision."
            : "";
          prev.textContent = `Planned target: ${target} kcal (current phase ${phaseBase.kcal}${delta ? ` ${delta > 0 ? "+" : "−"}${Math.abs(delta)}` : ""}).${caution}`;
        }
      }
      refreshPlanDisclosure();
    };
    const activePresets = () => Sync.activeDayPlanPresets(state.settings.dayPlanPresets || []);
    const refreshPresetChips = () => {
      const root = UI.$("#dg-presets");
      const chips = UI.$("#dg-preset-chips");
      if (!root || !chips) return;
      const intent = selectedDayIntent();
      const list = activePresets().slice().sort((a, b) =>
        (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0) ||
        String(a.label).localeCompare(String(b.label))
      );
      // Hide on Normal (clear-only); show on Reduced/Fast even when empty so
      // "Save as preset" stays reachable for Fast.
      root.hidden = intent === "normal";
      const newest = list[0];
      chips.innerHTML = list.map((p) => {
        const label = escHtml(p.label || (p.intent === "fast" ? "Fast" : `${Math.round(p.targetKcal)} kcal`));
        const def = newest && newest.id === p.id ? " is-default" : "";
        // Two sibling buttons inside a non-interactive chip shell — nested
        // <button> markup is invalid and made delete mouse-only.
        return `<span class="uchip${def}">` +
          `<button type="button" class="uchip-apply" data-preset-id="${escHtml(p.id)}">${label}</button>` +
          `<button type="button" class="uchip-x" data-preset-delete="${escHtml(p.id)}" aria-label="Remove preset ${label}" title="Remove">×</button>` +
          `</span>`;
      }).join("");
      const hint = UI.$("#dg-preset-hint");
      if (hint) hint.hidden = list.length === 0;
    };
    const applyPresetToSheet = (preset) => {
      if (!preset || preset.deleted) return;
      if (preset.intent === "fast") {
        setDayIntentSeg("fast");
        const ack = UI.$("#dg-fast-ack");
        if (ack) ack.checked = true;
        return;
      }
      setDayIntentSeg("reduced");
      UI.$("#dg-kcal").value = String(Math.round(preset.targetKcal));
      refreshDayPlanPreview();
    };
    const touchPresetUsed = (id) => {
      const now = Date.now();
      const next = cloneLocalData(state.settings);
      // lastUsedAt is usage telemetry only — never bump updatedAt, or an
      // apply on one device would LWW-defeat a delete/edit on another.
      next.dayPlanPresets = (next.dayPlanPresets || []).map((p) =>
        p && p.id === id && !p.deleted ? { ...p, lastUsedAt: now } : p
      );
      next.dayPlanPresets = Sync.normalizeDayPlanPresets(next.dayPlanPresets);
      try {
        commitSettingsCandidate(next);
        Sync.schedulePush();
      } catch (_) { /* non-fatal for apply chip */ }
    };
    const deletePreset = (id) => {
      if (!id) return;
      const preset = activePresets().find((p) => p.id === id);
      const label = (preset && preset.label) || "this preset";
      if (!confirm(`Remove preset “${label}”?`)) return;
      const now = Date.now();
      const next = cloneLocalData(state.settings);
      const list = Sync.normalizeDayPlanPresets(next.dayPlanPresets || []);
      const found = list.some((p) => p.id === id);
      next.dayPlanPresets = found
        ? list.map((p) => p.id === id
          ? {
            id: p.id,
            deleted: true,
            updatedAt: Math.max(Number(p.updatedAt) || 0, now),
            createdAt: Number(p.createdAt) || now,
            ...(Object.prototype.hasOwnProperty.call(p, "resetEpoch")
              ? { resetEpoch: p.resetEpoch }
              : { resetEpoch: Sync.getResetAt() }),
          }
          : p)
        : list;
      try { commitSettingsCandidate(next); }
      catch (error) { UI.toast("Couldn’t remove this preset — nothing changed"); return; }
      Sync.schedulePush();
      refreshPresetChips();
      UI.toast("Preset removed");
    };
    const openDayGoalsSheet = () => {
      const g = Phases.goalsForDay(state.viewDay, state.settings);
      const bumps = g && g._dayPlan;
      const isFast = !!(bumps && bumps.intent === "fast");
      const hasReduced = !!(bumps && Number.isFinite(Number(bumps.kcal)) && Number(bumps.kcal) !== 0);
      // An existing plan reopens only while its own intent window is open.
      // An empty day can author either intent.
      if (isFast) {
        if (!toastIfBlocked("fast")) return;
      } else if (hasReduced) {
        if (!toastIfBlocked("reduced")) return;
      } else if (!canAuthorAnyIntent()) {
        const reason = guardDayIntent("reduced").reason || guardDayIntent("fast").reason ||
          "This day plan cannot be changed right now.";
        UI.toast(reason);
        refreshDayGoalsLink();
        return;
      }
      const phase = Phases.phaseForDay(state.settings.phases, state.viewDay);
      const phaseBit = phase ? ` (${Phases.labelForDay(phase, state.viewDay)})` : "";
      const phaseBase = g._phase || g;
      const titleEl = UI.$("#day-goals-title");
      if (titleEl) {
        const today = Ledger.todayKey();
        const yday = (() => {
          const d = new Date(today + "T12:00:00");
          d.setDate(d.getDate() - 1);
          return Ledger.todayKey(d);
        })();
        titleEl.textContent = state.viewDay === today
          ? "Today's plan"
          : state.viewDay === dayAfter(today)
            ? "Tomorrow's plan"
            : state.viewDay === yday
              ? "Yesterday's plan"
              : `Plan for ${state.viewDay}`;
      }
      UI.$("#day-goals-blurb").textContent =
        `Phase${phaseBit}: ${phaseBase.kcal} kcal. Plans freeze before the first food on a reduced day. Declaring a fast is a separate control.`;
      const ack = UI.$("#dg-fast-ack");
      if (ack) ack.checked = false;
      if (isFast) {
        setDayIntentSeg("fast");
        if (ack) ack.checked = true;
        UI.$("#dg-kcal").value = "";
      } else if (hasReduced) {
        setDayIntentSeg("reduced");
        UI.$("#dg-kcal").value = String(Math.round(g.kcal));
      } else {
        // Empty day: land on Reduced so the calorie field is ready. Normal is
        // still one tap away when the user only wants to clear.
        setDayIntentSeg(guardDayIntent("reduced").ok ? "reduced" : (guardDayIntent("fast").ok ? "fast" : "normal"));
        UI.$("#dg-kcal").value = "";
      }
      refreshDayPlanPreview();
      refreshPresetChips();
      UI.openSheet("sheet-day-goals");
    };
    UI.$("#btn-day-goals").addEventListener("click", openDayGoalsSheet);
    if (UI.$("#dg-intent-seg")) {
      UI.$("#dg-intent-seg").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-dg-intent]");
        if (!btn) return;
        const intent = btn.dataset.dgIntent;
        const g = Phases.goalsForDay(state.viewDay, state.settings);
        const bumps = g && g._dayPlan;
        const isFast = !!(bumps && bumps.intent === "fast");
        const hasReduced = !!(bumps && Number.isFinite(Number(bumps.kcal)) && Number(bumps.kcal) !== 0);
        if (intent === "reduced" && !guardDayIntent("reduced").ok) {
          UI.toast(guardDayIntent("reduced").reason || "Reduced plans are locked for this day.");
          return;
        }
        if (intent === "fast" && !guardDayIntent("fast").ok) {
          UI.toast(guardDayIntent("fast").reason || "A fast cannot be declared for this day.");
          return;
        }
        // Normal clears the plan — follow the same ladder as #dg-clear so a
        // locked Reduced day cannot switch to Normal just because Fast grace
        // is still open.
        if (intent === "normal") {
          if (isFast && !guardDayIntent("fast").ok) {
            UI.toast(guardDayIntent("fast").reason || "This fast cannot be cleared right now.");
            return;
          }
          if (hasReduced && !guardDayIntent("reduced").ok) {
            UI.toast(guardDayIntent("reduced").reason || "This plan cannot be cleared right now.");
            return;
          }
        }
        setDayIntentSeg(intent);
      });
    }
    UI.$("#dg-kcal").addEventListener("input", refreshDayPlanPreview);
    if (UI.$("#dg-preset-chips")) {
      UI.$("#dg-preset-chips").addEventListener("click", (e) => {
        const del = e.target.closest("[data-preset-delete]");
        if (del) {
          e.preventDefault();
          e.stopPropagation();
          deletePreset(del.dataset.presetDelete);
          return;
        }
        const btn = e.target.closest("[data-preset-id]");
        if (!btn) return;
        const preset = activePresets().find((p) => p.id === btn.dataset.presetId);
        if (!preset) return;
        applyPresetToSheet(preset);
        touchPresetUsed(preset.id);
      });
    }
    if (UI.$("#dg-preset-save")) {
      UI.$("#dg-preset-save").addEventListener("click", () => {
        const intent = selectedDayIntent();
        if (intent !== "reduced" && intent !== "fast") {
          UI.toast("Choose Reduced or Fast before saving a preset");
          return;
        }
        const phaseBase = Phases.goalsForDay(state.viewDay, { ...state.settings, dayGoals: {} });
        let targetKcal = Phases.FAST_KCAL;
        if (intent === "reduced") {
          const raw = UI.$("#dg-kcal").value.trim();
          targetKcal = roundPlannedKcal(raw === "" ? null : parseAmount(raw));
          if (!Number.isFinite(targetKcal) || targetKcal < 200 || targetKcal > 6000) {
            UI.toast("Target must be 200–6000 kcal");
            return;
          }
          if (targetKcal === phaseBase.kcal) {
            UI.toast("That is already the phase target — nothing to save as a preset");
            return;
          }
          if (targetKcal < 1200 &&
              !confirm("Very-low-calorie targets require clinician supervision. Save this preset anyway?")) return;
        } else {
          const ack = UI.$("#dg-fast-ack");
          if (!(ack && ack.checked)) {
            UI.toast("Confirm the fast acknowledgement before saving a Fast preset");
            return;
          }
        }
        const active = activePresets();
        const cap = Sync.DAY_PLAN_PRESET_ACTIVE_CAP || 5;
        if (active.length >= cap) {
          UI.toast(`Preset limit is ${cap}. Remove one before saving another.`);
          return;
        }
        const now = Date.now();
        const label = intent === "fast" ? "Fast" : `${Math.round(targetKcal)} kcal`;
        const preset = Sync.normalizeDayPlanPreset({
          id: `dpp_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          label,
          intent,
          targetKcal,
          fastAcknowledged: intent === "fast",
          veryLowCalorieAcknowledged: intent === "reduced" && targetKcal < 1200,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
          resetEpoch: Sync.getResetAt(),
        });
        if (!preset) { UI.toast("Couldn’t save this preset"); return; }
        const nextSettings = cloneLocalData(state.settings);
        nextSettings.dayPlanPresets = Sync.normalizeDayPlanPresets([
          ...(nextSettings.dayPlanPresets || []),
          preset,
        ]);
        try { commitSettingsCandidate(nextSettings); }
        catch (error) { UI.toast("Couldn’t save this preset — nothing changed"); return; }
        Sync.schedulePush();
        refreshPresetChips();
        UI.toast("Preset saved");
      });
    }
    UI.$("#dg-save").addEventListener("click", () => {
      const intent = selectedDayIntent();
      const phaseBase = Phases.goalsForDay(state.viewDay, { ...state.settings, dayGoals: {} });
      const nextSettings = cloneLocalData(state.settings);
      if (!nextSettings.dayGoals || typeof nextSettings.dayGoals !== "object") nextSettings.dayGoals = {};
      const now = Date.now();
      const bumps = Phases.goalsForDay(state.viewDay, state.settings)._dayPlan;
      const isFastPlan = !!(bumps && bumps.intent === "fast");
      const hasReducedPlan = !!(bumps && Number.isFinite(Number(bumps.kcal)) && Number(bumps.kcal) !== 0);

      if (intent === "normal") {
        // Same clear ladder as #dg-clear — Fast grace must not unlock a
        // locked Reduced plan (P2-1).
        if (isFastPlan) {
          if (!toastIfBlocked("fast")) return;
        } else if (hasReducedPlan) {
          if (!toastIfBlocked("reduced")) return;
        } else if (!canAuthorAnyIntent()) {
          toastIfBlocked("reduced");
          return;
        } else if (!isFastPlan && !hasReducedPlan) {
          // No plan on the day: nothing to clear — skip the LWW tombstone.
          UI.closeSheet("sheet-day-goals");
          return;
        }
        nextSettings.dayGoals[state.viewDay] = { cleared: true, updatedAt: now };
        try { commitSettingsCandidate(nextSettings); }
        catch (error) { UI.toast("Couldn’t clear this plan — nothing changed"); return; }
        Sync.schedulePush();
        UI.closeSheet("sheet-day-goals");
        refreshDay();
        UI.toast("Day plan cleared");
        return;
      }

      if (intent === "fast") {
        if (!toastIfBlocked("fast")) return;
        const ack = UI.$("#dg-fast-ack");
        if (!(ack && ack.checked)) {
          UI.toast("Confirm the fast acknowledgement to save");
          return;
        }
        const win = guardDayIntent("fast");
        nextSettings.dayGoals[state.viewDay] = {
          targetKcal: Phases.FAST_KCAL,
          baseKcal: phaseBase.kcal,
          plannedAt: now,
          updatedAt: now,
          intent: "fast",
          fastAcknowledged: true,
          ...(win.declaredAfterDay ? { declaredAfterDay: true } : {}),
        };
        try { commitSettingsCandidate(nextSettings); }
        catch (error) { UI.toast("Couldn’t save this plan — nothing changed"); return; }
        Sync.schedulePush();
        UI.closeSheet("sheet-day-goals");
        refreshDay();
        UI.toast("Fast declared");
        return;
      }

      // reduced
      if (!toastIfBlocked("reduced")) return;
      const raw = UI.$("#dg-kcal").value.trim();
      const typedKcal = raw === "" ? null : parseAmount(raw);
      const targetKcal = roundPlannedKcal(typedKcal);
      if (raw !== "" && (!Number.isFinite(targetKcal) || targetKcal < 200 || targetKcal > 6000)) {
        UI.toast("Target must be 200–6000 kcal");
        return;
      }
      if (targetKcal != null && targetKcal < 1200 &&
          !confirm("Very-low-calorie targets require clinician supervision. Save this target anyway?")) return;
      if (targetKcal != null && targetKcal !== phaseBase.kcal) {
        nextSettings.dayGoals[state.viewDay] = {
          targetKcal,
          baseKcal: phaseBase.kcal,
          plannedAt: now,
          updatedAt: now,
          intent: "reduced",
          veryLowCalorieAcknowledged: targetKcal < 1200,
        };
      } else {
        nextSettings.dayGoals[state.viewDay] = { cleared: true, updatedAt: now };
      }
      try { commitSettingsCandidate(nextSettings); }
      catch (error) { UI.toast("Couldn’t save this adjustment — nothing changed"); return; }
      Sync.schedulePush();
      UI.closeSheet("sheet-day-goals");
      refreshDay();
      UI.toast(targetKcal != null && targetKcal !== phaseBase.kcal ? "Planned calories saved" : "Day plan cleared");
    });
    UI.$("#dg-clear").addEventListener("click", () => {
      const g = Phases.goalsForDay(state.viewDay, state.settings);
      const bumps = g && g._dayPlan;
      const isFast = !!(bumps && bumps.intent === "fast");
      const hasReduced = !!(bumps && Number.isFinite(Number(bumps.kcal)) && Number(bumps.kcal) !== 0);
      // Clearing follows the plan on the day: a locked Reduced plan cannot be
      // cleared just because the Fast grace window is still open.
      if (isFast) {
        if (!toastIfBlocked("fast")) return;
      } else if (hasReduced) {
        if (!toastIfBlocked("reduced")) return;
      } else if (!canAuthorAnyIntent()) {
        toastIfBlocked("reduced");
        return;
      }
      const nextSettings = cloneLocalData(state.settings);
      if (!nextSettings.dayGoals || typeof nextSettings.dayGoals !== "object") nextSettings.dayGoals = {};
      nextSettings.dayGoals[state.viewDay] = { cleared: true, updatedAt: Date.now() };
      try { commitSettingsCandidate(nextSettings); }
      catch (error) { UI.toast("Couldn’t clear this plan — nothing changed"); return; }
      Sync.schedulePush();
      UI.closeSheet("sheet-day-goals");
      refreshDay();
      UI.toast("Day plan cleared");
    });
    if (UI.$("#btn-hud-fasting-log")) {
      UI.$("#btn-hud-fasting-log").addEventListener("click", () => {
        const fab = UI.$("#fab-add");
        if (fab) fab.click();
      });
    }

    UI.$("#btn-quick-kcal").addEventListener("click", () => openQuickKcal());
    UI.$("#btn-once-food").addEventListener("click", () => openOnceSheet());
    UI.$("#once-cancel").addEventListener("click", () => {
      resetQtyState();
      UI.closeSheet("sheet-once");
    });
    UI.$("#once-macros").addEventListener("toggle", () => UI.syncOnceMacroNudge());
    const onceChip = (rootSel, attr) => (e) => {
      const btn = e.target.closest(`[${attr}]`);
      if (!btn) return;
      UI.$(rootSel).querySelectorAll(".uchip").forEach((c) => {
        const on = c === btn; c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on));
      });
    };
    UI.$("#once-meals").addEventListener("click", onceChip("#once-meals", "data-meal"));
    UI.$("#once-units").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-unit]");
      if (!btn) return;
      onceChip("#once-units", "data-unit")(e);
      const qty = UI.$("#once-qty");
      if (qty && btn.dataset.unit === "portion" && !String(qty.value || "").trim()) qty.value = "1";
    });
    UI.$("#once-cats").addEventListener("click", onceChip("#once-cats", "data-cat"));
    UI.$("#once-confidence").addEventListener("click", onceChip("#once-confidence", "data-confidence"));
    UI.$("#once-save").addEventListener("click", () => saveOnce());
    UI.$("#once-remove").addEventListener("click", () => {
      if (!state.editEntryId) return;
      const id = state.editEntryId;
      const day = editDay();
      UI.closeSheet("sheet-once");
      resetQtyState();
      removeEntryWithUndo(day, id);
    });

    UI.$("#kcal-cancel").addEventListener("click", () => {
      resetQtyState();
      UI.closeSheet("sheet-kcal");
    });
    UI.$("#kcal-meals").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-meal]");
      if (!btn) return;
      UI.$("#kcal-meals").querySelectorAll(".uchip").forEach((c) => {
        const on = c === btn; c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on));
      });
    });
    UI.$("#kcal-save").addEventListener("click", () => {
      const name = UI.$("#kcal-name").value.trim() || "Quick kcal";
      const kcal = parseAmount(UI.$("#kcal-amount").value);
      if (!Number.isFinite(kcal) || kcal <= 0) { UI.toast("Enter calories"); return; }
      if (!producerText(name, PRODUCER_LIMITS.text.name) || kcal > PRODUCER_LIMITS.amount) {
        UI.toast("Name or calories exceed the supported storage limits");
        return;
      }
      const meal = UI.selectedMealIn("#kcal-meals");
      const payload = {
        name,
        displayQty: `${Math.round(kcal)} kcal`,
        grams: 0,
        // Calories-only estimates do not tell us anything about electrolytes.
        // Unknown must stay null so this entry lowers Na/K coverage instead of
        // claiming a measured zero-sodium, zero-potassium food.
        macros: { kcal: Math.round(kcal), p: 0, c: 0, f: 0, fb: 0, na: null, k: null },
        sd: 0.25,
        meal,
        source: "quick",
        cat: "snack",
        foodId: null,
        qty: kcal,
        unit: "kcal",
      };
      const producerError = validateProducerEntry(payload);
      if (producerError) { UI.toast(producerError); return; }
      const day = editDay();
      try {
        if (state.editEntryId) {
          Ledger.amendEntry(day, state.editEntryId, payload, "quick kcal edited");
        } else {
          Ledger.addEntry(day, payload);
        }
      } catch (error) {
        UI.toast("Couldn’t save this log — nothing changed");
        return;
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
      UI.$("#qty-units").querySelectorAll(".uchip").forEach((c) => {
        const on = c === btn; c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on));
      });
      if (state.pickFood && next !== prev) {
        UI.$("#qty-input").value = defaultQtyForUnit(state.pickFood, next);
        UI.$("#qty-input").select();
      }
      if (state.pickFood) UI.updateQtyPreview(state.pickFood);
    });
    UI.$("#qty-meals").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-meal]");
      if (!btn) return;
      UI.$("#qty-meals").querySelectorAll(".uchip").forEach((c) => {
        const on = c === btn; c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on));
      });
    });
    UI.$("#qty-save").addEventListener("click", saveQty);
    UI.$("#qty-cancel").addEventListener("click", cancelQty);
    UI.$("#qty-edit-food").addEventListener("click", () => {
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
      openEditFood(state.pickFood);
    });
    const qtyRefine = UI.$("#qty-refine-food");
    if (qtyRefine) {
      qtyRefine.addEventListener("click", () => {
        state.gapPendingItemId = null;
        state.gapPendingDay = null;
        openRefineFood(state.pickFood);
      });
    }
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
        revLogAs.querySelectorAll(".uchip").forEach((c) => {
          const on = c === btn; c.classList.toggle("active", on); c.setAttribute("aria-pressed", String(on));
        });
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
    if (UI.$("#btn-rev-copy-refine")) {
      UI.$("#btn-rev-copy-refine").addEventListener("click", () => {
        const text = reviewRefinePromptText();
        if (!text) { UI.toast("Save this food first"); return; }
        navigator.clipboard.writeText(text)
          .then(() => UI.toast("Refine prompt copied"))
          .catch(() => window.prompt("Select all and copy (Cmd/Ctrl+C):", text));
      });
    }
    if (UI.$("#btn-rev-share-refine")) {
      UI.$("#btn-rev-share-refine").addEventListener("click", () => {
        const text = reviewRefinePromptText();
        if (text) sharePromptText(text, { okToast: "Refine prompt copied" });
      });
    }
    if (UI.$("#btn-rev-ai-clipboard")) {
      UI.$("#btn-rev-ai-clipboard").addEventListener("click", async () => {
        try {
          const t = await navigator.clipboard.readText();
          UI.$("#rev-ai-paste").value = t;
        } catch (e) {
          UI.$("#rev-ai-paste").focus();
          UI.toast("Long-press the box and choose Paste");
        }
      });
    }
    if (UI.$("#btn-rev-apply-ai")) {
      UI.$("#btn-rev-apply-ai").addEventListener("click", applyReviewRefinePaste);
    }
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
    ["#rev-name", "#rev-kcal", "#rev-p", "#rev-c", "#rev-f", "#rev-fb", "#rev-na", "#rev-k"].forEach((sel) => {
      UI.$(sel).addEventListener("input", validateReviewSave);
    });
    UI.$("#rev-cat-filter").addEventListener("input", (e) => UI.filterCategories(e.target.value));

    UI.$("#insight-range").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-days]");
      if (!btn) return;
      const next = btn.dataset.days === "phase" ? "phase" : Number(btn.dataset.days);
      state.insightDays = next;
      if (next !== "phase") state.insightPhaseId = null;
      UI.$("#insight-range").querySelectorAll("button").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
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
        // Keep the one-release top-foods alias in sync with the dock.
        state.insightTopFoodMetric = btn.dataset.nutrient;
        nutPills.querySelectorAll("button").forEach((b) => {
          const on = b === btn;
          b.classList.toggle("active", on);
          b.tabIndex = on ? 0 : -1;
        });
        refreshInsights();
      });
      // Roving tabindex: one tab stop; arrows move focus; Enter/Space activate (P6-T4).
      nutPills.addEventListener("keydown", (e) => {
        const buttons = [...nutPills.querySelectorAll("[data-nutrient]")];
        const current = e.target.closest("[data-nutrient]");
        const i = buttons.indexOf(current);
        if (i < 0) return;
        let next = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % buttons.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + buttons.length) % buttons.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = buttons.length - 1;
        else if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          buttons[i].click();
          return;
        } else return;
        e.preventDefault();
        buttons.forEach((b, j) => { b.tabIndex = j === next ? 0 : -1; });
        buttons[next].focus();
      });
    }
    const rollSeg = UI.$("#rollup-seg");
    if (rollSeg) {
      rollSeg.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rollup]");
        if (!btn) return;
        state.insightRollup = btn.dataset.rollup === "week" ? "week" : "day";
        refreshInsights();
      });
    }
    // Apply a TDEE-derived calorie target without retyping it into Settings.
    const tdeeCard = UI.$("#tdee-card");
    if (tdeeCard) {
      tdeeCard.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action='apply-tdee']");
        if (!btn) return;
        const kcal = Number(btn.dataset.kcal);
        if (!Number.isFinite(kcal) || kcal < Analytics.MIN_AUTOMATED_KCAL ||
            kcal > Analytics.MAX_AUTOMATED_KCAL) {
          UI.toast(`Automated targets must be ${Analytics.MIN_AUTOMATED_KCAL}–${Analytics.MAX_AUTOMATED_KCAL} kcal`);
          return;
        }
        const today = Ledger.todayKey();
        const effectiveDay = Ledger.hasEverAdded(today) ? Analytics.addDays(today, 1) : today;
        const current = Phases.goalsForDay(today, state.settings);
        // Protein holds (it tracks body weight, not energy); carbs and fat
        // absorb the change so the macros still add up to the calories.
        const next = Analytics.retargetForKcal(current, kcal);
        if (!next) {
          UI.toast(`That target cannot fit protected protein plus at least ${Analytics.MIN_RETARGET_FAT_G} g fat. Choose a higher target or revise protein deliberately.`);
          return;
        }
        const eligibility = Phases.automatedTargetEligibility(state.settings, { todayKey: today });
        if (!eligibility.canApply) {
          UI.toast(eligibility.message || "Review your profile before applying an automated target");
          return;
        }
        const ok = confirm(
          `Set targets to ${next.kcal} kcal from ${effectiveDay === today ? "today" : "tomorrow"}?\n\n` +
          `Protein stays ${next.protein} g. Carbs ${current.carbs} → ${next.carbs} g, fat ${current.fat} → ${next.fat} g.\n\n` +
          `This adds a new version to your active phase. Past days keep the targets they were scored against.`
        );
        if (!ok) return;
        const nextSettings = cloneLocalData(state.settings);
        const result = Phases.appendRevision(
          nextSettings, next, effectiveDay,
          `From energy estimate (${btn.dataset.label || "TDEE"})`
        );
        try { commitSettingsCandidate(nextSettings); }
        catch (error) {
          UI.toast("Couldn’t set targets — nothing changed");
          return;
        }
        Sync.schedulePush();
        refreshAll();
        syncSettingsForm();
        UI.toast(result && result.label
          ? `${result.label} · ${next.kcal} kcal${effectiveDay !== today ? " · effective tomorrow" : ""}`
          : `Targets set to ${next.kcal} kcal${effectiveDay !== today ? " tomorrow" : ""}`);
      });
    }
    for (const selector of ["#insight-heatmap", "#trend-data", "#weight-data"]) {
      const dayAccess = UI.$(selector);
      if (dayAccess) {
        dayAccess.addEventListener("click", (e) => {
          const cell = e.target.closest("[data-action='heatmap-day'], [data-action='insight-chart-day']");
          if (!cell) return;
          openDayContrib(state.insightNutrient || "kcal", {
            day: cell.dataset.day,
            root: "#day-detail",
            focus: cell.dataset.action === "insight-chart-day",
          });
        });
      }
    }
    const canvas = UI.$("#trend-canvas");
    if (canvas) {
      canvas.style.cursor = "pointer";
      canvas.addEventListener("click", (e) => {
        const day = UI.onTrendTap(e.clientX);
        if (day) {
          openDayContrib(state.insightNutrient || "kcal", { day, root: "#day-detail" });
        }
      });
    }
    const wCanvas = UI.$("#weight-canvas");
    if (wCanvas) {
      wCanvas.style.cursor = "pointer";
      wCanvas.addEventListener("click", (e) => {
        const hit = UI.onWeightTap(e.clientX);
        if (hit) {
          openDayContrib(state.insightNutrient || "kcal", { day: hit.day, root: "#day-detail" });
        }
      });
    }
    const hud = UI.$("#hud");
    if (hud) {
      const openFromHud = (el) => {
        const nut = el && el.dataset.hudNutrient;
        if (!nut) return;
        openDayContrib(nut, { root: "#today-day-detail" });
      };
      hud.addEventListener("click", (e) => {
        openFromHud(e.target.closest("[data-hud-nutrient]"));
      });
      hud.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const el = e.target.closest("[data-hud-nutrient]");
        if (!el) return;
        e.preventDefault();
        openFromHud(el);
      });
    }
    let resizeT = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => refreshInsights(), 150);
    });

    document.body.addEventListener("click", (e) => {
      const jump = e.target.closest("[data-jump]");
      if (jump && jump.closest("#insight-observations")) {
        const sel = jump.dataset.jump;
        const target = sel && UI.$(sel);
        if (target) {
          const reduceMotion = !!(window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches);
          target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
          const heading = target.querySelector(".card-head-row b, h3, b")
            || (target.closest(".insight-section") &&
                target.closest(".insight-section").querySelector(".section-head"))
            || target;
          if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
          try { heading.focus({ preventScroll: true }); } catch (err) {
            try { heading.focus(); } catch (_e) {}
          }
        }
        return;
      }

      const close = e.target.closest("[data-close]");
      if (close) {
        const sheetId = close.dataset.close;
        UI.closeSheet(sheetId);
        if (sheetId === "sheet-qty" || sheetId === "sheet-kcal" || sheetId === "sheet-once") {
          if (sheetId === "sheet-qty") {
            state.gapPendingItemId = null;
            state.gapPendingDay = null;
          }
          resetQtyState();
        }
        if (sheetId === "sheet-gap") {
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
      } else if (action === "repeat-yesterday") {
        const entry = Ledger.entriesFor(state.yesterdayKey || yesterdayKey()).find((x) => x.id === id);
        if (!entry) return;
        UI.closeSheet("sheet-add");
        openQtyFromEntry(entry);
      } else if (action === "goto-day") {
        state.viewDay = actionEl.dataset.day;
        switchView("today");
        refreshDay();
      } else if (action === "close-day-contrib") {
        state.dayContribMetric = null;
        UI.renderDayDetail(null, { root: "#today-day-detail" });
      } else if (action === "scale-batch") {
        const food = findFood(id);
        if (!food) return;
        const curG = (food.batch && food.batch.grams) || (food.units && food.units.serving) || 500;
        const curS = (food.batch && food.batch.servings) || 1;
        const gStr = prompt("Batch weight in grams", String(curG));
        if (gStr == null) return;
        const grams = Number(gStr);
        if (!producerNumber(grams, { min: 0.0001, max: PRODUCER_LIMITS.amount })) {
          UI.toast(`Batch weight must be between 0.0001 and ${PRODUCER_LIMITS.amount} g`);
          return;
        }
        const sStr = prompt("Number of servings", String(curS));
        if (sStr == null) return;
        const servings = Number(sStr);
        if (!producerNumber(servings, { min: 0.0001, max: PRODUCER_LIMITS.batchServings })) {
          UI.toast(`Batch servings must be between 0.0001 and ${PRODUCER_LIMITS.batchServings}`);
          return;
        }
        const idx = state.personalFoods.findIndex((f) => f.id === id);
        if (idx < 0) return;
        const next = {
          ...food,
          batch: { grams, servings, weighed: true },
          units: { ...(food.units || {}) },
          updatedAt: Date.now(),
          version: (food.version || 1) + 1,
        };
        const nextPersonal = cloneLocalData(state.personalFoods);
        nextPersonal[idx] = next;
        try { commitFoodChanges(nextPersonal); }
        catch (error) { UI.toast("Couldn’t save the batch — nothing changed"); return; }
        Sync.schedulePush();
        UI.renderFoodDetail(findFood(id), { mode: state.detailMode || "library" });
        UI.toast(`Batch → ${Math.round(grams)} g / ${servings} serv`);
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
      } else if (action === "delete-food") {
        if (!confirm("Delete this food from your library? Past logs stay as they are.")) return;
        const idx = state.personalFoods.findIndex((f) => f.id === id);
        if (idx >= 0) {
          const nextPersonal = cloneLocalData(state.personalFoods);
          nextPersonal[idx] = Foods.tombstone(nextPersonal[idx]);
          try { commitFoodChanges(nextPersonal); }
          catch (error) { UI.toast("Couldn’t delete this food — nothing changed"); return; }
          Sync.schedulePush();
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
      if (top === "onboarding") {
        e.preventDefault();
        localStorage.setItem(ONB_KEY, "1");
        UI.showOnboarding(false);
        return;
      }
      UI.closeSheet(top);
      if (top === "sheet-qty") {
        state.gapPendingItemId = null;
        state.gapPendingDay = null;
        resetQtyState();
      }
      if (top === "sheet-paste") { state.editFoodDirect = false; state.updateFoodId = null; }
      if (top === "sheet-gap") {
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
      const nextSettings = cloneLocalData(state.settings);
      nextSettings.dayPlans = {};
      nextSettings.gapDrafts = {};
      try {
        commitLocalData({ events: [], personalFoods: [], settings: nextSettings }, { resetAt: Date.now() });
      } catch (error) {
        UI.toast("Clear failed — your foods and logs were left unchanged");
        return;
      }
      state.gapSelected = {};
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
      state.gapPortionCache = null;
      refreshAll();
      Sync.fullSync(false).catch(() => {});
      UI.toast("Logs cleared");
    });

    UI.$("#btn-factory-reset").addEventListener("click", () => {
      if (!confirm("Start completely fresh? This deletes meal logs, foods, phases, day plans, weight history, and resets goals.")) return;
      if (!confirm("Last chance. Export first if you want a backup. This cannot be undone. Continue?")) return;
      const resetAt = Date.now();
      const today = Ledger.todayKey();
      const nextSettings = {
        goals: { ...DEFAULT_GOALS },
        goalsUpdatedAt: resetAt,
        imperial: false,
        weightUnit: "lb",
        theme: "light",
        dayGoals: {},
        dayPlans: {},
        gapDrafts: {},
        dayPlanPresets: [],
        phases: [],
        weights: {},
        profile: {},
      };
      Phases.ensureMigrated(nextSettings, null, today);
      try {
        commitLocalData({ events: [], personalFoods: [], settings: nextSettings }, {
          resetAt,
          storageMutations: [
            { key: ONB_KEY, value: null },
            { key: SIGNIN_SEEN_KEY, value: null },
            { key: RECONNECT_HIDE_DAY_KEY, value: null },
            { key: FIRST_SEEN_KEY, value: String(resetAt) },
          ],
        });
      } catch (error) {
        UI.toast("Start fresh failed — your data was left unchanged");
        return;
      }
      state.gapSelected = {};
      state.gapPendingItemId = null;
      state.gapPendingDay = null;
      state.gapPortionCache = null;
      state.viewDay = today;
      state.lastCalendarToday = state.viewDay;
      state.insightDays = 14;
      state.insightNutrient = "kcal";
      state.insightPhaseId = null;
      state.insightRollup = "day";
      state.insightTopFoodMetric = "kcal";
      applyTheme();
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
    UI.$("#btn-drive-disconnect").addEventListener("click", async () => {
      const result = await Sync.disconnect();
      refreshDriveStatus();
      refreshInfoBanner();
      UI.setSyncPill("local", "local only");
      UI.toast(result && result.localCleared === false
        ? "Drive credentials were cleared, but this browser could not save the disconnected preference. Close this tab and check browser storage permissions."
        : (result && result.serverCleared === false
          ? "Disconnected locally. Server sign-out will retry when you reconnect to the internet."
          : "Drive disconnected"));
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
    Ledger.configureContext({
      getResetEpoch: () => Sync.getResetAt(),
      getDayGoalLock: (day) => {
        const resolved = Phases.goalsForDay(day, state.settings);
        const override = state.settings.dayGoals && state.settings.dayGoals[day];
        const out = {
          targetKcal: Number(resolved.kcal),
          baseKcal: Number(resolved._phase && resolved._phase.kcal != null
            ? resolved._phase.kcal : resolved.kcal),
        };
        if (override && override.plannedAt != null) out.plannedAt = Number(override.plannedAt) || 0;
        if (override && override.veryLowCalorieAcknowledged === true) {
          out.veryLowCalorieAcknowledged = true;
        }
        if (override && override.intent === "fast" && override.fastAcknowledged === true) {
          out.intent = "fast";
          out.fastAcknowledged = true;
          if (override.declaredAfterDay === true) out.declaredAfterDay = true;
        }
        return out;
      },
    });
    Sync.init({
      normalizeRemoteDoc: normalizeRemoteSyncDoc,
      // Sync applies several logical values that share nd_settings_v1. Capture
      // its exact bytes plus App/Ledger memory so any later setter failure can
      // roll the whole remote apply back before the Drive shard is written.
      beginApplyTransaction: () => beginLocalDataTransaction(),
      getPersonal: () => state.personalFoods,
      setPersonal: (list) => {
        const normalized = normalizeImportedFoods(list, "Drive personalFoods");
        state.personalFoods = normalized;
        localStorage.setItem(PERSONAL_KEY, JSON.stringify(normalized));
      },
      getGoals: () => state.settings.goals,
      getGoalsUpdatedAt: () => state.settings.goalsUpdatedAt || 0,
      getGoalsResetEpoch: () => Object.prototype.hasOwnProperty.call(state.settings, "goalsResetEpoch")
        ? safeResetEpoch(state.settings.goalsResetEpoch)
        : undefined,
      setGoals: (g, at, epoch) => setGoals(g, at, epoch),
      getDayGoals: () => state.settings.dayGoals || {},
      setDayGoals: (dg) => {
        const raw = importedObject(dg || {}, "Drive dayGoals");
        for (const day of Object.keys(raw)) importedDay(day, "Drive dayGoals day");
        // The sync boundary strips every non-calorie key while preserving a
        // legacy absolute kcal until the subsequently applied phase can resolve it.
        state.settings.dayGoals = Sync.normalizeDayGoals(raw);
        saveSettings({ inbound: true });
      },
      getDayPlans: () => state.settings.dayPlans || {},
      setDayPlans: (dp) => {
        state.settings.dayPlans = normalizeImportedDayPlans(dp);
        saveSettings({ inbound: true });
      },
      getGapDrafts: () => state.settings.gapDrafts || {},
      setGapDrafts: (drafts) => {
        state.settings.gapDrafts = normalizeImportedGapDrafts(drafts);
        saveSettings({ inbound: true });
      },
      getDayPlanPresets: () => state.settings.dayPlanPresets || [],
      setDayPlanPresets: (list) => {
        state.settings.dayPlanPresets = normalizeImportedDayPlanPresets(list);
        saveSettings({ inbound: true });
      },
      getPhases: () => state.settings.phases || [],
      setPhases: (list) => {
        state.settings.phases = normalizeImportedPhases(list, Ledger.allEvents());
        Phases.ensureMigrated(state.settings, Phases.earliestDayFromEvents(Ledger.allEvents()), Ledger.todayKey());
        saveSettings({ inbound: true });
      },
      getWeights: () => state.settings.weights || {},
      setWeights: (w) => {
        state.settings.weights = normalizeImportedWeights(w);
        saveSettings({ inbound: true });
      },
      getProfile: () => Phases.ensureProfile(state.settings),
      setProfile: (p) => {
        state.settings.profile = Phases.normalizeProfile(p);
        saveSettings({ inbound: true });
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
    installPersistenceErrorUx();
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
    window.addEventListener("online", async () => {
      if (typeof GDrive.retryPendingLogout === "function") {
        try { await GDrive.retryPendingLogout(); } catch (e) {}
      }
      // A failed preference write can leave the old enabled flag behind. Do
      // not let it trigger silent re-auth until explicit server logout wins.
      if ((!GDrive.logoutPending || !GDrive.logoutPending()) && Sync.state().enabled) {
        Sync.schedulePush();
      }
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

const ACTIVE_TAB_LOCK = "nutridaily-origin-active-tab-v1";

function reloadForActiveTabSafety() {
  try {
    if (typeof window.__ndActiveTabReloadForTest === "function") {
      window.__ndActiveTabReloadForTest();
      return;
    }
    location.reload();
  } catch (error) {
    blockActiveTab("failed");
  }
}

function blockActiveTab(reason, moveFocus = true) {
  const blocker = document.querySelector("#active-tab-blocker");
  const title = document.querySelector("#active-tab-title");
  const message = document.querySelector("#active-tab-message");
  const reload = document.querySelector("#active-tab-reload");
  const shell = document.querySelector(".shell");
  const copy = {
    secondary: {
      title: "NutriDaily is already open",
      message: "Another tab is using this nutrition log. Use that tab, or close it and reload this page.",
      action: "Reload after closing it",
    },
    unsupported: {
      title: "Browser update required",
      message: "NutriDaily needs Web Locks support to protect your local nutrition log from conflicting tabs. Update or switch to a current supported browser, then reload.",
      action: "Check again",
    },
    restoring: {
      title: "Restoring NutriDaily safely",
      message: "This page was restored from browser history. NutriDaily must reload before the nutrition log can be used again.",
      action: "Reload safely",
    },
    failed: {
      title: "NutriDaily could not start safely",
      message: "Exclusive access to this nutrition log could not be verified. Close other NutriDaily tabs, then reload. If this continues, update your browser.",
      action: "Try again",
    },
  }[reason] || null;
  if (copy) {
    if (title) title.textContent = copy.title;
    if (message) message.textContent = copy.message;
    if (reload) reload.textContent = copy.action;
  }
  if (shell) {
    shell.inert = true;
    shell.setAttribute("aria-hidden", "true");
  }
  if (blocker) {
    blocker.dataset.reason = reason || "failed";
    blocker.hidden = false;
  }
  if (reload) reload.onclick = reloadForActiveTabSafety;
  if (moveFocus && title) title.focus();
}

function bootWithActiveTabLock() {
  // Undefined means a pre-guard integration; false is an explicit stop signal
  // used by Sync while a BFCache page is suspended or startup is blocked.
  window.__ndActiveTabReady = false;
  let locks;
  try {
    locks = navigator.locks;
  } catch (e) {
    blockActiveTab("failed");
    return;
  }
  if (!locks || typeof locks.request !== "function") {
    blockActiveTab("unsupported");
    return;
  }

  let releaseLock;
  let pageHidden = false;
  const lifetime = new Promise((resolve) => { releaseLock = resolve; });
  window.addEventListener("pagehide", (event) => {
    pageHidden = true;
    window.__ndActiveTabReady = false;
    if (event.persisted) blockActiveTab("restoring", false);
    releaseLock();
  }, { once: true });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    // The old App instance has already released its lifetime lock. Keep every
    // control inert and replace the document; never resume it lock-free.
    window.__ndActiveTabReady = false;
    blockActiveTab("restoring");
    reloadForActiveTabSafety();
  });
  let booted = false;
  try {
    locks.request(ACTIVE_TAB_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) {
        blockActiveTab("secondary");
        return;
      }
      if (pageHidden) return;
      window.__ndActiveTabReady = true;
      try {
        App.boot();
        booted = true;
      } catch (error) {
        window.__ndActiveTabReady = false;
        blockActiveTab("failed");
        throw error;
      }
      await lifetime;
    }).catch(() => {
      window.__ndActiveTabReady = false;
      if (!pageHidden || !booted) blockActiveTab("failed");
    });
  } catch (e) {
    window.__ndActiveTabReady = false;
    blockActiveTab("failed");
  }
}

document.addEventListener("DOMContentLoaded", bootWithActiveTabLock, { once: true });
