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

  function setDayLabel(dayKey, isToday) {
    const d = new Date(dayKey + "T12:00:00");
    const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const btn = $("#day-label");
    btn.textContent = isToday ? `${label} · today` : `${label} · tap for today`;
    btn.classList.toggle("is-today", !!isToday);
    $("#btn-day-next").disabled = isToday;
  }

  function updateHUD(totals, goals) {
    const bumps = goals && goals._bumps;
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
    const bumpNote = bumps && bumps.kcal
      ? ` · planned ${fmt(goals.kcal)} kcal (${bumps.kcal > 0 ? "+" : ""}${fmt(bumps.kcal)})`
      : "";
    $("#kcal-range").textContent = totals.count ? `likely ${fmt(lo)}–${fmt(hi)}${bumpNote}` : "—";
    set("kcal", totals.kcal.mean, goals.kcal, "kcal", "");
    set("p", totals.p.mean, goals.protein, "protein", "g");
    set("c", totals.c.mean, goals.carbs, "carbs", "g");
    set("f", totals.f.mean, goals.fat, "fat", "g");
    set("fb", totals.fb.mean, goals.fiber, "fiber", "g");
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
    if (sodiumCovered) set("sodium", totals.na.mean, goals.sodium, "sodium", "mg");
    else naFootPct = incompleteMineral("sodium", totals.na.mean, totals.naCoverage);

    // Absolute sodium and potassium each use their own coverage. The ratio is
    // stricter: only paired Na+K entries contribute to it.
    const potassiumCovered = typeof Phases !== "undefined" && Phases.potassiumCovered(totals);
    const jointCovered = typeof Phases !== "undefined" && Phases.nakCovered(totals);
    const kFill = $("#f-potassium");
    const kVal = $("#v-potassium");
    let kFootPct = null;
    if (kFill && kVal) {
      if (potassiumCovered) {
        set("potassium", totals.k.mean, goals.potassium, "potassium", "mg");
      } else {
        kFootPct = incompleteMineral("potassium", totals.k.mean, totals.kCoverage);
      }
    }
    const nakLine = $("#v-nak");
    if (nakLine) {
      const paired = jointCovered ? Phases.pairedMinerals(totals) : null;
      const ratio = paired ? Phases.naKRatio(paired.na, paired.k) : null;
      if (ratio == null) {
        nakLine.hidden = true;
        nakLine.textContent = "";
      } else {
        const target = Number(goals.naK) || 1.0;
        const status = Phases.classify(ratio, target, Phases.BANDS.naK);
        nakLine.hidden = false;
        nakLine.className = `nak-line small ${status === "over" ? "over" : "ok"}`;
        nakLine.textContent = `Na:K ${ratio.toFixed(2)} (target ≤ ${target.toFixed(1)})`;
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

  function entryTime(e) {
    if (!e.addedTs) return "";
    return new Date(e.addedTs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
        const expanded = isExp
          ? `<div class="r-expanded">
              <div class="r-expanded-main">
                <div class="r-contrib">${esc(fmtMacros(e.macros))}</div>
                ${editNote ? `<div class="r-edits">${esc(editNote)}</div>` : ""}
              </div>
              <button type="button" class="linkbtn edit-entry-btn" data-action="edit-entry" data-id="${esc(e.id)}">Edit</button>
            </div>`
          : "";
        return `<div class="log-row-stack${isExp ? " is-expanded" : ""}">
          <button type="button" class="log-row${isExp ? " expanded" : ""}" data-action="toggle-entry" data-id="${esc(e.id)}">
            <div class="r-top">
              <div>
                <div class="r-name">${esc(e.name)}</div>
                <div class="r-qty">${esc(e.displayQty)}${t ? ` · ${esc(t)}` : ""}</div>
              </div>
              <div class="r-macros">
                <span class="mini">${fmt(e.macros.kcal)} kcal</span>
                <span class="mini">P ${esc(Number.isFinite(Number(e.macros && e.macros.p)) ? Number(e.macros.p) : "?")}</span>
              </div>
            </div>
          </button>
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
      root.innerHTML = `<div class="empty">${q ? "No matches." : "No foods yet.<br><span class=\"muted small\">Add one from an AI paste, or log a common food from Today.</span>"}</div>`;
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

    const personalRow = (f) =>
      `<button type="button" class="log-row" data-action="pick-food" data-id="${esc(f.id)}">
        <div class="r-name">${esc(f.name)}</div>
        <span class="mini">${fmt(f.per100.kcal)} /100g</span>
      </button>`;
    const catalogRow = (f) =>
      `<button type="button" class="log-row" data-action="pick-catalog" data-id="${esc(f.id)}">
        <div class="r-name">${esc(f.name)}</div>
        <span class="mini">${fmt(f.per100.kcal)} /100g</span>
      </button>`;
    const yRow = (e) =>
      `<button type="button" class="log-row" data-action="repeat-yesterday" data-id="${esc(e.id)}">
        <div>
          <div class="r-name">${esc(e.name)}</div>
          <div class="r-qty">${esc(e.displayQty)} · ${esc(e.meal || "")}</div>
        </div>
        <span class="mini">${fmt(e.macros.kcal)} kcal</span>
      </button>`;

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

  function fillQtySheet(food, imperial, prefill) {
    $("#qty-name").textContent = food.name;
    $("#qty-per100").textContent = `per 100 g: ${fmt(food.per100.kcal)} kcal · ${fmtMacros(food.per100)}`;
    const prov = Foods.provenance(food);
    const src = $("#qty-source");
    if (src) {
      src.textContent = prov.label;
      src.title = prov.detail || "";
    }
    const pieceG = FoodMatch.pieceGrams(food);
    const servG = food.units && +food.units.serving > 0 ? +food.units.serving : null;
    const units = ["g"];
    if (imperial) units.push("oz");
    if (pieceG) units.push("piece");
    if (food.batch && food.batch.grams) units.push("batch");
    if (servG && !(pieceG && Math.round(servG) === Math.round(pieceG))) units.push("serving");
    const hist = weightPrefillFromHistory(food, !!imperial);
    let unit = (prefill && prefill.unit) || hist.unit;
    if (unit && unit !== "kcal" && !units.includes(unit)) units.push(unit);
    if (unit === "kcal") unit = hist.unit;
    const noun = FoodMatch.countNoun(food);
    $("#qty-units").innerHTML = units.map((u) => {
      let label = u;
      if (u === "serving" && servG) label = `serving (${Math.round(servG)} g)`;
      if (u === "piece" && pieceG) label = `${noun} (${Math.round(pieceG)} g)`;
      if (u === "batch" && food.batch) label = `batch (${fmt(food.batch.grams)} g)`;
      return `<button type="button" class="uchip${u === unit ? " active" : ""}" data-unit="${esc(u)}" aria-pressed="${u === unit}">${esc(label)}</button>`;
    }).join("");
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

  function updateQtyPreview(food) {
    const qty = Number(String($("#qty-input").value || "").replace(/,/g, "").trim());
    if (!Number.isFinite(qty) || qty <= 0) {
      $("#qty-preview").textContent = "Enter an amount";
      return null;
    }
    const unit = selectedUnit();
    const entry = Foods.entryFromQty(food, qty, unit, selectedMeal());
    let qtyLine = entry.displayQty;
    if (fillQtySheet._imperial && unit === "oz") {
      qtyLine = `${qty} oz (${Math.round(entry.grams)} g)`;
      entry.displayQty = qtyLine;
    } else if (fillQtySheet._imperial && (unit === "g" || unit === "grams")) {
      const oz = Math.round((entry.grams / 28.35) * 10) / 10;
      qtyLine = `${Math.round(entry.grams)} g (${oz} oz)`;
      entry.displayQty = qtyLine;
    }
    $("#qty-preview").textContent = `${qtyLine} · ${fmt(entry.macros.kcal)} kcal · ${fmtMacros(entry.macros)}`;
    return entry;
  }

  function showPastePrompt() {
    $("#paste-step-prompt").hidden = false;
    $("#paste-step-review").hidden = true;
    $("#paste-title").textContent = "Add food from AI paste";
    const fb = $("#prompt-fallback");
    if (fb) fb.hidden = true;
  }

  function showPromptFallback(text) {
    const fb = $("#prompt-fallback");
    const ta = $("#prompt-fallback-text");
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
      dup.innerHTML = `You already have “${esc(opts.duplicate.name)}”.
        <div class="row" style="margin-top:8px">
          <button type="button" class="btn ghost" data-action="update-dup" data-id="${esc(opts.duplicate.id)}">Update that one</button>
          <button type="button" class="btn ghost" data-action="save-new-anyway">Save as separate</button>
        </div>`;
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

  /** @returns {"hit"|"under"|"over"|"none"} */
  function statusFor(key, value, goal) {
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
      bumpForDay: (day) => (settings.dayGoals && settings.dayGoals[day]) || null,
      firstAddAt: (day) => Ledger.firstAddAt(day),
    });
    const viewingPastPhase = daysBack === "phase" && !!selectedPhase && selectedPhase.endDay != null;
    const scoreDay = typeof Phases !== "undefined" ? Phases.scoreDayTotals : null;
    const ctx = {
      keys, days, settings, todayKey, selectedPhase, daysBack, viewingPastPhase, scoreDay,
      nutrient: o.nutrient || "kcal",
      rollup: o.rollup === "week" ? "week" : "day",
      topFoodMetric: o.topFoodMetric || "kcal",
      weightUnit: settings.weightUnit === "kg" ? "kg" : "lb",
      // Today is still in progress; counting it as a miss would be wrong.
      scoreOpts: { todayKey: viewingPastPhase ? null : todayKey },
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
    const kcalGoal = Analytics.mean(ctx.days.map((d) => (d.goals || {}).kcal));
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

  /** Short factual notes; nothing here praises or scolds. */
  function renderObservations(ctx) {
    const root = $("#insight-observations");
    if (!root) return;
    const obs = Analytics.observations(ctx.days, ctx.scoreOpts);
    root.innerHTML = obs.map((o) =>
      `<p class="obs obs-${esc(o.tone)}">${esc(o.text)}</p>`
    ).join("");
  }

  // ---------------------------------------------------------- intake chart

  function accessibleDate(day) {
    const d = new Date(`${day}T12:00:00`);
    return Number.isFinite(d.getTime())
      ? d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })
      : day;
  }

  function chartDayButton(day, label) {
    return `<button type="button" class="chart-day-link" data-action="insight-chart-day" data-day="${esc(day)}" aria-label="Open nutrition details for ${esc(accessibleDate(day))}">${esc(label)}</button>`;
  }

  function renderTrendDataTable(ctx, series, roll, weekly) {
    const root = $("#trend-data");
    const canvas = $("#trend-canvas");
    if (!root) return;
    const wasOpen = !!root.querySelector("details[open]");
    const meta = nutMeta(ctx.nutrient);
    const bt = bandText(ctx.nutrient);
    const rows = series.map((p, i) => {
      const status = !p.logged || !Number.isFinite(p.value)
        ? "Not logged"
        : (bt[statusFor(ctx.nutrient, p.value, p.goal)] || "Logged");
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
        }))
      : ctx.days.map((d) => ({
          key: d.day,
          label: d.day.slice(5),
          value: d.logged ? d[ctx.nutrient] : null,
          goal: (d.goals || {})[ctx.nutrient] || 0,
          logged: d.logged,
          sub: typeof Phases !== "undefined" ? Phases.shortDate(d.day) : d.day,
          partial: false,
        }));

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

  /** One-line summary under the intake chart. */
  function renderTrendSummary(ctx) {
    const el = $("#trend-summary");
    if (!el) return;
    const logged = Analytics.loggedRows(ctx.days);
    if (!logged.length) {
      el.textContent = "No logged days in this range yet.";
      return;
    }
    const meta = nutMeta(ctx.nutrient);
    const avgSel = Analytics.mean(logged.map((d) => d[ctx.nutrient]));
    const last7 = Analytics.loggedRows(ctx.days.slice(-7));
    const weekAvg = Analytics.mean(last7.map((d) => d[ctx.nutrient]));
    const bits = [
      `${logged.length} of ${ctx.days.length} days logged (${ctx.rangeLabel})`,
      `avg ${fmt(avgSel)}${meta.unit} ${meta.label.toLowerCase()}`,
      `P ${fmt(Analytics.mean(logged.map((d) => d.protein)))} · C ${fmt(Analytics.mean(logged.map((d) => d.carbs)))} · F ${fmt(Analytics.mean(logged.map((d) => d.fat)))}`,
    ];
    if (weekAvg != null) bits.push(`last 7 d ${fmt(weekAvg)}${meta.unit}`);
    if (!ctx.viewingPastPhase) bits.push(`streak ${ctx.consistency.currentStreak} d`);
    el.textContent = bits.join(" · ");
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
      { k: "Average", v: `${fmt(stats.avg)}${u}` },
      { k: "Median", v: `${fmt(stats.median)}${u}` },
      { k: "Typical swing", v: stats.sd == null ? "—" : `±${fmt(stats.sd)}${u}` },
      { k: "Range", v: `${fmt(stats.min)} – ${fmt(stats.max)}${u}` },
    ];
    if (mom) cells.push({ k: "vs prior 7 d", v: `${Analytics.fmtSigned(mom.delta)}${u}` });
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
    const kcalGoal = Analytics.mean(ctx.days.map((d) => (d.goals || {}).kcal));

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
      <p class="muted small">From ${t.loggedDays} logged days and ${t.weighIns} weigh-ins over ${t.spanDays} days:
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
      bits.push(`<p class="muted small">Cumulative vs calorie target: ${sign}${fmt(bal.sum)} kcal across ${bal.n} days (≈ ${sign}${(bal.sum / 7700).toFixed(2)} kg).</p>`);
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
    scoreRoot.innerHTML = `<b>Target scorecard</b>
      <p class="muted small">Across ${scorecard.logged} logged days.</p>
      <ul class="score-list">${scorecard.nutrients.map((n) => {
        const t = bandText(n.key);
        const total = n.hit + n.under + n.over;
        const pct = (v) => (total ? (v / total) * 100 : 0);
        // A floor can never be "over" and a ceiling can never be "under", so
        // those counts are structurally zero — showing them is noise.
        const counts = [
          n.under ? `${n.under} ${t.under}` : null,
          n.hit ? `${n.hit} ${t.hit}` : null,
          n.over ? `${n.over} ${t.over}` : null,
        ].filter(Boolean).join(" · ") || "—";
        const avg = n.n ? formatBandDelta(n.key, n.avgDelta) : "—";
        return `<li>
          <span class="score-name">${esc(n.label)}</span>
          <span class="score-bar" role="img" aria-label="${esc(counts)}">
            <i class="sb-under" style="width:${pct(n.under)}%"></i><i class="sb-hit" style="width:${pct(n.hit)}%"></i><i class="sb-over" style="width:${pct(n.over)}%"></i>
          </span>
          <span class="muted small">${total ? `${Math.round(pct(n.hit))}% ${esc(t.hit)}` : "—"} · ${esc(counts)} · avg ${esc(avg)}</span>
        </li>`;
      }).join("")}</ul>
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
    const bumpDays = ctx.nutrient === "kcal"
      ? new Set(Analytics.bumpAudit(ctx.days, ctx.scoreOpts).days.map((b) => b.day))
      : new Set();
    for (const c of cells) c.bumped = bumpDays.has(c.day);
    const weeks = Analytics.heatmapWeeks(cells);
    if (!weeks.length) { root.innerHTML = ""; return; }
    const cons = ctx.consistency;
    const meta = nutMeta(ctx.nutrient);

    const dowLabels = ["M", "T", "W", "T", "F", "S", "S"];
    const cols = weeks.map((wk) => {
      const inner = wk.cells.map((c) => {
        if (!c) return `<i class="hm-cell hm-void"></i>`;
        const bt2 = bandText(ctx.nutrient);
        const stateWord = c.logged ? (bt2[c.status] || c.status) : "not logged";
        const title = c.logged
          ? `${c.day} · ${fmt(c.value)}${meta.unit}${c.goal ? ` of ${fmt(c.goal)}` : ""} · ${stateWord}${c.bumped ? " · planned calorie target" : ""}`
          : `${c.day} · not logged`;
        // Status is carried by shape as well as colour: green/orange alone
        // fails for red-green colour blindness, and this grid has no text or
        // position fallback the way the bars and scorecard do.
        return `<button type="button" class="hm-cell hm-${esc(c.status)}${c.bumped ? " hm-bumped" : ""}" data-action="heatmap-day" data-day="${esc(c.day)}" title="${esc(title)}" aria-label="${esc(title)}"></button>`;
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
      dir !== "ceiling" ? `<i class="hm-cell hm-under"></i>${esc(bt.under)}` : null,
      `<i class="hm-cell hm-hit"></i>${esc(bt.hit)}`,
      dir !== "floor" ? `<i class="hm-cell hm-over"></i>${esc(bt.over)}` : null,
    ].filter(Boolean).join(" ");
    const dirNote = dir === "ceiling"
      ? "ceiling — lower is better"
      : dir === "floor" ? "floor — more is fine" : "range";
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
      <p class="muted small hm-key">${keySwatches}</p>
      <div class="stat-grid">
        <div class="stat"><span class="stat-k">Days logged</span><span class="stat-v">${cons.loggedDays}/${cons.totalDays}</span></div>
        <div class="stat"><span class="stat-k">Current streak</span><span class="stat-v">${cons.currentStreak} d</span></div>
        <div class="stat"><span class="stat-k">Best streak</span><span class="stat-v">${cons.longestStreak} d</span></div>
        <div class="stat"><span class="stat-k">Weekday / weekend</span><span class="stat-v">${pct(cons.weekdayRate)} / ${pct(cons.weekendRate)}</span></div>
      </div>`;
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
    const meals = Analytics.byMeal(ctx.keys, (day) => Ledger.entriesFor(day));
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
      root.innerHTML = `<b>By day of week</b><p class="muted small">Appears once you have logged days.</p>`;
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
      <div class="card-head-row"><b>By day of week</b><span class="muted small">avg ${esc(meta.label.toLowerCase())}</span></div>
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
    const rows = Analytics.topFoods(ctx.keys, (day) => Ledger.entriesFor(day), metric, 6);
    const pills = $("#topfood-metric");
    if (pills) {
      pills.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.metric === metric;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
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
      const usable = enabled.filter((x) => x.row[coverageKey] && Number.isFinite(x.row[valueKey]));
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
    root.hidden = true;
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
        bumpForDay: (day) => (ctx.settings.dayGoals && ctx.settings.dayGoals[day]) || null,
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
    root.hidden = false;
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

  /** Single render pass for the whole Insights tab. */
  function renderInsights(opts) {
    if (typeof Analytics === "undefined") return;
    const ctx = buildInsightContext(opts);

    const nutPills = $("#insight-nutrient");
    if (nutPills) {
      nutPills.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.nutrient === ctx.nutrient;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
    }
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
    renderScorecard(renderCallouts(ctx));
    renderNaKCard(ctx);
    renderPhaseCompare(ctx);
    renderHeatmap(ctx);
    renderMacroSplit(ctx);
    renderMealSplit(ctx);
    renderDowPattern(ctx);
    renderTopFoods(ctx);
    renderWeightChart(ctx);
    hideTip("#trend-tip");
    hideTip("#weight-tip");
    // Keep an open day card and re-score it for the newly selected nutrient.
    const detail = $("#day-detail");
    const keepDay = detail && detail.dataset.day;
    if (keepDay) {
      renderDayDetail(keepDay, {
        metric: ctx.nutrient,
        settings: ctx.settings,
        goals: typeof Phases !== "undefined"
          ? Phases.goalsForDay(keepDay, ctx.settings)
          : null,
      });
    } else {
      renderDayDetail(null);
    }
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
   * Tap on the intake chart: show a tooltip and, in daily mode, return the day
   * so the caller can open the day detail.
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
    showTip("#trend-tip", "#section-intake .canvas-wrap", x,
      `<span class="tip-day">${esc(p.sub || p.key)}</span>${value}${goal}`);
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
   * @param {string} [opts.root]    DOM id selector (default "#day-detail")
   * @param {object} [opts.goals]   goals for the day (kcal/protein/…); looked up if omitted
   * @param {object} [opts.settings] settings pass-through for goals lookup
   */
  function renderDayDetail(dayKey, opts) {
    const o = opts || {};
    const root = $(o.root || "#day-detail");
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
    const goal = Number(goals[metric]) || 0;
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
    let headLine;
    if (!mineralComplete) {
      const coverageText = Number.isFinite(mineralCoverage)
        ? ` · ${Math.round(mineralCoverage * 100)}% covered`
        : "";
      headLine = `${fmt(value)}${esc(unitSuffix)} known subtotal${coverageText} · incomplete; not compared with the full ${metric === "sodium" ? "limit" : "floor"}`;
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

    const onTodayRoot = (o.root || "#day-detail") === "#today-day-detail";
    const actions = onTodayRoot
      ? `<button type="button" class="btn ghost full" data-action="close-day-contrib">Close</button>`
      : `<button type="button" class="btn ghost full" data-action="goto-day" data-day="${esc(dayKey)}">Open this day</button>`;

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
      body = `<ul class="topfood-list">${rows.map((r) => `
        <li>
          <span class="tf-name">${esc(r.name)}</span>
          <span class="tf-track"><i style="width:${((r.value / max) * 100).toFixed(2)}%"></i></span>
          <span class="tf-v">${fmt(r.value)}${esc(unit)}<span class="muted small"> · ${Math.round(r.pct * 100)}%</span></span>
        </li>`).join("")}</ul>
        <p class="muted small">${footer}</p>`;
    }

    root.innerHTML = `<div class="card-block day-contrib">
      <div class="card-head-row"><b>${esc(label)}</b><span class="muted small">${esc(meta.label)}</span></div>
      <p class="day-contrib-head">${headLine}</p>
      ${body}
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
    const bits = [];
    const push = (label, key, unit) => {
      const r = Number(remaining[key]);
      if (!Number.isFinite(r)) return;
      const g = Number(goals && goals[key]) || 0;
      if (!g && r === 0) return;
      const sign = r > 0 ? "+" : "";
      bits.push(`${label} ${sign}${fmt(r)}${unit}`);
    };
    push("kcal", "kcal", "");
    push("P", "protein", "g");
    push("C", "carbs", "g");
    push("F", "fat", "g");
    {
      const g = Number(goals && goals.fiber) || 0;
      const r = Number(remaining.fiber);
      const actual = Number.isFinite(r) ? g - r : 0;
      if (g > 0) bits.push(`Fiber ${fmt(actual)} / ${fmt(g)} g`);
      else if (Number.isFinite(r) && actual !== 0) bits.push(`Fiber ${fmt(actual)} g`);
    }
    {
      const g = Number(goals && goals.sodium) || 0;
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
   * Plan items list. pending first, then logged.
   * items: [{ id, name, meal, qtyLabel, macros, macrosExtra, status }]
   */
  function renderGapPlanList(items) {
    const root = $("#gap-plan-list");
    if (!root) return;
    if (!items || !items.length) {
      root.innerHTML = `<div class="empty small">No plan items yet. Parse a GAP v1 reply.</div>`;
      return;
    }
    root.innerHTML = items.map((it) => {
      const logged = it.status === "logged";
      const meal = it.meal || "";
      const head = [meal, it.qtyLabel].filter(Boolean).join(" · ");
      const macros = it.macros || "";
      const extra = it.macrosExtra
        ? `<span class="gap-macros-extra"> · ${esc(it.macrosExtra)}</span>`
        : "";
      return `
        <button type="button" class="gap-plan-item${logged ? " logged" : ""}" data-action="log-gap-item" data-id="${esc(it.id)}" ${logged ? "disabled" : ""}>
          <div class="r-name">${esc(it.name)}</div>
          <div class="r-qty">${esc(head)}${macros ? ` · ${esc(macros)}` : ""}${extra}${logged ? " · logged" : ""}</div>
        </button>`;
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
        ? "Today’s plan"
        : step === "prompt"
          ? "AI gap prompt"
          : step === "choose"
            ? "Choose a plan"
            : "Close the gap";
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
    renderDayLog, toggleEntryExpand, renderFoods, renderPicker, fillQtySheet, updateQtyPreview, selectedUnit, selectedMeal, selectedMealIn,
    showPastePrompt, showPromptFallback, showReview, setReviewErrors, filterCategories, readReviewDraft, parseNutrientNumber,
    syncReviewLogAsUI, renderFoodDetail,
    renderInsights, renderTrends, renderWeightTrend,
    onTrendTap, onWeightTap, trendDayAtClientX, weightDayAtClientX,
    renderDayDetail, fillMealChips, setSyncPill, showOnboarding, renderWeightTrendLine, MEALS,
    formatGapRemaining, planProjectionFlags, renderPlanProjection, renderGapPlanStatus,
    titleCaseName, renderGapSelectList, renderGapPlanList, showGapStep, renderGapOptions,
  };
})();
