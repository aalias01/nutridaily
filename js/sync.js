/* NutriDaily — offline-first sync engine.
 * localStorage is the working copy; the user's Google Drive is durability.
 *
 * Merge model (why sync is conflict-free here):
 *  - Ledger events are IMMUTABLE and have unique ids → merging two devices
 *    is just the set-union of events, re-sorted by timestamp. No conflicts,
 *    no lost updates — a direct payoff of the event-sourced design.
 *  - personalFoods merge by id, newest updatedAt wins; deletes are tombstones
 *    ({deleted:true}) so they propagate across devices instead of resurrecting.
 *  - goals: newest goalsUpdatedAt wins.
 */
const Sync = (() => {
  const ENABLED_KEY = "nd_sync_enabled";
  const EMAIL_KEY = "nd_sync_email";
  const PUSH_DELAY = 4000;

  let deps = null;      // injected accessors { getPersonal, setPersonal, getGoals, setGoals, onStatus, onRemoteApplied }
  let fileId = null;
  let timer = null;
  let running = false;
  let queued = false;
  let lastSync = null;

  const state = () => ({
    enabled: localStorage.getItem(ENABLED_KEY) === "1",
    email: localStorage.getItem(EMAIL_KEY) || "",
    lastSync,
  });

  const setStatus = (s, detail) => deps && deps.onStatus && deps.onStatus(s, detail || "");

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

  function mergeDocs(local, remote) {
    const events = mergeEvents(local.events, remote.events);
    const personalFoods = mergePersonal(local.personalFoods, remote.personalFoods);
    const goalsLocalNewer = (local.goalsUpdatedAt || 0) >= (remote.goalsUpdatedAt || 0);
    const merged = {
      version: 1,
      updatedAt: Date.now(),
      events,
      personalFoods,
      goals: goalsLocalNewer ? local.goals : remote.goals,
      goalsUpdatedAt: Math.max(local.goalsUpdatedAt || 0, remote.goalsUpdatedAt || 0),
    };
    return {
      doc: merged,
      differsFromLocal: fingerprint(merged) !== fingerprint(local),
      differsFromRemote: fingerprint(merged) !== fingerprint(remote),
    };
  }

  function fingerprint(doc) {
    const ev = (doc.events || []).map((e) => e.id).sort().join(",");
    const pf = (doc.personalFoods || []).map((f) => `${f.id}:${f.updatedAt || 0}:${f.deleted ? 1 : 0}`).sort().join(",");
    return `${ev}|${pf}|${JSON.stringify(doc.goals || {})}`;
  }

  // ---------- doc <-> app state ----------
  function localDoc() {
    return {
      version: 1,
      updatedAt: Date.now(),
      events: Ledger.allEvents(),
      personalFoods: deps.getPersonal(),
      goals: deps.getGoals(),
      goalsUpdatedAt: deps.getGoalsUpdatedAt ? deps.getGoalsUpdatedAt() : 0,
    };
  }

  function applyDoc(doc) {
    Ledger.replaceAll(doc.events || []);
    deps.setPersonal(doc.personalFoods || []);
    if (doc.goals) deps.setGoals(doc.goals, doc.goalsUpdatedAt || 0);
    if (deps.onRemoteApplied) deps.onRemoteApplied();
  }

  // ---------- sync cycles ----------
  async function fullSync(interactive) {
    if (running) { queued = true; return; }
    running = true;
    setStatus("syncing");
    try {
      if (!fileId) {
        const r = await GDrive.ensureFile(localDoc());
        fileId = r.fileId;
        if (r.created) { done("ok"); return; } // fresh file already holds local state
      }
      const remote = await GDrive.readFile(fileId).catch(() => ({ version: 1, events: [], personalFoods: [], goals: null }));
      const { doc, differsFromLocal, differsFromRemote } = mergeDocs(localDoc(), remote);
      if (differsFromLocal) applyDoc(doc);
      if (differsFromRemote) await GDrive.writeFile(fileId, doc);
      done("ok");
    } catch (err) {
      running = false;
      const authy = /sign-in|401|none|credential/i.test(err.message || "");
      setStatus(authy ? "auth" : "error", err.message);
      if (authy && interactive) throw err;
    }
    function done(s) {
      running = false;
      lastSync = Date.now();
      setStatus(s);
      if (queued) { queued = false; schedulePush(); }
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
    await fullSync(true);
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
      await GDrive.getToken(false); // silent; throws if consent needed again
      await fullSync(false);
    } catch (e) {
      setStatus("auth", "Tap to re-connect Google Drive");
    }
  }

  function init(d) { deps = d; }

  return { init, connect, disconnect, resume, schedulePush, fullSync, state, mergeDocs, mergeEvents, mergePersonal };
})();

if (typeof module !== "undefined") module.exports = Sync;
