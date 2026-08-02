/* NutriDaily — diary bootstrap, state, event wiring. */
const App = (() => {
  const SETTINGS_KEY = "nd_settings_v1";
  const PERSONAL_KEY = "nd_personal_v1";
  const ONB_KEY = "nd_onboarded_v1";
  const FIRST_SEEN_KEY = "nd_first_seen_at";
  const SIGNIN_SEEN_KEY = "nd_signin_banner_seen";
  const RECONNECT_HIDE_DAY_KEY = "nd_reconnect_hide_day";
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
    try { state.personalFoods = JSON.parse(localStorage.getItem(PERSONAL_KEY) || "[]"); }
    catch (e) { state.personalFoods = []; }
    state.viewDay = Ledger.todayKey();
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
    UI.fillQtySheet(food, !!state.settings.imperial, {
      ...(prefill || {}),
      allowRemove: !!(prefill && prefill.allowRemove),
    });
    UI.closeSheet("sheet-add");
    UI.openSheet("sheet-qty");
    setTimeout(() => UI.$("#qty-input").focus(), 50);
  }

  function cancelQty() {
    UI.closeSheet("sheet-qty");
    state.pickFood = null;
    state.editEntryId = null;
  }

  /** Open the food editor (macros / name / units) for a personal food. */
  function openEditFood(food) {
    if (!food) return;
    let target = findFood(food.id);
    if (!target && food.per100) {
      // Ensure catalog picks are editable as personal copies
      target = Foods.fromCatalog({
        id: food.catalogId || food.id,
        name: food.name,
        aliases: food.aliases || [],
        cat: food.cat,
        per100: food.per100,
        units: food.units || {},
      });
      // Prefer existing personal copy by catalogId
      const existing = state.personalFoods.find((f) => !f.deleted && f.catalogId === target.catalogId);
      if (existing) target = existing;
      else {
        state.personalFoods.push(target);
        savePersonal();
      }
    }
    if (!target) { UI.toast("Can't edit this food"); return; }

    state.updateFoodId = target.id;
    state.saveAsNew = false;
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
    UI.showReview(state.reviewParsed, { updateId: target.id, forceEnable: true });
    UI.$("#paste-title").textContent = "Edit food";
    validateReviewSave();
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
    if (state.updateFoodId) UI.$("#paste-title").textContent = "Update from AI paste";
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
    UI.$("#qty-cancel").addEventListener("click", cancelQty);
    UI.$("#qty-edit-food").addEventListener("click", () => openEditFood(state.pickFood));
    UI.$("#qty-remove").addEventListener("click", () => {
      if (!state.editEntryId) return;
      if (!confirm("Remove this log entry?")) return;
      Ledger.removeEntry(state.viewDay, state.editEntryId, "removed");
      Sync.schedulePush();
      cancelQty();
      refreshDay();
      UI.toast("Removed");
    });

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
        openQty(food, { qty: entry.qty || entry.grams, unit: entry.unit || "g", meal: entry.meal, allowRemove: true });
      } else if (action === "food-detail") {
        openDetail(id);
      } else if (action === "log-this") {
        UI.closeSheet("sheet-detail");
        openQty(findFood(id));
      } else if (action === "edit-food") {
        openEditFood(findFood(id));
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

    UI.$("#btn-drive-connect").addEventListener("click", () => connectDrive());
    UI.$("#btn-drive-sync").addEventListener("click", async () => {
      try {
        await Sync.fullSync(true);
        localStorage.removeItem(RECONNECT_HIDE_DAY_KEY);
        UI.toast("Synced");
      } catch (err) {
        UI.toast(err.message || "Sync failed");
      }
      refreshDriveStatus();
      refreshInfoBanner();
    });
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
        try { await Sync.fullSync(true); UI.toast("Synced"); }
        catch (e) { UI.toast(e.message || "Sync failed"); }
        refreshDriveStatus();
        refreshInfoBanner();
        return;
      }
      openSettings();
    });

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
