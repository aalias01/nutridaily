/* NutriDaily — event-sourced day ledger.
 * Every change is an immutable event: add | amend | remove.
 * State (entries, totals) is always derived by reduction — never stored.
 * Uncertainty: each entry has sd (relative). Totals carry a ±1σ interval,
 * σ_total = sqrt(Σ (value_i · sd_i)²) — independent errors assumption.
 */
const Ledger = (() => {
  const KEY = "nd_events_v1";
  const LEGACY_KEY = "nc_events_v1";

  let store = (() => {
    if (typeof localStorage !== "undefined") return localStorage;
    let mem = {}; // node test shim
    return { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] };
  })();

  /**
   * Durable writes are part of the ledger contract: callers must never be told
   * an event was accepted when localStorage rejected it (quota, privacy mode,
   * or an unavailable storage backend). The error is intentionally typed and
   * carries a stable code so the UI/sync layer can show a recovery action.
   */
  class PersistenceError extends Error {
    constructor(operation, cause) {
      super(`Could not ${operation} nutrition history on this device. Export or free browser storage, then try again.`);
      this.name = "PersistenceError";
      this.code = "ledger-persistence-failed";
      this.operation = operation;
      this.cause = cause;
    }
  }

  function _write(events, operation) {
    try {
      store.setItem(KEY, JSON.stringify(events));
    } catch (e) {
      throw new PersistenceError(operation || "save", e);
    }
  }

  let _cache = null;
  /**
   * day → events, built lazily from _cache.
   *
   * Without it, every eventsFor() scanned the whole log, so a day read cost
   * O(all events). Insights reads each day several times over a range, which
   * made a render cost O(range × history) — a year of data turned one tab
   * switch into tens of milliseconds, two years into hundreds. Reads now cost
   * only what the range actually contains.
   */
  let _byDay = null;

  // App-owned context is injected once during boot. Keeping the ledger unaware
  // of Settings/Sync avoids a circular dependency while still letting the
  // immutable root add capture the privacy generation and the day target that
  // was in force when logging began.
  let _context = {
    getResetEpoch: () => 0,
    getDayGoalLock: () => null,
  };

  function configureContext(next) {
    const value = next || {};
    _context = {
      getResetEpoch: typeof value.getResetEpoch === "function" ? value.getResetEpoch : () => 0,
      getDayGoalLock: typeof value.getDayGoalLock === "function" ? value.getDayGoalLock : () => null,
    };
  }

  function _safeGeneration(value) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  function _normalizedDayGoalLock(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const targetKcal = Number(value.targetKcal);
    const baseKcal = Number(value.baseKcal);
    // targetKcal is a planned day ({0} ∪ [200, 6000], a fast or a real
    // reduced-day protocol); baseKcal is a frozen phase target and keeps its
    // own unrelated [800, 6000] floor. ledger.js has no require()s of its own
    // and never reads a Phases global — the range is inlined, not delegated
    // to Phases.isPlannedKcal, so this module keeps loading standalone (same
    // reason sync.js inlines it).
    // A 0 target is only ever a real declaration, never bare arithmetic — a
    // lock that recorded targetKcal 0 without its own fast acknowledgement
    // would be the one shape the rest of the system refuses to honour
    // (Part VIII.1). Reject the whole lock rather than write a half
    // declaration. The reverse direction matters too: intent "fast" paired
    // with a nonzero target is not a fast either, just an ordinary planned
    // day with a stray label — Sync.normalizeDayGoal and
    // App.importedPlannedKcal already refuse that combination, and this is
    // the validator that writes the immutable event log, so it must not be
    // the one place that honours it (Part IX.2).
    const declaredFast = value.intent === "fast" && value.fastAcknowledged === true && targetKcal === 0;
    const targetOk = Number.isFinite(targetKcal) &&
      (targetKcal === 0 ? declaredFast : (targetKcal >= 200 && targetKcal <= 6000));
    if (!targetOk ||
        !Number.isFinite(baseKcal) || baseKcal < 800 || baseKcal > 6000) return null;
    const out = { targetKcal, baseKcal };
    const plannedAt = Number(value.plannedAt);
    if (Number.isFinite(plannedAt) && plannedAt >= 0) out.plannedAt = plannedAt;
    if (value.veryLowCalorieAcknowledged === true) out.veryLowCalorieAcknowledged = true;
    if (declaredFast) {
      out.intent = "fast";
      out.fastAcknowledged = true;
      if (value.declaredAfterDay === true) out.declaredAfterDay = true;
    }
    return out;
  }

  function _load() {
    if (_cache) return _cache;
    let raw;
    try {
      raw = store.getItem(KEY);
      if (raw == null && store.getItem(LEGACY_KEY) != null) {
        raw = store.getItem(LEGACY_KEY);
        // Migration failure must not make a readable legacy ledger look empty.
        // The next actual mutation will retry a durable write and surface a
        // typed PersistenceError if storage is still unavailable.
        try { store.setItem(KEY, raw); } catch (e) { /* keep the readable copy */ }
      }
    } catch (e) {
      throw new PersistenceError("read", e);
    }
    try {
      _cache = JSON.parse(raw || "[]");
      if (!Array.isArray(_cache)) throw new Error("ledger root is not an array");
    } catch (e) {
      _cache = null;
      throw new PersistenceError("read", e);
    }
    return _cache;
  }

  function _index() {
    if (_byDay) return _byDay;
    const map = new Map();
    for (const ev of _load()) {
      let list = map.get(ev.day);
      if (!list) { list = []; map.set(ev.day, list); }
      list.push(ev);
    }
    _byDay = map;
    return _byDay;
  }

  /** Append to the log and keep the index in step (cheaper than rebuilding). */
  function _append(ev) {
    const next = [..._load(), ev];
    _write(next, "save");
    _cache = next;
    if (_byDay) {
      let list = _byDay.get(ev.day);
      if (!list) { list = []; _byDay.set(ev.day, list); }
      list.push(ev);
    }
    return ev;
  }

  function _invalidate() { _byDay = null; }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  let _lastEventTs = 0;
  function _eventTimestamp() {
    const now = Date.now();
    _lastEventTs = Math.max(Number.isFinite(now) ? now : 0, _lastEventTs + 1);
    return _lastEventTs;
  }

  /**
   * New events carry a logical per-entry clock in addition to their wall clock:
   *
   *   causal: { entryId, seq, parentEventId }
   *
   * The first add is seq 0 with no parent. Every amend/remove, and an add that
   * restores a removed entry, names the exact head it follows and increments
   * seq. Concurrent children of one parent are therefore honest siblings, not
   * an input-order-dependent sequence. Legacy events remain untouched on disk;
   * their deterministic wall-clock/id chain is synthesized only while reading.
   */
  class CausalError extends Error {
    constructor(code, message, event, entryId) {
      super(message);
      this.name = "CausalError";
      this.code = code;
      this.eventId = event && event.id || null;
      this.entryId = entryId || null;
    }
  }

  function _causalError(code, message, event, entryId) {
    throw new CausalError(code, message, event, entryId);
  }

  function _stableValue(value) {
    if (Array.isArray(value)) return value.map(_stableValue);
    if (!value || typeof value !== "object") return value;
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = _stableValue(value[key]);
    }
    return out;
  }

  const _stableText = (value) => JSON.stringify(_stableValue(value));

  function _wallClock(ev) {
    const n = Number(ev && ev.ts);
    return Number.isFinite(n) ? n : 0;
  }

  function _fallbackCompare(a, b) {
    return _wallClock(a) - _wallClock(b) ||
      String(a && a.id || "").localeCompare(String(b && b.id || "")) ||
      _stableText(a).localeCompare(_stableText(b));
  }

  function _eventEntryId(ev) {
    if (!ev || typeof ev !== "object") return "";
    return ev.type === "add"
      ? String(ev.entry && ev.entry.id || "")
      : String(ev.target || "");
  }

  function _eventLabel(ev) {
    return ev && ev.id ? `event ${ev.id}` : "ledger event";
  }

  /**
   * Analyze immutable events without changing them. The result is used both by
   * replay and by validateEvents(). Each node owns the state reached through
   * its own ancestry, so sibling forks are never accidentally applied in series.
   */
  function _analyzeEvents(events) {
    if (!Array.isArray(events)) {
      _causalError("ledger-causal-invalid", "Ledger history must be an array.");
    }

    const byEventId = new Map();
    const groups = new Map();
    for (const ev of events) {
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) {
        _causalError("ledger-causal-invalid", "Ledger history contains a non-object event.", ev);
      }
      if (typeof ev.id !== "string" || !ev.id) {
        _causalError("ledger-causal-invalid", "A ledger event is missing its immutable id.", ev);
      }
      if (byEventId.has(ev.id)) {
        _causalError("ledger-causal-duplicate-event", `Ledger history repeats event id ${ev.id}.`, ev);
      }
      if (!(["add", "amend", "remove"].includes(ev.type))) {
        _causalError("ledger-causal-invalid", `${_eventLabel(ev)} has an invalid type.`, ev);
      }
      if (typeof ev.day !== "string" || !ev.day) {
        _causalError("ledger-causal-invalid", `${_eventLabel(ev)} is missing its day.`, ev);
      }
      const entryId = _eventEntryId(ev);
      if (!entryId) {
        _causalError("ledger-causal-invalid", `${_eventLabel(ev)} is missing its entry id.`, ev);
      }
      if (ev.type === "add" && (!ev.entry || typeof ev.entry !== "object" || Array.isArray(ev.entry))) {
        _causalError("ledger-causal-invalid", `${_eventLabel(ev)} is missing its entry snapshot.`, ev, entryId);
      }
      if (ev.type === "amend" && (!ev.patch || typeof ev.patch !== "object" || Array.isArray(ev.patch))) {
        _causalError("ledger-causal-invalid", `${_eventLabel(ev)} is missing its amendment patch.`, ev, entryId);
      }
      byEventId.set(ev.id, {
        event: ev, entryId, effective: null, state: null, latestAddId: null,
        resolving: false, resolved: false,
      });
      const group = groups.get(entryId) || {
        entryId, days: new Set(), nodes: [], root: null, transition: null, activeAdd: null, winner: null,
      };
      group.days.add(ev.day);
      group.nodes.push(byEventId.get(ev.id));
      groups.set(entryId, group);
    }

    // One immutable entry identity cannot move between days. This also makes a
    // wrong-day target distinguishable from a genuinely missing/orphan target.
    for (const group of groups.values()) {
      if (group.days.size > 1) {
        const ev = group.nodes.slice().sort((a, b) => _fallbackCompare(a.event, b.event))[0].event;
        _causalError(
          "ledger-causal-cross-day",
          `Entry ${group.entryId} is referenced on more than one day.`,
          ev,
          group.entryId
        );
      }
    }

    for (const group of groups.values()) {
      const legacy = [];
      for (const node of group.nodes) {
        const ev = node.event;
        if (ev.causal == null) {
          legacy.push(node);
          continue;
        }
        const c = ev.causal;
        if (!c || typeof c !== "object" || Array.isArray(c) ||
            c.entryId !== group.entryId || !Number.isSafeInteger(c.seq) || c.seq < 0 ||
            !(c.parentEventId == null || (typeof c.parentEventId === "string" && c.parentEventId))) {
          _causalError(
            "ledger-causal-invalid-metadata",
            `${_eventLabel(ev)} has invalid causal metadata.`,
            ev,
            group.entryId
          );
        }
        node.effective = {
          entryId: group.entryId,
          seq: c.seq,
          parentEventId: c.parentEventId == null ? null : c.parentEventId,
          legacy: false,
        };
      }

      if (legacy.length) {
        const sorted = legacy.slice().sort((a, b) => _fallbackCompare(a.event, b.event));
        // Legacy dependants could have an earlier skewed wall clock than their
        // originating add. Pin the canonical first add to the root, then retain
        // timestamp/id order for every remaining legacy transition.
        const root = sorted.find((node) => node.event.type === "add");
        if (!root) {
          _causalError(
            "ledger-causal-orphan",
            `Legacy history for entry ${group.entryId} has no originating add.`,
            sorted[0].event,
            group.entryId
          );
        }
        const chain = [root, ...sorted.filter((node) => node !== root)];
        chain.forEach((node, seq) => {
          node.effective = {
            entryId: group.entryId,
            seq,
            parentEventId: seq ? chain[seq - 1].event.id : null,
            legacy: true,
          };
        });
      }
    }

    const resolve = (node) => {
      if (node.resolved) return node;
      if (node.resolving) {
        _causalError(
          "ledger-causal-cycle",
          `${_eventLabel(node.event)} participates in a causal cycle.`,
          node.event,
          node.entryId
        );
      }
      node.resolving = true;
      const ev = node.event;
      const c = node.effective;
      let parent = null;
      if (c.parentEventId != null) {
        parent = byEventId.get(c.parentEventId);
        if (!parent) {
          _causalError(
            "ledger-causal-orphan",
            `${_eventLabel(ev)} names a parent that is not present.`,
            ev,
            node.entryId
          );
        }
        if (parent.event.day !== ev.day) {
          _causalError(
            "ledger-causal-cross-day",
            `${_eventLabel(ev)} names a parent on a different day.`,
            ev,
            node.entryId
          );
        }
        if (parent.entryId !== node.entryId) {
          _causalError(
            "ledger-causal-cross-entry",
            `${_eventLabel(ev)} names a parent from a different entry.`,
            ev,
            node.entryId
          );
        }
        resolve(parent);
        if (c.seq !== parent.effective.seq + 1) {
          _causalError(
            "ledger-causal-sequence",
            `${_eventLabel(ev)} does not advance its parent's sequence by one.`,
            ev,
            node.entryId
          );
        }
      } else if (c.seq !== 0 || ev.type !== "add") {
        _causalError(
          "ledger-causal-orphan",
          `${_eventLabel(ev)} is not a valid initial add.`,
          ev,
          node.entryId
        );
      }

      const parentState = parent && parent.state;
      if (ev.type === "add") {
        if (parentState && parentState.live) {
          _causalError(
            "ledger-causal-duplicate-live-add",
            `${_eventLabel(ev)} adds an entry that is already live.`,
            ev,
            node.entryId
          );
        }
        const { addedTs: _a, history: _h, ...snapshot } = ev.entry;
        node.state = {
          live: true,
          entry: { ...snapshot, id: node.entryId, addedTs: ev.ts, history: [] },
        };
        node.latestAddId = ev.id;
      } else {
        if (!parentState) {
          _causalError(
            "ledger-causal-orphan",
            `${_eventLabel(ev)} has no entry state to change.`,
            ev,
            node.entryId
          );
        }
        if (!parentState.live) {
          _causalError(
            "ledger-causal-invalid-transition",
            `${_eventLabel(ev)} cannot ${ev.type} an already removed entry.`,
            ev,
            node.entryId
          );
        }
        if (ev.type === "amend") {
          const previous = parentState.entry;
          const { id: _id, addedTs: _addedTs, history: _history, ...patch } = ev.patch;
          node.state = {
            live: true,
            entry: {
              ...previous,
              ...patch,
              id: node.entryId,
              addedTs: previous.addedTs,
              history: [...(previous.history || []), {
                ts: ev.ts,
                label: ev.label || "amended",
                changes: _diffEntry(previous, patch),
              }],
            },
          };
        } else {
          node.state = { live: false, entry: parentState.entry };
        }
        node.latestAddId = parent.latestAddId;
      }
      node.resolving = false;
      node.resolved = true;
      return node;
    };

    for (const group of groups.values()) {
      for (const node of group.nodes) resolve(node);
      const roots = group.nodes.filter((node) => node.effective.parentEventId == null);
      if (roots.length !== 1) {
        const ev = roots.slice().sort((a, b) => _fallbackCompare(a.event, b.event))[1] || roots[0] || group.nodes[0];
        _causalError(
          "ledger-causal-duplicate-live-add",
          `Entry ${group.entryId} has more than one originating add.`,
          ev && ev.event,
          group.entryId
        );
      }
      group.root = roots[0];
      // Liveness is a remove-wins register over add/remove transitions. An
      // amendment, even on a causally deeper concurrent branch, cannot revive
      // a removed generation. Only a later add whose parent is removed can.
      group.transition = group.nodes.filter((node) =>
        node.event.type === "add" || node.event.type === "remove"
      ).sort((a, b) =>
        (b.effective.seq - a.effective.seq) ||
        ((b.event.type === "remove" ? 1 : 0) - (a.event.type === "remove" ? 1 : 0)) ||
        _stableText(b.event).localeCompare(_stableText(a.event))
      )[0];
      group.activeAdd = group.transition && group.transition.event.type === "add"
        ? group.transition
        : null;

      // The next local operation follows the deterministic active-generation
      // amendment head, or the winning remove while the entry is tombstoned.
      const activeNodes = group.activeAdd
        ? group.nodes.filter((node) =>
          node.latestAddId === group.activeAdd.event.id && node.event.type !== "remove"
        )
        : [group.transition];
      group.winner = activeNodes.filter(Boolean).sort((a, b) =>
        (b.effective.seq - a.effective.seq) ||
        _stableText(b.event).localeCompare(_stableText(a.event))
      )[0] || null;
    }

    return { groups, byEventId };
  }

  /** Pure, order-independent causal validation. Returns true or throws CausalError. */
  function validateEvents(events) {
    _analyzeEvents(events);
    return true;
  }

  /** Root adds are the immutable ownership boundary for privacy and day locks. */
  function rootAddEvents(events) {
    const analysis = _analyzeEvents(events || []);
    return [...analysis.groups.values()].map((group) => group.root.event).sort(_fallbackCompare);
  }

  /**
   * A reset generation is causal, not a wall-clock filter. Missing metadata is
   * deliberately generation zero: legacy data survives until the first reset,
   * then privacy wins over a stale device's clock. Descendant metadata is never
   * trusted to revive a root created in an older generation.
   */
  function filterEventsByResetEpoch(events, resetEpoch) {
    const epoch = _safeGeneration(resetEpoch);
    const analysis = _analyzeEvents(events || []);
    const kept = [];
    for (const group of analysis.groups.values()) {
      const rootEpoch = _safeGeneration(group.root && group.root.event && group.root.event.resetEpoch);
      if (rootEpoch < epoch) continue;
      for (const node of group.nodes) kept.push(node.event);
    }
    return kept.sort(_fallbackCompare);
  }

  function _projectGroup(group) {
    const activeAdd = group && group.activeAdd;
    if (!activeAdd) return null;
    const { addedTs: _a, history: _h, ...base } = activeAdd.event.entry;
    const entry = {
      ...base,
      id: group.entryId,
      addedTs: activeAdd.event.ts,
      history: [],
    };
    const amendments = group.nodes.filter((node) =>
      node.event.type === "amend" && node.latestAddId === activeAdd.event.id
    ).sort((a, b) =>
      (a.effective.seq - b.effective.seq) ||
      _stableText(a.event).localeCompare(_stableText(b.event))
    );
    for (const node of amendments) {
      const ev = node.event;
      const { id: _id, addedTs: _addedTs, history: _history, ...patch } = ev.patch;
      entry.history.push({
        ts: ev.ts,
        label: ev.label || "amended",
        changes: _diffEntry(entry, patch),
      });
      Object.assign(entry, patch, { id: group.entryId, addedTs: activeAdd.event.ts });
    }
    return entry;
  }

  /** Pure replay helper used by entriesFor and focused import/sync tests. */
  function replayEvents(events) {
    const analysis = _analyzeEvents(events);
    const entries = [];
    for (const group of analysis.groups.values()) {
      const entry = _projectGroup(group);
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) =>
      (_wallClock({ ts: a.addedTs }) - _wallClock({ ts: b.addedTs })) ||
      String(a.id).localeCompare(String(b.id))
    );
  }

  function _nextCausal(day, entryId, type) {
    const matching = _load().filter((ev) => _eventEntryId(ev) === entryId);
    const wrongDay = matching.find((ev) => ev.day !== day);
    if (wrongDay) {
      _causalError(
        "ledger-causal-cross-day",
        `Entry ${entryId} already belongs to ${wrongDay.day}.`,
        wrongDay,
        entryId
      );
    }
    if (!matching.length) {
      if (type !== "add") {
        _causalError(
          "ledger-causal-orphan",
          `Cannot ${type} entry ${entryId} because its add event is missing.`,
          null,
          entryId
        );
      }
      return { entryId, seq: 0, parentEventId: null };
    }
    const group = _analyzeEvents(matching).groups.get(entryId);
    const head = group && group.winner;
    if (!head) {
      _causalError("ledger-causal-orphan", `Entry ${entryId} has no causal head.`, null, entryId);
    }
    const live = !!group.activeAdd;
    if (type === "add" && live) {
      _causalError(
        "ledger-causal-duplicate-live-add",
        `Cannot add entry ${entryId} because it is already live.`,
        head.event,
        entryId
      );
    }
    if (type !== "add" && !live) {
      _causalError(
        "ledger-causal-invalid-transition",
        `Cannot ${type} entry ${entryId} because it is removed.`,
        head.event,
        entryId
      );
    }
    if (head.effective.seq >= Number.MAX_SAFE_INTEGER) {
      _causalError("ledger-causal-sequence", `Entry ${entryId} exhausted its causal sequence.`, head.event, entryId);
    }
    return { entryId, seq: head.effective.seq + 1, parentEventId: head.event.id };
  }

  function todayKey(d) {
    const t = d ? new Date(d) : new Date();
    const y = t.getFullYear(), m = String(t.getMonth() + 1).padStart(2, "0"), dd = String(t.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  /** entry: { name, displayQty, grams, macros:{kcal,p,c,f,fb,na}, sd, meal, source, cat, foodId }
   *  Pass entry.id to restore a removed entry (undo) with the same identity. */
  function addEntry(day, entry) {
    const entryId = entry && entry.id ? entry.id : uid();
    const { id: _ignore, addedTs: _a, history: _h, ...rest } = entry || {};
    const causal = _nextCausal(day, entryId, "add");
    let resetEpoch;
    if (causal.seq === 0) resetEpoch = _safeGeneration(_context.getResetEpoch());
    else {
      const parent = _load().find((event) => event && event.id === causal.parentEventId);
      resetEpoch = _safeGeneration(parent && parent.resetEpoch);
    }
    const ev = {
      id: uid(), ts: _eventTimestamp(), day, type: "add", causal, resetEpoch,
      entry: { ...rest, id: entryId },
    };
    // A restore remains in its original causal component and cannot redefine
    // the day. Only the first immutable root add on a previously-unlogged day
    // owns the frozen target snapshot.
    if (causal.seq === 0 && !hasEverAdded(day)) {
      const lock = _normalizedDayGoalLock(_context.getDayGoalLock(day));
      if (lock) ev.dayGoalLock = lock;
    }
    return _append(ev);
  }

  /** patch: full replacement fields (recomputed upstream): grams, displayQty, macros, sd, name?, meal? */
  function amendEntry(day, targetEntryId, patch, label) {
    const causal = _nextCausal(day, targetEntryId, "amend");
    const parent = _load().find((event) => event && event.id === causal.parentEventId);
    return _append({
      id: uid(), ts: _eventTimestamp(), day, type: "amend", causal,
      resetEpoch: _safeGeneration(parent && parent.resetEpoch),
      target: targetEntryId, patch, label: label || "",
    });
  }

  function removeEntry(day, targetEntryId, label) {
    const causal = _nextCausal(day, targetEntryId, "remove");
    const parent = _load().find((event) => event && event.id === causal.parentEventId);
    return _append({
      id: uid(), ts: _eventTimestamp(), day, type: "remove", causal,
      resetEpoch: _safeGeneration(parent && parent.resetEpoch),
      target: targetEntryId, label: label || "",
    });
  }

  function eventsFor(day) {
    const list = _index().get(day);
    return list ? list.slice() : [];
  }

  /** Day keys that hold at least one event, ascending. */
  function loggedDayKeys() {
    return [..._index().keys()].sort();
  }

  /** Compare entry vs amend patch → user-facing before/after pairs. */
  function _diffEntry(prev, patch) {
    const out = [];
    const p = patch || {};
    if (p.name != null && p.name !== prev.name) out.push({ field: "name", from: prev.name, to: p.name });
    if (p.displayQty != null && p.displayQty !== prev.displayQty) {
      out.push({ field: "qty", from: prev.displayQty, to: p.displayQty });
    }
    if (p.meal != null && p.meal !== prev.meal) out.push({ field: "meal", from: prev.meal, to: p.meal });
    const toK = p.macros && p.macros.kcal;
    const fromK = prev.macros && prev.macros.kcal;
    if (Number.isFinite(toK) && Number.isFinite(fromK) && Math.round(toK) !== Math.round(fromK)) {
      out.push({ field: "kcal", from: Math.round(fromK), to: Math.round(toK) });
    }
    return out;
  }

  /** Reduce a day's events → current entries (with .history of corrections). */
  function entriesFor(day) {
    return replayEvents(eventsFor(day));
  }

  /**
   * Totals with uncertainty.
   *
   * Sodium and potassium preserve completeness: null/missing means unknown,
   * while numeric 0 means a known zero. `naCoverage` / `kCoverage` are the
   * conservative minimum of calorie share and item share represented by
   * entries with a known value. Taking both shares means a zero-calorie item
   * with an unknown mineral still lowers completeness. `naKCoverage` and the
   * paired totals use only entries where both minerals are known.
   */
  function totalsFor(day) {
    return totalsOf(entriesFor(day));
  }

  function totalsOf(entries) {
    const keys = ["kcal", "p", "c", "f", "fb"];
    const out = { count: entries.length };
    for (const k of keys) {
      let mean = 0, varSum = 0;
      for (const e of entries) {
        const v = (e.macros && e.macros[k]) || 0;
        mean += v;
        const s = v * (e.sd || 0.1);
        varSum += s * s;
      }
      out[k] = { mean: Math.round(mean * 10) / 10, sd: Math.round(Math.sqrt(varSum) * 10) / 10 };
    }

    const completeMineral = (key) => {
      let mean = 0, varSum = 0, items = 0, kcalKnown = 0, kcalAll = 0;
      for (const e of entries) {
        const kcal = Number(e.macros && e.macros.kcal);
        const safeKcal = Number.isFinite(kcal) ? Math.max(0, kcal) : 0;
        kcalAll += safeKcal;
        const raw = e.macros ? e.macros[key] : null;
        if (raw == null || !Number.isFinite(Number(raw))) continue;
        const value = Number(raw);
        mean += value;
        const sigma = value * (e.sd || 0.1);
        varSum += sigma * sigma;
        items += 1;
        kcalKnown += safeKcal;
      }
      const calorieCoverage = entries.length === 0
        ? 0
        : (kcalAll > 0 ? kcalKnown / kcalAll : items / entries.length);
      const itemCoverage = entries.length ? items / entries.length : 0;
      return {
        total: { mean: Math.round(mean * 10) / 10, sd: Math.round(Math.sqrt(varSum) * 10) / 10 },
        items,
        calorieCoverage,
        itemCoverage,
        coverage: Math.min(calorieCoverage, itemCoverage),
      };
    };

    const sodium = completeMineral("na");
    out.na = sodium.total;
    out.naItems = sodium.items;
    out.naCoverage = sodium.coverage;

    // Potassium is summed only over entries that actually have a value, and
    // the share of the day's calories those entries represent is reported
    // alongside it. A total of "2,100 mg" means nothing without knowing
    // whether it covers the whole day or a third of it — and the Na:K ratio
    // is unusable without that, since missing potassium always biases the
    // ratio upward (worse-looking) rather than randomly.
    const potassium = completeMineral("k");
    out.k = potassium.total;
    out.kItems = potassium.items;
    out.kCoverage = potassium.coverage;

    let pairedNa = 0, pairedK = 0, pairedItems = 0, pairedKcal = 0, allKcal = 0;
    for (const e of entries) {
      const kcal = Number(e.macros && e.macros.kcal);
      const safeKcal = Number.isFinite(kcal) ? Math.max(0, kcal) : 0;
      allKcal += safeKcal;
      const rawNa = e.macros ? e.macros.na : null;
      const rawK = e.macros ? e.macros.k : null;
      if (rawNa == null || rawK == null ||
          !Number.isFinite(Number(rawNa)) || !Number.isFinite(Number(rawK))) continue;
      pairedNa += Number(rawNa);
      pairedK += Number(rawK);
      pairedItems += 1;
      pairedKcal += safeKcal;
    }
    const pairedCalorieCoverage = entries.length === 0
      ? 0
      : (allKcal > 0 ? pairedKcal / allKcal : pairedItems / entries.length);
    const pairedItemCoverage = entries.length ? pairedItems / entries.length : 0;
    out.naKNa = { mean: Math.round(pairedNa * 10) / 10 };
    out.naKK = { mean: Math.round(pairedK * 10) / 10 };
    out.naKItems = pairedItems;
    out.naKCoverage = Math.min(pairedCalorieCoverage, pairedItemCoverage);
    return out;
  }

  /** Last n day-keys that have events (excluding `day` optionally), newest first. */
  function recentDays(n, beforeDay) {
    const days = loggedDayKeys().reverse();
    return days.filter((d) => !beforeDay || d < beforeDay).slice(0, n);
  }

  /** Averages over recent days for coach context. */
  function recentSummary(nDays, excludeDay) {
    const days = recentDays(nDays, excludeDay);
    return days.map((d) => {
      const t = totalsFor(d);
      return { day: d, kcal: Math.round(t.kcal.mean), p: Math.round(t.p.mean), c: Math.round(t.c.mean), f: Math.round(t.f.mean), fb: Math.round(t.fb.mean), na: Math.round(t.na.mean), items: t.count };
    });
  }

  function _quantile(sorted, q) {
    if (!sorted.length) return null;
    if (sorted.length === 1) return sorted[0];
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /**
   * Historical logged grams for a foodId (weigh-first portion guidance).
   * @returns {{ n: number, median: number|null, p25: number|null, p75: number|null, last: number|null }}
   */
  function portionStats(foodId, opts) {
    const empty = { n: 0, median: null, p25: null, p75: null, last: null };
    const id = String(foodId || "");
    if (!id) return empty;
    const lookbackDays = opts && opts.lookbackDays != null ? opts.lookbackDays : 60;
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - Math.max(0, lookbackDays));
    const startKey = todayKey(start);
    const endKey = todayKey(end);

    const samples = []; // { grams, ts }
    const days = loggedDayKeys().filter((d) => d >= startKey && d <= endKey);
    for (const day of days) {
      for (const e of entriesFor(day)) {
        if (e.foodId !== id) continue;
        const g = +e.grams;
        if (!Number.isFinite(g) || g <= 0) continue;
        samples.push({ grams: g, ts: e.addedTs || 0 });
      }
    }
    if (!samples.length) return empty;
    samples.sort((a, b) => a.ts - b.ts);
    const grams = samples.map((s) => s.grams).slice().sort((a, b) => a - b);
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      n: grams.length,
      median: r1(_quantile(grams, 0.5)),
      p25: r1(_quantile(grams, 0.25)),
      p75: r1(_quantile(grams, 0.75)),
      last: r1(samples[samples.length - 1].grams),
    };
  }

  /** Find today's entry by fuzzy name, most recent first. "that"/"" → most recent entry. */
  function findEntry(day, targetName, scorer) {
    const entries = entriesFor(day);
    if (!entries.length) return null;
    const t = String(targetName || "").trim().toLowerCase();
    if (!t || t === "that" || t === "it" || t === "last" || t === "the last one") return entries[entries.length - 1];
    let best = null;
    for (const e of entries) {
      const s = scorer ? scorer(t, e.name) : (e.name.toLowerCase().includes(t) ? 0.8 : 0);
      if (!best || s > best.s) best = { e, s };
    }
    return best && best.s >= 0.45 ? best.e : null;
  }

  function allEvents() { return [..._load()]; }
  /** Immutable history check: removing the last visible entry does not erase that logging began. */
  function hasEverAdded(day) {
    return eventsFor(day).some((event) => event && event.type === "add");
  }
  /** First immutable add timestamp for audit provenance; null when the day never began. */
  function firstAddAt(day) {
    let first = null;
    const analysis = _analyzeEvents(eventsFor(day));
    for (const group of analysis.groups.values()) {
      const ts = Number(group.root && group.root.event && group.root.event.ts);
      if (!Number.isFinite(ts)) continue;
      if (first == null || ts < first) first = ts;
    }
    return first;
  }
  function replaceAll(events) {
    const next = Array.isArray(events) ? events : [];
    _write(next, "replace");
    _cache = next;
    _invalidate();
  }
  function clearAll() {
    try { store.removeItem(KEY); }
    catch (e) { throw new PersistenceError("clear", e); }
    _cache = [];
    _invalidate();
  }
  function _resetCacheForTests() { _cache = null; _invalidate(); }
  function _setStoreForTests(next) {
    store = next;
    _cache = null;
    _invalidate();
  }

  return {
    todayKey, addEntry, amendEntry, removeEntry, entriesFor, totalsFor, totalsOf,
    recentDays, recentSummary, portionStats, findEntry, allEvents, loggedDayKeys, hasEverAdded, firstAddAt,
    replayEvents, validateEvents, rootAddEvents, filterEventsByResetEpoch, configureContext,
    replaceAll, clearAll, _resetCacheForTests, _setStoreForTests,
    CausalError, isCausalError: (e) => !!e && /^ledger-causal-/.test(String(e.code || "")),
    PersistenceError, isPersistenceError: (e) => !!e && e.code === "ledger-persistence-failed", uid,
  };
})();

if (typeof module !== "undefined") module.exports = Ledger;
