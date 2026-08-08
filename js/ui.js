/* NutriDaily — DOM rendering for the diary UI. */
const UI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const fmt = (n) => {
    const value = Number(n);
    return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let _focusStack = [];
  let _sheetStack = [];
  let _trendHit = null; // { keys, pad, iw, w }
  let _weightHit = null; // { keys, pad, iw, w, byDay, unit }
  let expandedEntryId = null;
  let expandedDayKey = null;
  let expandedGapItemId = null;
  let _modalInert = [];

  function clearModalInert() {
    for (const row of _modalInert) {
      if (!row.hadAttribute) row.node.removeAttribute("inert");
      if ("inert" in row.node) row.node.inert = row.hadProperty;
      if (row.hadAriaHidden) row.node.setAttribute("aria-hidden", row.ariaHiddenValue);
      else row.node.removeAttribute("aria-hidden");
    }
    _modalInert = [];
  }

  /** Inert siblings at each ancestor level, never the sheet or its ancestors. */
  function syncModalInert() {
    clearModalInert();
    const id = topSheetId();
    document.body.classList.toggle("sheet-open", !!id);
    let current = id && $(`#${id}`);
    if (!current) return;
    while (current && current.parentElement) {
      const parent = current.parentElement;
      for (const sibling of parent.children) {
        if (sibling === current || sibling.hasAttribute("inert")) continue;
        _modalInert.push({
          node: sibling,
          hadAttribute: sibling.hasAttribute("inert"),
          hadProperty: "inert" in sibling ? sibling.inert : false,
          hadAriaHidden: sibling.hasAttribute("aria-hidden"),
          ariaHiddenValue: sibling.getAttribute("aria-hidden"),
        });
        sibling.setAttribute("inert", "");
        if ("inert" in sibling) sibling.inert = true;
        sibling.setAttribute("aria-hidden", "true");
      }
      current = parent;
      if (current === document.body) break;
    }
  }

  function focusInsideSheet(sheet, fromEnd, containerOnly) {
    if (!sheet) return;
    const nodes = focusablesIn(sheet);
    const target = !containerOnly && nodes.length ? (fromEnd ? nodes[nodes.length - 1] : nodes[0]) : sheet;
    if (!target.hasAttribute("tabindex") && target === sheet) target.setAttribute("tabindex", "-1");
    try { target.focus({ preventScroll: true }); } catch (e) { try { target.focus(); } catch (_e) {} }
  }

  function toast(msg, opts) {
    const el = $("#toast");
    clearTimeout(toast._t);
    if (opts && opts.action) {
      el.innerHTML = `${esc(msg)} <button type="button" class="toast-action">${esc(opts.action.label)}</button>`;
      el.style.pointerEvents = "auto";
      const btn = el.querySelector(".toast-action");
      if (btn) {
        btn.onclick = (e) => {
          e.stopPropagation();
          el.classList.remove("show");
          el.style.pointerEvents = "none";
          // Defer so a nested toast("Restored") isn't immediately cleared
          setTimeout(() => opts.action.onClick(), 0);
        };
      }
      el.classList.add("show");
      toast._t = setTimeout(() => { el.classList.remove("show"); el.style.pointerEvents = "none"; }, opts.ms || 5000);
    } else {
      el.textContent = msg;
      el.style.pointerEvents = "none";
      el.classList.add("show");
      toast._t = setTimeout(() => el.classList.remove("show"), opts && opts.ms ? opts.ms : 2200);
    }
  }

  function openSheet(id, opts) {
    const el = $(`#${id}`);
    if (!el) return;
    if (el._hideTimer) { clearTimeout(el._hideTimer); el._hideTimer = null; }
    const isNew = !_sheetStack.includes(id);
    if (isNew) {
      _focusStack.push(document.activeElement);
      el._returnFocus = document.activeElement;
      _sheetStack.push(id);
    }
    el.hidden = false;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.setAttribute("role", el.getAttribute("role") || "dialog");
    el.setAttribute("aria-modal", "true");
    if (!el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) {
      const heading = el.querySelector("h1, h2, h3");
      if (heading) {
        if (!heading.id) heading.id = `${id}-title`;
        el.setAttribute("aria-labelledby", heading.id);
      }
    }
    if (el._openFrame) cancelAnimationFrame(el._openFrame);
    el._openFrame = requestAnimationFrame(() => {
      el._openFrame = null;
      // A save can close a sheet before its opening frame runs (especially in
      // tests or with keyboard submit). Do not revive a sheet already closed.
      if (!_sheetStack.includes(id) || el.hidden) return;
      el.classList.add("open");
      // Don't autofocus the picker search — it covers the food list with the mobile keyboard
      const skipFocus = (opts && opts.noAutofocus) || id === "sheet-add";
      if (skipFocus) {
        focusInsideSheet(el, false, true);
        return;
      }
      const focusable = el.querySelector("input:not([type=hidden]), button.btn, textarea, select");
      if (focusable) focusable.focus();
      else focusInsideSheet(el, false);
    });
    syncModalInert();
    if ((opts && opts.noAutofocus) || id === "sheet-add") focusInsideSheet(el, false, true);
  }
  function closeSheet(id) {
    const el = typeof id === "string" ? $(`#${id}`) : id;
    if (!el) return;
    const sid = el.id;
    if (el._openFrame) {
      cancelAnimationFrame(el._openFrame);
      el._openFrame = null;
    }
    const idx = _sheetStack.lastIndexOf(sid);
    // Speculative / duplicate closes must not pop the focus stack
    if (idx < 0) return;
    const returnFocus = el._returnFocus || _focusStack[idx] || null;
    el._returnFocus = null;
    _sheetStack.splice(idx, 1);
    if (idx < _focusStack.length) _focusStack.splice(idx, 1);
    syncModalInert();
    const shouldRestore = true;
    el.classList.remove("open");
    if (el._hideTimer) clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.hidden = true;
      el._hideTimer = null;
      if (!shouldRestore) return;
      const top = topSheetId();
      const topEl = top && $(`#${top}`);
      // If another modal opened while this one was animating closed, only
      // restore focus when the original trigger belongs to that modal.
      if (topEl && (!returnFocus || !topEl.contains(returnFocus))) return;
      if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) {
        try { returnFocus.focus(); } catch (e) {}
      }
    }, 200);
  }

  function focusablesIn(el) {
    return [...el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((node) => {
        const hiddenAncestor = node.closest('[hidden], [aria-hidden="true"]');
        // The active sheet itself is already checked by the caller. Ignore its
        // own visibility marker here, but never include a control hidden by an
        // intermediate multi-step panel.
        return !hiddenAncestor || hiddenAncestor === el;
      });
  }

  // Keep keyboard focus inside the top modal sheet. Escape is handled by the
  // app, while Tab/Shift+Tab cycle here so focus cannot reach the obscured UI.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const id = topSheetId();
    const sheet = id && $(`#${id}`);
    if (!sheet || sheet.hidden) return;
    const nodes = focusablesIn(sheet);
    if (!nodes.length) { e.preventDefault(); return; }
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (!sheet.contains(document.activeElement) || !nodes.includes(document.activeElement)) {
      e.preventDefault();
      focusInsideSheet(sheet, !!e.shiftKey);
    }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Programmatic focus and assistive-technology navigation can bypass Tab.
  // Pull escaped focus back into the active dialog immediately.
  document.addEventListener("focusin", (e) => {
    const id = topSheetId();
    const sheet = id && $(`#${id}`);
    if (!sheet || sheet.hidden || sheet.contains(e.target)) return;
    focusInsideSheet(sheet, false);
  });
  function closeAllSheets() {
    [..._sheetStack].reverse().forEach((id) => closeSheet(id));
  }
  function topSheetId() {
    return _sheetStack.length ? _sheetStack[_sheetStack.length - 1] : null;
  }

  function setDayLabel(dayKey, isToday, opts) {
    const d = new Date(dayKey + "T12:00:00");
    const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const btn = $("#day-label");
    const todayKey = (opts && opts.todayKey)
      || (typeof Ledger !== "undefined" && Ledger.todayKey ? Ledger.todayKey() : null);
    let relation = "today";
    if (todayKey && dayKey !== todayKey) {
      relation = dayKey > todayKey ? "future" : "past";
    } else if (!isToday) {
      relation = "past";
    }
    let suffix;
    if (relation === "today") {
      suffix = "today";
    } else if (relation === "future") {
      suffix = "tomorrow";
    } else {
      // Past: prefer "yesterday" when adjacent.
      let yesterday = null;
      if (todayKey) {
        const y = new Date(todayKey + "T12:00:00");
        y.setDate(y.getDate() - 1);
        yesterday = typeof Ledger !== "undefined" && Ledger.todayKey
          ? Ledger.todayKey(y)
          : y.toISOString().slice(0, 10);
      }
      suffix = dayKey === yesterday ? "yesterday" : "past";
    }
    btn.textContent = `${label} · ${suffix}`;
    btn.classList.toggle("is-today", relation === "today");
    btn.classList.toggle("is-past", relation === "past");
    btn.classList.toggle("is-future", relation === "future");
    btn.title = relation === "today" ? "Pick a date" : "Jump to today";
    btn.setAttribute("aria-label", relation === "today"
      ? `${label}, today. Pick a date`
      : `${label}, ${suffix}. Jump to today`);
    // Default remains today-only; callers that allow §10 plan-ahead pass
    // disableNext when viewDay has reached tomorrow.
    const disableNext = opts && Object.prototype.hasOwnProperty.call(opts, "disableNext")
      ? !!opts.disableNext
      : !!isToday;
    $("#btn-day-next").disabled = disableNext;
  }

  function updateHUD(totals, goals, opts) {
    // A declared fast that actually recorded food scores against the phase
    // targets, not the fast declaration (see Phases.effectiveGoals) — reading
    // goals._unscored directly here, as this used to, cannot see that: it
    // would keep showing "not scored today" on every macro while Insights
    // (which calls the same reconciliation) scores the day normally. Route
    // through the one shared implementation so the two tabs cannot disagree.
    const resolvedGoals = typeof Phases !== "undefined" ? Phases.effectiveGoals(totals, goals) : goals;
    const bumps = resolvedGoals && resolvedGoals._dayPlan;
    const unscored = (resolvedGoals && resolvedGoals._unscored) || null;
    const o = opts || {};
    const viewDay = o.viewDay || null;
    const todayKey = o.todayKey || (typeof Ledger !== "undefined" && Ledger.todayKey
      ? Ledger.todayKey()
      : null);
    const hud = $("#hud");
    const fastingRoot = $("#hud-fasting");
    const declaredFast = !!(goals && goals._dayPlan && goals._dayPlan.intent === "fast");
    const ateOnAFast = declaredFast && totals && totals.count > 0 &&
      Number(totals.kcal && totals.kcal.mean) > 0;
    // Honoured fast (including empty day and black-coffee-only): replace the
    // nutrient HUD. Food with calories reverts to the ordinary bars.
    const showFasting = declaredFast && !ateOnAFast;
    if (hud) hud.classList.toggle("is-fasting", showFasting);
    if (fastingRoot) {
      fastingRoot.hidden = !showFasting;
      if (showFasting) {
        const meta = $("#hud-fasting-meta");
        if (meta) {
          const plannedAt = Number(goals && goals._dayPlan && goals._dayPlan.plannedAt);
          const declared = Number.isFinite(plannedAt) && plannedAt > 0
            ? new Date(plannedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
            : null;
          // Hours elapsed of the *fast day*, not of the declaration: clamp to
          // start-of-viewDay, and only render while viewing today (past days
          // would tick forever as "192 h in").
          let elapsed = "";
          const isToday = !!(viewDay && todayKey && viewDay === todayKey);
          if (isToday && viewDay && /^\d{4}-\d{2}-\d{2}$/.test(String(viewDay))) {
            const dayStart = new Date(String(viewDay) + "T12:00:00");
            dayStart.setHours(0, 0, 0, 0);
            const startMs = dayStart.getTime();
            const endMs = typeof Phases !== "undefined" && typeof Phases.endOfLocalDayMs === "function"
              ? Phases.endOfLocalDayMs(viewDay)
              : (startMs + 24 * 3600000);
            const clockStart = Number.isFinite(plannedAt) && plannedAt > startMs
              ? plannedAt
              : startMs;
            const now = Math.min(Date.now(), Number.isFinite(endMs) ? endMs : Date.now());
            const hrs = Math.max(0, (now - clockStart) / 3600000);
            if (hrs > 0 || Number.isFinite(plannedAt)) {
              elapsed = hrs < 1
                ? ` · ${Math.max(1, Math.round(hrs * 60))} min in`
                : ` · ${Math.floor(hrs)} h in`;
            }
          }
          meta.textContent = declared
            ? `Declared ${declared}${elapsed}`
            : `Declared fast${elapsed}`;
        }
        // Keep nutrient cells in the empty-day dash state. The fasting panel
        // replaces them visually, but direct callers (and a later ordinary
        // day) must not read leftover "not scored" / coverage text.
        if ($("#v-kcal-big")) $("#v-kcal-big").textContent = "0";
        if ($("#kcal-range")) $("#kcal-range").textContent = "—";
        for (const id of ["kcal", "p", "c", "f", "fb", "sodium", "potassium"]) {
          const val = $(`#v-${id}`);
          if (val) val.textContent = "—";
          const fill = $(`#f-${id}`);
          if (fill) {
            fill.style.width = "0%";
            fill.classList.remove("near", "over");
          }
        }
        const nakLine = $("#v-nak");
        if (nakLine) {
          nakLine.hidden = false;
          nakLine.className = "nak-line small";
          nakLine.textContent = "—";
        }
        const naLine = $("#v-na");
        if (naLine) {
          naLine.hidden = true;
          naLine.textContent = "";
        }
      }
    }
    if (showFasting) return;
    // A plan can make a target arithmetically incoherent (see Phases.goalsForDay
    // / _unscored). Drawing a bar against a target that will not be graded
    // reads as a bug — the same over/under-vs-Insights confusion the "near"
    // HUD state exists to prevent for banded targets. This is the un-banded
    // version of that fix: no bar, no target line, just an honest label.
    const notScored = (id, mean, unit, coverage) => {
      const fill = $(`#f-${id}`), val = $(`#v-${id}`);
      if (!fill || !val) return null;
      const bar = fill.parentElement;
      fill.style.width = "0%";
      fill.classList.remove("near", "over");
      val.classList.remove("near", "over");
      if (bar && bar.classList.contains("bar")) {
        bar.classList.remove("warn", "warn-near", "warn-over");
        bar.title = "Not scored today — see Insights for why.";
      }
      // Same empty-day guard as incompleteMineral: with nothing logged at
      // all, "0 mg* · not scored today" plus a "0% covered" footnote reads as
      // a measurement that came back empty, not as the absence of one.
      if (!totals.count) { val.textContent = "—"; return null; }
      // A plan exemption does not make a partial known-subtotal complete —
      // caller passes `coverage` only when the mineral is also incomplete, so
      // the value keeps its asterisk and feeds the same footnote
      // incompleteMineral does, instead of quietly dropping both.
      const partial = Number.isFinite(coverage);
      const mark = partial ? "*" : "";
      val.textContent = unit
        ? `${fmt(mean)} ${unit}${mark} · not scored today`
        : `${fmt(mean)}${mark} · not scored today`;
      return partial ? Math.round(coverage * 100) : null;
    };
    const goalLabel = (resolved, key, unit) => {
      const g = Number(resolved) || 0;
      if (!g) return "";
      return unit ? `${fmt(g)} ${unit}` : `${fmt(g)}`;
    };
    const set = (id, mean, goal, key, unit) => {
      const fill = $(`#f-${id}`), val = $(`#v-${id}`);
      if (!fill || !val) return;
      const bar = fill.parentElement;
      const g = Number(goal) || 0;
      const pct = g ? Math.min(100, (mean / g) * 100) : 0;
      fill.style.width = pct + "%";
      // Today stays strict — it flags the moment you pass your number. But it
      // now names which side of the scoring band you are on, so a day that
      // reads amber here and green in Insights explains itself rather than
      // looking like the two tabs disagree. Status is a "!" on the bar (not
      // "over" in the value) so long mg figures don't wrap the card.
      const st = Phases.hudState(mean, g, Phases.BANDS[key]);
      fill.classList.toggle("near", st === "near");
      fill.classList.toggle("over", st === "over");
      val.classList.toggle("near", st === "near");
      val.classList.toggle("over", st === "over");
      if (bar && bar.classList.contains("bar")) {
        bar.classList.toggle("warn", st === "near" || st === "over");
        bar.classList.toggle("warn-near", st === "near");
        bar.classList.toggle("warn-over", st === "over");
        bar.title = st === "near" ? "Slightly over target" : st === "over" ? "Over target" : "";
      }
      const right = goalLabel(goal, key, unit);
      if (id === "kcal") val.textContent = g ? `${fmt(mean)} / ${right}` : `${fmt(mean)}`;
      else val.textContent = g ? `${fmt(mean)} / ${right}` : unit ? `${fmt(mean)} ${unit}` : `${fmt(mean)}`;
    };
    $("#v-kcal-big").textContent = fmt(totals.kcal.mean);
    const lo = Math.max(0, Math.round(totals.kcal.mean - totals.kcal.sd));
    const hi = Math.round(totals.kcal.mean + totals.kcal.sd);
    const dayPlanNote = bumps && bumps.kcal
      ? ` · planned ${fmt(resolvedGoals.kcal)} kcal (${bumps.kcal > 0 ? "+" : ""}${fmt(bumps.kcal)})`
      : "";
    $("#kcal-range").textContent = totals.count ? `likely ${fmt(lo)}–${fmt(hi)}${dayPlanNote}` : "—";
    set("kcal", totals.kcal.mean, resolvedGoals.kcal, "kcal", "");
    const macrosCovered = typeof Phases !== "undefined" && Phases.macrosCovered(totals);
    const macroFootCov = macrosCovered ? null : totals.macroCoverage;
    if (unscored && unscored.protein) notScored("p", totals.p.mean, "g", macroFootCov);
    else if (macrosCovered) set("p", totals.p.mean, resolvedGoals.protein, "protein", "g");
    else notScored("p", totals.p.mean, "g", totals.macroCoverage);
    if (unscored && unscored.carbs) notScored("c", totals.c.mean, "g", macroFootCov);
    else if (macrosCovered) set("c", totals.c.mean, resolvedGoals.carbs, "carbs", "g");
    else notScored("c", totals.c.mean, "g", totals.macroCoverage);
    if (unscored && unscored.fat) notScored("f", totals.f.mean, "g", macroFootCov);
    else if (macrosCovered) set("f", totals.f.mean, resolvedGoals.fat, "fat", "g");
    else notScored("f", totals.f.mean, "g", totals.macroCoverage);
    if (unscored && unscored.fiber) notScored("fb", totals.fb.mean, "g", macroFootCov);
    else if (macrosCovered) set("fb", totals.fb.mean, resolvedGoals.fiber, "fiber", "g");
    else notScored("fb", totals.fb.mean, "g", totals.macroCoverage);
    // The full "known subtotal · N% covered · incomplete" sentence used to
    // live inline in the value column, where it wrapped onto 2-3 lines and
    // threw off the whole card's row heights. It now collapses to a short
    // marked value ("0 mg*") with the explanation moved to a single shared
    // footnote line at the bottom of the card (see naLine below) — same
    // information, no layout breakage.
    const incompleteMineral = (id, total, coverage) => {
      const fill = $(`#f-${id}`), val = $(`#v-${id}`);
      if (!fill || !val) return null;
      const bar = fill.parentElement;
      fill.style.width = "0%";
      fill.classList.remove("near", "over");
      val.classList.remove("near", "over");
      if (bar && bar.classList.contains("bar")) {
        bar.classList.remove("warn", "warn-near", "warn-over");
        bar.title = "";
      }
      if (!totals.count) { val.textContent = "—"; return null; }
      val.textContent = `${fmt(total)} mg*`;
      return Number.isFinite(coverage) ? Math.round(coverage * 100) : null;
    };
    const sodiumCovered = typeof Phases !== "undefined" && Phases.sodiumCovered(totals);
    let naFootPct = null;
    if (unscored && unscored.sodium) {
      naFootPct = notScored("sodium", totals.na.mean, "mg", sodiumCovered ? null : totals.naCoverage);
    } else if (sodiumCovered) set("sodium", totals.na.mean, resolvedGoals.sodium, "sodium", "mg");
    else naFootPct = incompleteMineral("sodium", totals.na.mean, totals.naCoverage);

    // Absolute sodium and potassium each use their own coverage. The ratio is
    // stricter: only paired Na+K entries contribute to it.
    const potassiumCovered = typeof Phases !== "undefined" && Phases.potassiumCovered(totals);
    const jointCovered = typeof Phases !== "undefined" && Phases.nakCovered(totals);
    const kFill = $("#f-potassium");
    const kVal = $("#v-potassium");
    let kFootPct = null;
    if (kFill && kVal) {
      if (unscored && unscored.potassium) {
        kFootPct = notScored("potassium", totals.k.mean, "mg", potassiumCovered ? null : totals.kCoverage);
      } else if (potassiumCovered) {
        set("potassium", totals.k.mean, resolvedGoals.potassium, "potassium", "mg");
      } else {
        kFootPct = incompleteMineral("potassium", totals.k.mean, totals.kCoverage);
      }
    }
    const nakLine = $("#v-nak");
    if (nakLine) {
      if (unscored && unscored.naK) {
        nakLine.hidden = false;
        nakLine.className = "nak-line small";
        // Same empty-day guard as notScored()/incompleteMineral above: with
        // nothing logged at all, "Na:K — not scored today" is the one row on
        // an empty fast that does not read a plain dash like its neighbours.
        nakLine.textContent = totals.count ? "Na:K — not scored today" : "—";
      } else {
        const paired = jointCovered ? Phases.pairedMinerals(totals) : null;
        const ratio = paired ? Phases.naKRatio(paired.na, paired.k) : null;
        if (ratio == null) {
          nakLine.hidden = true;
          nakLine.textContent = "";
        } else {
          const target = Number(resolvedGoals.naK) || 1.0;
          const status = Phases.classify(ratio, target, Phases.BANDS.naK);
          nakLine.hidden = false;
          nakLine.className = `nak-line small ${status === "over" ? "over" : "ok"}`;
          nakLine.textContent = `Na:K ${ratio.toFixed(2)} (target ≤ ${target.toFixed(1)})`;
        }
      }
    }
    const naLine = $("#v-na");
    if (naLine) {
      const parts = [];
      if (naFootPct != null) parts.push(`Sodium ${naFootPct}%`);
      if (kFootPct != null) parts.push(`${parts.length ? "potassium" : "Potassium"} ${kFootPct}%`);
      if (parts.length) {
        naLine.hidden = false;
        naLine.textContent = `* ${parts.join(" and ")} covered by foods with a known amount.`;
      } else {
        naLine.hidden = true;
        naLine.textContent = "";
      }
    }
  }

  const MEALS = ["breakfast", "lunch", "dinner", "snack"];
  const MEAL_SHORT = { breakfast: "B", lunch: "L", dinner: "D", snack: "S" };

  /** Expand-only meal picker. actionPrefix: "entry" | "gap". Short pills: B L D S. */
  function mealPillsHtml(meal, id, actionPrefix) {
    const cur = MEALS.includes(meal) ? meal : "snack";
    const pills = MEALS.map((m) =>
      `<button type="button" class="uchip meal-pill${m === cur ? " active" : ""}" data-action="${esc(actionPrefix)}-set-meal" data-id="${esc(id)}" data-meal="${esc(m)}" aria-label="${esc(m)}" aria-pressed="${m === cur}">${esc(MEAL_SHORT[m])}</button>`
    ).join("");
    return `<div class="unit-chips meal-chips meal-pills-row" role="group" aria-label="Meal">${pills}</div>`;
  }

  /**
   * Inline amount for expanded diary/Planner rows.
   * Prefer logged wire unit (piece / oz / g); fall back to grams if count is missing.
   * null when there is nothing honest to edit (kcal-only / zero grams).
   */
  function inlineAmountFields({ qty, unit, grams }) {
    const u0 = unit || "g";
    const u = u0 === "grams" ? "g" : u0;
    if (u === "kcal") return null;
    const g = Number(grams);
    if (!(g > 0)) return null;
    if (u === "g") {
      return { value: Math.round(g), unitLabel: "g", unit: "g" };
    }
    const q = Number(qty);
    if (Number.isFinite(q) && q > 0) {
      return { value: q, unitLabel: u, unit: u };
    }
    return { value: Math.round(g), unitLabel: "g", unit: "g" };
  }

  function mealAmtEditHtml(meal, id, actionPrefix, amount, inputClass) {
    if (!amount) return mealPillsHtml(meal, id, actionPrefix);
    return `<div class="gap-plan-edit-row">
      ${mealPillsHtml(meal, id, actionPrefix)}
      <span class="gap-plan-amt-row">
        <input type="number" inputmode="decimal" min="0" step="any" class="gap-plan-qty${inputClass ? ` ${esc(inputClass)}` : ""}" data-id="${esc(id)}" data-unit="${esc(amount.unit)}" value="${esc(amount.value)}" aria-label="Amount in ${esc(amount.unitLabel)}">
        <span class="muted small">${esc(amount.unitLabel)}</span>
      </span>
    </div>`;
  }

  function entryTime(e) {
    if (!e.addedTs) return "";
    return new Date(e.addedTs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  /**
   * Badge / expand chrome for ledger entries that are not library foods.
   * Uses Foods.entryProvenance — never Foods.provenance (food-shaped).
   */
  function entrySourceChrome(entry) {
    const blank = { kind: "", badge: "", detailLine: "", short: "" };
    if (!entry || typeof Foods === "undefined" || !Foods.entryProvenance) return blank;
    const prov = Foods.entryProvenance(entry);
    if (prov.kind !== "once" && prov.kind !== "quick") return blank;
    const short = prov.kind === "once" ? "One-off" : "Quick";
    const title = prov.detail || prov.label || short;
    return {
      kind: prov.kind,
      short,
      badge: ` <span class="src-badge src-badge-${esc(prov.kind)}" title="${esc(title)}">${esc(short)}</span>`,
      detailLine: `<div class="r-prov" title="${esc(title)}">${esc(prov.detail || prov.label)}</div>`,
    };
  }

  /** Prefer once over quick when a day-detail aggregate name mixes sources. */
  function nameSourceKind(entries, name) {
    let once = false;
    let quick = false;
    for (const e of entries || []) {
      if (e.name !== name) continue;
      if (e.source === "once") once = true;
      else if (e.source === "quick") quick = true;
    }
    if (once) return "once";
    if (quick) return "quick";
    return "";
  }

  function sourceBadgeForKind(kind) {
    if (kind !== "once" && kind !== "quick") return "";
    const short = kind === "once" ? "One-off" : "Quick";
    const title = kind === "once"
      ? "Logged once from your own estimate. Not saved to My Foods."
      : "Calories only; protein and other macros are logged as zero.";
    return ` <span class="src-badge src-badge-${esc(kind)}" title="${esc(title)}">${esc(short)}</span>`;
  }

  /** Portion-scaled nutrition for Today cards and qty preview. */
  function fmtMacros(m) {
    if (!m) return "";
    const amount = (value) => Number.isFinite(Number(value)) ? Number(value) : "?";
    const na = m.na == null ? "?" : fmt(m.na);
    const k = m.k == null ? "?" : fmt(m.k);
    return `P ${amount(m.p)} · C ${amount(m.c)} · F ${amount(m.f)} · Fb ${amount(m.fb)} · Na ${na} · K ${k}`;
  }

  /** Newest amend → short "Edited: …" line for the expanded log row. */
  function fmtEditNote(history) {
    if (!history || !history.length) return "";
    const last = history[history.length - 1];
    if (typeof last === "string") {
      const n = history.length > 1 ? ` (${history.length} edits)` : "";
      return `Edited: ${last}${n}`;
    }
    const ch = (last && last.changes) || [];
    const pair = (c) => {
      if (c.field === "kcal") return `${c.from} kcal → ${c.to} kcal`;
      return `${c.from} → ${c.to}`;
    };
    const body = ch.length
      ? ch.slice(0, 2).map(pair).join(" · ") + (ch.length > 2 ? ` +${ch.length - 2} more` : "")
      : (last && last.label) || "amended";
    const n = history.length > 1 ? ` (${history.length} edits)` : "";
    return `Edited: ${body}${n}`;
  }

  function toggleEntryExpand(id) {
    expandedEntryId = expandedEntryId === id ? null : id;
  }

  function setExpandedEntryId(id) {
    expandedEntryId = id || null;
  }

  function toggleGapItemExpand(id) {
    expandedGapItemId = expandedGapItemId === id ? null : id;
  }

  function setExpandedGapItemId(id) {
    expandedGapItemId = id || null;
  }

  function renderDayLog(dayKey, entries) {
    const root = $("#day-log");
    if (dayKey !== expandedDayKey) {
      expandedEntryId = null;
      expandedDayKey = dayKey;
    }
    if (expandedEntryId && !entries.some((e) => e.id === expandedEntryId)) {
      expandedEntryId = null;
    }
    if (!entries.length) {
      root.innerHTML = `<div class="empty">Nothing logged yet.<br><span class="muted small">Tap + to add a food. Swipe left/right to change days.</span></div>`;
      return;
    }
    const groups = {};
    for (const m of MEALS) groups[m] = [];
    for (const e of entries) {
      const m = MEALS.includes(e.meal) ? e.meal : "snack";
      groups[m].push(e);
    }
    root.innerHTML = MEALS.filter((m) => groups[m].length).map((meal) => {
      const mealKcal = groups[meal].reduce((s, e) => s + ((e.macros && e.macros.kcal) || 0), 0);
      const rows = groups[meal].map((e) => {
        const t = entryTime(e);
        const isExp = e.id === expandedEntryId;
        const editNote = isExp ? fmtEditNote(e.history) : "";
        const chrome = entrySourceChrome(e);
        const amount = inlineAmountFields({ qty: e.qty, unit: e.unit, grams: e.grams });
        const mealAmtRow = mealAmtEditHtml(e.meal || meal, e.id, "entry", amount, "entry-inline-qty");
        const expanded = isExp
          ? `<div class="r-expanded">
              <div class="r-expanded-main">
                <div class="r-contrib">${esc(fmtMacros(e.macros))}</div>
                ${mealAmtRow}
                ${chrome.detailLine || ""}
                ${editNote ? `<div class="r-edits">${esc(editNote)}</div>` : ""}
              </div>
              <div class="r-expanded-actions">
                <button type="button" class="linkbtn edit-entry-btn" data-action="edit-entry" data-id="${esc(e.id)}">Edit</button>
                ${e.source === "once" && Number(e.grams) > 0
                  ? `<button type="button" class="linkbtn" data-action="promote-once" data-id="${esc(e.id)}">Save to My Foods</button>`
                  : (e.source === "once" || e.source === "quick"
                    ? `<button type="button" class="linkbtn" disabled title="Add a portion weight first; a saved food needs to know what 100 g looks like.">Save to My Foods</button>`
                    : "")}
              </div>
            </div>`
          : "";
        return `<div class="log-row-stack${isExp ? " is-expanded" : ""}" data-id="${esc(e.id)}">
          <div class="log-row${isExp ? " expanded" : ""}">
            <button type="button" class="log-row-main" data-action="toggle-entry" data-id="${esc(e.id)}">
              <div class="r-top">
                <div>
                  <div class="r-name">${esc(e.name)}${chrome.badge}</div>
                  <div class="r-qty">${esc(e.displayQty)}${t ? ` · ${esc(t)}` : ""}</div>
                </div>
                <div class="r-macros">
                  <span class="mini">${fmt(e.macros.kcal)} kcal</span>
                  <span class="mini">P ${esc(Number.isFinite(Number(e.macros && e.macros.p)) ? Number(e.macros.p) : "?")}</span>
                </div>
              </div>
            </button>
            <button type="button" class="log-row-delete" data-action="remove-entry" data-id="${esc(e.id)}" aria-label="Delete ${esc(e.name)}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
              </svg>
            </button>
          </div>
          ${expanded}
        </div>`;
      }).join("");
      return `<div class="meal-group"><div class="meal-label">${esc(meal)} · ${fmt(mealKcal)} kcal</div>${rows}</div>`;
    }).join("");
  }

  function renderFoods(list, query) {
    const q = String(query || "").trim().toLowerCase();
    let foods = Foods.sortForPicker(list);
    if (q) {
      foods = foods.filter((f) => {
        const names = [f.name, ...(f.aliases || [])].join(" ").toLowerCase();
        return names.includes(q) || FoodMatch.scoreMatch(q, f.name) >= 0.45;
      }).sort((a, b) => FoodMatch.scoreMatch(q, b.name) - FoodMatch.scoreMatch(q, a.name));
    }
    const root = $("#foods-list");
    if (!foods.length) {
      root.innerHTML = `<div class="empty">${q ? "No matches." : "No foods yet.<br><span class=\"muted small\">Add one via NUTRI import, or log a common food from Today.</span>"}</div>`;
      return;
    }
    root.innerHTML = foods.map((f) => {
      const sub = `per 100 g: ${fmt(f.per100.kcal)} kcal · P ${f.per100.p}`;
      return `<button type="button" class="food-item" data-action="food-detail" data-id="${esc(f.id)}">
        <div><div class="r-name">${esc(f.name)}</div><div class="r-qty">${esc(sub)}</div></div>
        <span class="muted small">›</span>
      </button>`;
    }).join("");
  }

  function renderPicker(personal, query, showCatalog, extras) {
    const q = String(query || "").trim();
    const root = $("#pick-list");
    const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
    const byId = new Map(DB.map((f) => [f.id, f]));
    const personalActive = Foods.active(personal);
    const ownedCatalogIds = new Set(personalActive.map((f) => f.catalogId).filter(Boolean));
    const yesterday = (!q && extras && extras.yesterday) ? extras.yesterday : [];
    const yesterdayLabel = (extras && extras.yesterdayLabel) || "Yesterday";
    const multiMode = !!(extras && extras.multiMode);
    const selectedKeys = (extras && extras.selectedKeys) || new Set();

    const recent = q ? [] : Foods.recent(personal, 8);
    const recentIds = new Set(recent.map((f) => f.id));
    const freq = q ? [] : Foods.frequent(personal, 8, recentIds);
    let all = personalActive;
    if (q) {
      all = all.filter((f) => FoodMatch.scoreMatch(q, f.name) >= 0.35 || (f.aliases || []).some((a) => FoodMatch.scoreMatch(q, a) >= 0.35))
        .sort((a, b) => FoodMatch.scoreMatch(q, b.name) - FoodMatch.scoreMatch(q, a.name));
    } else {
      all = Foods.sortForPicker(personal).filter((f) => !recentIds.has(f.id) && !freq.find((x) => x.id === f.id));
    }

    const check = () => multiMode
      ? `<span class="pick-check" aria-hidden="true"></span>`
      : "";
    const personalRow = (f) => {
      const selected = selectedKeys.has(`food:${f.id}`);
      return `<button type="button" class="log-row${selected ? " pick-selected" : ""}" data-action="pick-food" data-id="${esc(f.id)}" aria-pressed="${selected ? "true" : "false"}">
        ${check()}
        <div class="pick-meta">
          <div class="r-name">${esc(f.name)}</div>
        </div>
        <span class="mini">${fmt(f.per100.kcal)} /100g</span>
      </button>`;
    };
    const catalogRow = (f) => {
      const selected = selectedKeys.has(`cat:${f.id}`);
      return `<button type="button" class="log-row${selected ? " pick-selected" : ""}" data-action="pick-catalog" data-id="${esc(f.id)}" aria-pressed="${selected ? "true" : "false"}">
        ${check()}
        <div class="pick-meta">
          <div class="r-name">${esc(f.name)}</div>
        </div>
        <span class="mini">${fmt(f.per100.kcal)} /100g</span>
      </button>`;
    };
    const yRow = (e) => {
      const chrome = entrySourceChrome(e);
      const key = e.foodId ? `food:${e.foodId}` : `yest:${e.id}`;
      const selected = selectedKeys.has(key);
      if (multiMode) {
        return `<button type="button" class="log-row${selected ? " pick-selected" : ""}" data-action="repeat-yesterday" data-id="${esc(e.id)}" aria-pressed="${selected ? "true" : "false"}">
          ${check()}
          <div class="pick-meta">
            <div class="r-name">${esc(e.name)}${chrome.badge}</div>
            <div class="r-qty">${esc(e.displayQty)} · ${esc(e.meal || "")}</div>
          </div>
          <span class="mini">${fmt(e.macros.kcal)} kcal</span>
        </button>`;
      }
      return `<button type="button" class="log-row" data-action="repeat-yesterday" data-id="${esc(e.id)}">
        <div class="pick-meta">
          <div class="r-name">${esc(e.name)}${chrome.badge}</div>
          <div class="r-qty">${esc(e.displayQty)} · ${esc(e.meal || "")}</div>
        </div>
        <span class="mini">${fmt(e.macros.kcal)} kcal</span>
      </button>`;
    };

    const section = (title, items, rowFn) => {
      if (!items.length) return "";
      return `<div class="pick-section"><div class="meal-label">${esc(title)}</div>${items.map(rowFn).join("")}</div>`;
    };

    let html = "";
    if (!q) {
      html += section(yesterdayLabel, yesterday.slice(0, 12), yRow);
      html += section("Recent", recent, personalRow);
      html += section("Frequent", freq, personalRow);
      html += section("My foods", all.slice(0, 40), personalRow);
      if (showCatalog) {
        const commonIds = typeof FOOD_COMMON_IDS !== "undefined" ? FOOD_COMMON_IDS : [];
        const common = commonIds
          .map((id) => byId.get(id))
          .filter((f) => f && !ownedCatalogIds.has(f.id));
        html += section("Common foods", common, catalogRow);
        html += `<p class="muted small pick-hint">Common picks above; search the full catalog for walnuts, raisins, and ~150 other reference foods (USDA-style averages). Or paste a homemade dish below.</p>`;
      }
    } else {
      html += section("My foods", all.slice(0, 40), personalRow);
      if (showCatalog) {
        const cats = DB.filter((f) =>
          !ownedCatalogIds.has(f.id) &&
          (FoodMatch.scoreMatch(q, f.name) >= 0.4 || (f.aliases || []).some((a) => FoodMatch.scoreMatch(q, a) >= 0.4))
        )
          .sort((a, b) => FoodMatch.scoreMatch(q, b.name) - FoodMatch.scoreMatch(q, a.name))
          .slice(0, 25);
        html += section("Catalog", cats, catalogRow);
      }
    }

    if (!html) {
      html = q
        ? `<div class="empty small">No matches for “${esc(q)}”.</div>`
        : `<div class="empty small">Search common foods (banana, apple, eggs…), or paste a homemade dish below.</div>`;
    }
    root.innerHTML = html;
  }

  /** Default qty: piece count when logAs/piece says so; else history grams. */
  function weightPrefillFromHistory(food, imperial) {
    const OZ = 28.349523125;
    const pieceG = FoodMatch.pieceGrams(food);
    const usePiece = FoodMatch.prefersPieceLog(food) && pieceG;
    let histG = null;
    if (food && food.id && typeof Ledger !== "undefined" && Ledger.portionStats) {
      const stats = Ledger.portionStats(food.id);
      if (stats.median != null) histG = stats.median;
      else if (stats.last != null) histG = stats.last;
    }
    if (usePiece) {
      let count = 1;
      if (histG != null && histG > 0) count = Math.max(1, Math.round(histG / pieceG));
      return { qty: count, unit: "piece" };
    }
    const grams = histG != null ? Math.round(histG) : 100;
    if (imperial) {
      return { qty: Math.round((grams / OZ) * 10) / 10, unit: "oz" };
    }
    return { qty: grams, unit: "g" };
  }

  /** Unit chips available for a food (same rules as the single qty sheet). */
  function qtyUnitsForFood(food, imperial, preferredUnit) {
    const pieceG = FoodMatch.pieceGrams(food);
    const servG = food && food.units && +food.units.serving > 0 ? +food.units.serving : null;
    const units = ["g"];
    if (imperial) units.push("oz");
    if (pieceG) units.push("piece");
    if (food && food.batch && food.batch.grams) units.push("batch");
    if (servG && !(pieceG && Math.round(servG) === Math.round(pieceG))) units.push("serving");
    let unit = preferredUnit || null;
    if (unit && unit !== "kcal" && !units.includes(unit)) units.push(unit);
    if (unit === "kcal") unit = null;
    if (!unit || !units.includes(unit)) unit = weightPrefillFromHistory(food, !!imperial).unit;
    if (!units.includes(unit)) unit = units[0];
    return { units, unit, pieceG, servG };
  }

  function unitChipHtml(food, units, activeUnit) {
    const pieceG = FoodMatch.pieceGrams(food);
    const servG = food && food.units && +food.units.serving > 0 ? +food.units.serving : null;
    const noun = FoodMatch.countNoun(food);
    return units.map((u) => {
      let label = u;
      if (u === "serving" && servG) label = `serving (${Math.round(servG)} g)`;
      if (u === "piece" && pieceG) label = `${noun} (${Math.round(pieceG)} g)`;
      if (u === "batch" && food.batch) label = `batch (${fmt(food.batch.grams)} g)`;
      return `<button type="button" class="uchip${u === activeUnit ? " active" : ""}" data-unit="${esc(u)}" aria-pressed="${u === activeUnit}">${esc(label)}</button>`;
    }).join("");
  }

  function fillQtySheet(food, imperial, prefill) {
    $("#qty-name").textContent = food.name;
    $("#qty-per100").textContent = `per 100 g: ${fmt(food.per100.kcal)} kcal · ${fmtMacros(food.per100)}`;
    const prov = Foods.provenance(food);
    const src = $("#qty-source");
    if (src) {
      src.textContent = prov.label;
      src.title = prov.detail || "";
    }
    const hist = weightPrefillFromHistory(food, !!imperial);
    const preferred = (prefill && prefill.unit) || hist.unit;
    const { units, unit } = qtyUnitsForFood(food, !!imperial, preferred);
    $("#qty-units").innerHTML = unitChipHtml(food, units, unit);
    const meal = (prefill && prefill.meal) || Foods.inferMeal();
    $("#qty-meals").innerHTML = MEALS.map((m) =>
      `<button type="button" class="uchip${m === meal ? " active" : ""}" data-meal="${m}" aria-pressed="${m === meal}">${m}</button>`
    ).join("");
    $("#qty-input").value = prefill && prefill.qty != null ? prefill.qty : hist.qty;
    fillQtySheet._imperial = !!imperial;
    updateQtyPreview(food);
    const removeBtn = $("#qty-remove");
    if (removeBtn) removeBtn.hidden = !(prefill && prefill.allowRemove);
    const orphan = !!(food && (food._orphan || String(food.id || "").startsWith("orphan-")));
    const editBtn = $("#qty-edit-food");
    const refineBtn = $("#qty-refine-food");
    if (editBtn) editBtn.hidden = orphan;
    if (refineBtn) refineBtn.hidden = orphan;
  }

  function previewLineForQty(food, qty, unit, meal, imperial) {
    if (!Number.isFinite(qty) || qty <= 0) return "Enter an amount";
    const entry = Foods.entryFromQty(food, qty, unit, meal || Foods.inferMeal());
    let qtyLine = entry.displayQty;
    if (imperial && unit === "oz") {
      qtyLine = `${qty} oz (${Math.round(entry.grams)} g)`;
      entry.displayQty = qtyLine;
    } else if (imperial && (unit === "g" || unit === "grams")) {
      const oz = Math.round((entry.grams / 28.35) * 10) / 10;
      qtyLine = `${Math.round(entry.grams)} g (${oz} oz)`;
      entry.displayQty = qtyLine;
    }
    return { text: `${qtyLine} · ${fmt(entry.macros.kcal)} kcal · ${fmtMacros(entry.macros)}`, entry };
  }

  function updateQtyPreview(food) {
    const qty = Number(String($("#qty-input").value || "").replace(/,/g, "").trim());
    const preview = previewLineForQty(food, qty, selectedUnit(), selectedMeal(), !!fillQtySheet._imperial);
    if (typeof preview === "string") {
      $("#qty-preview").textContent = preview;
      return null;
    }
    $("#qty-preview").textContent = preview.text;
    return preview.entry;
  }

  /** Render compact amount rows for multi-select (same units/meal as single qty). */
  function renderMultiQtyList(items, imperial) {
    const root = $("#multi-qty-list");
    if (!root) return;
    const list = items || [];
    if (!list.length) {
      root.innerHTML = `<div class="empty small">No foods selected.</div>`;
      return;
    }
    root.innerHTML = list.map((item) => {
      const food = item.food;
      const preferred = item.unit || null;
      const { units, unit } = qtyUnitsForFood(food, !!imperial, preferred);
      const hist = weightPrefillFromHistory(food, !!imperial);
      const qty = item.qty != null ? item.qty : hist.qty;
      const meal = item.meal || Foods.inferMeal();
      const preview = previewLineForQty(food, Number(qty), unit, meal, !!imperial);
      const previewText = typeof preview === "string" ? preview : preview.text;
      return `<div class="multi-qty-row" data-multi-key="${esc(item.key)}">
        <div class="multi-qty-row-head">
          <div class="r-name">${esc(food.name)}</div>
          <div class="multi-qty-row-actions">
            <button type="button" class="linkbtn" data-action="multi-full-qty" data-key="${esc(item.key)}">Full</button>
            <button type="button" class="linkbtn danger" data-action="multi-remove" data-key="${esc(item.key)}">Remove</button>
          </div>
        </div>
        <div class="multi-qty-amt">
          <input class="multi-qty-input" type="text" inputmode="decimal" value="${esc(String(qty))}" aria-label="Amount for ${esc(food.name)}" data-multi-qty>
          <div class="unit-chips" data-multi-units role="group" aria-label="Unit">${unitChipHtml(food, units, unit)}</div>
        </div>
        <div class="unit-chips meal-chips multi-qty-meals" data-multi-meals role="group" aria-label="Meal">${MEALS.map((m) =>
          `<button type="button" class="uchip${m === meal ? " active" : ""}" data-meal="${m}" aria-pressed="${m === meal}">${m}</button>`
        ).join("")}</div>
        <p class="qty-preview" data-multi-preview>${esc(previewText)}</p>
      </div>`;
    }).join("");
  }

  function readMultiQtyRow(rowEl) {
    if (!rowEl) return null;
    const key = rowEl.dataset.multiKey;
    const qtyRaw = rowEl.querySelector("[data-multi-qty]");
    const qty = Number(String((qtyRaw && qtyRaw.value) || "").replace(/,/g, "").trim());
    const unitEl = rowEl.querySelector("[data-multi-units] .uchip.active");
    const mealEl = rowEl.querySelector("[data-multi-meals] .uchip.active");
    return {
      key,
      qty: Number.isFinite(qty) ? qty : NaN,
      unit: unitEl ? unitEl.dataset.unit : "g",
      meal: mealEl ? mealEl.dataset.meal : Foods.inferMeal(),
    };
  }

  function updateMultiRowPreview(rowEl, food, imperial) {
    if (!rowEl || !food) return null;
    const draft = readMultiQtyRow(rowEl);
    const previewEl = rowEl.querySelector("[data-multi-preview]");
    if (!draft || !previewEl) return null;
    const preview = previewLineForQty(food, draft.qty, draft.unit, draft.meal, !!imperial);
    if (typeof preview === "string") {
      previewEl.textContent = preview;
      return null;
    }
    previewEl.textContent = preview.text;
    return preview.entry;
  }

  function syncReviewLogAsUI() {
    const chip = $("#rev-log-as .uchip.active");
    const logAs = chip ? chip.dataset.logAs : "grams";
    const pieceBlock = $("#rev-piece-fields");
    if (pieceBlock) pieceBlock.hidden = logAs !== "piece";
  }

  function selectedUnit() {
    const el = $("#qty-units .uchip.active");
    return el ? el.dataset.unit : "g";
  }
  function selectedMeal() {
    const el = $("#qty-meals .uchip.active");
    return el ? el.dataset.meal : Foods.inferMeal();
  }
  function selectedMealIn(rootSel) {
    const el = $(`${rootSel} .uchip.active`);
    return el ? el.dataset.meal : Foods.inferMeal();
  }

  function showPastePrompt() {
    $("#paste-step-prompt").hidden = false;
    $("#paste-step-review").hidden = true;
    $("#paste-title").textContent = "Add food via NUTRI import";
    const fb = $("#prompt-fallback");
    if (fb) fb.hidden = true;
  }

  function showPromptFallback(text, opts) {
    const fbSel = (opts && opts.fallbackId) || "#prompt-fallback";
    const taSel = (opts && opts.textId) || "#prompt-fallback-text";
    const fb = $(fbSel);
    const ta = $(taSel);
    if (!fb || !ta) return;
    ta.value = text;
    fb.hidden = false;
    fb.open = true;
    ta.focus();
    ta.select();
  }

  function showReview(parsed, opts) {
    $("#paste-step-prompt").hidden = true;
    $("#paste-step-review").hidden = false;
    $("#paste-title").textContent = (opts && opts.title) || (opts && opts.updateId ? "Update food" : "Review food");
    const f = parsed.food;
    const banners = [];
    for (const r of parsed.rejects || []) banners.push(`<div class="banner danger">${esc(r)}</div>`);
    for (const w of parsed.warnings || []) banners.push(`<div class="banner warn">${esc(w)}</div>`);
    if (f.derivedFromTotals && !(parsed.warnings || []).length) {
      banners.push(`<div class="banner muted">Per 100 g computed from batch totals.</div>`);
    }
    if (parsed.unknownLines && parsed.unknownLines.length) {
      banners.push(`<details class="banner muted"><summary>Ignored lines</summary><pre>${esc(parsed.unknownLines.join("\n"))}</pre></details>`);
    }
    // Editing a recipe never rewrites history: each log line keeps the macros
    // and food version it was saved with. Deleting a food already said as much;
    // editing is far more common and said nothing, so people could reasonably
    // assume a correction propagated backwards. It does not.
    if (opts && opts.updateId) {
      banners.push(
        `<div class="banner muted">Days you already logged keep the macros they were saved with. This applies from now on.</div>`
      );
    }
    $("#review-banners").innerHTML = banners.join("");
    $("#rev-name").value = f.name || "";
    $("#rev-aliases").value = (f.aliases || []).join(", ");
    const catFilter = $("#rev-cat-filter");
    if (catFilter) catFilter.value = "";
    filterCategories("");
    $("#rev-cat").value = f.cat || "dish";
    $("#rev-kcal").value = f.per100.kcal;
    $("#rev-p").value = f.per100.p;
    $("#rev-c").value = f.per100.c;
    $("#rev-f").value = f.per100.f;
    $("#rev-fb").value = f.per100.fb;
    // Blank means unknown, which is not the same as 0 and must round-trip.
    if ($("#rev-k")) $("#rev-k").value = f.per100.k == null ? "" : f.per100.k;
    $("#rev-na").value = f.per100.na == null ? "" : f.per100.na;
    $("#rev-batch-g").value = (f.batch && f.batch.grams) || "";
    $("#rev-batch-s").value = (f.batch && f.batch.servings) || "";
    const logAs = f.logAs === "piece" || (f.units && f.units.piece && f.logAs !== "grams") ? "piece" : "grams";
    const logRoot = $("#rev-log-as");
    if (logRoot) {
      logRoot.innerHTML = ["grams", "piece"].map((u) =>
        `<button type="button" class="uchip${u === logAs ? " active" : ""}" data-log-as="${u}" aria-pressed="${u === logAs}">${u === "piece" ? "by count" : "by grams"}</button>`
      ).join("");
    }
    $("#rev-piece").value = (f.units && f.units.piece) || "";
    const countEl = $("#rev-count-as");
    if (countEl) countEl.value = f.countLabel || (logAs === "piece" ? FoodMatch.countNoun(f) : "");
    $("#rev-serving").value = (f.units && f.units.serving) || "";
    syncReviewLogAsUI();
    $("#rev-ingredients").value = ((f.recipe && f.recipe.ingredients) || []).map((i) => i.text).join("\n");
    $("#rev-prep").value = (f.recipe && f.recipe.prep) || "";
    $("#rev-notes").value = (f.recipe && f.recipe.notes) || "";
    $("#btn-review-save").disabled = !parsed.canSave && !(opts && opts.forceEnable);
    const err = $("#review-errors");
    if (err) { err.hidden = true; err.textContent = ""; }
    const dup = $("#review-dup");
    if (opts && opts.duplicate) {
      dup.hidden = false;
      if (opts.suppressUpdateDup) {
        // Promote path: saveAsNew is already armed — do not offer overwrite.
        dup.innerHTML = `You already have “${esc(opts.duplicate.name)}”. Saving creates a <b>separate</b> food; the existing one is left alone.`;
      } else {
        dup.innerHTML = `You already have “${esc(opts.duplicate.name)}”.
          <div class="row" style="margin-top:8px">
            <button type="button" class="btn ghost" data-action="update-dup" data-id="${esc(opts.duplicate.id)}">Update that one</button>
            <button type="button" class="btn ghost" data-action="save-new-anyway">Save as separate</button>
          </div>`;
      }
    } else {
      dup.hidden = true;
      dup.innerHTML = "";
    }
    const refine = $("#rev-ai-refine");
    if (refine) {
      refine.hidden = !(opts && opts.updateId);
      refine.open = false;
      const ta = $("#rev-ai-paste");
      if (ta) ta.value = "";
    }
  }

  function filterCategories(q) {
    const sel = $("#rev-cat");
    if (!sel) return;
    const needle = String(q || "").trim().toLowerCase();
    [...sel.options].forEach((opt) => {
      opt.hidden = !!(needle && !opt.value.toLowerCase().includes(needle));
    });
  }

  function setReviewErrors(reasons) {
    const el = $("#review-errors");
    if (!el) return;
    if (!reasons || !reasons.length) {
      el.hidden = true;
      el.textContent = "";
      ["#rev-name", "#rev-kcal", "#rev-p", "#rev-c", "#rev-f", "#rev-fb", "#rev-na", "#rev-k"].forEach((sel) => {
        const n = $(sel); if (n) n.classList.remove("field-bad");
      });
      return;
    }
    el.hidden = false;
    el.textContent = reasons.join(" ");
    const draft = readReviewDraft();
    const mark = (sel, bad) => { const n = $(sel); if (n) n.classList.toggle("field-bad", !!bad); };
    mark("#rev-name", !draft.name);
    const rawBad = (sel) => {
      const parsed = parseNutrientNumber($(sel) && $(sel).value, { nullable: sel === "#rev-na" || sel === "#rev-k" });
      return !parsed.ok || (parsed.value != null && parsed.value < 0);
    };
    mark("#rev-kcal", rawBad("#rev-kcal") || draft.per100.kcal > 920);
    const macroMassBad = draft.per100.p + draft.per100.c + draft.per100.f > 105;
    mark("#rev-p", rawBad("#rev-p") || macroMassBad);
    mark("#rev-c", rawBad("#rev-c") || macroMassBad);
    mark("#rev-f", rawBad("#rev-f") || macroMassBad);
    mark("#rev-fb", rawBad("#rev-fb"));
    mark("#rev-na", rawBad("#rev-na"));
    mark("#rev-k", rawBad("#rev-k"));
  }

  /** Strict review-field parser with well-formed optional thousands commas. */
  function parseNutrientNumber(value, opts) {
    const nullable = !!(opts && opts.nullable);
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return { ok: true, blank: true, value: nullable ? null : 0 };
    const plain = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
    const grouped = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
    if (!plain.test(raw) && !grouped.test(raw)) return { ok: false, blank: false, value: NaN };
    const n = Number(raw.replace(/,/g, ""));
    return Number.isFinite(n)
      ? { ok: true, blank: false, value: n }
      : { ok: false, blank: false, value: NaN };
  }

  function readReviewDraft(base) {
    const num = (id) => parseNutrientNumber($(id) && $(id).value).value;
    const numOrNullField = (id) => parseNutrientNumber($(id) && $(id).value, { nullable: true }).value;
    const logChip = $("#rev-log-as .uchip.active");
    const logAs = (logChip && logChip.dataset.logAs) || "grams";
    const serving = Number($("#rev-serving").value);
    const piece = Number($("#rev-piece").value);
    const batchG = Number($("#rev-batch-g").value);
    const batchS = Number($("#rev-batch-s").value);
    const units = { ...(base && base.units) };
    if (Number.isFinite(serving) && serving > 0) units.serving = serving;
    else delete units.serving;
    if (logAs === "piece" && Number.isFinite(piece) && piece > 0) units.piece = piece;
    else if (logAs !== "piece") delete units.piece;
    else if (!(Number.isFinite(piece) && piece > 0)) delete units.piece;
    if (Number.isFinite(batchG) && batchG > 0) units.batch = batchG;
    else delete units.batch;
    const countRaw = ($("#rev-count-as") && $("#rev-count-as").value || "").trim().toLowerCase();
    const ingredients = $("#rev-ingredients").value.split("\n").map((t) => t.trim()).filter(Boolean).map((text) => ({ text, grams: null }));
    return {
      name: $("#rev-name").value.trim(),
      aliases: $("#rev-aliases").value.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean),
      cat: $("#rev-cat").value,
      per100: {
        kcal: num("#rev-kcal"), p: num("#rev-p"), c: num("#rev-c"),
        f: num("#rev-f"), fb: num("#rev-fb"), na: numOrNullField("#rev-na"),
        // Blank stays null (unknown); known zero remains an explicit 0.
        k: numOrNullField("#rev-k"),
      },
      units,
      logAs,
      countLabel: logAs === "piece" ? (countRaw || null) : null,
      batch: Number.isFinite(batchG) && batchG > 0
        ? { grams: batchG, servings: Number.isFinite(batchS) && batchS > 0 ? batchS : 1, weighed: true }
        : null,
      recipe: {
        ingredients,
        prep: $("#rev-prep").value.trim(),
        notes: $("#rev-notes").value.trim(),
      },
      confidence: (base && base.confidence) || "medium",
      sd: (base && base.sd) || 0.12,
      raw: (base && base.raw) || "",
    };
  }

  function renderFoodDetail(food, opts) {
    const mode = (opts && opts.mode) === "log" ? "log" : "library";
    const pieceG = FoodMatch.pieceGrams(food);
    const serv = food.units && food.units.serving;
    const mPiece = pieceG ? FoodMatch.computeMacros(food.per100, pieceG) : null;
    const mServ = serv && !(pieceG && Math.round(+serv) === Math.round(pieceG))
      ? FoodMatch.computeMacros(food.per100, serv)
      : null;
    const noun = FoodMatch.countNoun(food);
    const ings = ((food.recipe && food.recipe.ingredients) || []).map((i) => {
      const t = typeof i === "string" ? i : (i && i.text) || "";
      return t ? `<li>${esc(t)}</li>` : "";
    }).join("");
    const prov = Foods.provenance(food);
    const nutrientText = (value) => {
      const n = Number(value);
      return value != null && Number.isFinite(n) && n >= 0 ? String(n) : "unknown";
    };
    const batchGrams = Number(food.batch && food.batch.grams);
    const batchServings = Number(food.batch && food.batch.servings);
    const useCount = Number.isFinite(Number(food.useCount)) && Number(food.useCount) >= 0 ? Math.floor(Number(food.useCount)) : 0;
    const version = Number.isFinite(Number(food.version)) && Number(food.version) >= 1 ? Math.floor(Number(food.version)) : 1;
    const batch = Number.isFinite(batchGrams) && batchGrams > 0
      ? `<div class="card-block"><b>Batch</b>: ${fmt(batchGrams)} g · ${fmt(Number.isFinite(batchServings) && batchServings > 0 ? batchServings : 1)} servings
          <button type="button" class="btn ghost full" style="margin-top:8px" data-action="scale-batch" data-id="${esc(food.id)}">Scale batch</button>
        </div>`
      : `<div class="card-block"><button type="button" class="btn ghost full" data-action="scale-batch" data-id="${esc(food.id)}">Set / scale batch</button></div>`;
    const logBtn = mode === "log"
      ? `<button type="button" class="btn full" data-action="log-this" data-id="${esc(food.id)}">Log this</button>`
      : `<button type="button" class="btn ghost full" data-action="log-this" data-id="${esc(food.id)}">Log this</button>`;
    const editBtn = mode === "library"
      ? `<button type="button" class="btn full" data-action="edit-food" data-id="${esc(food.id)}">Edit food</button>`
      : `<button type="button" class="btn ghost full" data-action="edit-food" data-id="${esc(food.id)}">Edit food</button>`;
    const logHint = food.logAs === "piece" && pieceG
      ? `<div class="muted small" style="margin-top:6px">Logs by count: 1 ${esc(noun)} = ${Math.round(pieceG)} g${mPiece ? ` · ${fmt(mPiece.kcal)} kcal` : ""}</div>`
      : `<div class="muted small" style="margin-top:6px">Logs by weight (grams)</div>`;
    $("#detail-body").innerHTML = `
      <h3>${esc(food.name)}</h3>
      <p class="muted small">${esc(prov.label)}${prov.detail ? " · " + esc(prov.detail) : ""}</p>
      <p class="muted small">Logged ${fmt(useCount)} times${Number.isFinite(Number(food.lastUsedAt)) && Number(food.lastUsedAt) > 0 ? " · last " + esc(new Date(Number(food.lastUsedAt)).toLocaleDateString()) : ""} · v${fmt(version)}</p>
      <div class="card-block">
        <div><b>Per 100 g</b>: ${fmt(food.per100 && food.per100.kcal)} kcal · P ${esc(nutrientText(food.per100 && food.per100.p))} · C ${esc(nutrientText(food.per100 && food.per100.c))} · F ${esc(nutrientText(food.per100 && food.per100.f))} · Fb ${esc(nutrientText(food.per100 && food.per100.fb))} · Na ${food.per100 && food.per100.na != null ? `${fmt(food.per100.na)} mg` : "unknown"} · K ${food.per100 && food.per100.k != null ? `${fmt(food.per100.k)} mg` : "unknown"}</div>
        ${logHint}
        ${mServ ? `<div class="muted small" style="margin-top:6px">Optional serving (${fmt(serv)} g): ${fmt(mServ.kcal)} kcal · P ${fmt(mServ.p)}</div>` : ""}
      </div>
      ${batch}
      ${ings ? `<div class="card-block"><b>Ingredients</b><ul class="ing-list">${ings}</ul>${food.recipe.prep ? `<p class="small">${esc(food.recipe.prep)}</p>` : ""}</div>` : ""}
      <div class="col-actions">
        ${mode === "log" ? logBtn : editBtn}
        ${mode === "log" ? editBtn : logBtn}
        <button type="button" class="btn ghost full" data-action="share-food" data-id="${esc(food.id)}">Share food</button>
        <button type="button" class="btn ghost full danger" data-action="delete-food" data-id="${esc(food.id)}">Delete</button>
      </div>`;
  }

  function streakEndingToday() {
    let streak = 0;
    const d = new Date();
    // Allow "current streak" to count through yesterday if today is still empty
    if (!Ledger.entriesFor(Ledger.todayKey(d)).length) d.setDate(d.getDate() - 1);
    for (;;) {
      const key = Ledger.todayKey(d);
      if (!Ledger.entriesFor(key).length) break;
      streak += 1;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  }

  // =====================================================================
  // Insights
  //
  // One render pass builds a single derived range (via Analytics) and every
  // panel reads from it, so the headline, charts and breakdowns can never
  // disagree about what "the last 30 days" means.
  // =====================================================================

  /** Per-render cache shared by all Insights panels. */
  let _insight = null;

  const NUT_META = {
    kcal:    { label: "Calories", unit: "" },
    protein: { label: "Protein",  unit: " g" },
    carbs:   { label: "Carbs",    unit: " g" },
    fat:     { label: "Fat",      unit: " g" },
    fiber:   { label: "Fiber",    unit: " g" },
    sodium:  { label: "Sodium",   unit: " mg" },
    potassium: { label: "Potassium", unit: " mg" },
  };

  function nutMeta(key) { return NUT_META[key] || NUT_META.kcal; }

  /**
   * Targets are not all the same shape, and the UI must not pretend they are:
   *   floor   (protein, fiber)  — a minimum. More is fine; only short counts.
   *   ceiling (sodium)          — a limit. Lower is better; only over counts.
   *   range   (kcal, carbs, fat)— a window. Both directions count.
   *
   * `Phases.classify` is the single source of truth, the same call the Today
   * tab and the scorecard use. Insights previously kept its own multiplier
   * table, which painted high protein and high fiber as warnings while Today
   * and the scorecard called the very same days on target.
   */
  function bandFor(key) {
    if (typeof Phases === "undefined") return null;
    return Phases.BANDS[key] || Phases.BANDS.kcal;
  }

  /**
   * @param {boolean} [unscored] true when the plan exempted this cell that
   *   day (goals._unscored[key]) — Today already says "not scored today" for
   *   the same cell, so this must never independently reach for a band
   *   verdict, or two tabs make opposite claims about the same day (Part X.2).
   * @returns {"hit"|"under"|"over"|"none"|"exempt"}
   */
  function statusFor(key, value, goal, unscored) {
    if (unscored) return "exempt";
    const band = bandFor(key);
    if (!band || !Number.isFinite(value) || !goal) return "none";
    const s = Phases.classify(value, goal, band);
    return s === "skip" ? "none" : s;
  }

  /** Bar fill for a value against its target, honouring the band direction. */
  function statusColor(status, theme) {
    if (status === "over") return theme.warn;
    if (status === "under") return withAlpha(theme.accent, 0.55);
    return theme.accent;
  }

  /**
   * Wording per band direction. A ceiling nutrient can never be "under" and a
   * floor can never be "over", so those words are never shown for them.
   */
  const BAND_TEXT = {
    range:   { under: "under", hit: "on target", over: "over" },
    floor:   { under: "short", hit: "met",       over: "over" },
    ceiling: { under: "under", hit: "within",    over: "over" },
  };

  function bandText(key) {
    const band = bandFor(key);
    return BAND_TEXT[(band && band.dir) || "range"] || BAND_TEXT.range;
  }

  /**
   * Average distance from target, phrased so the sign cannot be misread.
   * "-500 mg" on a sodium ceiling means 500 mg of headroom, not a shortfall.
   */
  function formatBandDelta(key, avgDelta) {
    if (!Number.isFinite(avgDelta)) return "—";
    const band = bandFor(key);
    const unit = (key === "kcal" || key === "naK") ? "" : (key === "sodium" || key === "potassium") ? " mg" : " g";
    const mag = `${fmt(Math.abs(avgDelta))}${unit}`;
    const dir = (band && band.dir) || "range";
    if (dir === "ceiling") return avgDelta <= 0 ? `${mag} headroom` : `${mag} over`;
    if (dir === "floor") return avgDelta >= 0 ? `${mag} above floor` : `${mag} short`;
    return `${avgDelta >= 0 ? "+" : "-"}${mag}`;
  }

  // ------------------------------------------------------------ canvas util

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /** Theme-aware palette, re-read each render so dark mode flips cleanly. */
  function chartTheme() {
    return {
      ink: cssVar("--ink", "#23282d"),
      muted: cssVar("--muted", "#7b8088"),
      line: cssVar("--line", "#e6e3da"),
      accent: cssVar("--accent", "#3d9970"),
      warn: cssVar("--warn", "#d0703c"),
      info: cssVar("--info", "#4a7dbd"),
      card: cssVar("--card", "#ffffff"),
    };
  }

  /** Size a canvas for the device pixel ratio and return a CSS-pixel context. */
  function setupCanvas(canvas, height) {
    const w = Math.max(160, canvas.clientWidth || 320);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, height);
    ctx.font = "10px system-ui,sans-serif";
    return { ctx, w, h: height };
  }

  /** Round gridline step (1/2/5 × 10ⁿ) so axis labels read as human numbers. */
  function niceStep(range, count) {
    if (!(range > 0)) return 1;
    const raw = range / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return mult * mag;
  }

  /** Compact axis labels: 2400 → "2.4k". */
  function axisNum(v) {
    const a = Math.abs(v);
    if (a >= 10000) return Math.round(v / 1000) + "k";
    if (a >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(v));
  }

  /** Horizontal gridlines + left labels. Returns the value→y mapper. */
  function drawYAxis(ctx, box, minV, maxV, theme) {
    const { pad, iw, ih } = box;
    const yAt = (v) => pad.t + ih * (1 - (v - minV) / (maxV - minV || 1));
    const step = niceStep(maxV - minV, 3);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.muted;
    for (let v = Math.ceil(minV / step) * step; v <= maxV + 1e-9; v += step) {
      const y = yAt(v);
      if (y < pad.t - 1 || y > pad.t + ih + 1) continue;
      ctx.strokeStyle = theme.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(y) + 0.5);
      ctx.lineTo(pad.l + iw, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillText(axisNum(v), pad.l - 5, y);
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
    return yAt;
  }

  /** Evenly spread x labels, dropping any that would collide. */
  function drawXLabels(ctx, box, labels, theme, labelW) {
    const { pad, iw, h } = box;
    const lw = labelW || 34;
    const n = labels.length;
    if (!n) return;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "center";
    const maxLabels = Math.max(2, Math.min(n, Math.floor(iw / lw)));
    const idx = [];
    if (n <= maxLabels) {
      for (let i = 0; i < n; i++) idx.push(i);
    } else {
      for (let k = 0; k < maxLabels; k++) idx.push(Math.round((k * (n - 1)) / (maxLabels - 1)));
    }
    let lastX = -Infinity;
    const seen = new Set();
    for (const i of idx) {
      if (seen.has(i)) continue;
      seen.add(i);
      const x = pad.l + (i + 0.5) * (iw / n);
      if (x - lastX < lw * 0.9) continue;
      lastX = x;
      ctx.fillText(labels[i], x, h - 8);
    }
    ctx.textAlign = "start";
  }

  function withAlpha(hex, alpha) {
    const m = String(hex).trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  // -------------------------------------------------------------- range

  function insightRangeKeys(opts) {
    const settings = (opts && opts.settings) || {};
    const todayKey = (opts && opts.todayKey) || Ledger.todayKey();
    const phaseId = opts && opts.phaseId;
    const daysBack = opts && opts.daysBack;
    const end = new Date(todayKey + "T12:00:00");
    let keys = [];
    let selectedPhase = null;
    if (daysBack === "phase" && typeof Phases !== "undefined") {
      selectedPhase = Phases.phaseById(settings.phases, phaseId) ||
        Phases.phaseForDay(settings.phases, todayKey) || Phases.activePhase(settings.phases);
      if (selectedPhase) keys = Phases.phaseDayKeys(selectedPhase, todayKey);
    }
    if (!keys.length) {
      const n = Number(daysBack) || 14;
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(end);
        d.setDate(d.getDate() - i);
        keys.push(Ledger.todayKey(d));
      }
    }
    return { keys, selectedPhase, daysBack, todayKey, settings };
  }

  /**
   * Build the shared derived range once per render.
   * Everything below reads `_insight` rather than recomputing.
   */
  function buildInsightContext(opts) {
    const o = opts || {};
    const { keys, selectedPhase, daysBack, todayKey, settings } = insightRangeKeys(o);
    const goalsForDay = o.goalsForDay || ((day) =>
      (typeof Phases !== "undefined" ? Phases.goalsForDay(day, settings) : (settings.goals || {})));
    const days = Analytics.buildDays({
      keys,
      totalsForDay: (day) => Ledger.totalsFor(day),
      goalsForDay,
      weightKgForDay: (day) =>
        (typeof Phases !== "undefined" ? Phases.weightForDay(settings, day) : null),
      dayPlanForDay: (day) => (settings.dayGoals && settings.dayGoals[day]) || null,
      firstAddAt: (day) => Ledger.firstAddAt(day),
    });
    const viewingPastPhase = daysBack === "phase" && !!selectedPhase && selectedPhase.endDay != null;
    const scoreDay = typeof Phases !== "undefined" ? Phases.scoreDayTotals : null;
    const ctx = {
      keys, days, settings, todayKey, selectedPhase, daysBack, viewingPastPhase, scoreDay,
      nutrient: o.nutrient || "kcal",
      rollup: o.rollup === "week" ? "week" : "day",
      topFoodMetric: o.topFoodMetric || o.nutrient,
      weightUnit: settings.weightUnit === "kg" ? "kg" : "lb",
      // Today is still in progress; counting it as a miss would be wrong.
      scoreOpts: { todayKey: viewingPastPhase ? null : todayKey },
      // One context surface for entry-level panels (topFoods / byMeal / onceDays).
      entriesForDay: (day) => Ledger.entriesFor(day),
      rangeLabel: daysBack === "phase" && selectedPhase
        ? Phases.labelForDay(selectedPhase, selectedPhase.endDay || todayKey)
        : `${keys.length} days`,
    };
    ctx.targetEligibility = typeof Phases !== "undefined" &&
      typeof Phases.automatedTargetEligibility === "function"
      ? Phases.automatedTargetEligibility(settings, { todayKey })
      : { canApply: true, status: "eligible", message: "" };
    ctx.tdee = Analytics.estimateTdee(days, ctx.scoreOpts);
    ctx.trend = Analytics.trendWeight(days);
    ctx.score = Analytics.nutritionScore(days, scoreDay, ctx.scoreOpts);
    ctx.consistency = ctx.score.consistency;
    // Counts logged days in the selected range (empty / thin / full first-run tiers).
    const loggedCount = Analytics.loggedRows(days).length;
    ctx.maturity = loggedCount === 0 ? "empty" : loggedCount < 3 ? "thin" : "full";
    _insight = ctx;
    return ctx;
  }

  // ------------------------------------------------------- headline card

  /**
   * The answer, before the charts: one score, then the three numbers people
   * actually open the app for (average intake, weight rate, logging streak).
   */
  function renderHeadline(ctx) {
    const root = $("#insight-headline");
    if (!root) return;
    const logged = Analytics.loggedRows(ctx.days);
    if (!logged.length) {
      root.innerHTML = `<div class="headline-empty">
        <b>No logged days in this range yet.</b>
        <span class="muted small">Log a day or two and this fills in with your averages, trends and target hit rates.</span>
      </div>`;
      return;
    }

    const s = ctx.score;
    const kcalAvg = Analytics.mean(logged.map((d) => d.kcal));
    const kcalGoal = Analytics.mean(ctx.days.map((d) => Analytics.phaseKcalOf(d)));
    const rate = Analytics.weightRate(ctx.trend);
    const cons = ctx.consistency;

    const dial = s.score == null ? "" : `
      <div class="score-dial" style="--pct:${Math.max(0, Math.min(100, s.score))}">
        <div class="score-dial-inner">
          <span class="score-value">${s.score}</span>
          <span class="score-max">/100</span>
        </div>
      </div>`;

    const stat = (label, value, sub) => `
      <div class="headline-stat">
        <span class="hs-label">${esc(label)}</span>
        <span class="hs-value">${esc(value)}</span>
        <span class="hs-sub muted small">${esc(sub || "")}</span>
      </div>`;

    const kcalSub = kcalGoal
      ? `${Analytics.fmtSigned(kcalAvg - kcalGoal)} vs target`
      : "no calorie target set";

    let weightVal = "—";
    let weightSub = "needs 2+ weigh-ins";
    if (rate) {
      const perWeek = Analytics.kgToDisplay(rate.kgPerWeek, ctx.weightUnit);
      weightVal = `${Analytics.fmtSigned(perWeek, 2)} ${ctx.weightUnit}/wk`;
      weightSub = `${rate.n} weigh-ins · ${rate.spanDays} d`;
    }

    // Name what is costing the most, so the number points somewhere.
    let gapLine = "";
    if (s.gap) {
      const t = bandText(s.gap.key);
      const missed = s.gap.n - s.gap.hit;
      gapLine = `<span class="hs-gap">Biggest gap: <b>${esc(s.gap.label.toLowerCase())}</b> — ${t.hit} on ${s.gap.hit} of ${s.gap.n} logged days (${missed} ${esc(t[s.gap.key === "sodium" ? "over" : "under"])}).</span>`;
    } else if (s.parts.targets != null && s.parts.consistency < 0.8) {
      gapLine = `<span class="hs-gap">Targets are landing; logging days is what moves this number now.</span>`;
    }

    root.innerHTML = `
      <div class="headline-top">
        ${dial}
        <div class="headline-lead">
          <b>${esc(s.grade)}</b>
          <span class="muted small">${esc(ctx.rangeLabel)} · ${cons.loggedDays} of ${cons.totalDays} days logged</span>
          ${gapLine}
        </div>
      </div>
      <div class="headline-stats">
        ${stat("Avg calories", `${fmt(kcalAvg)}`, kcalSub)}
        ${stat("Weight trend", weightVal, weightSub)}
        ${stat("Streak", `${cons.currentStreak} d`, `best ${cons.longestStreak} d`)}
      </div>`;
  }

  /** Short factual notes; triage layer with jump links to owning panels. */
  function renderObservations(ctx) {
    const root = $("#insight-observations");
    if (!root) return;
    const HONESTY = new Set(["partial-days", "bumps", "fasts", "once-days", "macro-incomplete", "excluded-days"]);
    const obs = Analytics.observations(ctx.days, {
      ...(ctx.scoreOpts || {}),
      entriesForDay: ctx.entriesForDay,
    })
      .slice()
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    const always = obs.filter((o) => o.tone === "watch" || HONESTY.has(o.id));
    const alwaysIds = new Set(always.map((o) => o.id));
    const rest = obs.filter((o) => !alwaysIds.has(o.id));
    const shownInfo = rest.slice(0, 3);
    const moreInfo = rest.slice(3);

    const renderNote = (o) => {
      const cls = `obs obs-${esc(o.tone)}`;
      const idAttr = ` data-obs-id="${esc(o.id)}"`;
      const dayAttr = o.jumpDay ? ` data-jump-day="${esc(o.jumpDay)}"` : "";
      if (o.panel) {
        return `<button type="button" class="${cls} obs-jump"${idAttr}${dayAttr} data-jump="${esc(o.panel)}">${esc(o.text)}</button>`;
      }
      return `<p class="${cls}"${idAttr}>${esc(o.text)}</p>`;
    };

    let html = always.map(renderNote).join("") + shownInfo.map(renderNote).join("");
    if (moreInfo.length) {
      html += `<details class="obs-more"><summary>More notes (${moreInfo.length})</summary>${moreInfo.map(renderNote).join("")}</details>`;
    }
    root.innerHTML = html;
  }

  // ---------------------------------------------------------- intake chart

  function accessibleDate(day) {
    const d = new Date(`${day}T12:00:00`);
    return Number.isFinite(d.getTime())
      ? d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })
      : day;
  }

  function chartDayButton(day, label) {
    return `<button type="button" class="chart-day-link" data-action="goto-day" data-day="${esc(day)}" aria-label="Open ${esc(accessibleDate(day))} in Today">${esc(label)}</button>`;
  }

  function renderTrendDataTable(ctx, series, roll, weekly) {
    const root = $("#trend-data");
    const canvas = $("#trend-canvas");
    if (!root) return;
    const wasOpen = !!root.querySelector("details[open]");
    const meta = nutMeta(ctx.nutrient);
    const bt = bandText(ctx.nutrient);
    const rows = series.map((p, i) => {
      const cellStatus = statusFor(ctx.nutrient, p.value, p.goal, p.unscored);
      const status = !p.logged || !Number.isFinite(p.value)
        ? "Not logged"
        // A plan exemption is not a band verdict — Today already says "not
        // scored today" for the same cell, so this row must say the same
        // thing rather than reaching for under/over/hit (Part X.2).
        : cellStatus === "exempt" ? "Not scored" : (bt[cellStatus] || "Logged");
      const period = weekly
        ? `<span>${esc(p.sub || p.key)}</span>`
        : chartDayButton(p.key, p.sub || p.label || p.key);
      return `<tr>
        <th scope="row">${period}</th>
        <td>${Number.isFinite(p.value) ? `${fmt(p.value)}${esc(meta.unit)}` : "—"}</td>
        <td>${p.goal ? `${fmt(p.goal)}${esc(meta.unit)}` : "—"}</td>
        ${weekly ? "" : `<td>${Number.isFinite(roll[i]) ? `${fmt(roll[i])}${esc(meta.unit)}` : "—"}</td>`}
        <td>${esc(status)}${p.partial ? " · partial week" : ""}</td>
      </tr>`;
    }).join("");
    root.innerHTML = `<details class="chart-data"${wasOpen ? " open" : ""}>
      <summary id="trend-data-summary">View intake chart data</summary>
      <div class="chart-table-scroll" tabindex="0" role="region" aria-label="Scrollable intake data table">
        <table class="chart-data-table">
          <caption>${esc(meta.label)} ${weekly ? "weekly averages" : "daily values"} for ${esc(ctx.rangeLabel)}</caption>
          <thead><tr><th scope="col">${weekly ? "Week" : "Day"}</th><th scope="col">${esc(meta.label)}</th><th scope="col">Target</th>${weekly ? "" : '<th scope="col">7-day average</th>'}<th scope="col">Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
    if (canvas) {
      canvas.setAttribute("aria-label", `${meta.label} ${weekly ? "weekly average" : "daily"} chart for ${ctx.rangeLabel}. Use the data table below for exact values${weekly ? "." : " and keyboard-accessible day details."}`);
      canvas.setAttribute("aria-describedby", "trend-data-summary trend-summary");
    }
  }

  /**
   * Daily bars (or weekly averages) against the day's own target, with the
   * hit band shaded and a 7-day rolling mean on top. The rolling line is the
   * point of the chart: single days are noise, the line is the behaviour.
   */
  function renderTrendChart(ctx) {
    const canvas = $("#trend-canvas");
    if (!canvas) return;
    const theme = chartTheme();
    const weekly = ctx.rollup === "week";

    const series = weekly
      ? Analytics.weeklyRollup(ctx.days, ctx.nutrient).map((w) => ({
          key: w.weekStart,
          label: w.label,
          value: w.value,
          goal: w.goal,
          logged: w.loggedDays > 0,
          sub: `${w.rangeLabel} · ${w.loggedDays}/${w.days} logged`,
          partial: w.partial,
          // Only a week where every logged day was exempt reads as a plan
          // exemption here — a partially-exempt week still carries real
          // evidence for the nutrient and keeps its band verdict (Part X.2).
          unscored: w.loggedDays > 0 && w.exemptDays === w.loggedDays,
        }))
      : ctx.days.map((d) => {
          // A declared fast that actually recorded food reverts to an
          // ordinary day (Phases.effectiveGoals, Part VIII.5) — reading
          // d.goals._unscored raw here would still call it exempt after the
          // data reverted it, disagreeing with Insights' own scoring and
          // with Today (Part X.2).
          const resolved = (typeof Phases !== "undefined" && typeof Analytics !== "undefined")
            ? Phases.effectiveGoals(Analytics.toTotalsLike(d), d.goals || {})
            : (d.goals || {});
          return {
            key: d.day,
            label: d.day.slice(5),
            value: d.logged ? d[ctx.nutrient] : null,
            goal: (d.goals || {})[ctx.nutrient] || 0,
            logged: d.logged,
            sub: typeof Phases !== "undefined" ? Phases.shortDate(d.day) : d.day,
            partial: false,
            unscored: d.logged && !!(resolved && resolved._unscored && resolved._unscored[ctx.nutrient]),
          };
        });

    const roll = weekly ? [] : Analytics.rollingMean(series.map((p) => p.value), 7, 3);
    const h = 190;
    const { ctx: c, w } = setupCanvas(canvas, h);
    const pad = { l: 34, r: 10, t: 12, b: 26 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const box = { pad, iw, ih, w, h };
    const slot = iw / Math.max(1, series.length);

    const values = series.map((p) => p.value).filter(Number.isFinite);
    const goals = series.map((p) => p.goal).filter((g) => g > 0);
    const maxV = Math.max(...values, ...goals, 1) * 1.12;
    const yAt = drawYAxis(c, box, 0, maxV, theme);

    // Hit band for the current nutrient, so "on target" is a region not a line.
    const band = (typeof Phases !== "undefined" && Phases.BANDS[ctx.nutrient]) || null;
    if (band) {
      c.fillStyle = withAlpha(theme.accent, 0.10);
      series.forEach((p, i) => {
        if (!p.goal) return;
        const x = pad.l + i * slot;
        const lo = band.dir === "ceiling" ? 0 : p.goal * (1 - band.pct);
        const hi = band.dir === "floor" ? maxV : p.goal * (1 + band.pct);
        const yHi = yAt(Math.min(hi, maxV));
        const yLo = yAt(Math.max(0, lo));
        c.fillRect(x, yHi, slot, Math.max(1, yLo - yHi));
      });
    }

    // Target step line.
    c.strokeStyle = withAlpha(theme.accent, 0.8);
    c.lineWidth = 1.5;
    c.beginPath();
    series.forEach((p, i) => {
      const x0 = pad.l + i * slot;
      const x1 = pad.l + (i + 1) * slot;
      const gy = yAt(p.goal || 0);
      if (i === 0) c.moveTo(x0, gy); else c.lineTo(x0, gy);
      c.lineTo(x1, gy);
    });
    c.stroke();
    c.lineWidth = 1;

    // Phase boundaries (daily view only — weeks blur them).
    if (!weekly && typeof Phases !== "undefined" && Array.isArray(ctx.settings.phases)) {
      c.strokeStyle = withAlpha(theme.muted, 0.45);
      c.setLineDash([3, 3]);
      for (const ph of ctx.settings.phases) {
        const idx = ctx.keys.indexOf(ph.startDay);
        if (idx <= 0) continue;
        const x = Math.round(pad.l + idx * slot) + 0.5;
        c.beginPath();
        c.moveTo(x, pad.t);
        c.lineTo(x, pad.t + ih);
        c.stroke();
      }
      c.setLineDash([]);
    }

    // Bars.
    const barW = Math.max(2, slot - Math.min(4, slot * 0.3));
    const inset = (slot - barW) / 2;
    series.forEach((p, i) => {
      if (!Number.isFinite(p.value)) return;
      const x = pad.l + i * slot + inset;
      const y = yAt(p.value);
      const base = statusColor(statusFor(ctx.nutrient, p.value, p.goal), theme);
      c.fillStyle = p.partial ? withAlpha(base, 0.55) : base;
      c.fillRect(x, y, barW, Math.max(1, pad.t + ih - y));
    });

    // 7-day rolling mean.
    if (!weekly && roll.some((v) => v != null)) {
      c.strokeStyle = theme.info;
      c.lineWidth = 2;
      c.lineJoin = "round";
      c.beginPath();
      let started = false;
      roll.forEach((v, i) => {
        if (v == null) { started = false; return; }
        const x = pad.l + (i + 0.5) * slot;
        const y = yAt(v);
        if (!started) { c.moveTo(x, y); started = true; } else { c.lineTo(x, y); }
      });
      c.stroke();
      c.lineWidth = 1;
    }

    drawXLabels(c, box, series.map((p) => p.label), theme, weekly ? 40 : 34);

    _trendHit = { series, pad, iw, w, slot, weekly, nutrient: ctx.nutrient };

    const legend = $("#trend-legend");
    if (legend) {
      // Name the line for what it is: sodium's is a limit, protein's a minimum.
      const dir = (bandFor(ctx.nutrient) || {}).dir || "range";
      const goalWord = dir === "ceiling" ? "Limit" : dir === "floor" ? "Minimum" : "Target";
      const bits = [
        `<span class="lg"><i class="sw sw-bar"></i>${weekly ? "Weekly avg" : "Daily"}</span>`,
        `<span class="lg"><i class="sw sw-goal"></i>${goalWord}</span>`,
        `<span class="lg"><i class="sw sw-band"></i>OK zone</span>`,
      ];
      if (!weekly) bits.push(`<span class="lg"><i class="sw sw-roll"></i>7-day avg</span>`);
      legend.innerHTML = bits.join("");
    }
    renderTrendDataTable(ctx, series, roll, weekly);
  }

  /** Chart caption under the intake chart — interaction hint, not a fact dump. */
  function renderTrendSummary(ctx) {
    const el = $("#trend-summary");
    if (!el) return;
    const logged = Analytics.loggedRows(ctx.days);
    if (!logged.length) {
      el.textContent = "No logged days in this range yet.";
      return;
    }
    const meta = nutMeta(ctx.nutrient);
    const period = ctx.rollup === "week" ? "week" : "day";
    const tip = period === "week"
      ? ""
      : " · tap a bar for details";
    el.textContent = `${meta.label} per ${period} vs target band${tip}`;
  }

  /** Distribution stats for the selected nutrient — the spread, not just the mean. */
  function renderIntakeStats(ctx) {
    const root = $("#intake-stats");
    if (!root) return;
    const stats = Analytics.summaryStats(ctx.days, ctx.nutrient);
    if (!stats.n) { root.innerHTML = ""; return; }
    const meta = nutMeta(ctx.nutrient);
    const u = meta.unit;
    const mom = Analytics.momentum(ctx.days, ctx.nutrient, 7);
    const cells = [
      { k: "Avg", v: `${fmt(stats.avg)}${u}` },
      { k: "Med", v: `${fmt(stats.median)}${u}` },
      { k: "Swing", v: stats.sd == null ? "—" : `±${fmt(stats.sd)}${u}` },
      { k: "Range", v: `${fmt(stats.min)}–${fmt(stats.max)}${u}` },
    ];
    if (mom) cells.push({ k: "vs 7d", v: `${Analytics.fmtSigned(mom.delta)}${u}` });
    root.innerHTML = cells.map((c) =>
      `<div class="stat"><span class="stat-k">${esc(c.k)}</span><span class="stat-v">${esc(c.v)}</span></div>`
    ).join("");
  }

  // ------------------------------------------------------------ energy card

  /**
   * Adaptive energy expenditure: what the data says you burn, rather than
   * what a formula guesses. Shown only when the inputs support it — otherwise
   * the card explains exactly what is missing.
   */
  function renderTdeeCard(ctx) {
    const root = $("#tdee-card");
    if (!root) return;
    const t = ctx.tdee;
    const partial = Analytics.partialDays(ctx.days, ctx.scoreOpts);
    const hasPartial = !!(partial && partial.flagged && partial.flagged.length);
    const eligibility = ctx.targetEligibility || { canApply: true, message: "" };
    const allowApply = !!t.actionable && !hasPartial && eligibility.canApply !== false;
    const kcalGoal = Analytics.mean(ctx.days.map((d) => Analytics.phaseKcalOf(d)));

    if (t.tdee == null) {
      root.innerHTML = `
        <div class="card-head-row"><b>Energy expenditure</b><span class="conf conf-none">not enough data</span></div>
        <p class="muted small">${esc(t.reason || "Log food and weigh in over a couple of weeks and an estimate appears here.")}</p>
        <p class="muted small">It works by comparing what you ate with how your weight trend actually moved — no formula, just your data.</p>`;
      return;
    }

    const confLabel = { high: "high confidence", medium: "medium confidence", low: "rough estimate" }[t.confidence] || "";
    // Wide bands are a reason to pause action, not a reason to hide uncertainty.
    const margin = Number.isFinite(t.marginKcal) ? ` ± ${fmt(t.marginKcal)}` : "";
    const perWeek = Analytics.kgToDisplay(t.kgPerWeek, ctx.weightUnit);
    const dir = Math.abs(t.kgPerWeek) < 0.05 ? "holding steady" : (t.kgPerWeek < 0 ? "losing" : "gaining");

    const rateRow = (label, kgWk) => {
      const target = Analytics.intakeForRate(t, kgWk);
      if (target == null) return "";
      const delta = kcalGoal ? target - kcalGoal : null;
      const sub = delta == null ? "" : `${Analytics.fmtSigned(delta)} vs your target`;
      const targetSupported = Number.isFinite(target) &&
        target >= Analytics.MIN_AUTOMATED_KCAL && target <= Analytics.MAX_AUTOMATED_KCAL;
      // Already where you want to be — no point offering to set it again.
      const isCurrent = delta != null && Math.abs(delta) < 25;
      const apply = isCurrent
        ? `<span class="muted small rate-current">current</span>`
        : (allowApply && targetSupported
          ? `<button type="button" class="linkbtn rate-apply" data-action="apply-tdee"
               data-kcal="${Math.round(target)}" data-label="${esc(label)}">Use</button>`
          : `<span class="muted small rate-current">${targetSupported ? "review only" :
            (target < Analytics.MIN_AUTOMATED_KCAL ? "below auto floor" : "outside auto range")}</span>`);
      return `<div class="rate-row"><span class="rate-k">${esc(label)}</span>
        <span class="rate-v">${fmt(target)} kcal/day</span>
        ${apply}
        <span class="muted small">${esc(sub)}</span></div>`;
    };

    root.innerHTML = `
      <div class="card-head-row"><b>Energy expenditure</b><span class="conf conf-${esc(t.confidence)}">${esc(confLabel)}</span></div>
      <div class="tdee-big">${fmt(t.tdee)}<span class="tdee-unit"> kcal/day${esc(margin)}</span></div>
      <p class="muted small">From ${t.loggedDays} eating day${t.loggedDays === 1 ? "" : "s"}${t.fastedDays ? ` and ${t.fastedDays} declared fast${t.fastedDays === 1 ? "" : "s"} (counted as 0 kcal)` : ""} and ${t.weighIns} weigh-ins over ${t.spanDays} days:
        you ate ${fmt(t.intakeAvg)} kcal/day while ${esc(dir)} ${Math.abs(perWeek).toFixed(2)} ${esc(ctx.weightUnit)}/week.</p>
      <div class="rate-table">
        <div class="rate-head muted small">To move at…</div>
        ${rateRow("Lose 0.5 kg/wk", -0.5)}
        ${rateRow("Lose 0.25 kg/wk", -0.25)}
        ${rateRow("Maintain", 0)}
        ${rateRow("Gain 0.25 kg/wk", 0.25)}
      </div>
      ${!allowApply ? `<p class="muted small"><b>Target actions are paused:</b> ${eligibility.canApply === false
        ? esc(eligibility.message || "profile review is required before applying an automated target.")
        : hasPartial
          ? `${partial.flagged.length} unusually low-intake day(s) may be partial logs.`
          : esc(t.actionReason || "this is still a low-confidence estimate.")} Review the source days before changing targets.</p>` : ""}
      <p class="muted small">Estimates, not prescriptions — expenditure shifts with activity, sleep and time. Recheck it every few weeks.</p>`;
  }

  /**
   * Target callouts + cumulative balance + weight delta.
   * @returns {object|null} the scorecard, reused by renderScorecard.
   */
  function renderCallouts(ctx) {
    const callRoot = $("#insight-callouts");
    if (!callRoot || typeof Phases === "undefined") return null;
    const totalsMap = {};
    for (const d of ctx.days) totalsMap[d.day] = Ledger.totalsFor(d.day);
    const scorecard = Phases.scoreRange(
      ctx.keys,
      (day) => totalsMap[day],
      ctx.settings,
      { excludeDay: ctx.scoreOpts.todayKey || null }
    );
    const calls = Phases.callouts(scorecard);
    const balanceKeys = ctx.scoreOpts.todayKey
      ? ctx.keys.filter((day) => day !== ctx.scoreOpts.todayKey)
      : ctx.keys;
    const bal = Phases.kcalBalance(balanceKeys, (day) => totalsMap[day], ctx.settings);
    const wDelta = ctx.keys.length
      ? Phases.weightDelta(ctx.settings, ctx.keys[0], ctx.keys[ctx.keys.length - 1])
      : null;

    const bits = [];
    if (calls.need) bits.push(`<p class="callout need">${esc(calls.need)}</p>`);
    if (calls.over) bits.push(`<p class="callout over">${esc(calls.over)}</p>`);
    if (bal) {
      const sign = bal.sum >= 0 ? "+" : "";
      bits.push(`<p class="muted small">Cumulative vs phase calorie target: ${sign}${fmt(bal.sum)} kcal across ${bal.n} days (≈ ${sign}${(bal.sum / 7700).toFixed(2)} kg).</p>`);
    }
    if (wDelta) {
      const sign = wDelta.delta >= 0 ? "+" : "";
      const wu = ctx.weightUnit;
      const f = Analytics.kgToDisplay(wDelta.first, wu);
      const l = Analytics.kgToDisplay(wDelta.last, wu);
      const d = Analytics.kgToDisplay(wDelta.delta, wu);
      bits.push(`<p class="muted small">Weight: ${f.toFixed(1)} → ${l.toFixed(1)} ${wu} (${sign}${d.toFixed(1)} ${wu}, ${wDelta.n} weigh-ins).</p>`);
    }
    callRoot.innerHTML = bits.join("");
    return scorecard;
  }

  function renderScorecard(scorecard) {
    const scoreRoot = $("#insight-scorecard");
    if (!scoreRoot) return;
    if (!scorecard || !scorecard.logged) {
      scoreRoot.innerHTML = `<b>Target scorecard</b><p class="muted small">Hit rates appear after a few logged days.</p>`;
      return;
    }
    const tiles = (scorecard.nutrients || []).map((n) => {
      const t = bandText(n.key);
      const total = n.hit + n.under + n.over;
      const pct = (v) => (total ? (v / total) * 100 : 0);
      const hitPct = total ? Math.round(pct(n.hit)) : null;
      const counts = [
        n.under ? `${n.under} ${t.under}` : null,
        n.hit ? `${n.hit} ${t.hit}` : null,
        n.over ? `${n.over} ${t.over}` : null,
      ].filter(Boolean).join(" · ") || "—";
      const avg = n.n ? formatBandDelta(n.key, n.avgDelta) : "—";
      const exemptLine = n.exemptN
        ? `<span class="muted small score-exempt">not scored on ${n.exemptN} planned day${n.exemptN === 1 ? "" : "s"}</span>`
        : "";
      return `<div class="score-tile" data-score-key="${esc(n.key)}">
        <div class="score-tile-top">
          <span class="score-name">${esc(n.label)}</span>
          <span class="muted small score-hit-label">${hitPct == null ? "no days" : esc(t.hit)}</span>
        </div>
        <div class="score-tile-mid">
          <span class="score-hit">${hitPct == null ? "—" : `${hitPct}%`}</span>
          <span class="muted small score-avg">avg ${esc(avg)}</span>
        </div>
        <span class="score-bar" role="img" aria-label="${esc(counts)}">
          <i class="sb-under" style="width:${pct(n.under)}%"></i><i class="sb-hit" style="width:${pct(n.hit)}%"></i><i class="sb-over" style="width:${pct(n.over)}%"></i>
        </span>
        ${exemptLine}
      </div>`;
    }).join("");
    scoreRoot.innerHTML = `<b>Target scorecard</b>
      <p class="muted small">Across ${scorecard.logged} logged days.</p>
      <div class="score-tile-grid">${tiles}</div>
      ${bandLegend()}`;
  }

  /**
   * Spells out the three target shapes. Without this, a green bar on a 900 mg
   * sodium day and a green bar on a 145 g protein day look like the same
   * claim, when one means "well under a limit" and the other "past a minimum".
   */
  function bandLegend() {
    return `<p class="muted small band-legend">
      <b>Protein, fiber and potassium are floors</b> — a minimum to reach; going above is fine, never flagged.
      <b>Sodium is a ceiling</b> — lower is better, only going over is flagged.
      <b>Calories, carbs and fat are ranges</b> — either direction counts.
    </p>`;
  }

  // -------------------------------------------------------------- heatmap

  /** Whole-range consistency at a glance, in the layout commit graphs taught. */
  function renderHeatmap(ctx) {
    const root = $("#insight-heatmap");
    if (!root) return;
    const cells = Analytics.heatmapCells(ctx.days, ctx.nutrient, ctx.scoreDay, ctx.scoreOpts);
    // An energy adjustment only moves the calorie target. Marking that day on
    // protein, sodium, or potassium heatmaps implies targets that never moved.
    const plannedDays = ctx.nutrient === "kcal"
      ? new Set(Analytics.dayPlanAudit(ctx.days, ctx.scoreOpts).days.map((b) => b.day))
      : new Set();
    for (const c of cells) c.planned = plannedDays.has(c.day);
    const weeks = Analytics.heatmapWeeks(cells);
    if (!weeks.length) { root.innerHTML = ""; return; }
    const cons = ctx.consistency;
    const meta = nutMeta(ctx.nutrient);

    const dowLabels = ["M", "T", "W", "T", "F", "S", "S"];
    const cols = weeks.map((wk) => {
      const inner = wk.cells.map((c) => {
        if (!c) return `<i class="hm-cell hm-void"></i>`;
        const bt2 = bandText(ctx.nutrient);
        let title;
        if (c.status === "fast") {
          // Honoured fast (0 kcal). §11 tooltip is just "fasted".
          title = `${c.day} · fasted`;
        } else if (c.fasted) {
          // Declared fast that recorded food: keep the real grade and name both
          // facts — the declaration marker and the intake vs target.
          const stateWord = bt2[c.status] || c.status;
          title = `${c.day} · fasted · recorded food · ${fmt(c.value)}${meta.unit}${c.goal ? ` of ${fmt(c.goal)}` : ""} · ${stateWord}${c.planned ? " · planned calorie target" : ""}`;
        } else {
          const stateWord = c.logged ? (bt2[c.status] || c.status) : "not logged";
          title = c.logged
            ? `${c.day} · ${fmt(c.value)}${meta.unit}${c.goal ? ` of ${fmt(c.goal)}` : ""} · ${stateWord}${c.planned ? " · planned calorie target" : ""}`
            : `${c.day} · not logged`;
        }
        // Status is carried by shape as well as colour: green/orange alone
        // fails for red-green colour blindness, and this grid has no text or
        // position fallback the way the bars and scorecard do.
        const fastMark = c.fasted && c.status !== "fast" ? " hm-fasted" : "";
        return `<button type="button" class="hm-cell hm-${esc(c.status)}${c.planned ? " hm-planned" : ""}${fastMark}" data-action="heatmap-day" data-day="${esc(c.day)}" title="${esc(title)}" aria-label="${esc(title)}"></button>`;
      }).join("");
      return `<div class="hm-col">${inner}</div>`;
    }).join("");

    const monthRow = weeks.map((wk, i) => {
      const d = Analytics.dateOf(wk.weekStart);
      const prev = i > 0 ? Analytics.dateOf(weeks[i - 1].weekStart) : null;
      const show = !prev || d.getMonth() !== prev.getMonth();
      return `<div class="hm-month">${show ? esc(d.toLocaleDateString(undefined, { month: "short" })) : ""}</div>`;
    }).join("");

    const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
    // Only show swatches for states this nutrient's band can actually produce.
    const bt = bandText(ctx.nutrient);
    const dir = (bandFor(ctx.nutrient) || {}).dir || "range";
    const keySwatches = [
      `<i class="hm-cell hm-empty"></i>none`,
      `<i class="hm-cell hm-fast"></i>fasted`,
      dir !== "ceiling" ? `<i class="hm-cell hm-under"></i>${esc(bt.under)}` : null,
      `<i class="hm-cell hm-hit"></i>${esc(bt.hit)}`,
      dir !== "floor" ? `<i class="hm-cell hm-over"></i>${esc(bt.over)}` : null,
    ].filter(Boolean).join(" ");
    const dirNote = dir === "ceiling"
      ? "ceiling — lower is better"
      : dir === "floor" ? "floor — more is fine" : "range";
    const eatingDays = Math.max(0, (cons.loggedDays || 0) - (cons.fastedDays || 0));
    const missedN = (cons.missedDays && cons.missedDays.length) || 0;
    root.innerHTML = `
      <div class="card-head-row"><b>Logging calendar</b><span class="muted small">${esc(nutMeta(ctx.nutrient).label)} · ${esc(dirNote)}</span></div>
      <div class="hm-scroll">
        <div class="hm-grid-wrap">
          <div class="hm-months" style="--cols:${weeks.length}">${monthRow}</div>
          <div class="hm-body">
            <div class="hm-dow">${dowLabels.map((l) => `<span>${l}</span>`).join("")}</div>
            <div class="hm-grid">${cols}</div>
          </div>
        </div>
      </div>
      <div id="heatmap-tip" class="hm-tip" hidden></div>
      <p class="muted small hm-key">${keySwatches}</p>
      <div class="stat-grid">
        <div class="stat"><span class="stat-k">Logged</span><span class="stat-v">${eatingDays}</span></div>
        <div class="stat"><span class="stat-k">Fasted</span><span class="stat-v">${cons.fastedDays || 0}</span></div>
        <div class="stat"><span class="stat-k">Missed</span><span class="stat-v">${missedN}</span></div>
        <div class="stat"><span class="stat-k">Streak</span><span class="stat-v">${cons.currentStreak} d</span></div>
        <div class="stat"><span class="stat-k">Best</span><span class="stat-v">${cons.longestStreak} d</span></div>
        <div class="stat"><span class="stat-k">Wk / We</span><span class="stat-v">${pct(cons.weekdayRate)} / ${pct(cons.weekendRate)}</span></div>
      </div>`;
  }

  /** Compact tip under the logging calendar for a tapped day. */
  function showHeatmapTip(dayKey, opts) {
    const tip = $("#heatmap-tip");
    if (!tip) return;
    if (!dayKey) {
      tip.hidden = true;
      tip.innerHTML = "";
      return;
    }
    const o = opts || {};
    const meta = nutMeta(o.nutrient || (_insight && _insight.nutrient) || "kcal");
    const d = new Date(dayKey + "T12:00:00");
    const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const value = o.value;
    const goal = o.goal;
    const status = o.status || "";
    const valueHtml = Number.isFinite(value)
      ? `<b>${fmt(value)}${esc(meta.unit)}</b>`
      : `<b class="muted">not logged</b>`;
    const goalHtml = Number.isFinite(goal) && goal
      ? `<span class="muted small">target ${fmt(goal)}${esc(meta.unit)}</span>`
      : "";
    const statusHtml = status ? `<span class="muted small">${esc(status)}</span>` : "";
    tip.innerHTML = `<span class="tip-day">${esc(label)}</span>${valueHtml}${goalHtml}${statusHtml}
      <button type="button" class="tip-goto" data-action="goto-day" data-day="${esc(dayKey)}">Open day</button>`;
    tip.hidden = false;
  }

  // ------------------------------------------------------------ breakdown

  /** Macro split as a share of calories, next to the split your targets imply. */
  function renderMacroSplit(ctx) {
    const root = $("#macro-split");
    if (!root) return;
    const split = Analytics.macroSplit(ctx.days);
    if (!split.actual) {
      root.innerHTML = `<b>Macro split</b><p class="muted small">Appears once you have a logged day.</p>`;
      return;
    }
    const theme = chartTheme();
    const parts = [
      { key: "protein", label: "Protein", color: theme.accent },
      { key: "carbs", label: "Carbs", color: theme.info },
      { key: "fat", label: "Fat", color: theme.warn },
    ];

    // Donut via stroke-dasharray on a single circle per slice.
    const R = 42, C = 2 * Math.PI * R;
    let offset = 0;
    const arcs = parts.map((p) => {
      const frac = split.actual[p.key];
      const seg = `<circle class="donut-seg" cx="60" cy="60" r="${R}" fill="none"
        stroke="${p.color}" stroke-width="16"
        stroke-dasharray="${(frac * C).toFixed(2)} ${(C - frac * C).toFixed(2)}"
        stroke-dashoffset="${(-offset * C).toFixed(2)}"
        transform="rotate(-90 60 60)"></circle>`;
      offset += frac;
      return seg;
    }).join("");

    const rows = parts.map((p) => {
      const a = split.actual[p.key];
      const t = split.target ? split.target[p.key] : null;
      const g = split.actual.grams[p.key];
      const gt = split.target ? split.target.grams[p.key] : null;
      const drift = t == null ? "" : `${Analytics.fmtSigned((a - t) * 100)} pts vs target`;
      return `<li>
        <span class="ms-dot" style="background:${p.color}"></span>
        <span class="ms-name">${esc(p.label)}</span>
        <span class="ms-pct">${Math.round(a * 100)}%</span>
        <span class="muted small">${fmt(g)} g${gt != null ? ` of ${fmt(gt)} g` : ""}${drift ? ` · ${drift}` : ""}</span>
      </li>`;
    }).join("");

    root.innerHTML = `
      <div class="card-head-row"><b>Macro split</b><span class="muted small">share of calories</span></div>
      <div class="donut-row">
        <svg class="donut" viewBox="0 0 120 120" role="img" aria-label="Macro split donut">
          ${arcs}
          <text x="60" y="56" class="donut-mid">${Math.round(split.actual.protein * 100)}%</text>
          <text x="60" y="72" class="donut-sub">protein</text>
        </svg>
        <ul class="macro-list">${rows}</ul>
      </div>`;
  }

  /** Where the calories land across the day. */
  function renderMealSplit(ctx) {
    const root = $("#meal-split");
    if (!root) return;
    const meals = Analytics.byMeal(ctx.keys, ctx.entriesForDay || ((day) => Ledger.entriesFor(day)));
    const total = meals.reduce((s, m) => s + m.kcal, 0);
    if (!total) {
      root.innerHTML = `<b>Calories by meal</b><p class="muted small">Appears once you log meals.</p>`;
      return;
    }
    const theme = chartTheme();
    const colors = {
      breakfast: theme.info,
      lunch: theme.accent,
      dinner: cssVar("--accent-ink", "#2c7a57"),
      snack: theme.warn,
    };
    const bar = meals.filter((m) => m.kcal > 0).map((m) =>
      `<i style="width:${(m.pct * 100).toFixed(2)}%;background:${colors[m.meal]}" title="${esc(m.label)} ${Math.round(m.pct * 100)}%"></i>`
    ).join("");
    const rows = meals.map((m) => `
      <li>
        <span class="ms-dot" style="background:${colors[m.meal]}"></span>
        <span class="ms-name">${esc(m.label)}</span>
        <span class="ms-pct">${Math.round(m.pct * 100)}%</span>
        <span class="muted small">${fmt(m.avgKcal)} kcal on the ${m.daysPresent} day${m.daysPresent === 1 ? "" : "s"} it appears</span>
      </li>`).join("");
    root.innerHTML = `
      <div class="card-head-row"><b>Calories by meal</b><span class="muted small">${esc(ctx.rangeLabel)}</span></div>
      <div class="stack-bar">${bar}</div>
      <ul class="macro-list">${rows}</ul>`;
  }

  /** Day-of-week pattern — where the weekend drift hides. */
  function renderDowPattern(ctx) {
    const root = $("#dow-pattern");
    if (!root) return;
    const rows = Analytics.byDayOfWeek(ctx.days, ctx.nutrient);
    const meta = nutMeta(ctx.nutrient);
    const vals = rows.map((r) => r.avg).filter(Number.isFinite);
    if (!vals.length) {
      root.innerHTML = `<div class="card-head-row"><b>By day of week</b><span class="muted small">${esc(meta.label)}</span></div>
        <p class="muted small">Appears once you have logged days.</p>`;
      return;
    }
    const goalMax = Math.max(...rows.map((r) => r.goal || 0));
    const max = Math.max(...vals, goalMax, 1) * 1.05;
    const theme = chartTheme();

    const bars = rows.map((r) => {
      if (r.avg == null) {
        return `<div class="dow-row"><span class="dow-k">${esc(r.label)}</span>
          <span class="dow-track"></span><span class="muted small dow-v">no data</span></div>`;
      }
      const pct = (r.avg / max) * 100;
      const goalPct = r.goal ? (r.goal / max) * 100 : null;
      const color = statusColor(statusFor(ctx.nutrient, r.avg, r.goal), theme);
      const mark = goalPct == null ? "" : `<i class="dow-goal" style="left:${goalPct.toFixed(2)}%"></i>`;
      return `<div class="dow-row${r.weekend ? " weekend" : ""}">
        <span class="dow-k">${esc(r.label)}</span>
        <span class="dow-track"><i class="dow-fill" style="width:${pct.toFixed(2)}%;background:${color}"></i>${mark}</span>
        <span class="dow-v">${fmt(r.avg)}<span class="muted small"> (${r.n})</span></span>
      </div>`;
    }).join("");

    const we = Analytics.weekendEffect(ctx.days, ctx.nutrient);
    const note = we
      ? `<p class="muted small">Weekends average ${Analytics.fmtSigned(we.delta)}${meta.unit} vs weekdays (${fmt(we.weekdayAvg)} → ${fmt(we.weekendAvg)}).</p>`
      : `<p class="muted small">Needs a few more logged weekdays and weekends to compare.</p>`;

    root.innerHTML = `
      <div class="card-head-row"><b>By day of week</b><span class="muted small">${esc(meta.label)}</span></div>
      <div class="dow-list">${bars}</div>
      ${note}`;
  }

  /**
   * Top contributors by the metric you choose. Ranking by sodium or protein —
   * not only calories — is what makes this actionable.
   */
  function renderTopFoods(ctx) {
    const root = $("#top-foods");
    if (!root) return;
    const metric = ctx.topFoodMetric;
    const unit = { kcal: " kcal", protein: " g", carbs: " g", fat: " g", fiber: " g", sodium: " mg", potassium: " mg" }[metric] || "";
    const rows = Analytics.topFoods(ctx.keys, ctx.entriesForDay || ((day) => Ledger.entriesFor(day)), metric, 6);
    const scope = $("#topfoods-scope");
    if (scope) scope.textContent = nutMeta(metric).label;
    if (!rows.length) {
      root.innerHTML = `<p class="muted small">Top foods appear as you log.</p>`;
      return;
    }
    const max = rows[0].value || 1;
    root.innerHTML = `<ul class="topfood-list">${rows.map((r) => `
      <li>
        <span class="tf-name">${esc(r.name)}</span>
        <span class="tf-track"><i style="width:${((r.value / max) * 100).toFixed(2)}%"></i></span>
        <span class="tf-v">${fmt(r.value)}${esc(unit)}<span class="muted small"> · ${Math.round(r.pct * 100)}%</span></span>
      </li>`).join("")}</ul>
      <p class="muted small">${rows.length} of your foods, ${Math.round(rows.reduce((s, r) => s + r.pct, 0) * 100)}% of range ${esc(nutMeta(metric).label.toLowerCase())}.</p>`;
  }

  // ------------------------------------------------------------ weight chart

  function renderWeightDataTable(ctx, series, unit) {
    const root = $("#weight-data");
    const canvas = $("#weight-canvas");
    if (!root) return;
    const wasOpen = !!root.querySelector("details[open]");
    const rows = series.map((p) => `<tr>
      <th scope="row">${p.raw != null ? chartDayButton(p.day, accessibleDate(p.day)) : esc(accessibleDate(p.day))}</th>
      <td>${p.raw == null ? "—" : `${p.raw.toFixed(1)} ${esc(unit)}`}</td>
      <td>${p.trend == null ? "—" : `${p.trend.toFixed(1)} ${esc(unit)}`}</td>
    </tr>`).join("");
    root.innerHTML = `<details class="chart-data"${wasOpen ? " open" : ""}>
      <summary id="weight-data-summary">View weight chart data</summary>
      <div class="chart-table-scroll" tabindex="0" role="region" aria-label="Scrollable weight data table">
        <table class="chart-data-table">
          <caption>Weigh-ins and smoothed weight trend for ${esc(ctx.rangeLabel)}</caption>
          <thead><tr><th scope="col">Day</th><th scope="col">Weigh-in</th><th scope="col">Trend</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
    if (canvas) {
      canvas.setAttribute("aria-label", `Weight and smoothed trend chart for ${ctx.rangeLabel}. Use the data table below for exact values and keyboard-accessible weigh-in day details.`);
      canvas.setAttribute("aria-describedby", "weight-data-summary weight-summary");
    }
  }

  /**
   * Raw weigh-ins as dots with the EMA trend line through them. The scale
   * bounces on water and gut content; the trend is the part that means
   * anything, so it is drawn as the primary line.
   */
  function renderWeightChart(ctx) {
    const canvas = $("#weight-canvas");
    const summary = $("#weight-summary");
    if (!canvas || !summary) return;
    const theme = chartTheme();
    const unit = ctx.weightUnit;
    const toDisp = (kg) => Analytics.kgToDisplay(kg, unit);

    const series = ctx.trend.map((p) => ({
      day: p.day,
      raw: p.raw == null ? null : toDisp(p.raw),
      trend: p.trend == null ? null : toDisp(p.trend),
    }));
    const anchors = series.filter((p) => p.raw != null);
    const byDay = {};
    for (const p of anchors) byDay[p.day] = p.raw;

    const h = 175;
    const { ctx: c, w } = setupCanvas(canvas, h);
    const pad = { l: 34, r: 10, t: 12, b: 26 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const box = { pad, iw, ih, w, h };
    const xAt = (i) => pad.l + (i + 0.5) * (iw / Math.max(1, series.length));
    _weightHit = { keys: ctx.keys, pad, iw, w, byDay, unit };

    const legend = $("#weight-legend");
    if (legend) {
      legend.innerHTML = anchors.length
        ? `<span class="lg"><i class="sw sw-dot"></i>Weigh-in</span><span class="lg"><i class="sw sw-trendline"></i>Trend</span>`
        : "";
    }
    renderWeightDataTable(ctx, series, unit);

    if (anchors.length < 2) {
      summary.textContent = anchors.length === 1
        ? `One weigh-in in range (${anchors[0].raw.toFixed(1)} ${unit}). Log another day to see a trend.`
        : "Log weight on Today (2+ days in this range) to see a trend.";
      c.fillStyle = theme.muted;
      c.font = "12px system-ui,sans-serif";
      c.textAlign = "center";
      c.fillText("Need 2+ weigh-ins", w / 2, h / 2);
      c.textAlign = "start";
      renderWeightStats(ctx, null);
      return;
    }

    const all = series.flatMap((p) => [p.raw, p.trend]).filter(Number.isFinite);
    let minV = Math.min(...all);
    let maxV = Math.max(...all);
    if (maxV - minV < 1) { minV -= 1; maxV += 1; }
    const padY = (maxV - minV) * 0.15;
    minV -= padY; maxV += padY;
    const yAt = drawYAxis(c, box, minV, maxV, theme);

    // Faint raw connector so gaps read as gaps.
    c.strokeStyle = withAlpha(theme.muted, 0.35);
    c.lineWidth = 1;
    c.beginPath();
    let started = false;
    series.forEach((p, i) => {
      if (p.raw == null) return;
      const x = xAt(i), y = yAt(p.raw);
      if (!started) { c.moveTo(x, y); started = true; } else { c.lineTo(x, y); }
    });
    c.stroke();

    // Trend line.
    c.strokeStyle = theme.warn;
    c.lineWidth = 2.5;
    c.lineJoin = "round";
    c.beginPath();
    started = false;
    series.forEach((p, i) => {
      if (p.trend == null) return;
      const x = xAt(i), y = yAt(p.trend);
      if (!started) { c.moveTo(x, y); started = true; } else { c.lineTo(x, y); }
    });
    c.stroke();
    c.lineWidth = 1;

    // Raw weigh-in dots.
    series.forEach((p, i) => {
      if (p.raw == null) return;
      const x = xAt(i), y = yAt(p.raw);
      c.beginPath();
      c.arc(x, y, 3.5, 0, Math.PI * 2);
      c.fillStyle = theme.card;
      c.fill();
      c.strokeStyle = withAlpha(theme.muted, 0.8);
      c.stroke();
    });

    drawXLabels(c, box, ctx.keys.map((k) => k.slice(5)), theme, 34);

    const rate = Analytics.weightRate(ctx.trend);
    const first = anchors[0], last = anchors[anchors.length - 1];
    const delta = last.raw - first.raw;
    const bits = [
      `${anchors.length} weigh-ins (${ctx.rangeLabel})`,
      `${first.raw.toFixed(1)} → ${last.raw.toFixed(1)} ${unit} (${Analytics.fmtSigned(delta, 1)} ${unit})`,
    ];
    if (rate) bits.push(`trend ${Analytics.fmtSigned(toDisp(rate.kgPerWeek), 2)} ${unit}/week`);
    summary.textContent = bits.join(" · ") + ". Tap a point for the day.";
    renderWeightStats(ctx, rate);
  }

  function renderWeightStats(ctx, rate) {
    const root = $("#weight-stats");
    if (!root) return;
    if (!rate) { root.innerHTML = ""; return; }
    const unit = ctx.weightUnit;
    const toDisp = (kg) => Analytics.kgToDisplay(kg, unit);
    const proj = Analytics.projectWeight(ctx.days, { weeks: 4 });
    const cells = [
      { k: "Trend now", v: `${toDisp(rate.last).toFixed(1)} ${unit}` },
      { k: "Rate", v: `${Analytics.fmtSigned(toDisp(rate.kgPerWeek), 2)} ${unit}/wk` },
      { k: "Weigh-ins", v: `${rate.n} over ${rate.spanDays} d` },
    ];
    if (proj && proj.confident) {
      cells.push({ k: "In 4 weeks", v: `≈ ${toDisp(proj.projectedKg).toFixed(1)} ${unit}` });
    }
    root.innerHTML = cells.map((c) =>
      `<div class="stat"><span class="stat-k">${esc(c.k)}</span><span class="stat-v">${esc(c.v)}</span></div>`
    ).join("");
  }

  /**
   * Sodium and potassium together.
   *
   * The kidney handles them as a coupled system, so the molar Na:K ratio
   * tracks blood pressure better than either number alone — and unlike most
   * of this tab, that claim rests on a randomised trial (SSaSS, ~21,000
   * people), not just cohort data.
   *
   * The card refuses to show a ratio it cannot stand behind. Missing potassium
   * biases the ratio in one direction only — upward, because the sodium is
   * counted and the potassium that came with it is not — so a thinly covered
   * range would reliably report a worse ratio than reality.
   */
  function renderNaKCard(ctx) {
    const root = $("#nak-card");
    if (!root || typeof Phases === "undefined") return;
    const logged = Analytics.loggedRows(ctx.days);
    if (!logged.length) { root.hidden = true; root.innerHTML = ""; return; }

    const covered = logged.filter((d) => d.jointCovered &&
      Number.isFinite(d.pairedSodium) && Number.isFinite(d.pairedPotassium));
    const usableFraction = logged.length ? covered.length / logged.length : 0;
    const meanPairedCoverage = Analytics.mean(logged.map((d) =>
      Number.isFinite(d.naKCoverage) ? d.naKCoverage : 0)) ?? 0;
    // Requiring both prevents many barely-covered days from looking as strong
    // as a smaller set of genuinely well-covered days (or vice versa).
    const confidenceEvidence = Math.min(usableFraction, meanPairedCoverage);
    const goalFor = (row, key, fallback) => {
      const raw = ((row.goals || {})[key]) ?? fallback;
      const value = Number(raw);
      return Number.isFinite(value) ? value : fallback;
    };
    const constraint = (key, coverageKey, valueKey, fallback) => {
      const all = logged.map((row) => ({ row, goal: goalFor(row, key, fallback) }));
      const enabled = all.filter((x) => x.goal > 0);
      // A declared fast keeps the ceiling/floor number on display (it never
      // scales), but a day the plan exempted from scoring must not enter the
      // average either — that would credit it, not merely leave it out, since
      // 0 mg on a fast pulls the mean down and makes the ceiling look easier
      // to hold than the eating days alone show (Part X.4: "exemption removes
      // from the denominator, never credits").
      // Resolve through effectiveGoals first: a declared fast that recorded
      // food reverts to an ordinary day, and reading goals._unscored raw would
      // still exclude it — the Part X.2 contradiction this card alone kept.
      const usable = enabled.filter((x) => {
        if (!x.row[coverageKey] || !Number.isFinite(x.row[valueKey])) return false;
        const resolved = Phases.effectiveGoals(Analytics.toTotalsLike(x.row), x.row.goals || {});
        return !(resolved && resolved._unscored && resolved._unscored[key]);
      });
      return {
        enabled: enabled.length > 0,
        goal: Analytics.mean(enabled.map((x) => x.goal)) ?? 0,
        avg: Analytics.mean(usable.map((x) => x.row[valueKey])),
        n: usable.length,
      };
    };
    // These populations are deliberately independent of ratio usability.
    // A day can support the sodium ceiling or potassium floor even when it
    // lacks enough same-entry pairs for the ratio.
    const sodium = constraint("sodium", "sodiumCovered", "sodium", Phases.DEFAULT_GOALS.sodium);
    const potassium = constraint("potassium", "potassiumCovered", "potassium", Phases.DEFAULT_GOALS.potassium);
    const independentText = () => {
      const na = !sodium.enabled
        ? "Sodium ceiling disabled."
        : sodium.avg == null
          ? `Sodium ceiling ${fmt(sodium.goal)} mg; not enough sodium coverage to assess it.`
          : `Sodium ${fmt(sodium.avg)} mg/day across ${sodium.n} usable day${sodium.n === 1 ? "" : "s"}; ${sodium.avg <= sodium.goal ? "within" : "above"} the ${fmt(sodium.goal)} mg ceiling.`;
      const k = !potassium.enabled
        ? "Potassium floor disabled."
        : potassium.avg == null
          ? `Potassium floor ${fmt(potassium.goal)} mg; not enough potassium coverage to assess it.`
          : `Potassium ${fmt(potassium.avg)} mg/day across ${potassium.n} usable day${potassium.n === 1 ? "" : "s"}; ${potassium.avg >= potassium.goal ? "meets" : "below"} the ${fmt(potassium.goal)} mg floor.`;
      return `${na} ${k}`;
    };
    root.hidden = false;

    if (!covered.length) {
      root.innerHTML = `
        <div class="card-head-row"><b>Sodium and potassium</b><span class="conf conf-none">not enough complete data</span></div>
        <p class="muted small">The app's 80% paired-coverage heuristic requires both sodium and potassium on the same foods, using the lower of calorie share and item share. Add missing values under <b>Edit food</b>; unknown is kept separate from zero.</p>
        <p class="muted small">Usable ratio days: 0 of ${logged.length} (0%). Mean within-day paired coverage: ${Math.round(meanPairedCoverage * 100)}%.</p>
        <p class="muted small">${esc(independentText())}</p>`;
      return;
    }

    const pairedNaAvg = Analytics.mean(covered.map((d) => d.pairedSodium));
    const pairedKAvg = Analytics.mean(covered.map((d) => d.pairedPotassium));
    // One aggregate formula drives both the headline and the lever math.
    // Averaging daily ratios is not equivalent to a ratio of aggregate intake.
    const avgRatio = Phases.naKRatio(pairedNaAvg, pairedKAvg);
    const target = Analytics.mean(covered.map((d) => goalFor(d, "naK", 1.0)).filter((g) => g > 0)) ?? 1.0;
    const status = Phases.classify(avgRatio, target, Phases.BANDS.naK);

    // Both levers, and which side the gap is actually on.
    // molar ratio = (Na/22.99)/(K/39.10), so K at target = Na * (39.10/22.99) / target.
    const kNeeded = pairedNaAvg * Phases.NAK_MASS_TO_MOLAR / target;
    const naNeeded = pairedKAvg * target / Phases.NAK_MASS_TO_MOLAR;
    const raiseK = Math.max(0, kNeeded - pairedKAvg);
    const cutNa = Math.max(0, pairedNaAvg - naNeeded);

    // Deliberately not "whichever number is smaller" — comparing milligrams of
    // sodium against milligrams of potassium treats them as equally hard to
    // change, and they are not. Adding a food is easier to sustain than
    // removing salt from food you already eat. So the deciding question is
    // whether sodium is already acceptable on its own terms: if it is, the gap
    // is on the potassium side no matter which number looks bigger.
    const sodiumUnknown = sodium.enabled && sodium.avg == null;
    const potassiumUnknown = potassium.enabled && potassium.avg == null;
    const sodiumMiss = sodium.enabled && sodium.avg != null && sodium.avg > sodium.goal;
    const potassiumMiss = potassium.enabled && potassium.avg != null && potassium.avg < potassium.goal;
    const pairedEstimate = `Paired-subtotal estimate: about ${fmt(raiseK)} mg/day more potassium or ${fmt(cutNa)} mg/day less sodium would bring the ratio to ${target.toFixed(1)}.`;
    let lever;
    if (sodiumMiss && potassiumMiss) {
      lever = `Sodium is above its independent ${fmt(sodium.goal)} mg ceiling, and potassium is below its independent ${fmt(potassium.goal)} mg floor. Address both; extra potassium does not cancel a high-sodium day.${status === "hit" ? "" : ` ${pairedEstimate}`}`;
    } else if (sodiumMiss) {
      lever = `Sodium is above its independent ${fmt(sodium.goal)} mg ceiling. Lower sodium even if the ratio is at target; extra potassium does not cancel a high-sodium day.${status === "hit" ? "" : ` ${pairedEstimate}`}`;
    } else if (potassiumMiss) {
      const floorGap = Math.max(0, potassium.goal - potassium.avg);
      lever = `Potassium is below its independent ${fmt(potassium.goal)} mg floor by about ${fmt(floorGap)} mg/day on potassium-usable days.${status === "hit" ? "" : ` ${pairedEstimate}`}`;
    } else if (sodiumUnknown || potassiumUnknown) {
      lever = `The ratio is available, but at least one enabled independent mineral constraint lacks enough coverage to assess. Add the missing mineral values before treating the card as all-clear.`;
    } else if (status === "hit") {
      lever = `The ratio and every enabled independent sodium/potassium constraint are in range. Keep emphasizing ordinary potassium-rich foods and moderate sodium.`;
    } else {
      lever = `The enabled independent sodium/potassium constraints are in range, but the ratio is not. ${pairedEstimate}`;
    }

    const confClass = confidenceEvidence >= 0.8 ? "conf-high" : confidenceEvidence >= 0.5 ? "conf-medium" : "conf-low";
    const confLabel = confidenceEvidence >= 0.8 ? "high confidence" : confidenceEvidence >= 0.5 ? "medium confidence" : "low confidence";

    root.innerHTML = `
      <div class="card-head-row"><b>Sodium and potassium</b><span class="conf ${confClass}">${esc(confLabel)}</span></div>
      <div class="nak-big ${esc(status)}">${avgRatio.toFixed(2)}<span class="nak-unit"> molar Na:K · target ≤ ${target.toFixed(1)}</span></div>
      <p class="muted small">The ratio uses only same-entry paired subtotals: ${fmt(pairedNaAvg)} mg sodium and ${fmt(pairedKAvg)} mg potassium on usable ratio days. ${esc(independentText())}</p>
      <p class="muted small">Usable ratio days: ${covered.length} of ${logged.length} (${Math.round(usableFraction * 100)}%). Mean within-day paired coverage: ${Math.round(meanPairedCoverage * 100)}%. Confidence uses the lower of those two signals.</p>
      <p class="small nak-lever">${esc(lever)}</p>
      <p class="muted small">The ratio is a supporting signal, not a replacement for the sodium ceiling or potassium target. Evidence links lower sodium and adequate potassium with better blood-pressure outcomes; the large SSaSS trial specifically tested potassium-enriched salt in an older, high-risk population, not this tracker score.</p>
      <p class="muted small nak-caution"><b>Potassium safety:</b> kidney disease and medicines such as ACE inhibitors, ARBs, and potassium-sparing diuretics can raise potassium dangerously. Ask a clinician before increasing potassium or using supplements or salt substitutes.</p>
      ${confidenceEvidence < 0.8 ? `<p class="muted small">Days without enough sodium and potassium data are excluded rather than estimated. Add both values to more foods to widen this.</p>` : ""}`;
  }

  /**
   * This phase against the one before it — the question people actually have
   * when a phase ends. Only shown when a previous phase has enough logged days
   * to say anything; a three-day predecessor would produce confident nonsense.
   */
  function renderPhaseCompare(ctx) {
    const root = $("#phase-compare");
    if (!root) return;
    const section = $("#section-compare");
    const setHidden = (v) => {
      root.hidden = v;
      if (section) section.hidden = v;
    };
    setHidden(true);
    root.innerHTML = "";
    if (typeof Phases === "undefined") return;

    const phases = (ctx.settings.phases || [])
      .filter((p) => p && !p.archived)
      .sort((a, b) => String(a.startDay).localeCompare(String(b.startDay)));
    if (phases.length < 2) return;

    const currentPhase = ctx.daysBack === "phase" && ctx.selectedPhase
      ? ctx.selectedPhase
      : Phases.phaseForDay(ctx.settings.phases, ctx.todayKey) ||
        Phases.activePhase(ctx.settings.phases) || phases[phases.length - 1];
    const idx = phases.findIndex((p) => p.id === currentPhase.id);
    if (idx < 1) return;
    const prevPhase = phases[idx - 1];

    const buildFor = (phase) => {
      const keys = Phases.phaseDayKeys(phase, ctx.todayKey);
      if (!keys.length) return null;
      return Analytics.buildDays({
        keys,
        totalsForDay: (day) => Ledger.totalsFor(day),
        goalsForDay: (day) => Phases.goalsForDay(day, ctx.settings),
        weightKgForDay: (day) => Phases.weightForDay(ctx.settings, day),
        dayPlanForDay: (day) => (ctx.settings.dayGoals && ctx.settings.dayGoals[day]) || null,
        firstAddAt: (day) => Ledger.firstAddAt(day),
      });
    };

    const curDays = buildFor(currentPhase);
    const prevDays = buildFor(prevPhase);
    if (!curDays || !prevDays) return;

    const cur = Analytics.rangeSummary(curDays, ctx.scoreDay, { todayKey: ctx.todayKey });
    const prev = Analytics.rangeSummary(prevDays, ctx.scoreDay, {});
    // Too little in the predecessor to compare honestly.
    if (prev.loggedDays < 5 || cur.loggedDays < 5) return;

    const rows = Analytics.compareSummaries(cur, prev, { weightUnit: ctx.weightUnit });
    setHidden(false);
    root.innerHTML = `
      <div class="card-head-row"><b>vs previous phase</b>
        <span class="muted small">${esc(Phases.labelForDay(prevPhase, prevPhase.endDay || ctx.todayKey))} → ${esc(Phases.labelForDay(currentPhase, currentPhase.endDay || ctx.todayKey))}</span></div>
      <p class="muted small">${prev.loggedDays} logged days then, ${cur.loggedDays} now.</p>
      <ul class="cmp-list">${rows.map((r) => {
        const arrow = r.better === true ? "up" : r.better === false ? "down" : "flat";
        return `<li>
          <span class="cmp-k">${esc(r.label)}</span>
          <span class="cmp-prev muted small">${esc(r.format(r.previous))}</span>
          <span class="cmp-arrow cmp-${arrow}" aria-hidden="true">→</span>
          <span class="cmp-cur">${esc(r.format(r.current))}</span>
        </li>`;
      }).join("")}</ul>
      <p class="muted small">Calorie average and weight rate have no better or worse without knowing the intent — a faster loss is progress in a cut and a problem in a bulk.</p>`;
  }

  // ------------------------------------------------------- phase chrome

  function renderPhaseChrome(ctx) {
    const ctxHeader = $("#phase-context");
    const backBtn = $("#btn-phase-current");
    if (typeof Phases === "undefined") return;
    if (ctxHeader) {
      const p = ctx.daysBack === "phase" ? ctx.selectedPhase :
        (Phases.phaseForDay(ctx.settings.phases, ctx.todayKey) || Phases.activePhase(ctx.settings.phases));
      ctxHeader.textContent = Phases.phaseContext(ctx.settings, ctx.todayKey, p);
    }
    if (backBtn) backBtn.hidden = !ctx.viewingPastPhase;

    const histRoot = $("#phase-history");
    const histList = $("#phase-history-list");
    const histSum = $("#phase-history-summary");
    if (!histRoot || !histList) return;
    const rows = Phases.phaseHistoryRows(ctx.settings, ctx.todayKey, (day) => Ledger.totalsFor(day));
    if (rows.length < 2) { histRoot.hidden = true; return; }
    histRoot.hidden = false;
    if (histSum) histSum.textContent = `Phase history (${rows.length})`;
    const selId = ctx.daysBack === "phase" && ctx.selectedPhase
      ? ctx.selectedPhase.id
      : (Phases.phaseForDay(ctx.settings.phases, ctx.todayKey) ||
        Phases.activePhase(ctx.settings.phases) || {}).id;
    histList.innerHTML = rows.map((r) => {
      const logs = r.logged ? `${r.logged}/${r.days} logged` : (r.days ? "no logs" : "0 d");
      const bits = [r.rangeLabel, `${r.days} d`, logs];
      if (r.kcalLabel) bits.push(r.kcalLabel);
      if (r.weightLabel) bits.push(r.weightLabel);
      const chip = r.active ? '<span class="phase-chip">Active</span>' : "";
      return `<button type="button" class="phase-hist-row${r.id === selId ? " active" : ""}" data-phase-id="${esc(r.id)}">
        <span class="phase-hist-title">${esc(r.name)} · ${esc(r.kindLabel)} ${chip}</span>
        <span class="muted small">${esc(bits.join(" · "))}</span>
      </button>`;
    }).join("");
  }

  // ------------------------------------------------------------- entry point

  /**
   * First-run maturity: hide panels that only refuse until enough days exist.
   * Does not change any panel's own refusal copy — only visibility.
   * `#section-compare` stays owned by renderPhaseCompare on `full`.
   * Dock visibility is owned by applyInsightCategory (Intake only).
   */
  let _insightMaturity = "empty";
  let _insightCategory = "overview";
  let _insightIntakePage = 0;

  const INSIGHT_CATS = ["overview", "intake", "body", "patterns"];
  const JUMP_TO_CAT = Object.freeze({
    "#insight-heatmap": { cat: "intake", page: 1 },
    "#dow-pattern": { cat: "intake", page: 2 },
    "#top-foods": { cat: "intake", page: 3 },
    "#top-foods-card": { cat: "intake", page: 3 },
    "#intake-stats": { cat: "intake", page: 0 },
    "#section-intake": { cat: "intake", page: 0 },
    "#today-day-detail": { cat: "overview" },
    "#insight-scorecard": { cat: "patterns" },
    "#macro-split": { cat: "patterns" },
    "#meal-split": { cat: "patterns" },
    "#nak-card": { cat: "patterns" },
    "#phase-compare": { cat: "patterns" },
    "#section-adherence": { cat: "patterns" },
    "#section-composition": { cat: "patterns" },
    "#section-compare": { cat: "patterns" },
    "#section-weight": { cat: "body" },
    "#section-energy": { cat: "body" },
    "#tdee-card": { cat: "body" },
    "#insight-callouts": { cat: "body" },
    "#insight-headline": { cat: "overview" },
    "#insight-observations": { cat: "overview" },
  });

  function syncInsightDock() {
    const insightsView = typeof document !== "undefined"
      ? document.getElementById("view-insights") : null;
    const onInsights = !!(insightsView && insightsView.classList.contains("active"));
    const show = onInsights && _insightMaturity !== "empty" && _insightCategory === "intake";
    const dock = $("#insight-dock");
    if (dock) {
      dock.hidden = !show;
      dock.classList.remove("is-inactive");
    }
    if (typeof document !== "undefined" && document.body) {
      document.body.classList.toggle("has-insight-dock", show);
    }
  }

  /** Resolve which category (and Intake page) owns a jump target selector. */
  function insightJumpTarget(sel) {
    if (!sel) return null;
    if (JUMP_TO_CAT[sel]) return { ...JUMP_TO_CAT[sel] };
    const target = $(sel);
    if (!target) return null;
    const pageEl = target.closest("[data-intake-page]");
    if (target.closest("#insight-panel-intake") || target.id === "section-intake") {
      return {
        cat: "intake",
        page: pageEl ? Number(pageEl.dataset.intakePage) || 0 : 0,
      };
    }
    if (target.closest("#insight-panel-body")) return { cat: "body" };
    if (target.closest("#insight-panel-patterns")) return { cat: "patterns" };
    if (target.closest("#insight-panel-overview")) return { cat: "overview" };
    return null;
  }

  function syncIntakeCarouselDots(page) {
    const dots = $$("#intake-carousel-dots .carousel-dot");
    dots.forEach((d) => {
      const on = Number(d.dataset.intakePage) === page;
      d.classList.toggle("on", on);
      d.setAttribute("aria-selected", String(on));
    });
  }

  /**
   * Scroll the Intake carousel to a page index (0–3) and sync pagination dots.
   * Pass `{ dotsOnly: true }` when reflecting an existing scroll position.
   */
  function setIntakeCarouselPage(page, opts) {
    const next = Math.max(0, Math.min(3, Number(page) || 0));
    _insightIntakePage = next;
    syncIntakeCarouselDots(next);
    if (opts && opts.dotsOnly) return next;
    const track = $("#intake-carousel-track");
    const pages = track
      ? [...track.querySelectorAll(".insight-carousel-page")]
      : [];
    const target = pages[next];
    if (track && target) {
      const reduce = typeof window !== "undefined" && window.matchMedia
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const smooth = !!(opts && opts.smooth) && !reduce;
      if (typeof track.scrollTo === "function") {
        track.scrollTo({ left: target.offsetLeft, behavior: smooth ? "smooth" : "auto" });
      } else {
        track.scrollLeft = target.offsetLeft;
      }
    }
    return next;
  }

  /**
   * Category gate for Insights: Overview / Intake / Body / Patterns.
   * Empty maturity forces Overview; dock only on Intake.
   * @returns {string} applied category id
   */
  function applyInsightCategory(cat) {
    let next = INSIGHT_CATS.includes(cat) ? cat : "overview";
    if (_insightMaturity === "empty" && next !== "overview") next = "overview";
    _insightCategory = next;

    $$("[data-insight-panel]").forEach((panel) => {
      const on = panel.dataset.insightPanel === next;
      panel.hidden = !on;
    });

    $$("#insight-cats [data-insight-cat]").forEach((btn) => {
      const on = btn.dataset.insightCat === next;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", String(on));
      if (_insightMaturity === "empty") {
        btn.disabled = btn.dataset.insightCat !== "overview";
      } else {
        btn.disabled = false;
      }
    });

    syncInsightDock();
    if (next === "intake") {
      // Ensure scroll position matches the remembered page after the panel shows.
      setIntakeCarouselPage(_insightIntakePage, { smooth: false });
    }
    return next;
  }

  function applyInsightMaturity(ctx) {
    const sectionIds = [
      "section-intake", "section-weight", "section-energy",
      "section-adherence", "section-composition", "section-compare",
    ];
    const dow = $("#dow-pattern");
    _insightMaturity = ctx.maturity || "empty";
    if (ctx.maturity === "empty") {
      for (const id of sectionIds) {
        const el = $("#" + id);
        if (el) el.hidden = true;
      }
      if (dow) dow.hidden = true;
      applyInsightCategory("overview");
      return;
    }
    for (const id of sectionIds) {
      if (id === "section-compare") continue; // renderPhaseCompare owns this
      const el = $("#" + id);
      if (el) el.hidden = false;
    }
    if (dow) dow.hidden = false;
    if (ctx.maturity === "thin") {
      for (const id of ["section-energy", "section-composition", "section-compare"]) {
        const el = $("#" + id);
        if (el) el.hidden = true;
      }
      if (dow) dow.hidden = true;
    }
    applyInsightCategory(_insightCategory);
  }

  /**
   * Dock pill hit marks (P6-T1) + roving tabindex seed (P6-T4) + scroll the
   * active pill into the horizontal lane (P6-T5). Status is filled / ring /
   * hollow via data-dock-status — never colour alone — and named in aria-label.
   */
  let _dockScrolledNutrient = null;
  function syncDockPills(ctx, scorecard) {
    const nutPills = $("#insight-nutrient");
    if (!nutPills) return;
    const byKey = Object.create(null);
    for (const n of (scorecard && scorecard.nutrients) || []) {
      if (n && n.key) byKey[n.key] = n;
    }
    const buttons = [...nutPills.querySelectorAll("[data-nutrient]")];
    const focusEl = typeof document !== "undefined" ? document.activeElement : null;
    const focusInDock = !!(focusEl && nutPills.contains(focusEl) && focusEl.dataset && focusEl.dataset.nutrient);
    let activeBtn = null;
    for (const b of buttons) {
      if (!b.dataset.dockName) {
        b.dataset.dockName = b.getAttribute("aria-label") || (b.textContent || "").trim();
      }
      const name = b.dataset.dockName;
      const row = byKey[b.dataset.nutrient];
      let status = "none";
      let detail = "not enough scored days";
      if (row && row.n >= 3) {
        const rate = row.hit / row.n;
        const pct = Math.round(rate * 100);
        detail = `${pct}% of days on target`;
        if (rate >= 0.8) status = "good";
        else if (rate >= 0.5) status = "mid";
        else status = "bad";
      }
      b.dataset.dockStatus = status;
      const on = b.dataset.nutrient === ctx.nutrient;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", `${name}, ${detail}`);
      // Keep the tab stop with keyboard focus while arrows browse (P6-N6);
      // fall back to the active pill when focus is outside the toolbar.
      if (focusInDock) b.tabIndex = b === focusEl ? 0 : -1;
      else b.tabIndex = on ? 0 : -1;
      if (on) activeBtn = b;
    }
    // Scroll only when the selected nutrient changes (P6-N5) — not on every
    // range/rollup re-render that would yank a manual horizontal scroll.
    if (activeBtn && ctx.nutrient !== _dockScrolledNutrient &&
        typeof activeBtn.scrollIntoView === "function") {
      _dockScrolledNutrient = ctx.nutrient;
      const reduce = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      activeBtn.scrollIntoView({
        inline: "center", block: "nearest",
        behavior: reduce ? "auto" : "smooth",
      });
    }
  }

  /** Single render pass for the whole Insights tab. */
  function renderInsights(opts) {
    if (typeof Analytics === "undefined") return;
    if (opts && opts.category) _insightCategory = opts.category;
    if (opts && opts.intakePage != null) {
      _insightIntakePage = Math.max(0, Math.min(3, Number(opts.intakePage) || 0));
    }
    const ctx = buildInsightContext(opts);

    const intakeHead = $("#intake-head");
    if (intakeHead) intakeHead.textContent = nutMeta(ctx.nutrient).label;
    const rollSeg = $("#rollup-seg");
    if (rollSeg) {
      rollSeg.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.rollup === ctx.rollup;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }

    renderPhaseChrome(ctx);
    renderHeadline(ctx);
    renderObservations(ctx);
    renderTrendChart(ctx);
    renderTrendSummary(ctx);
    renderIntakeStats(ctx);
    renderTdeeCard(ctx);
    const scorecard = renderCallouts(ctx);
    renderScorecard(scorecard);
    syncDockPills(ctx, scorecard);
    renderNaKCard(ctx);
    renderPhaseCompare(ctx);
    renderHeatmap(ctx);
    renderMacroSplit(ctx);
    renderMealSplit(ctx);
    renderDowPattern(ctx);
    renderTopFoods(ctx);
    renderWeightChart(ctx);
    applyInsightMaturity(ctx);
    hideTip("#trend-tip");
    hideTip("#weight-tip");
    showHeatmapTip(null);
  }

  // Back-compat: app.js historically called these two separately.
  function renderTrends(opts) { renderInsights(opts); }
  function renderWeightTrend() { /* folded into renderInsights */ }

  // ----------------------------------------------------------------- tips

  function hideTip(sel) {
    const el = $(sel);
    if (el) { el.hidden = true; el.innerHTML = ""; }
  }

  function showTip(sel, wrapSel, x, html) {
    const el = $(sel);
    const wrap = $(wrapSel);
    if (!el || !wrap) return;
    el.innerHTML = html;
    el.hidden = false;
    const wrapW = wrap.clientWidth || 320;
    const tipW = el.offsetWidth || 140;
    const left = Math.max(4, Math.min(wrapW - tipW - 4, x - tipW / 2));
    el.style.left = left + "px";
  }

  function indexAtClientX(canvasSel, hit, clientX) {
    if (!hit) return -1;
    const canvas = $(canvasSel);
    if (!canvas) return -1;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const n = hit.series ? hit.series.length : hit.keys.length;
    if (x < hit.pad.l || x > hit.pad.l + hit.iw || !n) return -1;
    return Math.min(n - 1, Math.max(0, Math.floor(((x - hit.pad.l) / hit.iw) * n)));
  }

  /**
   * Tap on the intake chart: show a tooltip. In daily mode the tip includes
   * Open day; callers should not auto-scroll a contribution panel.
   * @returns {string|null} day key
   */
  function onTrendTap(clientX) {
    const hit = _trendHit;
    const i = indexAtClientX("#trend-canvas", hit, clientX);
    if (i < 0) { hideTip("#trend-tip"); return null; }
    const p = hit.series[i];
    const meta = nutMeta(hit.nutrient);
    const x = hit.pad.l + (i + 0.5) * hit.slot;
    const value = Number.isFinite(p.value)
      ? `<b>${fmt(p.value)}${esc(meta.unit)}</b>`
      : `<b class="muted">not logged</b>`;
    const goal = p.goal ? `<span class="muted small">target ${fmt(p.goal)}${esc(meta.unit)}</span>` : "";
    const open = (!hit.weekly && p.key)
      ? `<button type="button" class="tip-goto" data-action="goto-day" data-day="${esc(p.key)}">Open day</button>`
      : "";
    showTip("#trend-tip", "#section-intake .canvas-wrap", x,
      `<span class="tip-day">${esc(p.sub || p.key)}</span>${value}${goal}${open}`);
    // Weekly bars span 7 days, so there is no single day to open.
    return hit.weekly ? null : p.key;
  }

  /** Tap on the weight chart: nearest weigh-in within ~2 day slots. */
  function onWeightTap(clientX) {
    const hit = _weightHit;
    const i = indexAtClientX("#weight-canvas", hit, clientX);
    if (i < 0) { hideTip("#weight-tip"); return null; }
    const { keys, byDay, unit } = hit;
    let day = byDay[keys[i]] != null ? keys[i] : null;
    if (!day) {
      let bestDist = Infinity;
      for (let j = 0; j < keys.length; j++) {
        if (byDay[keys[j]] == null) continue;
        const dist = Math.abs(j - i);
        if (dist < bestDist) { bestDist = dist; day = keys[j]; }
      }
      if (bestDist > 2) day = null;
    }
    if (!day) { hideTip("#weight-tip"); return null; }
    const idx = keys.indexOf(day);
    const x = hit.pad.l + (idx + 0.5) * (hit.iw / Math.max(1, keys.length));
    const label = new Date(day + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
    showTip("#weight-tip", "#section-weight .canvas-wrap", x,
      `<span class="tip-day">${esc(label)}</span><b>${byDay[day].toFixed(1)} ${esc(unit)}</b>`);
    return { day, value: byDay[day], unit };
  }

  // Legacy query helpers kept for callers that only want the day key.
  function trendDayAtClientX(clientX) {
    const hit = _trendHit;
    const i = indexAtClientX("#trend-canvas", hit, clientX);
    if (i < 0 || hit.weekly) return null;
    return hit.series[i].key;
  }

  function weightDayAtClientX(clientX) {
    const hit = _weightHit;
    const i = indexAtClientX("#weight-canvas", hit, clientX);
    if (i < 0) return null;
    const { keys, byDay, unit } = hit;
    if (byDay[keys[i]] != null) return { day: keys[i], value: byDay[keys[i]], unit };
    let best = null, bestDist = Infinity;
    for (let j = 0; j < keys.length; j++) {
      if (byDay[keys[j]] == null) continue;
      const dist = Math.abs(j - i);
      if (dist < bestDist) { bestDist = dist; best = keys[j]; }
    }
    if (best == null || bestDist > 2) return null;
    return { day: best, value: byDay[best], unit };
  }

  /**
   * Single-day "where it came from" card. Ranked contribution for one nutrient
   * against that day's target/limit — the incident counterpart to range Top foods.
   *
   * @param {string|null} dayKey
   * @param {object} [opts]
   * @param {string} [opts.metric]  nutrient key; defaults to the Insights chart nutrient
   * @param {string} [opts.root]    DOM id selector (default "#today-day-detail")
   * @param {object} [opts.goals]   goals for the day (kcal/protein/…); looked up if omitted
   * @param {object} [opts.settings] settings pass-through for goals lookup
   */
  function renderDayDetail(dayKey, opts) {
    const o = opts || {};
    const root = $(o.root || "#today-day-detail");
    if (!root) return;
    if (!dayKey) {
      root.innerHTML = "";
      delete root.dataset.day;
      delete root.dataset.metric;
      return;
    }
    const metric = o.metric || (_insight && _insight.nutrient) || "kcal";
    const meta = nutMeta(metric);
    const field = { kcal: "kcal", protein: "p", carbs: "c", fat: "f", fiber: "fb", sodium: "na", potassium: "k" }[metric] || "kcal";
    const entries = Ledger.entriesFor(dayKey);
    const t = Ledger.totalsFor(dayKey);
    const value = (t[field] && t[field].mean) || 0;
    // Prefer explicit goals. Only look up via Phases when settings were passed —
    // an empty settings object would invent DEFAULT_GOALS and print fake targets.
    const goals = o.goals
      || (typeof Phases !== "undefined" && o.settings
        ? Phases.goalsForDay(dayKey, o.settings)
        : null)
      || {};
    // A declared fast that actually recorded food reverts to an ordinary day
    // (Phases.effectiveGoals, Part VIII.5) — reading goals._unscored raw
    // here, as this used to, would keep calling an exempted cell "150 g
    // short" after Insights' own scoring and the Today HUD both call it
    // scored (or vice versa on a genuine fast), the same contradiction across
    // tabs Part X.2 closes for the day list and weekly rollup.
    const resolvedGoals = typeof Phases !== "undefined" ? Phases.effectiveGoals(t, goals) : goals;
    const unscoredReason = resolvedGoals && resolvedGoals._unscored && resolvedGoals._unscored[metric];
    const goal = Number(resolvedGoals[metric]) || 0;
    const d = new Date(dayKey + "T12:00:00");
    const label = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    root.dataset.day = dayKey;
    root.dataset.metric = metric;

    const band = bandFor(metric);
    const dir = (band && band.dir) || "range";
    const goalWord = dir === "ceiling" ? "limit" : dir === "floor" ? "floor" : "target";
    const unitSuffix = metric === "kcal" ? " kcal" : (meta.unit || "");
    const mineralCoverage = metric === "sodium" ? Number(t.naCoverage)
      : metric === "potassium" ? Number(t.kCoverage)
        : null;
    const mineralComplete = metric === "sodium"
      ? (typeof Phases !== "undefined" && Phases.sodiumCovered(t))
      : metric === "potassium"
        ? (typeof Phases !== "undefined" && Phases.potassiumCovered(t))
        : true;
    const macrosCovered = typeof Phases === "undefined" || Phases.macrosCovered(t);
    const macroNutrient = metric === "protein" || metric === "carbs"
      || metric === "fat" || metric === "fiber";
    let headLine;
    if (unscoredReason) {
      // Same wording as Today's own "not scored today" — a delta against a
      // target this cell was exempted from would be a band verdict Insights
      // itself never computed (Part X.2).
      headLine = `${fmt(value)}${esc(unitSuffix)} — not scored today`;
    } else if (!mineralComplete) {
      const coverageText = Number.isFinite(mineralCoverage)
        ? ` · ${Math.round(mineralCoverage * 100)}% covered`
        : "";
      headLine = `${fmt(value)}${esc(unitSuffix)} known subtotal${coverageText} · incomplete; not compared with the full ${metric === "sodium" ? "limit" : "floor"}`;
    } else if (macroNutrient && !macrosCovered) {
      const cov = Number(t.macroCoverage);
      const coverageText = Number.isFinite(cov) ? ` · ${Math.round(cov * 100)}% covered` : "";
      headLine = `${fmt(value)}${esc(unitSuffix)} known subtotal${coverageText} · incomplete; macros not scored`;
    } else if (!goal) {
      headLine = `${fmt(value)}${esc(unitSuffix)} ${esc(meta.label.toLowerCase())}`;
    } else {
      // formatBandDelta leaves kcal unit-less (scorecard context); give it one here.
      let delta = formatBandDelta(metric, value - goal);
      if (metric === "kcal" && delta !== "—" && !/kcal/.test(delta)) {
        delta = delta.replace(/(\d[\d,]*)/, "$1 kcal");
      }
      headLine = `${fmt(value)}${esc(unitSuffix)} of a ${fmt(goal)}${esc(unitSuffix)} ${esc(goalWord)} · ${esc(delta)}`;
    }

    const actions = `<button type="button" class="btn ghost full" data-action="close-day-contrib">Close</button>`;

    if (!entries.length) {
      root.innerHTML = `<div class="card-block day-contrib">
        <b>${esc(label)}</b>
        <p class="muted small">No entries.</p>
        ${actions}
      </div>`;
      return;
    }

    const rows = typeof Analytics !== "undefined"
      ? Analytics.topFoods([dayKey], () => entries, metric, 6)
      : [];
    const unit = { kcal: " kcal", protein: " g", carbs: " g", fat: " g", fiber: " g", sodium: " mg", potassium: " mg" }[metric] || "";
    let body;
    if (!rows.length) {
      body = `<p class="muted small">No ${esc(meta.label.toLowerCase())} logged this day.</p>`;
    } else {
      const max = rows[0].value || 1;
      const lead = rows.slice(0, Math.min(2, rows.length));
      // Sum already-rounded row % so "100%" cannot contradict a third listed food.
      let leadPct = lead.reduce((s, r) => s + Math.round(r.pct * 100), 0);
      if (rows.length > lead.length && leadPct >= 100) leadPct = 99;
      const nutLabel = meta.label.toLowerCase();
      const dayWord = dayKey === Ledger.todayKey() ? "today's" : "this day's";
      const footer = lead.length === 1
        ? `1 food is ${leadPct}% of ${dayWord} ${esc(nutLabel)}.`
        : `${lead.length} foods are ${leadPct}% of ${dayWord} ${esc(nutLabel)}.`;
      body = `<ul class="topfood-list">${rows.map((r) => {
        const kind = nameSourceKind(entries, r.name);
        const badge = sourceBadgeForKind(kind);
        return `
        <li>
          <span class="tf-name">${esc(r.name)}${badge}</span>
          <span class="tf-track"><i style="width:${((r.value / max) * 100).toFixed(2)}%"></i></span>
          <span class="tf-v">${fmt(r.value)}${esc(unit)}<span class="muted small"> · ${Math.round(r.pct * 100)}%</span></span>
        </li>`;
      }).join("")}</ul>
        <p class="muted small">${footer}</p>`;
    }

    // Design Phase 3: name foods that pull macro coverage down + Edit to repair.
    let culpritsHtml = "";
    if (!macrosCovered && typeof Ledger.entryMacrosKnown === "function") {
      const culprits = entries.filter((e) => !Ledger.entryMacrosKnown(e));
      if (culprits.length) {
        const items = culprits.map((e) => {
          const kind = (e.source === "quick") ? "quick" : (e.source === "once" ? "once" : "");
          const badge = sourceBadgeForKind(kind) || (kind === ""
            ? ` <span class="src-badge" title="Incomplete macros">Incomplete</span>`
            : "");
          const kcal = Number(e.macros && e.macros.kcal) || 0;
          return `<li class="macro-culprit-row">
            <span class="tf-name">${esc(e.name || "Untitled")}${badge}
              <span class="muted small"> · ${fmt(kcal)} kcal</span></span>
            <button type="button" class="btn ghost" data-action="edit-entry" data-day="${esc(dayKey)}" data-id="${esc(e.id)}">Edit</button>
          </li>`;
        }).join("");
        culpritsHtml = `<div class="macro-culprits">
          <p class="muted small"><b>Incomplete macros</b> — calories count; protein and other macros for these items are not scored.</p>
          <ul class="topfood-list">${items}</ul>
        </div>`;
      }
    }

    root.innerHTML = `<div class="card-block day-contrib">
      <div class="card-head-row"><b>${esc(label)}</b><span class="muted small">${esc(meta.label)}</span></div>
      <p class="day-contrib-head">${headLine}</p>
      ${body}
      ${culpritsHtml}
      ${actions}
    </div>`;
  }

  function fillMealChips(rootId, meal) {
    const root = $(rootId);
    if (!root) return;
    const m0 = meal || Foods.inferMeal();
    root.innerHTML = MEALS.map((m) =>
      `<button type="button" class="uchip${m === m0 ? " active" : ""}" data-meal="${m}" aria-pressed="${m === m0}">${m}</button>`
    ).join("");
  }

  const ONCE_CATS = ["dish", "snack", "bev"];
  const ONCE_CONF = [
    { id: "weighed", label: "Weighed / label" },
    { id: "estimated", label: "Estimated portion" },
    { id: "rough", label: "Rough guess" },
  ];

  /** Prefill #sheet-once from opts or clear for a new log. */
  function fillOnceSheet(opts) {
    const o = opts || {};
    const entry = o.from || null;
    const imperial = !!o.imperial;
    const nameEl = $("#once-name");
    const qtyEl = $("#once-qty");
    const kcalEl = $("#once-kcal");
    const macrosEl = $("#once-macros");
    const nudge = $("#once-macro-nudge");
    if (nameEl) nameEl.value = entry ? String(entry.name || "") : "";
    fillMealChips("#once-meals", (entry && entry.meal) || o.meal || undefined);

    let unit = entry && entry.unit === "oz" ? "oz"
      : entry && entry.unit === "portion" ? "portion"
      : entry && entry.unit === "g" ? "g"
      : "portion";
    // Legacy / kcal-only: show grams when mass was kept (H2); else a 1-portion shell.
    let qty = entry && Number.isFinite(Number(entry.qty)) && Number(entry.qty) > 0
      ? entry.qty
      : (unit === "portion" ? 1 : "");
    if (entry && (entry.source === "quick" || entry.unit === "kcal")) {
      if (Number(entry.grams) > 0) {
        unit = "g";
        qty = Number(entry.grams);
      } else {
        unit = "portion";
        qty = 1;
      }
    }
    if (unit === "oz" && !imperial) unit = "g";
    const units = imperial ? ["g", "oz", "portion"] : ["g", "portion"];
    const unitsRoot = $("#once-units");
    if (unitsRoot) {
      unitsRoot.innerHTML = units.map((u) =>
        `<button type="button" class="uchip${u === unit ? " active" : ""}" data-unit="${u}" aria-pressed="${u === unit}">${u}</button>`
      ).join("");
    }
    if (qtyEl) qtyEl.value = qty === "" ? "" : String(qty);

    const m = (entry && entry.macros) || {};
    if (kcalEl) kcalEl.value = m.kcal != null && m.kcal !== "" ? String(m.kcal) : "";
    const setMacro = (id, v) => {
      const el = $(id);
      if (!el) return;
      el.value = (v == null || v === "") ? "" : String(v);
    };
    setMacro("#once-p", m.p);
    setMacro("#once-c", m.c);
    setMacro("#once-f", m.f);
    setMacro("#once-fb", m.fb);
    setMacro("#once-na", m.na);
    setMacro("#once-k", m.k);

    let macrosOpened;
    if (o.macrosOpened === true) macrosOpened = true;
    else if (o.macrosOpened === false || (entry && (entry.source === "quick" || entry.unit === "kcal"))) {
      macrosOpened = false;
    } else if (entry && entry.source === "once") {
      // Weighed once with zero macros must stay on the once path — inferring
      // "closed" from zeros would Save as quick and wipe grams (H3).
      macrosOpened = true;
    } else {
      macrosOpened = !!(entry && (
        Number(m.p) > 0 || Number(m.c) > 0 || Number(m.f) > 0 || Number(m.fb) > 0
        || m.na != null || m.k != null
      ));
    }
    if (macrosEl) macrosEl.open = macrosOpened;
    if (nudge) nudge.hidden = macrosOpened;

    const cat = (entry && entry.cat) || "dish";
    const cats = $("#once-cats");
    if (cats) {
      cats.innerHTML = ONCE_CATS.map((c) =>
        `<button type="button" class="uchip${c === cat ? " active" : ""}" data-cat="${c}" aria-pressed="${c === cat}">${c}</button>`
      ).join("");
    }

    let conf = o.confidence || "estimated";
    if (!o.confidence && entry && Number.isFinite(Number(entry.sd))) {
      const sd = Number(entry.sd);
      if (sd <= 0.10) conf = "weighed";
      else if (sd >= 0.40) conf = "rough";
      else conf = "estimated";
    }
    const confRoot = $("#once-confidence");
    if (confRoot) {
      confRoot.innerHTML = ONCE_CONF.map((c) =>
        `<button type="button" class="uchip${c.id === conf ? " active" : ""}" data-confidence="${c.id}" aria-pressed="${c.id === conf}">${esc(c.label)}</button>`
      ).join("");
    }

    setOnceErrors([]);
    const rem = $("#once-remove");
    if (rem) rem.hidden = !o.allowRemove;
    // Keep Estimate available while editing so Edit → Estimate can amend (not hide it).
    const estimateAi = $("#once-estimate-ai");
    if (estimateAi) estimateAi.hidden = false;
    const promote = $("#once-promote");
    if (promote) {
      const canPromote = !!(entry && entry.source === "once" && Number(entry.grams) > 0 && o.allowRemove);
      promote.hidden = !canPromote;
      promote.disabled = !canPromote;
      promote.title = canPromote
        ? ""
        : "Add a portion weight first; a saved food needs to know what 100 g looks like.";
      promote.dataset.entryId = (entry && entry.id) || "";
    }
  }

  function selectedOnceChip(rootSel, attr) {
    const el = $(`${rootSel} .uchip.active`);
    return el && el.getAttribute(attr) || null;
  }

  function selectedOnceUnit() {
    return selectedOnceChip("#once-units", "data-unit") || "portion";
  }

  function selectedOnceCat() {
    return selectedOnceChip("#once-cats", "data-cat") || "dish";
  }

  function selectedOnceConfidence() {
    return selectedOnceChip("#once-confidence", "data-confidence") || "estimated";
  }

  /**
   * Read #sheet-once into a draft for Foods.entryFromOnceDraft.
   * Returns { ok, errors[], draft?, qty, unit, meal } — draft only when ok.
   */
  function readOnceDraft() {
    const errors = [];
    const name = ($("#once-name") && $("#once-name").value || "").trim();
    if (!name) errors.push("Name is required");

    const unit = selectedOnceUnit();
    const qtyParsed = parseNutrientNumber($("#once-qty") && $("#once-qty").value);
    if (!qtyParsed.ok || qtyParsed.blank || !(qtyParsed.value > 0)) {
      errors.push(unit === "portion" ? "Enter how many portions" : "Enter a portion amount");
    }

    const kcalParsed = parseNutrientNumber($("#once-kcal") && $("#once-kcal").value);
    if (!kcalParsed.ok || kcalParsed.blank || !(kcalParsed.value > 0)) {
      errors.push("Calories for that portion are required");
    }

    const macrosOpen = !!( $("#once-macros") && $("#once-macros").open );
    const field = (id, nullable) => parseNutrientNumber($(id) && $(id).value, { nullable: !!nullable });
    const p = field("#once-p"); const c = field("#once-c"); const f = field("#once-f");
    const fb = field("#once-fb"); const na = field("#once-na", true); const k = field("#once-k", true);
    const macroChecks = [
      ["Protein", p], ["Carbs", c], ["Fat", f], ["Fiber", fb], ["Sodium", na], ["Potassium", k],
    ];
    for (const [label, parsed] of macroChecks) {
      if (!parsed.ok) errors.push(`${label} must be a number`);
      else if (parsed.value != null && parsed.value < 0) errors.push(`${label} can't be negative`);
    }

    if (errors.length) return { ok: false, errors };

    return {
      ok: true,
      errors: [],
      qty: qtyParsed.value,
      unit,
      meal: selectedMealIn("#once-meals"),
      draft: {
        name,
        cat: selectedOnceCat(),
        confidence: selectedOnceConfidence(),
        macrosOpened: macrosOpen,
        macros: {
          kcal: kcalParsed.value,
          p: p.value || 0,
          c: c.value || 0,
          f: f.value || 0,
          fb: fb.value || 0,
          na: na.value,
          k: k.value,
        },
      },
    };
  }

  /**
   * Partial once-sheet read for Estimate with AI seeding — never blocks on
   * missing required fields. Blank / unparsable nutrients become null.
   */
  function readOnceDraftLenient() {
    const name = ($("#once-name") && $("#once-name").value || "").trim();
    const unit = selectedOnceUnit();
    const qtyParsed = parseNutrientNumber($("#once-qty") && $("#once-qty").value);
    const qty = qtyParsed.ok && !qtyParsed.blank && qtyParsed.value > 0 ? qtyParsed.value : null;
    const kcalParsed = parseNutrientNumber($("#once-kcal") && $("#once-kcal").value);
    const kcal = kcalParsed.ok && !kcalParsed.blank && kcalParsed.value > 0 ? kcalParsed.value : null;
    const macrosOpen = !!( $("#once-macros") && $("#once-macros").open );
    const field = (id, nullable) => parseNutrientNumber($(id) && $(id).value, { nullable: !!nullable });
    const numOrNull = (parsed) => {
      if (!parsed.ok || parsed.blank || parsed.value == null) return null;
      return parsed.value;
    };
    const p = field("#once-p"); const c = field("#once-c"); const f = field("#once-f");
    const fb = field("#once-fb"); const na = field("#once-na", true); const k = field("#once-k", true);
    return {
      qty,
      unit,
      meal: selectedMealIn("#once-meals"),
      draft: {
        name,
        cat: selectedOnceCat(),
        confidence: selectedOnceConfidence(),
        macrosOpened: macrosOpen,
        macros: {
          kcal,
          p: numOrNull(p),
          c: numOrNull(c),
          f: numOrNull(f),
          fb: numOrNull(fb),
          na: na.ok ? na.value : null,
          k: k.ok ? k.value : null,
        },
      },
    };
  }

  /** Format a lenient once snapshot for the ESTIMATE_PROMPT “What I ate” slot. */
  function formatOnceEstimateSeed(snap) {
    const s = snap || {};
    const d = s.draft || {};
    const m = d.macros || {};
    const lines = [];
    if (d.name) lines.push(String(d.name));
    if (s.meal) lines.push(`Meal: ${s.meal}`);
    if (Number.isFinite(Number(s.qty)) && Number(s.qty) > 0 && s.unit) {
      lines.push(`Portion: ${s.qty} ${s.unit}`);
    }
    if (Number.isFinite(Number(m.kcal)) && Number(m.kcal) > 0) {
      lines.push(`Calories: ${m.kcal}`);
    }
    const known = [];
    if (Number(m.p) > 0) known.push(`P ${m.p} g`);
    if (Number(m.c) > 0) known.push(`C ${m.c} g`);
    if (Number(m.f) > 0) known.push(`F ${m.f} g`);
    if (Number(m.fb) > 0) known.push(`Fiber ${m.fb} g`);
    if (m.na != null && Number.isFinite(Number(m.na))) known.push(`Na ${m.na} mg`);
    if (m.k != null && Number.isFinite(Number(m.k))) known.push(`K ${m.k} mg`);
    if (known.length) lines.push(`Known macros: ${known.join(", ")}`);
    return lines.join("\n");
  }

  /**
   * Refill #sheet-once from a lenient Estimate pending snapshot (draft persist).
   */
  function fillOnceSheetFromPending(pending, opts) {
    const o = opts || {};
    const p = pending || {};
    const d = p.draft || {};
    const m = d.macros || {};
    const unit = p.unit === "oz" || p.unit === "g" || p.unit === "portion" ? p.unit : "portion";
    const qty = Number.isFinite(Number(p.qty)) && Number(p.qty) > 0 ? Number(p.qty) : null;
    let grams = 0;
    if (unit === "g" && qty != null) grams = Math.round(qty);
    else if (unit === "oz" && qty != null) grams = Math.round(qty * 28.35);
    fillOnceSheet({
      from: {
        name: d.name || "",
        meal: p.meal,
        unit,
        qty: qty != null ? qty : (unit === "portion" ? 1 : 0),
        grams,
        macros: {
          kcal: m.kcal != null ? m.kcal : "",
          p: m.p != null ? m.p : "",
          c: m.c != null ? m.c : "",
          f: m.f != null ? m.f : "",
          fb: m.fb != null ? m.fb : "",
          na: m.na,
          k: m.k,
        },
        cat: d.cat || "dish",
        source: d.macrosOpened ? "once" : undefined,
      },
      meal: p.meal,
      imperial: !!o.imperial || !!p.imperial,
      allowRemove: !!o.allowRemove,
      macrosOpened: !!d.macrosOpened,
      confidence: d.confidence || "estimated",
    });
  }

  function setOnceErrors(list) {
    const el = $("#once-errors");
    if (!el) return;
    const msgs = (list || []).filter(Boolean);
    if (!msgs.length) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msgs.join(" · ");
  }

  function syncOnceMacroNudge() {
    const nudge = $("#once-macro-nudge");
    const macros = $("#once-macros");
    if (nudge && macros) nudge.hidden = !!macros.open;
  }

  function setSyncPill(status, detail) {
    const el = $("#sync-pill");
    el.classList.remove("ok", "pending", "warn");
    if (status === "ok") { el.classList.add("ok"); el.textContent = detail || "synced"; }
    else if (status === "pending") { el.classList.add("pending"); el.textContent = detail || "syncing…"; }
    else if (status === "warn") { el.classList.add("warn"); el.textContent = detail || "sync issue"; }
    else el.textContent = detail || "local only";
  }

  /**
   * Trend weight beside the scale entry on Today.
   *
   * The scale moves kilos on water and gut content alone, so the number people
   * type in is the least informative version of their own weight. Showing the
   * smoothed trend and the weekly rate at the moment of entry is the cheapest
   * way to stop a bad morning reading like a bad week — and it is the one place
   * everyone looks, unlike the Insights tab.
   *
   * @param {object} opts { settings, todayKey, unit, lookbackDays }
   */
  function renderWeightTrendLine(opts) {
    const el = $("#weight-trend-line");
    if (!el) return;
    const o = opts || {};
    const settings = o.settings || {};
    if (typeof Analytics === "undefined" || typeof Phases === "undefined") {
      el.hidden = true;
      return;
    }
    const unit = settings.weightUnit === "kg" ? "kg" : "lb";
    const endDay = o.todayKey || Ledger.todayKey();
    const back = o.lookbackDays || 30;
    const keys = [];
    for (let i = back - 1; i >= 0; i--) keys.push(Analytics.addDays(endDay, -i));

    const days = Analytics.buildDays({
      keys,
      totalsForDay: () => null,
      goalsForDay: () => ({}),
      weightKgForDay: (day) => Phases.weightForDay(settings, day),
    });
    const trend = Analytics.trendWeight(days);
    const anchors = trend.filter((p) => p.raw != null);
    if (anchors.length < 2) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const rate = Analytics.weightRate(trend);
    const trendNow = Analytics.kgToDisplay(anchors[anchors.length - 1].trend, unit);
    const bits = [`Trend ${trendNow.toFixed(1)} ${unit}`];
    if (rate) {
      const perWeek = Analytics.kgToDisplay(rate.kgPerWeek, unit);
      bits.push(
        Math.abs(perWeek) < 0.05
          ? "holding steady"
          : `${Analytics.fmtSigned(perWeek, 2)} ${unit}/week`
      );
    }
    bits.push(`${anchors.length} weigh-ins, ${back} d`);
    el.hidden = false;
    el.textContent = bits.join(" · ");
  }

  function showOnboarding(show) {
    if (show) {
      openSheet("onboarding");
      return;
    }
    const el = $("#onboarding");
    const returnFocus = el && el._returnFocus;
    closeSheet("onboarding");
    // Unlike bottom sheets this centered overlay has no exit transition.
    // Hide and restore synchronously so opening the Add sheet from its primary
    // button cannot capture a soon-to-be-hidden onboarding control as its
    // return-focus target.
    if (el) el.hidden = true;
    if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) {
      try { returnFocus.focus(); } catch (e) {}
    }
  }

  /** Remaining blurb for gap sheet / Today. Incomplete sodium is a subtotal, never headroom. */
  function formatGapRemaining(remaining, goals, totals) {
    if (!remaining) return "";
    const resolved = typeof Phases !== "undefined" ? Phases.effectiveGoals(totals, goals) : goals;
    const unscored = (resolved && resolved._unscored) || null;
    if (resolved && resolved._dayPlan && resolved._dayPlan.intent === "fast" && unscored) {
      return "Declared fast — nothing to close today.";
    }
    const bits = [];
    const push = (label, key, unit) => {
      if (unscored && unscored[key]) return;
      const r = Number(remaining[key]);
      if (!Number.isFinite(r)) return;
      const g = Number(resolved && resolved[key]) || 0;
      if (!g && r === 0) return;
      const sign = r > 0 ? "+" : "";
      bits.push(`${label} ${sign}${fmt(r)}${unit}`);
    };
    push("kcal", "kcal", "");
    push("P", "protein", "g");
    push("C", "carbs", "g");
    push("F", "fat", "g");
    {
      if (!(unscored && unscored.fiber)) {
        const g = Number(resolved && resolved.fiber) || 0;
        const r = Number(remaining.fiber);
        const actual = Number.isFinite(r) ? g - r : 0;
        if (g > 0) bits.push(`Fiber ${fmt(actual)} / ${fmt(g)} g`);
        else if (Number.isFinite(r) && actual !== 0) bits.push(`Fiber ${fmt(actual)} g`);
      }
    }
    {
      if (!(unscored && unscored.sodium)) {
        const g = Number(resolved && resolved.sodium) || 0;
        const r = Number(remaining.sodium);
        const sodiumCovered = !totals || !totals.count ||
          (typeof Phases !== "undefined" && Phases.sodiumCovered(totals));
        if (!sodiumCovered) {
          const known = totals && totals.na ? Number(totals.na.mean) || 0 : Math.max(0, g - (Number.isFinite(r) ? r : g));
          const pct = Number.isFinite(totals && totals.naCoverage) ? ` · ${Math.round(totals.naCoverage * 100)}% covered` : "";
          bits.push(`Na ${fmt(known)} mg known subtotal${pct} · incomplete`);
        } else if (g > 0) {
          if (Number.isFinite(r) && r < 0) bits.push(`Na over ${fmt(Math.abs(r))} mg`);
          else bits.push(`Na room +${fmt(Number.isFinite(r) ? r : g)} mg`);
        } else if (Number.isFinite(r) && r !== 0) {
          bits.push(`Na ${fmt(Math.abs(r))} mg`);
        }
      }
    }
    return bits.length ? `Gap: ${bits.join(" · ")}` : "Targets already met (or no goals set).";
  }

  /** Display title-case for plan food names; leave mixed-case catalog names alone. */
  function titleCaseName(name) {
    const s = String(name || "").trim();
    if (!s) return s;
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/(^|[\s-/])(\S)/g, (_, sep, ch) => sep + ch.toUpperCase());
  }

  /** Hard constraint flags for plan projection (protein floor, sodium ceiling). */
  function planProjectionFlags(projected, goals, opts) {
    const flags = [];
    if (!projected) return flags;
    const pFloor = Number(goals && goals.protein) || 0;
    const naCap = Number(goals && goals.sodium) || 0;
    if (pFloor && Phases.classify(projected.protein, pFloor, Phases.BANDS.protein) === "under") {
      flags.push({ id: "p-short", label: "P short" });
    }
    if ((!opts || opts.sodiumCovered !== false) && naCap &&
        Phases.classify(projected.sodium, naCap, Phases.BANDS.sodium) === "over") {
      flags.push({ id: "na-over", label: "Na over" });
    }
    return flags;
  }

  /** Structured end-of-day projection block for the plan sheet. */
  function renderPlanProjection(el, projected, goals, opts) {
    if (!el) return;
    if (!projected) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    const o = opts || {};
    const g = goals || {};
    const lead = o.source === "ai" ? "AI projected end of day" : "With remaining plan";
    const flagged = new Set(planProjectionFlags(projected, g, o).map((f) => f.id));
    const metric = (label, key, unit, flagId) => {
      const v = Number(projected[key]);
      if (!Number.isFinite(v)) return "";
      const goal = Number(g[key]) || 0;
      const hot = flagId && flagged.has(flagId);
      const val = key === "sodium" && o.sodiumCovered === false
        ? `${fmt(v)} mg known subtotal · incomplete`
        : goal
        ? `${key === "kcal" ? "~" : ""}${fmt(v)} / ${fmt(goal)}${unit}`
        : `${key === "kcal" ? "~" : ""}${fmt(v)}${unit}`;
      return `<div class="gap-proj-metric${hot ? " flag" : ""}"><span class="gap-proj-k">${esc(label)}</span><span class="gap-proj-v">${esc(val)}</span></div>`;
    };
    const grid = [
      metric("kcal", "kcal", "", null),
      metric("Protein", "protein", " g", "p-short"),
      metric("C", "carbs", " g", null),
      metric("F", "fat", " g", null),
      metric("Fb", "fiber", " g", null),
      metric("Sodium", "sodium", " mg", "na-over"),
      metric("Potassium", "potassium", " mg", null),
    ].filter(Boolean).join("");
    el.hidden = false;
    el.innerHTML = `<div class="gap-proj-lead">${esc(lead)}</div><div class="gap-proj-grid">${grid}</div>`;
  }

  function renderGapPlanStatus(el, flags) {
    if (!el) return;
    if (!flags || !flags.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = flags.map((f) =>
      `<span class="gap-status-chip${f.id === "fallback" || f.id === "unresolved" ? " muted-chip" : ""}">${esc(f.label)}</span>`
    ).join("");
  }

  /**
   * Multi-select food list for gap plan.
   * rows: [{ key, name, sub, selected }] — selected rows are expected first.
   * opts.queryActive: true when a search string is present (show empty results under selected).
   */
  function renderGapSelectList(rows, opts) {
    const foodsRoot = $("#gap-foods-list");
    const selectedRoot = $("#gap-selected-list");
    const selectedLabel = $("#gap-selected-label");
    if (!foodsRoot || !selectedRoot) return;
    const queryActive = !!(opts && opts.queryActive);
    const list = rows || [];
    const selected = list.filter((r) => r.selected);
    const rest = list.filter((r) => !r.selected);
    const rowHtml = (r) => `
      <button type="button" class="gap-select-row${r.selected ? " selected" : ""}" data-action="gap-toggle" data-key="${esc(r.key)}">
        <input type="checkbox" tabindex="-1" ${r.selected ? "checked" : ""} aria-hidden="true">
        <div class="gap-meta">
          <div class="r-name">${esc(r.name)}</div>
          <div class="r-qty">${esc(r.sub || "")}</div>
        </div>
      </button>`;
    if (rest.length) {
      foodsRoot.innerHTML = rest.map(rowHtml).join("");
    } else if (queryActive) {
      foodsRoot.innerHTML = `<div class="empty small">No foods match. Try a different search.</div>`;
    } else {
      foodsRoot.innerHTML = `<div class="empty small">No foods match. Add foods to My Foods or search the catalog.</div>`;
    }
    if (selectedLabel) selectedLabel.textContent = `Selected (${selected.length})`;
    selectedRoot.innerHTML = selected.length
      ? selected.map(rowHtml).join("")
      : `<div class="empty small">None yet</div>`;
  }

  /**
   * Plan items list (Today log layout). pending first, then logged.
   * items: [{ id, name, meal, qtyLabel, qty, unit, macrosObj, status }]
   */
  function renderGapPlanList(items) {
    const root = $("#gap-plan-list");
    if (!root) return;
    if (!items || !items.length) {
      expandedGapItemId = null;
      root.innerHTML = `<div class="empty small">Nothing planned yet. Add a food or fill remaining with AI.</div>`;
      return;
    }
    if (expandedGapItemId && !items.some((it) => it.id === expandedGapItemId)) {
      expandedGapItemId = null;
    }
    root.innerHTML = items.map((it) => {
      const logged = it.status === "logged";
      const isExp = it.id === expandedGapItemId;
      const meal = it.meal || "";
      const head = [meal, it.qtyLabel].filter(Boolean).join(" · ");
      const m = it.macrosObj;
      const kcal = m && Number.isFinite(Number(m.kcal)) ? fmt(m.kcal) : "?";
      const protein = m && Number.isFinite(Number(m.p)) ? Number(m.p) : "?";
      const amount = inlineAmountFields({ qty: it.qty, unit: it.unit, grams: it.grams });
      const expanded = isExp
        ? `<div class="r-expanded">
            <div class="r-expanded-main">
              <div class="r-contrib">${m ? esc(fmtMacros(m)) : "Macros unavailable"}</div>
              ${logged ? "" : mealAmtEditHtml(meal, it.id, "gap", amount, "")}
            </div>
            <div class="r-expanded-actions">
              ${logged
                ? `<span class="muted small">Logged</span>`
                : `<button type="button" class="linkbtn edit-entry-btn" data-action="edit-gap-item" data-id="${esc(it.id)}">Edit</button>`}
            </div>
          </div>`
        : "";
      return `<div class="log-row-stack${isExp ? " is-expanded" : ""}${logged ? " is-logged" : ""}" data-id="${esc(it.id)}">
        <div class="log-row${isExp ? " expanded" : ""}">
          <button type="button" class="log-row-main" data-action="toggle-gap-item" data-id="${esc(it.id)}">
            <div class="r-top">
              <div>
                <div class="r-name">${esc(it.name)}</div>
                <div class="r-qty">${esc(head)}${logged ? " · logged" : ""}</div>
              </div>
              <div class="r-macros">
                <span class="mini">${kcal} kcal</span>
                <span class="mini">P ${esc(protein)}</span>
              </div>
            </div>
          </button>
          ${logged ? "" : `
            <button type="button" class="log-row-add" data-action="log-gap-item" data-id="${esc(it.id)}" aria-label="Log ${esc(it.name)}">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                <path d="M12 5v14"/><path d="M5 12h14"/>
              </svg>
            </button>
            <button type="button" class="log-row-delete" data-action="remove-gap-item" data-id="${esc(it.id)}" aria-label="Remove ${esc(it.name)} from plan">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
              </svg>
            </button>`}
        </div>
        ${expanded}
      </div>`;
    }).join("");
  }

  function showGapStep(step) {
    const intro = $("#gap-step-intro");
    const select = $("#gap-step-select");
    const prompt = $("#gap-step-prompt");
    const choose = $("#gap-step-choose");
    const plan = $("#gap-step-plan");
    if (intro) intro.hidden = step !== "intro";
    if (select) select.hidden = step !== "select";
    if (prompt) prompt.hidden = step !== "prompt";
    if (choose) choose.hidden = step !== "choose";
    if (plan) plan.hidden = step !== "plan";
    const title = $("#gap-sheet-title");
    if (title) {
      title.textContent = step === "plan"
        ? "Planner"
        : step === "prompt"
          ? "AI fill prompt"
          : step === "choose"
            ? "Choose a plan"
            : step === "select"
              ? "Pick foods for AI"
              : step === "intro"
                ? "Fill with AI"
                : "Planner";
    }
    const disclaimer = $("#gap-disclaimer");
    // Intro carries its own copy; select/plan stay compact without the banner.
    if (disclaimer) disclaimer.hidden = step === "intro" || step === "select" || step === "plan";
  }

  /**
   * options: [{ index, label, reachable, safe, complete, autoApply,
   *   reviewReasons, note, summary, itemLines }]
   */
  function renderGapOptions(options) {
    const root = $("#gap-option-list");
    if (!root) return;
    if (!options || !options.length) {
      root.innerHTML = `<div class="empty small">No options parsed.</div>`;
      return;
    }
    root.innerHTML = options.map((o, i) => {
      const reach = o.autoApply
        ? `<span class="muted small">Local food math passes the checked constraints</span>`
        : `<span class="muted small">Manual review required — this option is not cleared automatically</span>`;
      const reasons = (o.reviewReasons || []).map((reason) => `<li>${esc(reason)}</li>`).join("");
      const items = (o.itemLines || []).map((l) => `<li>${esc(l)}</li>`).join("");
      return `
        <div class="phase-option">
          <h4>${esc(o.label || `Option ${o.index || i + 1}`)}</h4>
          ${reach}
          <p class="muted small">${esc(o.summary || "")}</p>
          ${o.note ? `<p class="small">${esc(o.note)}</p>` : ""}
          ${reasons ? `<ul class="ing-list gap-review-reasons">${reasons}</ul>` : ""}
          ${items ? `<ul class="ing-list">${items}</ul>` : ""}
          <button type="button" class="btn full ai-apply-opt" data-action="apply-gap-option" data-opt="${i}">${o.autoApply ? "Use this plan" : "Review and use"}</button>
        </div>`;
    }).join("");
  }

  return {
    $, $$, fmt, esc, toast, openSheet, closeSheet, closeAllSheets, topSheetId, setDayLabel, updateHUD,
    renderDayLog, toggleEntryExpand, setExpandedEntryId, toggleGapItemExpand, setExpandedGapItemId, renderFoods, renderPicker, fillQtySheet, updateQtyPreview, selectedUnit, selectedMeal, selectedMealIn,
    weightPrefillFromHistory, renderMultiQtyList, readMultiQtyRow, updateMultiRowPreview,
    showPastePrompt, showPromptFallback, showReview, setReviewErrors, filterCategories, readReviewDraft, parseNutrientNumber,
    syncReviewLogAsUI, renderFoodDetail,
    fillOnceSheet, readOnceDraft, readOnceDraftLenient, formatOnceEstimateSeed, fillOnceSheetFromPending,
    setOnceErrors, selectedOnceUnit, selectedOnceCat, selectedOnceConfidence, syncOnceMacroNudge,
    renderInsights, renderTrends, renderWeightTrend,
    applyInsightCategory, setIntakeCarouselPage, insightJumpTarget,
    onTrendTap, onWeightTap, trendDayAtClientX, weightDayAtClientX, showHeatmapTip,
    renderDayDetail, fillMealChips, setSyncPill, showOnboarding, renderWeightTrendLine, MEALS,
    inlineAmountFields,
    formatGapRemaining, planProjectionFlags, renderPlanProjection, renderGapPlanStatus,
    titleCaseName, renderGapSelectList, renderGapPlanList, showGapStep, renderGapOptions,
  };
})();
