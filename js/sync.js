/* NutriDaily — offline-first sync engine.
 * localStorage is the working copy; the user's Google Drive is durability.
 *
 * Merge model:
 *  - Ledger events are IMMUTABLE and have unique ids → merging two devices
 *    is the set-union of events. Per-entry causal reduction handles skewed
 *    timestamps. Devices write independent Drive shards, so stale reads cannot
 *    erase another device's events.
 *  - personalFoods merge by id, newest updatedAt wins; deletes are tombstones
 *    ({deleted:true}) so they propagate across devices instead of resurrecting.
 *  - goals: newest goalsUpdatedAt wins (derived mirror of active phase revision).
 *  - dayGoals: one-day calorie bumps merge by day key, newest updatedAt wins.
 *    Legacy absolute kcal overrides are retained only until phase-aware migration;
 *    all non-calorie override fields are discarded at the sync boundary.
 *  - dayPlans: per-day close-the-gap plans merge by day key, newest updatedAt wins.
 *  - phases: union by id; revisions are LWW by id and deletes use tombstones.
 *  - weights: per-day body weight, newest updatedAt wins.
 *  - resetAt: Clear-all / full Import bumps this. The side with the newer reset
 *    establishes a causal privacy generation. Records created in older or
 *    missing generations are discarded as complete identities; wall clocks
 *    never authorize resurrection. Legacy missing-generation data is treated
 *    as generation zero, so it remains usable before a reset and is removed by
 *    the first reset (the privacy-first fallback).
 *
 * Auth: background pushes never open a sign-in UI. Silent re-auth via
 * GDrive.silentBoot (BFF refresh cookie, or GIS prompt:none fallback).
 * Interactive connect redirects to /api/auth/start when needed.
 */
const Sync = (() => {
  const ENABLED_KEY = "nd_sync_enabled";
  const EMAIL_KEY = "nd_sync_email";
  const RESET_KEY = "nd_reset_at";
  const GENERATION_SCHEMA_KEY = "nd_generation_schema_version";
  const PUSH_DELAY = 4000;
  const DOC_VERSION = 4;
  const GENERATION_SCHEMA_VERSION = 1;
  const AUTH_DETAIL = "Tap to re-connect Google Drive";
  /** Real devices drift; five minutes is enough tolerance without making a bad clock authoritative. */
  const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

  let deps = null;      // injected accessors
  let timer = null;
  let running = false;
  let queued = false;
  let dirtyPending = false;
  let lastSync = null;
  let lastStatus = { s: "off", detail: "" };
  let visibilityWired = false;
  let refreshPushInflight = false;
  let connectionSerial = 0;

  class PersistenceError extends Error {
    constructor(operation, cause) {
      super(`Could not ${operation} sync settings on this device. Check browser storage, then try again.`);
      this.name = "PersistenceError";
      this.code = "sync-persistence-failed";
      this.operation = operation;
      this.cause = cause;
    }
  }

  class FutureClockError extends Error {
    constructor(path, value, now) {
      super(`Sync paused: ${path} is too far in the future. Correct this device's date and time, then try again.`);
      this.name = "FutureClockError";
      this.code = "sync-future-clock";
      this.path = path;
      this.value = value;
      this.now = now;
    }
  }

  function setLocal(key, value, operation) {
    try { localStorage.setItem(key, String(value)); }
    catch (e) { throw new PersistenceError(operation || "save", e); }
  }

  function removeLocal(key, operation) {
    try { localStorage.removeItem(key); }
    catch (e) { throw new PersistenceError(operation || "clear", e); }
  }

  function getLocal(key, operation) {
    try { return localStorage.getItem(key); }
    catch (e) { throw new PersistenceError(operation || "read", e); }
  }

  const state = () => ({
    enabled: getLocal(ENABLED_KEY, "read") === "1",
    email: getLocal(EMAIL_KEY, "read") || "",
    lastSync,
    status: lastStatus.s,
    detail: lastStatus.detail,
  });

  function activeTabReady() {
    return typeof window === "undefined" || window.__ndActiveTabReady !== false;
  }

  const setStatus = (s, detail) => {
    lastStatus = { s, detail: detail || "" };
    if (deps && deps.onStatus) deps.onStatus(s, detail || "");
  };

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== "object") return value;
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }

  const stableText = (value) => JSON.stringify(stableValue(value));
  const safeGeneration = (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };

  function generationSchemaVersion(doc) {
    const raw = doc && doc.generationSchemaVersion;
    if (raw == null || raw === "") return 0;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      const error = new Error("Sync generation schema marker is invalid.");
      error.code = "sync-schema-invalid";
      throw error;
    }
    if (value > GENERATION_SCHEMA_VERSION) {
      const error = new Error("This Drive data uses a newer privacy schema. Update NutriDaily before syncing.");
      error.code = "drive-newer-schema";
      throw error;
    }
    return value;
  }

  /** Validate every persisted conflict/privacy clock before filtering can hide it. */
  function validateDocClocks(doc, opts) {
    const now = Number(opts && opts.now != null ? opts.now : Date.now());
    const max = now + Number(opts && opts.maxFutureSkewMs != null
      ? opts.maxFutureSkewMs : MAX_FUTURE_SKEW_MS);
    const clockKey = (key) => key === "ts" || key === "resetAt" || key === "resetEpoch" ||
      key === "goalsResetEpoch" || key === "goalsUpdatedAt" || key === "plannedAt" ||
      key === "addedTs" || /(?:created|updated|deleted|lastUsed)At$/i.test(key);
    const visit = (value, path, parentKey) => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, parentKey));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        const tombstoneClock = parentKey === "revisionTombstones" || parentKey === "revisionTombstoneEpochs";
        if ((clockKey(key) || tombstoneClock) && child != null && child !== "") {
          const n = Number(child);
          if (Number.isFinite(n) && n > max) throw new FutureClockError(childPath, n, now);
        }
        visit(child, childPath, key);
      }
    };
    visit(doc || {}, "", "");
    return true;
  }
  function lwwPick(a, b, clock, tombstone) {
    if (!a) return b;
    if (!b) return a;
    const ac = Number(a[clock]) || 0, bc = Number(b[clock]) || 0;
    if (ac !== bc) return bc > ac ? b : a;
    const ad = !!(a[tombstone] || a.deleted), bd = !!(b[tombstone] || b.deleted);
    if (ad !== bd) return bd ? b : a;
    return stableText(b) > stableText(a) ? b : a;
  }

  function isAuthErr(err) {
    const m = (err && err.message) || "";
    return m === GDrive.NEEDS_AUTH ||
      /sign-in|401|none|credential|needs-auth|insufficient|scope|Drive permission was not granted/i.test(m);
  }

  // ---------- pure merge (unit-tested) ----------
  function mergeEvents(a, b) {
    const map = new Map();
    for (const e of [...(a || []), ...(b || [])]) {
      if (!e || !e.id) continue;
      const text = stableText(e);
      const cur = map.get(e.id);
      // Event ids should be globally unique. If corrupt shards reuse one, a
      // canonical tie-break keeps every device convergent instead of preferring
      // whichever payload happened to be local. Parsing the canonical text also
      // makes semantically identical objects with different key insertion order
      // byte-identical after merge.
      if (!cur || text > cur.text) map.set(e.id, { text, event: JSON.parse(text) });
    }
    return [...map.values()].map((item) => item.event).sort((x, y) =>
      ((Number(x.ts) || 0) - (Number(y.ts) || 0)) ||
      String(x.id).localeCompare(String(y.id)) ||
      stableText(x).localeCompare(stableText(y))
    );
  }

  function mergePersonal(a, b) {
    const map = new Map();
    for (const f of [...(a || []), ...(b || [])]) {
      if (!f || !f.id) continue;
      const cur = map.get(f.id);
      map.set(f.id, lwwPick(cur, f, "updatedAt", "deleted"));
    }
    return [...map.values()].sort((x, y) => String(x.id).localeCompare(String(y.id)));
  }

  function normalizeDayGoal(ov) {
    if (!ov || typeof ov !== "object") return null;
    const updatedAt = Number.isFinite(Number(ov.updatedAt)) ? Number(ov.updatedAt) : 0;
    const resetEpoch = safeGeneration(ov.resetEpoch);
    const generation = Object.prototype.hasOwnProperty.call(ov, "resetEpoch") ? { resetEpoch } : {};
    if (ov.cleared) return { cleared: true, updatedAt, ...generation };

    // Current records freeze both sides of the plan. Whitelist only the
    // calorie-plan fields so arbitrary imported/synced properties never ride
    // along with settings data.
    const targetKcal = Number(ov.targetKcal);
    const baseKcal = Number(ov.baseKcal);
    if (Number.isFinite(targetKcal) && targetKcal >= 800 && targetKcal <= 6000 &&
        Number.isFinite(baseKcal) && baseKcal >= 800 && baseKcal <= 6000) {
      const locked = ov.locked === true || (typeof ov.lockedByEventId === "string" && ov.lockedByEventId);
      if (targetKcal === baseKcal && !locked) return { cleared: true, updatedAt, ...generation };
      const out = { targetKcal, baseKcal, updatedAt, ...generation };
      const plannedAt = Number(ov.plannedAt);
      if (Number.isFinite(plannedAt) && plannedAt >= 0) out.plannedAt = plannedAt;
      if (ov.veryLowCalorieAcknowledged === true) out.veryLowCalorieAcknowledged = true;
      if (locked) {
        out.locked = true;
        if (typeof ov.lockedByEventId === "string") out.lockedByEventId = ov.lockedByEventId.slice(0, 160);
      }
      return out;
    }

    if (ov.bumps && typeof ov.bumps === "object") {
      const raw = ov.bumps.kcal;
      const kcal = raw == null || raw === "" ? NaN : Number(raw);
      if (Number.isFinite(kcal) && kcal !== 0) {
        const out = { bumps: { kcal }, updatedAt, ...generation };
        const plannedAt = Number(ov.plannedAt);
        if (Number.isFinite(plannedAt) && plannedAt >= 0) out.plannedAt = plannedAt;
        if (ov.veryLowCalorieAcknowledged === true) out.veryLowCalorieAcknowledged = true;
        return out;
      }
      // A newer legacy safety/macro-only row must still defeat an older calorie
      // override for the same day. Turn it into a calorie clear tombstone.
      return { cleared: true, updatedAt, ...generation };
    }

    // Pre-bump documents stored absolute daily goals. Preserve only absolute
    // kcal until Phases can convert it against that day's historical target.
    const rawKcal = ov.kcal;
    const kcal = rawKcal == null || rawKcal === "" ? NaN : Number(rawKcal);
    if (Number.isFinite(kcal) && kcal >= 800 && kcal <= 6000) {
      const out = { kcal, updatedAt, ...generation };
      const plannedAt = Number(ov.plannedAt);
      if (Number.isFinite(plannedAt) && plannedAt >= 0) out.plannedAt = plannedAt;
      if (ov.veryLowCalorieAcknowledged === true) out.veryLowCalorieAcknowledged = true;
      return out;
    }
    return { cleared: true, updatedAt, ...generation };
  }

  function normalizeDayGoals(map) {
    const out = Object.create(null);
    for (const [day, ov] of Object.entries(map || {})) {
      const normalized = normalizeDayGoal(ov);
      if (normalized) out[day] = normalized;
    }
    return out;
  }

  function mergeDayGoals(a, b) {
    const out = normalizeDayGoals(a);
    for (const [day, ov] of Object.entries(normalizeDayGoals(b))) {
      const cur = out[day];
      out[day] = lwwPick(cur, ov, "updatedAt", "cleared");
    }
    return out;
  }

  /** Day plans are not nutrient overrides; merge their complete records. */
  function mergeDayPlans(a, b) {
    const out = Object.create(null);
    for (const [day, plan] of Object.entries(a || {})) {
      if (plan && typeof plan === "object") out[day] = { ...plan };
    }
    for (const [day, plan] of Object.entries(b || {})) {
      if (!plan || typeof plan !== "object") continue;
      const cur = out[day];
      out[day] = { ...lwwPick(cur, plan, "updatedAt", "cleared") };
    }
    return out;
  }

  function mergePhases(a, b, events) {
    if (typeof Phases !== "undefined" && Phases.mergePhases) return Phases.mergePhases(a, b, events);
    return Array.isArray(a) && a.length ? a : (b || []);
  }

  function mergeWeights(a, b) {
    if (typeof Phases !== "undefined" && Phases.mergeWeights) return Phases.mergeWeights(a, b);
    const out = Object.create(null);
    for (const [day, w] of Object.entries(a || {})) if (w && typeof w === "object") out[day] = { ...w };
    for (const [day, w] of Object.entries(b || {})) {
      if (!w || typeof w !== "object") continue;
      const cur = out[day];
      out[day] = { ...lwwPick(cur, w, "updatedAt", "deleted") };
    }
    return out;
  }

  /** Active (non-cleared) day overrides for HUD / settings. */
  function activeDayGoals(map) {
    const out = Object.create(null);
    for (const [day, ov] of Object.entries(normalizeDayGoals(map))) {
      if (ov && !ov.cleared) out[day] = ov;
    }
    return out;
  }

  function getResetAt() {
    const n = Number(getLocal(RESET_KEY, "read the reset marker") || 0);
    return Number.isFinite(n) ? n : 0;
  }

  function setResetAt(ts) {
    // Persist the schema marker before the privacy epoch so RESET_KEY remains
    // the final authoritative write in clear/import transactions.
    setLocal(GENERATION_SCHEMA_KEY, GENERATION_SCHEMA_VERSION, "save the privacy schema marker");
    setLocal(RESET_KEY, ts || Date.now(), "save the reset marker");
  }

  function filterMapGeneration(map, epoch) {
    const out = Object.create(null);
    for (const [key, record] of Object.entries(map || {})) {
      if (record && typeof record === "object" && safeGeneration(record.resetEpoch) >= epoch) {
        out[key] = record;
      }
    }
    return out;
  }

  function filterEventComponents(events, epoch) {
    if (typeof Ledger !== "undefined" && typeof Ledger.filterEventsByResetEpoch === "function") {
      return Ledger.filterEventsByResetEpoch(events || [], epoch);
    }
    // Test/legacy fallback when Ledger is not loaded: group by immutable entry
    // identity and trust only the originating add's generation.
    const groups = new Map();
    for (const event of events || []) {
      if (!event || typeof event !== "object") continue;
      const entryId = event.type === "add" ? event.entry && event.entry.id : event.target;
      if (!entryId) continue;
      const row = groups.get(entryId) || [];
      row.push(event);
      groups.set(entryId, row);
    }
    const kept = [];
    for (const rows of groups.values()) {
      const root = rows.find((event) => event.type === "add" && event.causal && event.causal.seq === 0) ||
        rows.filter((event) => event.type === "add").sort((a, b) =>
          (Number(a.ts) || 0) - (Number(b.ts) || 0) || String(a.id).localeCompare(String(b.id))
        )[0];
      if (root && safeGeneration(root.resetEpoch) >= epoch) kept.push(...rows);
    }
    return kept;
  }

  function filterPhasesGeneration(phases, epoch) {
    const out = [];
    for (const phase of phases || []) {
      if (!phase || safeGeneration(phase.resetEpoch) < epoch) continue;
      const revisionTombstones = {};
      const revisionTombstoneEpochs = {};
      for (const [id, stamp] of Object.entries(phase.revisionTombstones || {})) {
        const generation = safeGeneration(phase.revisionTombstoneEpochs && phase.revisionTombstoneEpochs[id]);
        if (generation < epoch) continue;
        revisionTombstones[id] = stamp;
        revisionTombstoneEpochs[id] = generation;
      }
      const revisions = (phase.revisions || []).filter((revision) =>
        revision && safeGeneration(revision.resetEpoch) >= epoch
      );
      if (!revisions.length) continue;
      out.push({
        ...phase,
        revisions,
        revisionTombstones,
        revisionTombstoneEpochs,
      });
    }
    return out;
  }

  function filterDocGeneration(doc, epoch, opts) {
    const d = doc || {};
    return {
      ...d,
      events: filterEventComponents(d.events, epoch),
      personalFoods: (d.personalFoods || []).filter((record) =>
        record && safeGeneration(record.resetEpoch) >= epoch
      ),
      // During raw rollout migration, preserve the exact day-goal payload for
      // the App's strict inbound normalizer. Generation stamping must not
      // accidentally sanitize an otherwise-invalid outbound candidate.
      dayGoals: filterMapGeneration(opts && opts.preserveRawDayGoals
        ? d.dayGoals : normalizeDayGoals(d.dayGoals), epoch),
      dayPlans: filterMapGeneration(d.dayPlans, epoch),
      gapDrafts: filterMapGeneration(d.gapDrafts, epoch),
      phases: filterPhasesGeneration(d.phases, epoch),
      weights: filterMapGeneration(d.weights, epoch),
      profile: d.profile && safeGeneration(d.profile.resetEpoch) >= epoch ? d.profile : null,
      goals: safeGeneration(d.goalsResetEpoch) >= epoch ? (d.goals || {}) : null,
      goalsUpdatedAt: safeGeneration(d.goalsResetEpoch) >= epoch ? (Number(d.goalsUpdatedAt) || 0) : 0,
      goalsResetEpoch: safeGeneration(d.goalsResetEpoch),
    };
  }

  function phaseBaseKcal(day, phases, goals, beforeAt, goalsUpdatedAt) {
    const cutoff = Number(beforeAt);
    const hasCutoff = Number.isFinite(cutoff) && cutoff >= 0;
    const historicalPhases = !hasCutoff ? (phases || []) : (phases || []).flatMap((phase) => {
      const phaseCreated = Number(phase && phase.createdAt) || 0;
      if (phaseCreated > cutoff) return [];
      const revisions = ((phase && phase.revisions) || []).filter((revision) => {
        const stamp = Number(revision && (revision.createdAt != null
          ? revision.createdAt : revision.updatedAt)) || 0;
        return stamp <= cutoff;
      });
      return revisions.length ? [{ ...phase, revisions }] : [];
    });
    const historicalGoals = hasCutoff && Number(goalsUpdatedAt) > cutoff ? {} : (goals || {});
    let kcal = Number(historicalGoals && historicalGoals.kcal);
    if (typeof Phases !== "undefined" && typeof Phases.goalsForDay === "function") {
      const resolved = Phases.goalsForDay(day, {
        phases: historicalPhases,
        goals: historicalGoals,
        dayGoals: {},
      });
      kcal = Number(resolved && resolved.kcal);
    }
    return Number.isFinite(kcal) && kcal >= 800 && kcal <= 6000 ? kcal : 2200;
  }

  function frozenDayGoal(day, value, phases, goals, beforeAt, goalsUpdatedAt) {
    const record = normalizeDayGoal(value);
    const baseKcal = phaseBaseKcal(day, phases, goals, beforeAt, goalsUpdatedAt);
    if (!record || record.cleared) return { targetKcal: baseKcal, baseKcal, source: record };
    let targetKcal = Number(record.targetKcal);
    let frozenBase = Number(record.baseKcal);
    if (!(Number.isFinite(targetKcal) && Number.isFinite(frozenBase))) {
      frozenBase = baseKcal;
      if (record.bumps && Number.isFinite(Number(record.bumps.kcal))) {
        targetKcal = frozenBase + Number(record.bumps.kcal);
      } else if (Number.isFinite(Number(record.kcal))) targetKcal = Number(record.kcal);
    }
    if (!Number.isFinite(targetKcal) || targetKcal < 800 || targetKcal > 6000 ||
        !Number.isFinite(frozenBase) || frozenBase < 800 || frozenBase > 6000) {
      return { targetKcal: baseKcal, baseKcal, source: record };
    }
    return { targetKcal, baseKcal: frozenBase, source: record };
  }

  /** Convert every accepted legacy override to the current frozen representation. */
  function migrateDayGoals(map, phases, goals) {
    const out = Object.create(null);
    for (const [day, raw] of Object.entries(map || {})) {
      const record = normalizeDayGoal(raw);
      if (!record) continue;
      if (record.cleared) { out[day] = record; continue; }
      const frozen = frozenDayGoal(day, record, phases, goals);
      const common = {
        updatedAt: record.updatedAt || 0,
        resetEpoch: safeGeneration(record.resetEpoch),
      };
      if (record.plannedAt != null) common.plannedAt = record.plannedAt;
      if (record.veryLowCalorieAcknowledged === true) common.veryLowCalorieAcknowledged = true;
      if (record.bumps && frozen.targetKcal !== frozen.baseKcal && !record.locked) {
        // Valid legacy relative plans remain relative until logging begins;
        // their resolved range was checked above. Absolute legacy plans migrate
        // immediately because their historical base would otherwise be lost.
        out[day] = { bumps: { kcal: Number(record.bumps.kcal) }, ...common };
      } else if (frozen.targetKcal === frozen.baseKcal && !record.locked) out[day] = { cleared: true, ...common };
      else {
        out[day] = { targetKcal: frozen.targetKcal, baseKcal: frozen.baseKcal, ...common };
        if (record.locked) {
          out[day].locked = true;
          if (record.lockedByEventId) out[day].lockedByEventId = record.lockedByEventId;
        }
      }
    }
    return out;
  }

  function rootAdds(events) {
    if (typeof Ledger !== "undefined" && typeof Ledger.rootAddEvents === "function") {
      return Ledger.rootAddEvents(events || []);
    }
    return (events || []).filter((event) => event && event.type === "add" &&
      (!event.causal || event.causal.seq === 0));
  }

  function legacyRecordGeneration(record, epoch, clockKeys) {
    if (!record || typeof record !== "object") return 0;
    if (Object.prototype.hasOwnProperty.call(record, "resetEpoch")) {
      const explicit = safeGeneration(record.resetEpoch);
      // The released pre-marker producers could materialize a missing legacy
      // epoch as zero while saving an otherwise-current record. In an
      // unmarked snapshot zero is therefore not proof of generation zero; use
      // the record clock below. A nonzero claim must already match this
      // document's own generation or the snapshot is internally inconsistent.
      if (explicit > 0) {
        if (explicit === epoch) return explicit;
        throw generationError("legacy.resetEpoch", epoch, record.resetEpoch);
      }
    }
    if (!epoch) return 0;
    for (const key of clockKeys || []) {
      if (record[key] == null || record[key] === "") continue;
      const clock = Number(record[key]);
      if (Number.isFinite(clock)) return clock >= epoch ? epoch : 0;
    }
    // With no trustworthy provenance, privacy wins. A current record from the
    // released pre-generation build normally has updatedAt/createdAt/ts at or
    // after its own reset marker; an undated row cannot prove that.
    return 0;
  }

  function eventEntryId(event) {
    if (!event || typeof event !== "object") return "";
    return String((event.causal && event.causal.entryId) ||
      (event.type === "add" && event.entry && event.entry.id) || event.target || "");
  }

  function generationError(path, expected, actual) {
    const error = new Error(
      `Sync privacy generation is invalid at ${path}; expected ${expected}, received ${actual == null ? "missing" : actual}.`
    );
    error.name = "GenerationSchemaError";
    error.code = "sync-generation-invalid";
    error.path = path;
    return error;
  }

  /** A marked snapshot may contain only records from its own reset generation. */
  function validateDocGenerations(doc) {
    if (generationSchemaVersion(doc) < GENERATION_SCHEMA_VERSION) return true;
    const epoch = safeGeneration(doc && doc.resetAt);
    const requireEpoch = (record, path, key) => {
      const field = key || "resetEpoch";
      if (!record || typeof record !== "object" ||
          !Object.prototype.hasOwnProperty.call(record, field) ||
          safeGeneration(record[field]) !== epoch) {
        throw generationError(path, epoch, record && record[field]);
      }
    };
    for (const [index, event] of (doc.events || []).entries()) {
      requireEpoch(event, `events[${index}].resetEpoch`);
    }
    for (const [index, food] of (doc.personalFoods || []).entries()) {
      requireEpoch(food, `personalFoods[${index}].resetEpoch`);
    }
    for (const key of ["dayGoals", "dayPlans", "gapDrafts", "weights"]) {
      for (const [id, record] of Object.entries(doc[key] || {})) {
        requireEpoch(record, `${key}.${id}.resetEpoch`);
      }
    }
    for (const [phaseIndex, phase] of (doc.phases || []).entries()) {
      requireEpoch(phase, `phases[${phaseIndex}].resetEpoch`);
      for (const [revisionIndex, revision] of ((phase && phase.revisions) || []).entries()) {
        requireEpoch(revision, `phases[${phaseIndex}].revisions[${revisionIndex}].resetEpoch`);
      }
      const tombstones = (phase && phase.revisionTombstones) || {};
      const epochs = (phase && phase.revisionTombstoneEpochs) || {};
      for (const id of Object.keys(tombstones)) {
        requireEpoch(epochs, `phases[${phaseIndex}].revisionTombstoneEpochs.${id}`, id);
      }
    }
    if (doc.profile && typeof doc.profile === "object") {
      requireEpoch(doc.profile, "profile.resetEpoch");
    }
    if (doc.goals && typeof doc.goals === "object") {
      requireEpoch(doc, "goalsResetEpoch", "goalsResetEpoch");
    }
    return true;
  }

  /**
   * One-time rollout bridge for v4 snapshots created before resetEpoch existed.
   * The document's own reset marker is the only generation it may claim. Where
   * a record clock proves it predates that reset, keep it in generation zero so
   * the normal privacy filter removes it. Event descendants always inherit the
   * canonical causal root's result; their own clocks/metadata cannot revive it.
   */
  function migrateLegacyGenerationDoc(doc) {
    validateDocClocks(doc || {});
    const out = detached(doc || {});
    if (generationSchemaVersion(out) >= GENERATION_SCHEMA_VERSION) {
      validateDocGenerations(out);
      return out;
    }
    const epoch = safeGeneration(out.resetAt);

    const events = Array.isArray(out.events) ? out.events : [];
    const rootGenerationByEntry = new Map();
    for (const root of rootAdds(events)) {
      rootGenerationByEntry.set(
        eventEntryId(root),
        legacyRecordGeneration(root, epoch, ["ts"])
      );
    }
    out.events = events.map((event) => ({
      ...event,
      resetEpoch: rootGenerationByEntry.has(eventEntryId(event))
        ? rootGenerationByEntry.get(eventEntryId(event))
        : legacyRecordGeneration(event, epoch, ["ts"]),
    }));

    out.personalFoods = (Array.isArray(out.personalFoods) ? out.personalFoods : []).map((food) => ({
      ...food,
      resetEpoch: legacyRecordGeneration(food, epoch, ["updatedAt", "createdAt"]),
    }));
    const stampMap = (map, clockKeys) => {
      const stamped = Object.create(null);
      for (const [key, record] of Object.entries(map || {})) {
        if (!record || typeof record !== "object") continue;
        stamped[key] = {
          ...record,
          resetEpoch: legacyRecordGeneration(record, epoch, clockKeys),
        };
      }
      return stamped;
    };
    out.dayGoals = stampMap(out.dayGoals, ["updatedAt", "plannedAt"]);
    out.dayPlans = stampMap(out.dayPlans, ["updatedAt", "createdAt"]);
    out.gapDrafts = stampMap(out.gapDrafts, ["updatedAt", "createdAt"]);
    out.weights = stampMap(out.weights, ["updatedAt", "createdAt"]);

    out.phases = (Array.isArray(out.phases) ? out.phases : []).map((phase) => {
      const revisionTombstones = { ...((phase && phase.revisionTombstones) || {}) };
      const priorEpochs = (phase && phase.revisionTombstoneEpochs) || {};
      const revisionTombstoneEpochs = Object.create(null);
      for (const [id, clockValue] of Object.entries(revisionTombstones)) {
        const explicit = Object.prototype.hasOwnProperty.call(priorEpochs, id)
          ? safeGeneration(priorEpochs[id]) : 0;
        if (explicit > 0 && explicit !== epoch) {
          throw generationError(`revisionTombstoneEpochs.${id}`, epoch, priorEpochs[id]);
        }
        revisionTombstoneEpochs[id] = explicit === epoch
          ? explicit
          : (epoch && Number.isFinite(Number(clockValue)) && Number(clockValue) >= epoch ? epoch : 0);
      }
      return {
        ...phase,
        resetEpoch: legacyRecordGeneration(phase, epoch, ["createdAt", "updatedAt"]),
        revisions: ((phase && phase.revisions) || []).map((revision) => ({
          ...revision,
          resetEpoch: legacyRecordGeneration(revision, epoch, ["createdAt", "updatedAt"]),
        })),
        revisionTombstones,
        revisionTombstoneEpochs,
      };
    });

    if (out.profile && typeof out.profile === "object") {
      out.profile = {
        ...out.profile,
        resetEpoch: legacyRecordGeneration(out.profile, epoch, ["updatedAt", "createdAt"]),
      };
    }
    const explicitGoalsEpoch = Object.prototype.hasOwnProperty.call(out, "goalsResetEpoch")
      ? safeGeneration(out.goalsResetEpoch) : 0;
    if (explicitGoalsEpoch > 0 && explicitGoalsEpoch !== epoch) {
      throw generationError("goalsResetEpoch", epoch, out.goalsResetEpoch);
    }
    const goalClock = Number(out.goalsUpdatedAt);
    out.goalsResetEpoch = explicitGoalsEpoch === epoch
      ? explicitGoalsEpoch
      : (!epoch ? 0 : (Number.isFinite(goalClock) && goalClock >= epoch ? epoch : 0));
    out.generationSchemaVersion = GENERATION_SCHEMA_VERSION;
    // Rows whose own clocks prove they predate this document's reset are not
    // part of the current snapshot. Remove them now so the marked canonical
    // document satisfies the strict exact-generation contract thereafter.
    const filtered = filterDocGeneration(out, epoch, { preserveRawDayGoals: true });
    filtered.generationSchemaVersion = GENERATION_SCHEMA_VERSION;
    filtered.resetAt = epoch;
    validateDocClocks(filtered);
    validateDocGenerations(filtered);
    return filtered;
  }

  /** Logged-day target is derived from immutable history after every shard merge. */
  function healLoggedDayGoals(dayGoals, events, phases, goals, candidateMaps, goalsUpdatedAt) {
    const out = migrateDayGoals(dayGoals, phases, goals);
    const candidatesByDay = new Map();
    for (const source of [...(candidateMaps || []), dayGoals || {}]) {
      for (const [day, raw] of Object.entries(source || {})) {
        const record = normalizeDayGoal(raw);
        if (!record) continue;
        const rows = candidatesByDay.get(day) || [];
        rows.push(record);
        candidatesByDay.set(day, rows);
      }
    }
    const byDay = new Map();
    for (const event of rootAdds(events)) {
      const rows = byDay.get(event.day) || [];
      rows.push(event);
      byDay.set(event.day, rows);
    }
    for (const [day, rows] of byDay) {
      rows.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0) ||
        String(a.id || "").localeCompare(String(b.id || "")) || stableText(a).localeCompare(stableText(b)));
      // Ownership is decided before inspecting snapshots. During a mixed-version
      // rollout, a later new client can attach dayGoalLock while the true first
      // legacy root cannot. Skipping that first root would let a later meal
      // redefine an already-logged day.
      const root = rows[0];
      const rootValue = root && root.dayGoalLock;
      const eventLock = rootValue &&
        Number(rootValue.targetKcal) >= 800 && Number(rootValue.targetKcal) <= 6000 &&
        Number(rootValue.baseKcal) >= 800 && Number(rootValue.baseKcal) <= 6000
        ? root
        : null;
      const rootTs = Number(root.ts) || 0;
      const baseKcal = phaseBaseKcal(day, phases, goals, rootTs, goalsUpdatedAt);
      let targetKcal = baseKcal;
      let frozenBase = baseKcal;
      let plannedAt = 0;
      let acknowledged = false;
      if (eventLock) {
        targetKcal = Number(eventLock.dayGoalLock.targetKcal);
        frozenBase = Number(eventLock.dayGoalLock.baseKcal);
        plannedAt = Number(eventLock.dayGoalLock.plannedAt) || 0;
        acknowledged = eventLock.dayGoalLock.veryLowCalorieAcknowledged === true;
      } else {
        const candidates = candidatesByDay.get(day) || [];
        const planClock = (record) => Number(
          record && record.plannedAt != null ? record.plannedAt : record && record.updatedAt
        ) || 0;
        const pickLatest = (records) => records.slice().sort((a, b) =>
          planClock(a) - planClock(b) || stableText(a).localeCompare(stableText(b))
        ).slice(-1)[0] || null;
        // A previously healed record is an immutable legacy snapshot. Otherwise
        // choose the latest record demonstrably created before logging began,
        // including a pre-log clear. A later stale create/change/clear is ignored.
        const priorLock = pickLatest(candidates.filter((record) => record.locked &&
          (!record.lockedByEventId || record.lockedByEventId === root.id)));
        const selected = priorLock || pickLatest(candidates.filter((record) =>
          !record.locked && planClock(record) <= rootTs
        ));
        if (selected && !selected.cleared) {
          const frozen = frozenDayGoal(day, selected, phases, goals, rootTs, goalsUpdatedAt);
          targetKcal = frozen.targetKcal;
          frozenBase = frozen.baseKcal;
          plannedAt = Number(selected.plannedAt) || 0;
          acknowledged = selected.veryLowCalorieAcknowledged === true;
        }
      }
      out[day] = {
        targetKcal,
        baseKcal: frozenBase,
        updatedAt: Number(root.ts) || 0,
        resetEpoch: safeGeneration(root.resetEpoch),
        locked: true,
        lockedByEventId: String(root.id || "legacy").slice(0, 160),
      };
      if (plannedAt) out[day].plannedAt = plannedAt;
      if (acknowledged) out[day].veryLowCalorieAcknowledged = true;
    }
    return out;
  }

  function mergeDocs(local, remote) {
    validateDocClocks(local || {});
    validateDocClocks(remote || {});
    // Upgrade each snapshot in isolation before comparing reset generations.
    // A legacy device may legitimately have resetAt > 0 and current records
    // without resetEpoch; filtering first would erase its post-reset data.
    const migratedLocal = migrateLegacyGenerationDoc(local || {});
    const migratedRemote = migrateLegacyGenerationDoc(remote || {});
    const localReset = safeGeneration(migratedLocal && migratedLocal.resetAt);
    const remoteReset = safeGeneration(migratedRemote && migratedRemote.resetAt);
    const resetAt = Math.max(localReset, remoteReset);
    const L = filterDocGeneration(migratedLocal, resetAt);
    const R = filterDocGeneration(migratedRemote, resetAt);
    const events = mergeEvents(L.events, R.events);
    const personalFoods = mergePersonal(L.personalFoods, R.personalFoods);
    const dayPlans = mergeDayPlans(L.dayPlans, R.dayPlans);
    const gapDrafts = mergeDayPlans(L.gapDrafts, R.gapDrafts);
    const phases = mergePhases(L.phases, R.phases, events);
    const weights = mergeWeights(L.weights, R.weights);
    const pickedProfile = L.profile && R.profile
      ? mergeProfiles(L.profile, R.profile)
      : { ...((L.profile || R.profile) || { updatedAt: 0, resetEpoch: resetAt }) };
    const profile = typeof Phases !== "undefined" && typeof Phases.normalizeProfile === "function"
      ? Phases.normalizeProfile(pickedProfile)
      : pickedProfile;
    const localGoalAt = L.goalsUpdatedAt || 0, remoteGoalAt = R.goalsUpdatedAt || 0;
    const goalsLocalNewer = !!L.goals && (!R.goals || localGoalAt > remoteGoalAt ||
      (localGoalAt === remoteGoalAt && stableText(L.goals || {}) >= stableText(R.goals || {})));
    let goals = goalsLocalNewer ? (L.goals || {}) : (R.goals || {});
    let goalsUpdatedAt = goalsLocalNewer ? localGoalAt : remoteGoalAt;
    if (typeof Phases !== "undefined" && typeof Phases.sanitizePersistentTargets === "function") {
      const targetState = {
        phases,
        goals,
        goalsUpdatedAt,
        goalsResetEpoch: resetAt,
      };
      // A fixed far-future horizon makes quarantine and singleton fallback
      // independent of the calendar date/device performing the merge.
      Phases.sanitizePersistentTargets(targetState, "9999-12-31");
      goals = targetState.goals;
      goalsUpdatedAt = targetState.goalsUpdatedAt || 0;
    }
    if (typeof Phases !== "undefined" && typeof Phases.activePhase === "function") {
      const active = Phases.activePhase(phases);
      const latest = active && typeof Phases.latestActivatableRevision === "function"
        ? Phases.latestActivatableRevision(active)
        : (active && Array.isArray(active.revisions)
          ? active.revisions.slice().sort((a, b) =>
            String(a.effectiveFrom || "").localeCompare(String(b.effectiveFrom || "")) ||
            (Number(a.updatedAt || a.createdAt) || 0) - (Number(b.updatedAt || b.createdAt) || 0) ||
            String(a.id || "").localeCompare(String(b.id || ""))
          ).slice(-1)[0]
          : null);
      if (latest && latest.goals) {
        goals = latest.goals;
        goalsUpdatedAt = Math.max(goalsUpdatedAt, Number(latest.updatedAt || latest.createdAt) || 0);
      }
    }
    const mergedDayGoals = mergeDayGoals(L.dayGoals, R.dayGoals);
    const dayGoals = healLoggedDayGoals(
      mergedDayGoals, events, phases, goals, [L.dayGoals, R.dayGoals], goalsUpdatedAt
    );
    const merged = {
      version: DOC_VERSION,
      generationSchemaVersion: GENERATION_SCHEMA_VERSION,
      updatedAt: Date.now(),
      resetAt,
      events,
      personalFoods,
      dayGoals,
      dayPlans,
      gapDrafts,
      phases,
      weights,
      profile: { ...profile, resetEpoch: safeGeneration(profile.resetEpoch) || resetAt },
      goals,
      goalsUpdatedAt,
      goalsResetEpoch: resetAt,
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
    return { ...lwwPick(A, B, "updatedAt", "deleted") };
  }

  function fingerprint(doc) {
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (!value || typeof value !== "object") return value;
      const out = Object.create(null);
      for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) out[key] = canonical(value[key]);
      }
      return out;
    };
    // updatedAt is transport bookkeeping; all actual conflict clocks remain in
    // their records and are included. Canonicalizing the complete sync payload
    // prevents new fields (profile notes, revision tombstones, etc.)
    // from being silently omitted by a hand-maintained fingerprint.
    return JSON.stringify(canonical({
      version: doc.version || 1,
      generationSchemaVersion: generationSchemaVersion(doc),
      resetAt: doc.resetAt || 0,
      events: doc.events || [],
      personalFoods: doc.personalFoods || [],
      // Keep the raw representation in the comparison: legacy forbidden
      // fields must differ from the sanitized merged document so sync writes
      // the cleanup back to Drive instead of treating it as semantically equal.
      dayGoals: doc.dayGoals || {},
      dayPlans: doc.dayPlans || {},
      gapDrafts: doc.gapDrafts || {},
      phases: doc.phases || [],
      weights: doc.weights || {},
      profile: doc.profile || {},
      goals: doc.goals || {},
      goalsUpdatedAt: doc.goalsUpdatedAt || 0,
      goalsResetEpoch: doc.goalsResetEpoch || 0,
    }));
  }

  // ---------- doc <-> app state ----------
  function localDoc() {
    return {
      version: DOC_VERSION,
      generationSchemaVersion: Number(getLocal(
        GENERATION_SCHEMA_KEY, "read the privacy schema marker"
      ) || 0),
      updatedAt: Date.now(),
      resetAt: getResetAt(),
      events: Ledger.allEvents(),
      personalFoods: deps.getPersonal(),
      // Deliberately raw until the same canonical inbound normalizer accepts it.
      dayGoals: deps.getDayGoals ? deps.getDayGoals() : {},
      dayPlans: deps.getDayPlans ? deps.getDayPlans() : {},
      gapDrafts: deps.getGapDrafts ? deps.getGapDrafts() : {},
      phases: deps.getPhases ? deps.getPhases() : [],
      weights: deps.getWeights ? deps.getWeights() : {},
      profile: deps.getProfile ? deps.getProfile() : { resetEpoch: getResetAt() },
      goals: deps.getGoals(),
      goalsUpdatedAt: deps.getGoalsUpdatedAt ? deps.getGoalsUpdatedAt() : 0,
      goalsResetEpoch: deps.getGoalsResetEpoch ? deps.getGoalsResetEpoch() : getResetAt(),
    };
  }

  function detached(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function snapshotApplyState() {
    return {
      events: detached(Ledger.allEvents()),
      personalFoods: detached(deps.getPersonal()),
      goals: detached(deps.getGoals()),
      goalsUpdatedAt: deps.getGoalsUpdatedAt ? deps.getGoalsUpdatedAt() : 0,
      goalsResetEpoch: deps.getGoalsResetEpoch ? deps.getGoalsResetEpoch() : undefined,
      dayGoals: deps.getDayGoals ? detached(deps.getDayGoals()) : undefined,
      dayPlans: deps.getDayPlans ? detached(deps.getDayPlans()) : undefined,
      gapDrafts: deps.getGapDrafts ? detached(deps.getGapDrafts()) : undefined,
      phases: deps.getPhases ? detached(deps.getPhases()) : undefined,
      weights: deps.getWeights ? detached(deps.getWeights()) : undefined,
      profile: deps.getProfile ? detached(deps.getProfile()) : undefined,
      resetRaw: getLocal(RESET_KEY, "read the reset marker"),
      generationSchemaRaw: getLocal(GENERATION_SCHEMA_KEY, "read the privacy schema marker"),
    };
  }

  function restoreApplyState(snapshot) {
    // A caller that owns several values in one durable record (as App does for
    // settings) should inject beginApplyTransaction(). This fallback still
    // restores every logical value and keeps standalone/test integrations safe.
    const attempts = [];
    const restore = (fn) => {
      try { fn(); } catch (error) { attempts.push(error); }
    };
    restore(() => Ledger.replaceAll(snapshot.events || []));
    restore(() => deps.setPersonal(detached(snapshot.personalFoods || [])));
    restore(() => deps.setGoals(
      detached(snapshot.goals || {}), snapshot.goalsUpdatedAt || 0, snapshot.goalsResetEpoch
    ));
    if (deps.setDayGoals && snapshot.dayGoals !== undefined) {
      restore(() => deps.setDayGoals(detached(snapshot.dayGoals)));
    }
    if (deps.setDayPlans && snapshot.dayPlans !== undefined) {
      restore(() => deps.setDayPlans(detached(snapshot.dayPlans)));
    }
    if (deps.setGapDrafts && snapshot.gapDrafts !== undefined) {
      restore(() => deps.setGapDrafts(detached(snapshot.gapDrafts)));
    }
    if (deps.setPhases && snapshot.phases !== undefined) {
      restore(() => deps.setPhases(detached(snapshot.phases)));
    }
    if (deps.setWeights && snapshot.weights !== undefined) {
      restore(() => deps.setWeights(detached(snapshot.weights)));
    }
    if (deps.setProfile && snapshot.profile !== undefined) {
      restore(() => deps.setProfile(detached(snapshot.profile)));
    }
    restore(() => {
      if (snapshot.resetRaw == null) removeLocal(RESET_KEY, "restore the reset marker");
      else setLocal(RESET_KEY, snapshot.resetRaw, "restore the reset marker");
    });
    restore(() => {
      if (snapshot.generationSchemaRaw == null) {
        removeLocal(GENERATION_SCHEMA_KEY, "restore the privacy schema marker");
      } else {
        setLocal(GENERATION_SCHEMA_KEY, snapshot.generationSchemaRaw, "restore the privacy schema marker");
      }
    });
    if (attempts.length) throw attempts[0];
  }

  function applyDoc(doc) {
    // Validate/serialize the rollback view before the first mutation. The App
    // transaction adapter additionally snapshots the exact localStorage bytes
    // and its mutable state object, because several setters share one settings
    // key and can mutate memory before their durable write throws.
    let snapshot = null;
    let transaction = null;
    try {
      // Capture the owner-provided raw/in-memory transaction first. A getter
      // used to build the logical snapshot may normalize a live object, and a
      // later snapshot/serialization error must undo even that side effect.
      transaction = deps && typeof deps.beginApplyTransaction === "function"
        ? deps.beginApplyTransaction()
        : null;
      snapshot = snapshotApplyState();
      const priorResetAt = Number(snapshot.resetRaw || 0) || 0;
      Ledger.replaceAll(detached(doc.events || []));
      deps.setPersonal(detached(doc.personalFoods || []));
      if (doc.goals) deps.setGoals(
        detached(doc.goals), doc.goalsUpdatedAt || 0, doc.goalsResetEpoch || doc.resetAt || 0
      );
      if (deps.setDayGoals) deps.setDayGoals(normalizeDayGoals(detached(doc.dayGoals)));
      // Older Drive docs omit dayPlans; do not wipe a newer local map.
      if (deps.setDayPlans && doc.dayPlans != null && typeof doc.dayPlans === "object") {
        deps.setDayPlans(detached(doc.dayPlans));
      }
      if (deps.setGapDrafts && doc.gapDrafts != null && typeof doc.gapDrafts === "object") {
        deps.setGapDrafts(detached(doc.gapDrafts));
      }
      if (deps.setPhases && Array.isArray(doc.phases)) deps.setPhases(detached(doc.phases));
      if (deps.setWeights && doc.weights && typeof doc.weights === "object") {
        deps.setWeights(detached(doc.weights));
      }
      if (deps.setProfile && doc.profile && typeof doc.profile === "object") {
        deps.setProfile(detached(doc.profile));
      }
      if (generationSchemaVersion(doc) >= GENERATION_SCHEMA_VERSION) {
        setLocal(GENERATION_SCHEMA_KEY, GENERATION_SCHEMA_VERSION, "save the privacy schema marker");
      }
      // The privacy epoch is the final durable state write. A failure anywhere
      // above (or in the remote-applied callback below) restores the old epoch
      // along with every collection and singleton.
      if ((doc.resetAt || 0) > priorResetAt) setResetAt(doc.resetAt);
      if (deps.onRemoteApplied) deps.onRemoteApplied();
      if (transaction && typeof transaction.commit === "function") transaction.commit();
    } catch (error) {
      try {
        if (transaction && typeof transaction.rollback === "function") transaction.rollback();
        else if (snapshot) restoreApplyState(snapshot);
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      throw error;
    }
  }

  function canonicalizeDoc(doc) {
    // The guard intentionally runs both before and after whitelisting: a future
    // clock must not disappear during sanitization, and the exact payload about
    // to be applied/written must independently satisfy the same contract.
    validateDocClocks(doc || {});
    // Generation rollout must run while property presence is still intact.
    // The App normalizer intentionally supplies numeric defaults for many
    // fields; running it first would turn a missing legacy resetEpoch into an
    // explicit zero and make post-reset v4 rows look provably stale.
    const migrated = migrateLegacyGenerationDoc(detached(doc || {}));
    const normalized = deps && typeof deps.normalizeRemoteDoc === "function"
      ? deps.normalizeRemoteDoc(detached(migrated))
      : detached(migrated);
    validateDocClocks(normalized || {});
    if (generationSchemaVersion(normalized) >= GENERATION_SCHEMA_VERSION) {
      validateDocGenerations(normalized);
    }
    return normalized;
  }

  // ---------- sync cycles ----------
  async function fullSync(interactive) {
    if (!activeTabReady()) {
      dirtyPending = true;
      return { ok: false, suspended: true };
    }
    if (running) { queued = true; return { ok: false, busy: true }; }
    running = true;
    const cycleSerial = connectionSerial;
    setStatus("syncing");
    const wantInteractive = !!interactive;
    try {
      const lock = typeof GDrive.withWriterLock === "function"
        ? GDrive.withWriterLock
        : (callback) => callback();
      await lock(async () => {
        // The lock spans the complete read -> merge -> own-shard write cycle.
        // readShards validates every file before returning, so a malformed or
        // newer shard cannot partially apply locally or trigger a Drive write.
        const snapshot = await GDrive.readShards(wantInteractive);
        const remoteDocs = (snapshot.docs || []).map((item) => ({
          ...item,
          // Retain the raw comparison. Otherwise a legacy own shard can become
          // canonical in memory and look equal before its marker/stamps have
          // actually been written back to Drive.
          sourceFingerprint: fingerprint(item.doc || {}),
          doc: canonicalizeDoc(item.doc),
        }));
        const localRaw = localDoc();
        const localSourceFingerprint = fingerprint(localRaw);
        const before = canonicalizeDoc(localRaw);
        // Also migrate a local-only install: there may be no Drive shard to
        // invoke mergeDocs, but the marker and stamped snapshot still need one
        // transactional apply before the first write.
        // Run even a local-only rollout through the aggregate constructor. A
        // per-source migration may intentionally filter stale singleton data
        // to null; the aggregate stage supplies canonical blank/default
        // singletons at the winning generation before App apply.
        let merged = mergeDocs(before, {
          version: DOC_VERSION,
          generationSchemaVersion: GENERATION_SCHEMA_VERSION,
          resetAt: safeGeneration(before.resetAt),
          events: [], personalFoods: [], dayGoals: {}, dayPlans: {}, gapDrafts: {},
          phases: [], weights: {}, profile: null, goals: null,
          goalsUpdatedAt: 0,
          goalsResetEpoch: safeGeneration(before.resetAt),
        }).doc;
        for (const item of remoteDocs) {
          merged = mergeDocs(merged, item.doc || {}).doc;
        }
        // Self-round-trip through the inbound schema immediately before either
        // local apply or Drive write. Local corruption therefore produces zero
        // mutation and zero writes with an actionable sync error.
        merged = canonicalizeDoc(merged);
        if (cycleSerial !== connectionSerial) {
          const stopped = new Error("Sync stopped because Drive was disconnected.");
          stopped.code = "sync-disconnected";
          throw stopped;
        }
        // A shard can be causally valid by itself while the aggregate is not
        // (for example, two devices independently introducing the same entry
        // identity on different days). Validate only after the complete union,
        // but before the first local mutation or Drive write.
        if (typeof Ledger !== "undefined" && typeof Ledger.validateEvents === "function") {
          Ledger.validateEvents(merged.events || []);
        }
        if (fingerprint(merged) !== localSourceFingerprint) applyDoc(merged);

        const own = remoteDocs.find((item) => item.fileId === snapshot.ownFileId || item.id === snapshot.ownFileId);
        if (!own || own.sourceFingerprint !== fingerprint(merged)) {
          await GDrive.writeOwnShard(own || null, merged, wantInteractive);
        }
      });
      dirtyPending = false;
      running = false;
      lastSync = Date.now();
      setStatus("ok");
      if (queued) { queued = false; schedulePush(); }
      return { ok: true };
    } catch (err) {
      running = false;
      if (err && err.code === "sync-disconnected") {
        dirtyPending = false;
        setStatus("off");
        return { ok: false, disconnected: true };
      }
      dirtyPending = true;
      if (err && err.code === "drive-newer-schema") {
        lastSync = Date.now();
        setStatus("warn", err.message);
        return { ok: true, upgrade: true, preservedLocal: true };
      }
      const authy = isAuthErr(err);
      setStatus(authy ? "auth" : "error", authy ? AUTH_DETAIL : err.message);
      if (interactive) throw err;
      return { ok: false, error: err };
    }
  }

  /** Debounced push after local mutations. */
  function schedulePush() {
    if (!activeTabReady()) { dirtyPending = true; return; }
    // An explicit logout wins even if persisting the disabled preference
    // failed. Never race its durable server-cookie retry with silent re-auth.
    if (typeof GDrive.logoutPending === "function" && GDrive.logoutPending()) {
      clearTimeout(timer);
      timer = null;
      dirtyPending = false;
      setStatus("off");
      return;
    }
    if (!state().enabled) return;
    if (!GDrive.cachedToken()) {
      dirtyPending = true;
      clearTimeout(timer);
      timer = null;
      if (refreshPushInflight) return;
      refreshPushInflight = true;
      setStatus("pending");
      GDrive.silentBoot()
        .then(() => {
          refreshPushInflight = false;
          if (!state().enabled) return;
          if (GDrive.cachedToken()) {
            clearTimeout(timer);
            timer = setTimeout(() => fullSync(false), PUSH_DELAY);
            setStatus("pending");
          } else {
            setStatus("auth", AUTH_DETAIL);
          }
        })
        .catch(() => {
          refreshPushInflight = false;
          if (state().enabled) setStatus("auth", AUTH_DETAIL);
        });
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => fullSync(false), PUSH_DELAY);
    setStatus("pending");
  }

  /** Complete connect after cookie/token is available (post-redirect or silent refresh). */
  async function finishConnect() {
    await GDrive.refreshSession();
    const email = await GDrive.userEmail();
    setLocal(EMAIL_KEY, email, "save account details");
    // Enable last so a partial localStorage failure cannot leave background
    // sync on with incomplete connection state.
    setLocal(ENABLED_KEY, "1", "enable");
    dirtyPending = false;
    const r = await fullSync(true);
    if (r && r.busy) return email;
    if (!r || !r.ok) throw new Error((r && r.error && r.error.message) || "Sync failed");
    return email;
  }

  /**
   * User-gesture connect. Tries silent refresh first; if that fails, redirects to Google
   * (BFF) or opens GIS popup (fallback). Returns email, or null when a redirect started.
   */
  async function connect() {
    try {
      await GDrive.refreshSession();
    } catch (e) {
      try {
        await GDrive.getToken(true);
      } catch (e2) {
        throw e2;
      }
      /* getToken may navigate away (BFF); if we still have a token, finish. */
      if (!GDrive.cachedToken()) return null;
    }
    return finishConnect();
  }

  async function disconnect() {
    connectionSerial += 1;
    clearTimeout(timer);
    timer = null;
    queued = false;
    dirtyPending = false;
    setStatus("off");
    // signOut clears in-memory/session credentials synchronously before its
    // first await. Start it before fallible localStorage preference cleanup so
    // a quota/security error can never leave a usable credential behind.
    let serverResult;
    try { serverResult = Promise.resolve(GDrive.signOut()).catch(() => false); }
    catch (error) { serverResult = Promise.resolve(false); }
    let localError = null;
    try { setLocal(ENABLED_KEY, "0", "disable"); }
    catch (error) { localError = error; }
    try { removeLocal(EMAIL_KEY, "clear account details"); }
    catch (error) { if (!localError) localError = error; }
    const serverCleared = await serverResult;
    return { serverCleared, localCleared: !localError, error: localError };
  }

  /** On app start / foreground: silent resume if previously connected. */
  async function resume() {
    if (typeof GDrive.logoutPending === "function" && GDrive.logoutPending()) {
      setStatus("off");
      try { await GDrive.retryPendingLogout(); } catch (e) {}
      // Never refresh a session while its explicit logout is still pending,
      // even if a prior localStorage failure left the enabled flag behind.
      if (GDrive.logoutPending()) return;
    }
    if (!state().enabled) {
      setStatus("off");
      if (typeof GDrive.retryPendingLogout === "function") {
        try { await GDrive.retryPendingLogout(); } catch (e) {}
      }
      return;
    }
    if (!GDrive.onHttp()) { setStatus("error", GDrive.unavailableReason()); return; }
    try {
      await GDrive.silentBoot();
      const result = await fullSync(false);
      if (!(result && result.upgrade) && dirtyPending && GDrive.cachedToken()) await fullSync(false);
    } catch (e) {
      setStatus("auth", AUTH_DETAIL);
    }
  }

  async function onForeground() {
    if (!state().enabled || !GDrive.onHttp()) return;
    if (GDrive.cachedToken()) {
      if (dirtyPending) schedulePush();
      return;
    }
    try {
      await GDrive.silentBoot();
      await fullSync(false);
    } catch (e) {
      setStatus("auth", AUTH_DETAIL);
    }
  }

  function wireVisibility() {
    if (visibilityWired || typeof document === "undefined") return;
    visibilityWired = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && activeTabReady()) onForeground();
    });
    window.addEventListener("pageshow", (ev) => {
      if (ev.persisted && activeTabReady()) onForeground();
    });
  }

  /** Mark a local wipe/replace so the next merge does not resurrect old remote data. */
  function markReset(ts) {
    setResetAt(ts || Date.now());
  }

  function init(d) {
    deps = d;
    wireVisibility();
  }

  return {
    init, connect, finishConnect, disconnect, resume, schedulePush, fullSync, state,
    mergeDocs, mergeEvents, mergePersonal, normalizeDayGoal, normalizeDayGoals,
    mergeDayGoals, mergeDayPlans, mergePhases, mergeWeights, mergeProfiles,
    activeDayGoals, markReset, getResetAt, fingerprint, canonicalizeDoc,
    validateDocClocks, validateDocGenerations, migrateLegacyGenerationDoc,
    MAX_FUTURE_SKEW_MS, FutureClockError, DOC_VERSION,
    GENERATION_SCHEMA_VERSION, GENERATION_SCHEMA_KEY,
    PersistenceError, isPersistenceError: (e) => !!e && e.code === "sync-persistence-failed",
  };
})();

if (typeof module !== "undefined") module.exports = Sync;
