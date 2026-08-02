/* NutriDaily — diary bootstrap, state, event wiring. */
const App = (() => {
  const SETTINGS_KEY = "nd_settings_v1";
  const PERSONAL_KEY = "nd_personal_v1";
  const ONB_KEY = "nd_onboarded_v1";
  const FIRST_SEEN_KEY = "nd_first_seen_at";
  const SIGNIN_SEEN_KEY = "nd_signin_banner_seen";
  const RECONNECT_HIDE_DAY_KEY = "nd_reconnect_hide_day";
  const DEFAULT_GOALS = { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300 };

  const state = {
    settings: { goals: { ...DEFAULT_GOALS }, goalsUpdatedAt: 0, imperial: false, theme: "light", dayGoals: {} },
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
    insightDays: 14,
    lastCalendarToday: null, // for overnight day roll without yanking past-day browsing
    yesterdayKey: null,
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
    const has = !!dayGoalOverride();
    btn.classList.toggle("has-override", has);
    btn.textContent = has ? "Day goals · custom" : "Day goals";
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
    if (!state.settings.dayGoals || typeof state.settings.dayGoals !== "object") state.settings.dayGoals = {};
    try { state.personalFoods = JSON.parse(localStorage.getItem(PERSONAL_KEY) || "[]"); }
    catch (e) { state.personalFoods = []; }
    state.viewDay = Ledger.todayKey();
    state.lastCalendarToday = state.viewDay;
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
      ? "Meals still save on this device. Tap Reconnect to resume Google Drive (opens a Google popup)."
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
    });
    const recon = UI.$("#banner-reconnect");
    if (recon) recon.addEventListener("click", async () => {
      try {
        await Sync.connect();
        localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
        UI.toast("Drive reconnected");
      } catch (e) {
        UI.toast(e.message || "Could not reconnect");
      }
      refreshDriveStatus();
      refreshInfoBanner();
    });
    const go = UI.$("#banner-settings");
    if (go) go.addEventListener("click", () => openSettings());
  }

  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  const savePersonal = () => {
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(state.personalFoods));
    Sync.schedulePush();
  };

  function setGoals(goals, updatedAt) {
    state.settings.goals = { ...DEFAULT_GOALS, ...goals };
    state.settings.goalsUpdatedAt = updatedAt || Date.now();
    saveSettings();
  }

  function goalsForView() {
    const base = { ...DEFAULT_GOALS, ...(state.settings.goals || {}) };
    const ov = dayGoalOverride();
    if (!ov) return base;
    const { updatedAt: _u, cleared: _c, ...rest } = ov;
    return { ...base, ...rest };
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
    UI.renderDayLog(state.viewDay, Ledger.entriesFor(state.viewDay));
  }

  function refreshFoods() {
    UI.renderFoods(state.personalFoods, UI.$("#foods-search").value);
  }

  function refreshAll() {
    refreshDay();
    refreshFoods();
    if (document.querySelector("#view-insights.active")) {
      UI.renderTrends({ ...DEFAULT_GOALS, ...(state.settings.goals || {}) }, state.insightDays);
    }
  }

  function switchView(name) {
    document.querySelectorAll(".bottom-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    document.querySelectorAll("main .view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    if (name === "foods") refreshFoods();
    if (name === "insights") UI.renderTrends({ ...DEFAULT_GOALS, ...(state.settings.goals || {}) }, state.insightDays);
    if (name === "today") refreshDay();
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
    resetQtyState();
  }

  function defaultQtyForUnit(food, unit) {
    const u = String(unit || "g").toLowerCase();
    if (u === "serving" || u === "piece" || u === "batch" || u === "oz") return 1;
    if (food.units && food.units.serving) return food.units.serving;
    return 100;
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
    } else {
      if (state.pendingCatalogFood && state.pendingCatalogFood.id === food.id) {
        if (!state.personalFoods.some((f) => f.id === food.id)) {
          state.personalFoods.push(food);
        }
        state.pendingCatalogFood = null;
      }
      if (!entry.foodId && food.id && !food._orphan) entry.foodId = food.id;
      if (food._orphan) entry.foodId = null;
      Ledger.addEntry(state.viewDay, entry);
      const idx = state.personalFoods.findIndex((f) => f.id === food.id);
      if (idx >= 0) {
        state.personalFoods[idx] = Foods.touchUse(state.personalFoods[idx]);
        savePersonal();
      } else {
        savePersonal();
      }
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
    UI.$("#paste-text").value = "";
    UI.showPastePrompt();
    if (state.updateFoodId) UI.$("#paste-title").textContent = "Update from AI paste";
    UI.openSheet("sheet-paste");
  }

  function copyPrompt() {
    let text = NutriParse.PROMPT;
    if (state.updateFoodId) {
      const f = findFood(state.updateFoodId);
      if (f) text = NutriParse.updatePrompt(f.raw || "");
    }
    navigator.clipboard.writeText(text).then(() => UI.toast("Prompt copied")).catch(() => {
      UI.showPromptFallback(text);
      UI.toast("Select the prompt below, then copy");
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
    savePersonal();
    state.updateFoodId = null;
    state.saveAsNew = false;
    state.editFoodDirect = false;
    UI.closeSheet("sheet-paste");
    refreshFoods();
    if (wasDirect && savedFood) {
      switchView("foods");
      openDetail(savedFood.id);
    } else {
      switchView("today");
      if (savedFood) openQty(savedFood);
    }
  }

  function openDetail(id) {
    const food = findFood(id);
    if (!food) return;
    UI.renderFoodDetail(food);
    UI.openSheet("sheet-detail");
  }

  function syncSettingsForm() {
    const g = state.settings.goals;
    UI.$("#set-kcal").value = g.kcal;
    UI.$("#set-protein").value = g.protein;
    UI.$("#set-carbs").value = g.carbs;
    UI.$("#set-fat").value = g.fat;
    UI.$("#set-fiber").value = g.fiber;
    if (UI.$("#set-sodium")) UI.$("#set-sodium").value = g.sodium != null ? g.sodium : DEFAULT_GOALS.sodium;
    UI.$("#set-imperial").checked = !!state.settings.imperial;
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

  function openSettings() {
    syncSettingsForm();
    refreshDriveStatus();
    refreshInstallCard();
    UI.$("#settings-modal").classList.add("open");
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

  async function connectDrive() {
    try {
      await Sync.connect();
      localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
      localStorage.setItem(SIGNIN_SEEN_KEY, "1");
      refreshDriveStatus();
      refreshInfoBanner();
      UI.toast("Drive connected");
    } catch (err) {
      UI.toast(err.message || "Connect failed");
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
      version: 2,
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
    UI.$("#btn-add-food").addEventListener("click", () => openPaste());
    UI.$("#btn-paste-new").addEventListener("click", () => {
      UI.closeSheet("sheet-add");
      openPaste();
    });
    UI.$("#btn-settings").addEventListener("click", openSettings);
    UI.$("#btn-close-settings").addEventListener("click", () => UI.$("#settings-modal").classList.remove("open"));
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
    UI.$("#btn-save-settings").addEventListener("click", () => {
      setGoals({
        kcal: Number(UI.$("#set-kcal").value) || DEFAULT_GOALS.kcal,
        protein: Number(UI.$("#set-protein").value) || 0,
        carbs: Number(UI.$("#set-carbs").value) || 0,
        fat: Number(UI.$("#set-fat").value) || 0,
        fiber: Number(UI.$("#set-fiber").value) || 0,
        sodium: Number(UI.$("#set-sodium") && UI.$("#set-sodium").value) || 0,
      });
      state.settings.imperial = UI.$("#set-imperial").checked;
      const gc = UI.$("#set-gclient").value.trim();
      if (gc) localStorage.setItem("nd_gclient", gc);
      else localStorage.removeItem("nd_gclient");
      saveSettings();
      applyTheme();
      UI.$("#settings-modal").classList.remove("open");
      refreshHUD();
      UI.toast("Saved");
    });

    UI.$("#foods-search").addEventListener("input", refreshFoods);
    UI.$("#pick-search").addEventListener("input", (e) => {
      UI.renderPicker(state.personalFoods, e.target.value, true, {
        yesterday: Ledger.entriesFor(state.yesterdayKey || yesterdayKey()),
        yesterdayLabel: isToday() ? "Yesterday" : "Previous day",
      });
    });
    UI.$("#day-label").addEventListener("click", jumpToToday);
    UI.$("#btn-day-goals").addEventListener("click", () => {
      const ov = dayGoalOverride() || {};
      UI.$("#dg-kcal").value = ov.kcal != null ? ov.kcal : "";
      UI.$("#dg-protein").value = ov.protein != null ? ov.protein : "";
      UI.$("#dg-carbs").value = ov.carbs != null ? ov.carbs : "";
      UI.$("#dg-fat").value = ov.fat != null ? ov.fat : "";
      UI.$("#dg-fiber").value = ov.fiber != null ? ov.fiber : "";
      UI.$("#dg-sodium").value = ov.sodium != null ? ov.sodium : "";
      const base = { ...DEFAULT_GOALS, ...(state.settings.goals || {}) };
      UI.$("#day-goals-blurb").textContent = `Usual goals: ${base.kcal} kcal · P ${base.protein}. Blank fields keep those.`;
      UI.openSheet("sheet-day-goals");
    });
    UI.$("#dg-save").addEventListener("click", () => {
      const num = (id) => {
        const v = UI.$(id).value.trim();
        if (v === "") return null;
        const n = parseAmount(v);
        return Number.isFinite(n) ? n : null;
      };
      const patch = {};
      [["kcal", "#dg-kcal"], ["protein", "#dg-protein"], ["carbs", "#dg-carbs"], ["fat", "#dg-fat"], ["fiber", "#dg-fiber"], ["sodium", "#dg-sodium"]]
        .forEach(([k, sel]) => { const n = num(sel); if (n != null) patch[k] = n; });
      if (!state.settings.dayGoals) state.settings.dayGoals = {};
      if (Object.keys(patch).length) {
        state.settings.dayGoals[state.viewDay] = { ...patch, updatedAt: Date.now() };
      } else {
        // Tombstone so Drive merge does not resurrect the override
        state.settings.dayGoals[state.viewDay] = { cleared: true, updatedAt: Date.now() };
      }
      saveSettings();
      Sync.schedulePush();
      UI.closeSheet("sheet-day-goals");
      refreshDay();
      UI.toast(Object.keys(patch).length ? "Day goals saved" : "Using defaults");
    });
    UI.$("#dg-clear").addEventListener("click", () => {
      if (!state.settings.dayGoals) state.settings.dayGoals = {};
      state.settings.dayGoals[state.viewDay] = { cleared: true, updatedAt: Date.now() };
      saveSettings();
      Sync.schedulePush();
      UI.closeSheet("sheet-day-goals");
      refreshDay();
      UI.toast("Using defaults");
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
    UI.$("#qty-edit-food").addEventListener("click", () => openEditFood(state.pickFood));
    UI.$("#qty-remove").addEventListener("click", () => {
      if (!state.editEntryId) return;
      const id = state.editEntryId;
      const day = editDay();
      cancelQty();
      removeEntryWithUndo(day, id);
    });

    UI.$("#btn-copy-prompt").addEventListener("click", copyPrompt);
    UI.$("#btn-settings-copy-prompt").addEventListener("click", () => {
      navigator.clipboard.writeText(NutriParse.PROMPT).then(() => UI.toast("Prompt copied")).catch(() => {
        window.prompt("Select all and copy (Cmd/Ctrl+C):", NutriParse.PROMPT);
      });
    });
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
      state.insightDays = Number(btn.dataset.days);
      UI.$("#insight-range").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      UI.renderTrends({ ...DEFAULT_GOALS, ...(state.settings.goals || {}) }, state.insightDays);
    });
    const canvas = UI.$("#trend-canvas");
    if (canvas) {
      canvas.style.cursor = "pointer";
      canvas.addEventListener("click", (e) => {
        const day = UI.trendDayAtClientX(e.clientX);
        if (day) UI.renderDayDetail(day);
      });
    }
    let resizeT = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        if (document.querySelector("#view-insights.active")) {
          UI.renderTrends({ ...DEFAULT_GOALS, ...(state.settings.goals || {}) }, state.insightDays);
        }
      }, 150);
    });

    document.body.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close]");
      if (close) {
        const sheetId = close.dataset.close;
        UI.closeSheet(sheetId);
        if (sheetId === "sheet-qty" || sheetId === "sheet-kcal") resetQtyState();
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
          units: { ...(food.units || {}), serving: Math.round(grams / servings) },
          updatedAt: Date.now(),
          version: (food.version || 1) + 1,
        };
        state.personalFoods[idx] = next;
        savePersonal();
        UI.renderFoodDetail(next);
        UI.toast(`Batch → ${Math.round(grams)} g / ${servings} serv`);
      } else if (action === "food-detail") {
        openDetail(id);
      } else if (action === "log-this") {
        UI.closeSheet("sheet-detail");
        state.pendingCatalogFood = null;
        openQty(findFood(id));
      } else if (action === "edit-food") {
        openEditFood(findFood(id));
      } else if (action === "update-food") {
        UI.closeSheet("sheet-detail");
        openPaste({ updateId: id });
      } else if (action === "copy-update-prompt") {
        const f = findFood(id);
        if (!f) return;
        const text = NutriParse.updatePrompt(f.raw || "");
        navigator.clipboard.writeText(text).then(() => UI.toast("Update prompt copied")).catch(() => {
          UI.closeSheet("sheet-detail");
          openPaste({ updateId: id });
          UI.showPromptFallback(text);
          UI.toast("Select the prompt below, then copy");
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
      const row = e.target.closest("[data-action='edit-entry']");
      if (!row) return;
      e.preventDefault();
      removeEntryWithUndo(state.viewDay, row.dataset.id);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const modal = UI.$("#settings-modal");
      if (modal && modal.classList.contains("open")) {
        modal.classList.remove("open");
        return;
      }
      const top = UI.topSheetId();
      if (!top) return;
      UI.closeSheet(top);
      if (top === "sheet-qty") resetQtyState();
      if (top === "sheet-paste") { state.editFoodDirect = false; state.updateFoodId = null; }
    });

    UI.$("#btn-export").addEventListener("click", exportData);
    UI.$("#import-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = "";
    });
    UI.$("#btn-clear").addEventListener("click", () => {
      if (!confirm("Clear all foods and logs on this device? If Drive sync is on, the cloud copy will be wiped on the next sync.")) return;
      Sync.markReset(Date.now());
      Ledger.clearAll();
      state.personalFoods = [];
      savePersonal();
      refreshAll();
      Sync.fullSync(false).catch(() => {});
      UI.toast("Cleared");
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
      if (st.enabled && (st.status === "auth" || !GDrive.storedToken())) {
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
      Sync.resume().catch(() => {});
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
      onStatus: (s, detail) => {
        if (s === "ok") {
          localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
          UI.setSyncPill("ok", Sync.state().email ? Sync.state().email.split("@")[0] : "synced");
        } else if (s === "pending" || s === "syncing") UI.setSyncPill("pending", detail || "syncing…");
        else if (s === "auth") UI.setSyncPill("warn", "reconnect");
        else if (s === "error") UI.setSyncPill("warn", detail || "sync issue");
        else UI.setSyncPill("local", "local only");
        refreshInfoBanner();
        if (UI.$("#settings-modal").classList.contains("open")) refreshDriveStatus();
      },
      onRemoteApplied: () => refreshAll(),
    });
    Sync.resume().catch(() => {});
  }

  function boot() {
    loadState();
    wire();
    window.addEventListener("beforeinstallprompt", (ev) => {
      ev.preventDefault();
      deferredInstall = ev;
      if (UI.$("#settings-modal").classList.contains("open")) refreshInstallCard();
    });
    window.addEventListener("appinstalled", () => {
      deferredInstall = null;
      if (UI.$("#settings-modal").classList.contains("open")) refreshInstallCard();
    });
    window.addEventListener("online", () => {
      if (Sync.state().enabled) Sync.schedulePush();
    });
    initSync();
    refreshAll();
    refreshInfoBanner();
    if (!localStorage.getItem(ONB_KEY) && !activeFoods().length && !Ledger.allEvents().length) {
      UI.showOnboarding(true);
    }
  }

  return { boot, state };
})();

document.addEventListener("DOMContentLoaded", () => App.boot());
