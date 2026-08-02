/* NutriDaily — diary bootstrap, state, event wiring. */
const App = (() => {
  const SETTINGS_KEY = "nd_settings_v1";
  const PERSONAL_KEY = "nd_personal_v1";
  const ONB_KEY = "nd_onboarded_v1";
  const DEFAULT_GOALS = { kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28 };

  const state = {
    settings: { goals: { ...DEFAULT_GOALS }, goalsUpdatedAt: 0, imperial: false, theme: "light" },
    personalFoods: [],
    viewDay: null, // YYYY-MM-DD
    pickFood: null,
    editEntryId: null,
    reviewParsed: null,
    updateFoodId: null,
    saveAsNew: false,
    insightDays: 14,
  };

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
    try { state.personalFoods = JSON.parse(localStorage.getItem(PERSONAL_KEY) || "[]"); }
    catch (e) { state.personalFoods = []; }
    state.viewDay = Ledger.todayKey();
    applyTheme();
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

  function isToday() { return state.viewDay === Ledger.todayKey(); }

  function refreshHUD() {
    UI.updateHUD(Ledger.totalsFor(state.viewDay), state.settings.goals);
    UI.setDayLabel(state.viewDay, isToday());
  }

  function refreshDay() {
    refreshHUD();
    UI.renderDayLog(state.viewDay, Ledger.entriesFor(state.viewDay));
  }

  function refreshFoods() {
    UI.renderFoods(state.personalFoods, UI.$("#foods-search").value);
  }

  function refreshAll() {
    refreshDay();
    refreshFoods();
    if (document.querySelector("#view-insights.active")) {
      UI.renderTrends(state.settings.goals, state.insightDays);
    }
  }

  function switchView(name) {
    document.querySelectorAll(".bottom-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
    document.querySelectorAll("main .view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    if (name === "foods") refreshFoods();
    if (name === "insights") UI.renderTrends(state.settings.goals, state.insightDays);
    if (name === "today") refreshDay();
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
    UI.$("#pick-search").value = "";
    UI.renderPicker(state.personalFoods, "", true);
    UI.openSheet("sheet-add");
  }

  function openQty(food, prefill) {
    state.pickFood = food;
    UI.fillQtySheet(food, !!state.settings.imperial, prefill);
    UI.closeSheet("sheet-add");
    UI.openSheet("sheet-qty");
    setTimeout(() => UI.$("#qty-input").focus(), 50);
  }

  function saveQty() {
    const food = state.pickFood;
    if (!food) return;
    const entry = UI.updateQtyPreview(food);
    if (!entry) { UI.toast("Enter a valid amount"); return; }
    entry.meal = UI.selectedMeal();

    if (state.editEntryId) {
      Ledger.amendEntry(state.viewDay, state.editEntryId, {
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
      Ledger.addEntry(state.viewDay, entry);
      const idx = state.personalFoods.findIndex((f) => f.id === food.id);
      if (idx >= 0) {
        state.personalFoods[idx] = Foods.touchUse(state.personalFoods[idx]);
        savePersonal();
      }
    }
    Sync.schedulePush();
    UI.closeSheet("sheet-qty");
    state.editEntryId = null;
    refreshDay();
    UI.toast("Logged");
  }

  function openPaste(opts) {
    state.updateFoodId = (opts && opts.updateId) || null;
    state.saveAsNew = false;
    state.reviewParsed = null;
    UI.$("#paste-text").value = "";
    UI.showPastePrompt();
    if (state.updateFoodId) UI.$("#paste-title").textContent = "Update from ChatGPT";
    UI.openSheet("sheet-paste");
  }

  function copyPrompt() {
    let text = NutriParse.PROMPT;
    if (state.updateFoodId) {
      const f = findFood(state.updateFoodId);
      if (f) text = NutriParse.updatePrompt(f.raw || "");
    }
    navigator.clipboard.writeText(text).then(() => UI.toast("Prompt copied")).catch(() => UI.toast("Copy failed — select manually in Settings"));
  }

  function importPaste() {
    const text = UI.$("#paste-text").value;
    const parsed = NutriParse.parse(text);
    if (!parsed.found) {
      UI.toast(parsed.error);
      return;
    }
    const result = parsed.results[0];
    result.food.raw = text;
    state.reviewParsed = result;
    const dup = !state.updateFoodId ? Foods.findByName(state.personalFoods, result.food.name) : null;
    UI.showReview(result, {
      updateId: state.updateFoodId,
      duplicate: dup && (!state.updateFoodId || dup.id !== state.updateFoodId) ? dup : null,
      forceEnable: true,
    });
    // re-validate from form fields after user edits
    validateReviewSave();
  }

  function openManualReview() {
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

  function validateReviewSave() {
    const draft = UI.readReviewDraft(state.reviewParsed && state.reviewParsed.food);
    const bad = !draft.name || draft.per100.kcal < 0 || draft.per100.p + draft.per100.c + draft.per100.f > 105 || draft.per100.kcal > 920;
    UI.$("#btn-review-save").disabled = bad;
    return !bad;
  }

  function saveReview() {
    if (!validateReviewSave()) { UI.toast("Fix the highlighted fields"); return; }
    const draft = UI.readReviewDraft(state.reviewParsed && state.reviewParsed.food);
    let updateId = state.updateFoodId;
    if (!updateId && !state.saveAsNew) {
      const dup = Foods.findByName(state.personalFoods, draft.name);
      if (dup) updateId = dup.id;
    }

    if (updateId) {
      const idx = state.personalFoods.findIndex((f) => f.id === updateId);
      if (idx < 0) { UI.toast("Food not found"); return; }
      const prev = state.personalFoods[idx];
      state.personalFoods[idx] = Foods.applyUpdate(prev, draft);
      // offer amend today's entries with same foodId
      const today = Ledger.todayKey();
      const todays = Ledger.entriesFor(today).filter((e) => e.foodId === updateId);
      if (todays.length && confirm(`Update ${todays.length} log(s) today to the new recipe numbers?`)) {
        const food = state.personalFoods[idx];
        for (const e of todays) {
          const qty = e.qty || e.grams;
          const unit = e.unit || "g";
          const fresh = Foods.entryFromQty(food, qty, unit, e.meal);
          Ledger.amendEntry(today, e.id, {
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
      state.personalFoods.push(Foods.createFromDraft(draft));
      UI.toast("Food saved");
    }
    savePersonal();
    state.updateFoodId = null;
    state.saveAsNew = false;
    UI.closeSheet("sheet-paste");
    refreshFoods();
    switchView("foods");
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
    UI.$("#settings-modal").classList.add("open");
  }

  function refreshDriveStatus() {
    const st = Sync.state();
    const el = UI.$("#drive-status");
    if (st.enabled) {
      el.textContent = st.email ? `Connected as ${st.email}` : "Connected";
      UI.$("#btn-drive-connect").style.display = "none";
      UI.$("#btn-drive-disconnect").style.display = "";
    } else {
      el.textContent = GDrive.unavailableReason() || "Not connected — optional backup to your Drive.";
      UI.$("#btn-drive-connect").style.display = "";
      UI.$("#btn-drive-disconnect").style.display = "none";
    }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({
      version: 2,
      exportedAt: new Date().toISOString(),
      settings: state.settings,
      personalFoods: state.personalFoods,
      events: Ledger.allEvents(),
    }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `nutridaily-export-${Ledger.todayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.events) Ledger.replaceAll(data.events);
        if (data.personalFoods) state.personalFoods = data.personalFoods;
        if (data.settings) {
          Object.assign(state.settings, data.settings);
          delete state.settings.key;
          delete state.settings.model;
          state.settings.goals = { ...DEFAULT_GOALS, ...(state.settings.goals || {}) };
        }
        saveSettings();
        savePersonal();
        refreshAll();
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
    UI.$("#pick-search").addEventListener("input", (e) => UI.renderPicker(state.personalFoods, e.target.value, true));

    UI.$("#qty-input").addEventListener("input", () => state.pickFood && UI.updateQtyPreview(state.pickFood));
    UI.$("#qty-units").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-unit]");
      if (!btn) return;
      UI.$("#qty-units").querySelectorAll(".uchip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      if (state.pickFood) UI.updateQtyPreview(state.pickFood);
    });
    UI.$("#qty-meals").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-meal]");
      if (!btn) return;
      UI.$("#qty-meals").querySelectorAll(".uchip").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
    });
    UI.$("#qty-save").addEventListener("click", saveQty);

    UI.$("#btn-copy-prompt").addEventListener("click", copyPrompt);
    UI.$("#btn-settings-copy-prompt").addEventListener("click", () => {
      navigator.clipboard.writeText(NutriParse.PROMPT).then(() => UI.toast("Prompt copied")).catch(() => UI.toast("Copy failed"));
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
    UI.$("#btn-review-back").addEventListener("click", () => UI.showPastePrompt());
    UI.$("#btn-review-save").addEventListener("click", saveReview);
    ["#rev-name", "#rev-kcal", "#rev-p", "#rev-c", "#rev-f"].forEach((sel) => {
      UI.$(sel).addEventListener("input", validateReviewSave);
    });

    UI.$("#insight-range").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-days]");
      if (!btn) return;
      state.insightDays = Number(btn.dataset.days);
      UI.$("#insight-range").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      UI.renderTrends(state.settings.goals, state.insightDays);
    });

    document.body.addEventListener("click", (e) => {
      const close = e.target.closest("[data-close]");
      if (close) UI.closeSheet(close.dataset.close);

      const actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id;

      if (action === "pick-food") {
        const food = findFood(id);
        if (food) openQty(food);
      } else if (action === "pick-catalog") {
        const db = (typeof FOOD_DB !== "undefined" ? FOOD_DB : []).find((f) => f.id === id);
        if (!db) return;
        const existing = state.personalFoods.find((f) => !f.deleted && f.catalogId === db.id);
        const food = existing || Foods.fromCatalog(db);
        if (!existing) {
          state.personalFoods.push(food);
          savePersonal();
        }
        openQty(food);
      } else if (action === "edit-entry") {
        const entry = Ledger.entriesFor(state.viewDay).find((x) => x.id === id);
        if (!entry) return;
        state.editEntryId = id;
        let food = entry.foodId ? findFood(entry.foodId) : null;
        if (!food) {
          food = {
            id: entry.foodId || "tmp",
            name: entry.name,
            per100: entry.per100 || { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 0 },
            units: {},
            batch: null,
            sd: entry.sd,
            version: entry.foodVersion || 1,
          };
        }
        openQty(food, { qty: entry.qty || entry.grams, unit: entry.unit || "g", meal: entry.meal });
      } else if (action === "food-detail") {
        openDetail(id);
      } else if (action === "log-this") {
        UI.closeSheet("sheet-detail");
        openQty(findFood(id));
      } else if (action === "update-food") {
        UI.closeSheet("sheet-detail");
        openPaste({ updateId: id });
      } else if (action === "copy-update-prompt") {
        const f = findFood(id);
        if (!f) return;
        navigator.clipboard.writeText(NutriParse.updatePrompt(f.raw || "")).then(() => UI.toast("Update prompt copied")).catch(() => UI.toast("Copy failed"));
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

    // long-press / swipe delete via context menu on log rows
    UI.$("#day-log").addEventListener("contextmenu", (e) => {
      const row = e.target.closest("[data-action='edit-entry']");
      if (!row) return;
      e.preventDefault();
      if (confirm("Remove this entry?")) {
        Ledger.removeEntry(state.viewDay, row.dataset.id, "removed");
        Sync.schedulePush();
        refreshDay();
      }
    });

    UI.$("#btn-export").addEventListener("click", exportData);
    UI.$("#import-file").addEventListener("change", (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = "";
    });
    UI.$("#btn-clear").addEventListener("click", () => {
      if (!confirm("Clear all foods and logs on this device?")) return;
      Ledger.clearAll();
      state.personalFoods = [];
      savePersonal();
      refreshAll();
      UI.toast("Cleared");
    });

    UI.$("#btn-drive-connect").addEventListener("click", async () => {
      try {
        await Sync.connect();
        refreshDriveStatus();
        UI.toast("Drive connected");
      } catch (err) {
        UI.toast(err.message || "Connect failed");
      }
    });
    UI.$("#btn-drive-disconnect").addEventListener("click", () => {
      Sync.disconnect();
      refreshDriveStatus();
      UI.setSyncPill("local", "local only");
    });
    UI.$("#sync-pill").addEventListener("click", openSettings);

    UI.$("#btn-onb-start").addEventListener("click", () => {
      localStorage.setItem(ONB_KEY, "1");
      UI.showOnboarding(false);
      openPaste();
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
      onStatus: (s, detail) => {
        if (s === "ok") UI.setSyncPill("ok", "synced");
        else if (s === "pending" || s === "syncing") UI.setSyncPill("pending", detail || "syncing…");
        else if (s === "auth" || s === "error") UI.setSyncPill("warn", detail || "sync issue");
        else UI.setSyncPill("local", "local only");
      },
      onRemoteApplied: () => refreshAll(),
    });
    Sync.resume().catch(() => {});
  }

  function boot() {
    loadState();
    wire();
    initSync();
    refreshAll();
    if (!localStorage.getItem(ONB_KEY) && !activeFoods().length && !Ledger.allEvents().length) {
      UI.showOnboarding(true);
    }
  }

  return { boot, state };
})();

document.addEventListener("DOMContentLoaded", () => App.boot());
