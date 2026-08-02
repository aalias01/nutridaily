/* NutriChat — event-sourced day ledger.
 * Every change is an immutable event: add | amend | remove.
 * State (entries, totals) is always derived by reduction — never stored.
 * Uncertainty: each entry has sd (relative). Totals carry a ±1σ interval,
 * σ_total = sqrt(Σ (value_i · sd_i)²) — independent errors assumption.
 */
const Ledger = (() => {
  const KEY = "nc_events_v1";

  const store = (() => {
    if (typeof localStorage !== "undefined") return localStorage;
    let mem = {}; // node test shim
    return { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => (mem[k] = String(v)), removeItem: (k) => delete mem[k] };
  })();

  let _cache = null;

  function _load() {
    if (_cache) return _cache;
    try { _cache = JSON.parse(store.getItem(KEY) || "[]"); }
    catch (e) { _cache = []; }
    return _cache;
  }
  function _save() { store.setItem(KEY, JSON.stringify(_cache)); }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function todayKey(d) {
    const t = d ? new Date(d) : new Date();
    const y = t.getFullYear(), m = String(t.getMonth() + 1).padStart(2, "0"), dd = String(t.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  /** entry: { name, displayQty, grams, macros:{kcal,p,c,f,fb,na}, sd, meal, source, cat, foodId } */
  function addEntry(day, entry) {
    const ev = { id: uid(), ts: Date.now(), day, type: "add", entry: { ...entry, id: uid() } };
    _load().push(ev); _save();
    return ev;
  }

  /** patch: full replacement fields (recomputed upstream): grams, displayQty, macros, sd, name?, meal? */
  function amendEntry(day, targetEntryId, patch, label) {
    const ev = { id: uid(), ts: Date.now(), day, type: "amend", target: targetEntryId, patch, label: label || "" };
    _load().push(ev); _save();
    return ev;
  }

  function removeEntry(day, targetEntryId, label) {
    const ev = { id: uid(), ts: Date.now(), day, type: "remove", target: targetEntryId, label: label || "" };
    _load().push(ev); _save();
    return ev;
  }

  function eventsFor(day) { return _load().filter((e) => e.day === day); }

  /** Reduce a day's events → current entries (with .history of corrections). */
  function entriesFor(day) {
    const map = new Map(); // entryId → entry
    for (const ev of eventsFor(day)) {
      if (ev.type === "add") {
        map.set(ev.entry.id, { ...ev.entry, addedTs: ev.ts, history: [] });
      } else if (ev.type === "amend") {
        const cur = map.get(ev.target);
        if (cur) {
          cur.history.push(ev.label || "amended");
          Object.assign(cur, ev.patch);
        }
      } else if (ev.type === "remove") {
        map.delete(ev.target);
      }
    }
    return [...map.values()].sort((a, b) => a.addedTs - b.addedTs);
  }

  /** Totals with uncertainty. Returns { kcal:{mean,sd}, p:{...}, c, f, fb, na, count } */
  function totalsFor(day) {
    return totalsOf(entriesFor(day));
  }

  function totalsOf(entries) {
    const keys = ["kcal", "p", "c", "f", "fb", "na"];
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
    return out;
  }

  /** Last n day-keys that have events (excluding `day` optionally), newest first. */
  function recentDays(n, beforeDay) {
    const days = [...new Set(_load().map((e) => e.day))].sort().reverse();
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
  function replaceAll(events) { _cache = Array.isArray(events) ? events : []; _save(); }
  function clearAll() { _cache = []; store.removeItem(KEY); }
  function _resetCacheForTests() { _cache = null; }

  return { todayKey, addEntry, amendEntry, removeEntry, entriesFor, totalsFor, totalsOf, recentDays, recentSummary, findEntry, allEvents, replaceAll, clearAll, _resetCacheForTests, uid };
})();

if (typeof module !== "undefined") module.exports = Ledger;
