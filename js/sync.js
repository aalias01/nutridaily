/* NutriDaily — offline-first sync engine.
 * localStorage is the working copy; the user's Google Drive is durability.
 *
 * Merge model (why sync is conflict-free here):
 *  - Ledger events are IMMUTABLE and have unique ids → merging two devices
 *    is just the set-union of events, re-sorted by timestamp. No conflicts,
 *    no lost updates — a direct payoff of the event-sourced design.
 *  - personalFoods merge by id, newest updatedAt wins; deletes are tombstones
 *    ({deleted:true}) so they propagate across devices instead of resurrecting.
 *  - goals: newest goalsUpdatedAt wins (derived mirror of active phase revision).
 *  - dayGoals: per-day bumps (or legacy absolute overrides) merge by day key, newest updatedAt wins.
 *  - phases: union by id; revisions union by id (append-only goal timeline).
 *  - weights: per-day body weight, newest updatedAt wins.
 *  - resetAt: Clear-all / full Import bumps this. The side with the newer reset
 *    is the base; the other side only contributes events/foods at or after that
 *    timestamp, so a wipe is not undone by the next Drive merge.
 */
const Sync = (() => {
  const ENABLED_KEY = "nd_sync_enabled";
  const EMAIL_KEY = "nd_sync_email";
  const RESET_KEY = "nd_reset_at";
  const PUSH_DELAY = 4000;
  const DOC_VERSION = 2;

  let deps = null;      // injected accessors
  let fileId = null;
  let timer = null;
  let running = false;
  let queued = false;
  let lastSync = null;
  let lastStatus = { s: "off", detail: "" };

  const state = () => ({
    enabled: localStorage.getItem(ENABLED_KEY) === "1",
    email: localStorage.getItem(EMAIL_KEY) || "",
    lastSync,
    status: lastStatus.s,
    detail: lastStatus.detail,
  });

  const setStatus = (s, detail) => {
    lastStatus = { s, detail: detail || "" };
    if (deps && deps.onStatus) deps.onStatus(s, detail || "");
  };

  // ---------- pure merge (unit-tested) ----------
  function mergeEvents(a, b) {
    const map = new Map();
    for (const e of [...(a || []), ...(b || [])]) if (e && e.id && !map.has(e.id)) map.set(e.id, e);
    return [...map.values()].sort((x, y) => (x.ts - y.ts) || String(x.id).localeCompare(String(y.id)));
  }

  function mergePersonal(a, b) {
    const map = new Map();
    for (const f of [...(a || []), ...(b || [])]) {
      if (!f || !f.id) continue;
      const cur = map.get(f.id);
      if (!cur || (f.updatedAt || 0) > (cur.updatedAt || 0)) map.set(f.id, f);
    }
    return [...map.values()];
  }

  function mergeDayGoals(a, b) {
    const out = { ...(a || {}) };
    for (const [day, ov] of Object.entries(b || {})) {
      if (!ov || typeof ov !== "object") continue;
      const cur = out[day];
      if (!cur || (ov.updatedAt || 0) >= (cur.updatedAt || 0)) out[day] = { ...ov };
    }
    return out;
  }

  function mergePhases(a, b) {
    if (typeof Phases !== "undefined" && Phases.mergePhases) return Phases.mergePhases(a, b);
    return Array.isArray(a) && a.length ? a : (b || []);
  }

  function mergeWeights(a, b) {
    if (typeof Phases !== "undefined" && Phases.mergeWeights) return Phases.mergeWeights(a, b);
    const out = { ...(a || {}) };
    for (const [day, w] of Object.entries(b || {})) {
      if (!w || typeof w !== "object") continue;
      const cur = out[day];
      if (!cur || (w.updatedAt || 0) >= (cur.updatedAt || 0)) out[day] = { ...w };
    }
    return out;
  }

  /** Active (non-cleared) day overrides for HUD / settings. */
  function activeDayGoals(map) {
    const out = {};
    for (const [day, ov] of Object.entries(map || {})) {
      if (ov && !ov.cleared) out[day] = ov;
    }
    return out;
  }

  function getResetAt() {
    const n = Number(localStorage.getItem(RESET_KEY) || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function setResetAt(ts) {
    localStorage.setItem(RESET_KEY, String(ts || Date.now()));
  }

  function filterDayGoalsAfter(map, ts) {
    const out = {};
    for (const [day, ov] of Object.entries(map || {})) {
      if ((ov && ov.updatedAt || 0) >= ts) out[day] = ov;
    }
    return out;
  }

  function filterPhasesAfter(phases, ts) {
    if (typeof Phases !== "undefined" && Phases.filterPhasesAfter) return Phases.filterPhasesAfter(phases, ts);
    return (phases || []).filter((p) => (p.updatedAt || 0) >= ts || (p.createdAt || 0) >= ts);
  }

  function filterWeightsAfter(map, ts) {
    if (typeof Phases !== "undefined" && Phases.filterWeightsAfter) return Phases.filterWeightsAfter(map, ts);
    const out = {};
    for (const [day, w] of Object.entries(map || {})) {
      if ((w && w.updatedAt || 0) >= ts) out[day] = w;
    }
    return out;
  }

  function mergeDocs(local, remote) {
    const localReset = local.resetAt || 0;
    const remoteReset = remote.resetAt || 0;
    const resetAt = Math.max(localReset, remoteReset);
    let events;
    let personalFoods;
    let dayGoals;
    let phases;
    let weights;
    let profile;
    if (localReset > remoteReset) {
      const remoteEv = (remote.events || []).filter((e) => (e.ts || 0) >= localReset);
      const remotePf = (remote.personalFoods || []).filter((f) => (f.updatedAt || 0) >= localReset);
      events = mergeEvents(local.events, remoteEv);
      personalFoods = mergePersonal(local.personalFoods, remotePf);
      dayGoals = mergeDayGoals(local.dayGoals, filterDayGoalsAfter(remote.dayGoals, localReset));
      phases = mergePhases(local.phases, filterPhasesAfter(remote.phases, localReset));
      weights = mergeWeights(local.weights, filterWeightsAfter(remote.weights, localReset));
      profile = mergeProfiles(local.profile, remote.profile);
    } else if (remoteReset > localReset) {
      const localEv = (local.events || []).filter((e) => (e.ts || 0) >= remoteReset);
      const localPf = (local.personalFoods || []).filter((f) => (f.updatedAt || 0) >= remoteReset);
      events = mergeEvents(localEv, remote.events);
      personalFoods = mergePersonal(localPf, remote.personalFoods);
      dayGoals = mergeDayGoals(filterDayGoalsAfter(local.dayGoals, remoteReset), remote.dayGoals);
      phases = mergePhases(filterPhasesAfter(local.phases, remoteReset), remote.phases);
      weights = mergeWeights(filterWeightsAfter(local.weights, remoteReset), remote.weights);
      profile = mergeProfiles(local.profile, remote.profile);
    } else {
      events = mergeEvents(local.events, remote.events);
      personalFoods = mergePersonal(local.personalFoods, remote.personalFoods);
      dayGoals = mergeDayGoals(local.dayGoals, remote.dayGoals);
      phases = mergePhases(local.phases, remote.phases);
      weights = mergeWeights(local.weights, remote.weights);
      profile = mergeProfiles(local.profile, remote.profile);
    }
    const goalsLocalNewer = (local.goalsUpdatedAt || 0) >= (remote.goalsUpdatedAt || 0);
    const merged = {
      version: DOC_VERSION,
      updatedAt: Date.now(),
      resetAt,
      events,
      personalFoods,
      dayGoals,
      phases,
      weights,
      profile,
      goals: goalsLocalNewer ? local.goals : remote.goals,
      goalsUpdatedAt: Math.max(local.goalsUpdatedAt || 0, remote.goalsUpdatedAt || 0),
    };
    return {
      doc: merged,
      differsFromLocal: fingerprint(merged) !== fingerprint(local),
      differsFromRemote: fingerprint(merged) !== fingerprint(remote),
    };
  }

  function mergeProfiles(a, b) {
    if (typeof Phases !== "undefined" && Phases.mergeProfiles) return Phases.mergeProfiles(a, b);
    const A = a || {};
    const B = b || {};
    return ((B.updatedAt || 0) >= (A.updatedAt || 0)) ? { ...B } : { ...A };
  }

  function fingerprint(doc) {
    const ev = (doc.events || []).map((e) => e.id).sort().join(",");
    const pf = (doc.personalFoods || []).map((f) => `${f.id}:${f.updatedAt || 0}:${f.deleted ? 1 : 0}`).sort().join(",");
    const dg = Object.keys(doc.dayGoals || {}).sort().map((d) => {
      const o = doc.dayGoals[d] || {};
      const b = o.bumps || {};
      return `${d}:${o.updatedAt || 0}:${o.cleared ? 1 : 0}:${b.kcal || o.kcal || ""}:${b.protein || o.protein || ""}`;
    }).join(",");
    const ph = (doc.phases || []).map((p) => {
      const revs = (p.revisions || []).map((r) => r.id).sort().join("+");
      return `${p.id}:${p.updatedAt || 0}:${p.endDay || ""}:${revs}`;
    }).sort().join(",");
    const wt = Object.keys(doc.weights || {}).sort().map((d) => {
      const w = doc.weights[d] || {};
      return `${d}:${w.updatedAt || 0}:${w.kg || ""}:${w.cleared ? 1 : 0}`;
    }).join(",");
    const pr = doc.profile || {};
    const profileFp = `${pr.updatedAt || 0}:${pr.dob || ""}:${pr.sex || ""}:${pr.heightCm || ""}:${pr.activity || ""}`;
    return `${doc.resetAt || 0}|${ev}|${pf}|${dg}|${ph}|${wt}|${profileFp}|${JSON.stringify(doc.goals || {})}`;
  }

  // ---------- doc <-> app state ----------
  function localDoc() {
    return {
      version: DOC_VERSION,
      updatedAt: Date.now(),
      resetAt: getResetAt(),
      events: Ledger.allEvents(),
      personalFoods: deps.getPersonal(),
      dayGoals: deps.getDayGoals ? deps.getDayGoals() : {},
      phases: deps.getPhases ? deps.getPhases() : [],
      weights: deps.getWeights ? deps.getWeights() : {},
      profile: deps.getProfile ? deps.getProfile() : {},
      goals: deps.getGoals(),
      goalsUpdatedAt: deps.getGoalsUpdatedAt ? deps.getGoalsUpdatedAt() : 0,
    };
  }

  function applyDoc(doc) {
    if ((doc.resetAt || 0) > getResetAt()) setResetAt(doc.resetAt);
    Ledger.replaceAll(doc.events || []);
    deps.setPersonal(doc.personalFoods || []);
    if (doc.goals) deps.setGoals(doc.goals, doc.goalsUpdatedAt || 0);
    if (deps.setDayGoals) deps.setDayGoals(doc.dayGoals || {});
    if (deps.setPhases) {
      if (Array.isArray(doc.phases)) deps.setPhases(doc.phases);
    }
    if (deps.setWeights) {
      if (doc.weights && typeof doc.weights === "object") deps.setWeights(doc.weights);
    }
    if (deps.setProfile && doc.profile && typeof doc.profile === "object") {
      deps.setProfile(doc.profile);
    }
    if (deps.onRemoteApplied) deps.onRemoteApplied();
  }

  // ---------- sync cycles ----------
  async function fullSync(interactive) {
    if (running) { queued = true; return { ok: false, busy: true }; }
    running = true;
    setStatus("syncing");
    try {
      if (!fileId) {
        const r = await GDrive.ensureFile(localDoc());
        fileId = r.fileId;
        if (r.created) {
          running = false;
          lastSync = Date.now();
          setStatus("ok");
          if (queued) { queued = false; schedulePush(); }
          return { ok: true };
        }
      }
      let remote;
      try {
        remote = await GDrive.readFile(fileId);
      } catch (err) {
        if (/404|not found|trash/i.test(String(err.message || err))) {
          fileId = null;
          const r = await GDrive.ensureFile(localDoc());
          fileId = r.fileId;
          running = false;
          lastSync = Date.now();
          setStatus("ok");
          if (queued) { queued = false; schedulePush(); }
          return { ok: true };
        }
        throw err;
      }
      // Newer schema from another device: apply but avoid writing a stripped doc
      if ((remote.version || 1) > DOC_VERSION) {
        applyDoc(remote);
        running = false;
        lastSync = Date.now();
        setStatus("warn", "Update this app to keep syncing phases");
        return { ok: true, upgrade: true };
      }
      const { doc, differsFromLocal, differsFromRemote } = mergeDocs(localDoc(), remote);
      if (differsFromLocal) applyDoc(doc);
      if (differsFromRemote) await GDrive.writeFile(fileId, doc);
      running = false;
      lastSync = Date.now();
      setStatus("ok");
      if (queued) { queued = false; schedulePush(); }
      return { ok: true };
    } catch (err) {
      running = false;
      const authy = /sign-in|401|none|credential/i.test(err.message || "");
      setStatus(authy ? "auth" : "error", err.message);
      if (interactive) throw err;
      return { ok: false, error: err };
    }
  }

  /** Debounced push after local mutations. */
  function schedulePush() {
    if (!state().enabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => fullSync(false), PUSH_DELAY);
    setStatus("pending");
  }

  /** Interactive connect (call from a click). */
  async function connect() {
    await GDrive.getToken(true);
    const email = await GDrive.userEmail();
    localStorage.setItem(ENABLED_KEY, "1");
    localStorage.setItem(EMAIL_KEY, email);
    const r = await fullSync(true);
    if (r && r.busy) return email;
    if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || "Sync failed");
    return email;
  }

  function disconnect() {
    localStorage.setItem(ENABLED_KEY, "0");
    localStorage.removeItem(EMAIL_KEY);
    GDrive.signOut();
    fileId = null;
    setStatus("off");
  }

  /** On app start: silent resume if previously connected. */
  async function resume() {
    if (!state().enabled) { setStatus("off"); return; }
    if (!GDrive.canUse()) { setStatus("error", GDrive.unavailableReason()); return; }
    try {
      await GDrive.getToken(false);
      await fullSync(false);
    } catch (e) {
      setStatus("auth", "Tap to re-connect Google Drive");
    }
  }

  /** Mark a local wipe/replace so the next merge does not resurrect old remote data. */
  function markReset(ts) {
    setResetAt(ts || Date.now());
  }

  function init(d) { deps = d; }

  return {
    init, connect, disconnect, resume, schedulePush, fullSync, state,
    mergeDocs, mergeEvents, mergePersonal, mergeDayGoals, mergePhases, mergeWeights, mergeProfiles,
    activeDayGoals, markReset, getResetAt, fingerprint, DOC_VERSION,
  };
})();

if (typeof module !== "undefined") module.exports = Sync;
