/* NutriDaily — Sample vs Real profile session.
 * One shipped Sample seed (js/sample-seed.js) and one Real ledger.
 * Sample never syncs to Drive. Seed is always recoverable via resetSample.
 */
const SampleProfile = (() => {
  const ACTIVE_KEY = "nd_active_profile";
  const REAL_CREATED_KEY = "nd_real_created";
  const REAL_NAME_KEY = "nd_real_display_name";
  const WARN_DISMISSED_AT_KEY = "nd_sample_warn_dismissed_at";
  const INTRO_SESSION_KEY = "nutridaily.sampleIntroArmed";
  const ENTRY_SESSION_KEY = "nutridaily.sampleEntryAt";

  const KEYS = {
    real: {
      settings: "nd_settings_v1",
      personal: "nd_personal_v1",
      events: "nd_events_v1",
      reset: "nd_reset_at",
    },
    sample: {
      settings: "nd_sample_settings_v1",
      personal: "nd_sample_personal_v1",
      events: "nd_sample_events_v1",
      reset: "nd_sample_reset_at",
    },
  };

  const WARN_COOLDOWN_MS = 10 * 60 * 1000;
  const INTRO_DELAY_MS = 30 * 1000;

  let _active = "real";
  let _hooks = null;
  let _introTimer = null;
  let _pendingMutation = null;

  function storage() {
    if (typeof localStorage !== "undefined") return localStorage;
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }

  function session() {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
    return {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
  }

  function isSample() { return _active === "sample"; }
  function activeId() { return _active; }
  function realCreated() { return storage().getItem(REAL_CREATED_KEY) === "1"; }
  function realDisplayName() {
    return String(storage().getItem(REAL_NAME_KEY) || "").trim() || "My tracking";
  }

  function keysFor(id) {
    return KEYS[id === "sample" ? "sample" : "real"];
  }

  function workingKeys() {
    return keysFor(_active);
  }

  function dayKeyFromDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function addDays(dayKey, n) {
    const [y, m, d] = String(dayKey).split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dayKeyFromDate(new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  }

  function daysBetween(a, b) {
    const [ay, am, ad] = String(a).split("-").map(Number);
    const [by, bm, bd] = String(b).split("-").map(Number);
    const aMs = Date.UTC(ay, am - 1, ad);
    const bMs = Date.UTC(by, bm - 1, bd);
    return Math.round((bMs - aMs) / 86400000);
  }

  function shiftDayMap(map, delta) {
    if (!map || typeof map !== "object" || !delta) return map || {};
    const out = {};
    for (const [day, value] of Object.entries(map)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      out[addDays(day, delta)] = value;
    }
    return out;
  }

  function shiftPhases(phases, delta) {
    if (!Array.isArray(phases) || !delta) return phases || [];
    return phases.map((ph) => {
      const next = { ...ph };
      if (next.startDay) next.startDay = addDays(next.startDay, delta);
      if (next.endDay) next.endDay = addDays(next.endDay, delta);
      if (Array.isArray(next.revisions)) {
        next.revisions = next.revisions.map((rv) => ({
          ...rv,
          effectiveFrom: rv.effectiveFrom ? addDays(rv.effectiveFrom, delta) : rv.effectiveFrom,
        }));
      }
      return next;
    });
  }

  function shiftEvents(events, delta) {
    if (!Array.isArray(events) || !delta) return events || [];
    const dayMs = delta * 86400000;
    return events.map((ev) => ({
      ...ev,
      day: ev.day ? addDays(ev.day, delta) : ev.day,
      ts: Number.isFinite(Number(ev.ts)) ? Number(ev.ts) + dayMs : ev.ts,
    }));
  }

  function seedPayload(todayKey) {
    const raw = typeof SAMPLE_SEED !== "undefined" ? SAMPLE_SEED : null;
    if (!raw || typeof raw !== "object") {
      throw new Error("SAMPLE_SEED is missing");
    }
    const anchor = raw.anchorDay || todayKey;
    const delta = daysBetween(anchor, todayKey);
    const settings = JSON.parse(JSON.stringify(raw.settings || {}));
    settings.weights = shiftDayMap(settings.weights, delta);
    settings.dayGoals = shiftDayMap(settings.dayGoals, delta);
    settings.dayPlans = shiftDayMap(settings.dayPlans, delta);
    settings.gapDrafts = shiftDayMap(settings.gapDrafts, delta);
    settings.phases = shiftPhases(settings.phases, delta);
    return {
      version: 3,
      seedId: raw.seedId || "sample-v1",
      resetAt: Number(raw.resetAt) || 1,
      settings,
      personalFoods: JSON.parse(JSON.stringify(raw.personalFoods || [])),
      events: shiftEvents(JSON.parse(JSON.stringify(raw.events || [])), delta),
    };
  }

  function writeSampleStore(payload) {
    const k = KEYS.sample;
    const store = storage();
    store.setItem(k.settings, JSON.stringify(payload.settings || {}));
    store.setItem(k.personal, JSON.stringify(payload.personalFoods || []));
    store.setItem(k.events, JSON.stringify(payload.events || []));
    store.setItem(k.reset, String(payload.resetAt || 1));
  }

  function sampleStoreEmpty() {
    const store = storage();
    const k = KEYS.sample;
    const eventsRaw = store.getItem(k.events);
    if (!eventsRaw) return true;
    try {
      const events = JSON.parse(eventsRaw);
      return !Array.isArray(events) || events.length === 0;
    } catch (e) {
      return true;
    }
  }

  function realHasData() {
    const store = storage();
    const k = KEYS.real;
    try {
      const events = JSON.parse(store.getItem(k.events) || "[]");
      if (Array.isArray(events) && events.length) return true;
    } catch (e) {}
    try {
      const foods = JSON.parse(store.getItem(k.personal) || "[]");
      if (Array.isArray(foods) && foods.some((f) => f && !f.deleted)) return true;
    } catch (e) {}
    return false;
  }

  function applyWorkingKeys() {
    const k = workingKeys();
    if (_hooks && typeof _hooks.applyWorkingKeys === "function") {
      _hooks.applyWorkingKeys(k);
    }
  }

  function setActive(id, options) {
    const next = id === "sample" ? "sample" : "real";
    const prev = _active;
    _active = next;
    storage().setItem(ACTIVE_KEY, next);
    applyWorkingKeys();
    if (next === "sample" && (prev !== "sample" || (options && options.forceWarnReset))) {
      armSampleEntry();
    }
    if (next !== "sample") {
      clearIntroTimer();
      session().removeItem(ENTRY_SESSION_KEY);
    }
  }

  function armSampleEntry() {
    session().setItem(ENTRY_SESSION_KEY, String(Date.now()));
    session().setItem(INTRO_SESSION_KEY, "1");
    storage().removeItem(WARN_DISMISSED_AT_KEY);
  }

  function ensureSampleSeeded(todayKey) {
    if (!sampleStoreEmpty()) return false;
    const payload = seedPayload(todayKey || dayKeyFromDate(new Date()));
    writeSampleStore(payload);
    return true;
  }

  function resetSample(todayKey) {
    const payload = seedPayload(todayKey || dayKeyFromDate(new Date()));
    writeSampleStore(payload);
    if (isSample() && _hooks && typeof _hooks.reloadActive === "function") {
      _hooks.reloadActive();
    }
    armSampleEntry();
    return payload;
  }

  function createReal(displayName) {
    const name = String(displayName || "").trim() || "My tracking";
    storage().setItem(REAL_CREATED_KEY, "1");
    storage().setItem(REAL_NAME_KEY, name);
    // Real store starts empty — do not wipe if user somehow already has Real data.
    if (!realHasData()) {
      const k = KEYS.real;
      const store = storage();
      const emptySettings = {
        goals: {
          kcal: 2200, protein: 140, carbs: 250, fat: 70, fiber: 28, sodium: 2300, potassium: 3510,
        },
        goalsUpdatedAt: 0,
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
      store.setItem(k.settings, JSON.stringify(emptySettings));
      store.setItem(k.personal, "[]");
      store.setItem(k.events, "[]");
      store.setItem(k.reset, String(Date.now()));
    }
    setActive("real");
    if (_hooks && typeof _hooks.reloadActive === "function") _hooks.reloadActive();
    return { name };
  }

  function renameReal(displayName) {
    const name = String(displayName || "").trim();
    if (!name) return realDisplayName();
    storage().setItem(REAL_NAME_KEY, name);
    return name;
  }

  /**
   * First boot: seed Sample; empty installs land on Sample; existing Real data stays Real.
   */
  function bootstrap(hooks) {
    _hooks = hooks || {};
    const todayKey = (_hooks.todayKey && _hooks.todayKey()) || dayKeyFromDate(new Date());
    ensureSampleSeeded(todayKey);

    const stored = storage().getItem(ACTIVE_KEY);
    const hasReal = realHasData();
    if (hasReal) {
      if (!realCreated()) storage().setItem(REAL_CREATED_KEY, "1");
      setActive(stored === "sample" ? "sample" : "real");
    } else if (realCreated() && stored === "real") {
      setActive("real");
    } else {
      // Empty Real → first-run Sample experience.
      setActive("sample", { forceWarnReset: true });
    }
    return { active: _active, seeded: true };
  }

  function switchTo(id) {
    const next = id === "sample" ? "sample" : "real";
    if (next === "real" && !realCreated()) {
      return { ok: false, reason: "real-missing" };
    }
    if (next === _active) return { ok: true, active: _active };
    setActive(next, { forceWarnReset: next === "sample" });
    if (_hooks && typeof _hooks.reloadActive === "function") _hooks.reloadActive();
    return { ok: true, active: _active };
  }

  function warnNeeded() {
    if (!isSample()) return false;
    const last = Number(storage().getItem(WARN_DISMISSED_AT_KEY) || 0);
    if (!last) return true;
    return (Date.now() - last) >= WARN_COOLDOWN_MS;
  }

  function markWarnDismissed() {
    storage().setItem(WARN_DISMISSED_AT_KEY, String(Date.now()));
  }

  function clearIntroTimer() {
    if (_introTimer) {
      clearTimeout(_introTimer);
      _introTimer = null;
    }
  }

  function scheduleIntro(showIntro) {
    clearIntroTimer();
    if (!isSample()) return;
    if (session().getItem(INTRO_SESSION_KEY) !== "1") return;
    _introTimer = setTimeout(() => {
      _introTimer = null;
      if (!isSample()) return;
      session().removeItem(INTRO_SESSION_KEY);
      if (typeof showIntro === "function") showIntro();
    }, INTRO_DELAY_MS);
  }

  /**
   * Gate a mutating action while Sample is active.
   * If a warning is due, show it and run `action` after OK (or skip if cancelled).
   */
  function guardMutation(action, showWarn) {
    if (!isSample() || !warnNeeded()) {
      return typeof action === "function" ? action() : undefined;
    }
    _pendingMutation = typeof action === "function" ? action : null;
    if (typeof showWarn === "function") {
      showWarn({
        onOk() {
          markWarnDismissed();
          const fn = _pendingMutation;
          _pendingMutation = null;
          if (fn) fn();
        },
        onGoToProfile() {
          markWarnDismissed();
          _pendingMutation = null;
          if (_hooks && typeof _hooks.openProfileSettings === "function") {
            _hooks.openProfileSettings();
          }
        },
        onCancel() {
          _pendingMutation = null;
        },
      });
    } else {
      markWarnDismissed();
      if (_pendingMutation) _pendingMutation();
      _pendingMutation = null;
    }
  }

  function init(hooks) {
    _hooks = Object.assign(_hooks || {}, hooks || {});
  }

  return {
    KEYS,
    WARN_COOLDOWN_MS,
    INTRO_DELAY_MS,
    ACTIVE_KEY,
    REAL_CREATED_KEY,
    bootstrap,
    init,
    isSample,
    activeId,
    realCreated,
    realDisplayName,
    renameReal,
    workingKeys,
    keysFor,
    ensureSampleSeeded,
    resetSample,
    createReal,
    switchTo,
    warnNeeded,
    markWarnDismissed,
    scheduleIntro,
    clearIntroTimer,
    guardMutation,
    armSampleEntry,
    realHasData,
    sampleStoreEmpty,
  };
})();

if (typeof module !== "undefined") module.exports = SampleProfile;
