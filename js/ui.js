/* NutriDaily — DOM rendering for the diary UI. */
const UI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let _focusStack = [];
  let _sheetStack = [];
  let _trendHit = null; // { keys, pad, iw, w }
  let _weightHit = null; // { keys, pad, iw, w, byDay, unit }
  let expandedEntryId = null;
  let expandedDayKey = null;

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
      _sheetStack.push(id);
    }
    el.hidden = false;
    el.setAttribute("role", el.getAttribute("role") || "dialog");
    el.setAttribute("aria-modal", "true");
    requestAnimationFrame(() => {
      el.classList.add("open");
      // Don't autofocus the picker search — it covers the food list with the mobile keyboard
      const skipFocus = (opts && opts.noAutofocus) || id === "sheet-add";
      if (skipFocus) return;
      const focusable = el.querySelector("input:not([type=hidden]), button.btn, textarea, select");
      if (focusable) focusable.focus();
    });
  }
  function closeSheet(id) {
    const el = typeof id === "string" ? $(`#${id}`) : id;
    if (!el) return;
    const sid = el.id;
    const idx = _sheetStack.lastIndexOf(sid);
    // Speculative / duplicate closes must not pop the focus stack
    if (idx < 0) return;
    _sheetStack.splice(idx, 1);
    const shouldRestore = true;
    el.classList.remove("open");
    if (el._hideTimer) clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.hidden = true;
      el._hideTimer = null;
      if (!shouldRestore) return;
      const prev = _focusStack.pop();
      if (prev && typeof prev.focus === "function" && document.contains(prev)) {
        try { prev.focus(); } catch (e) {}
      }
    }, 200);
  }
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
    const phase = goals && goals._phase;
    const goalLabel = (resolved, key, unit) => {
      const g = Number(resolved) || 0;
      if (!g) return "";
      const b = bumps && bumps[key];
      if (b && phase) {
        const base = Number(phase[key]) || 0;
        const sign = b > 0 ? "+" : "";
        return unit
          ? `${fmt(g)} (${fmt(base)}${sign}${fmt(b)}) ${unit}`
          : `${fmt(g)} (${fmt(base)}${sign}${fmt(b)})`;
      }
      return unit ? `${fmt(g)} ${unit}` : `${fmt(g)}`;
    };
    const set = (id, mean, goal, key, unit) => {
      const fill = $(`#f-${id}`), val = $(`#v-${id}`);
      if (!fill || !val) return;
      const g = Number(goal) || 0;
      const pct = g ? Math.min(100, (mean / g) * 100) : 0;
      fill.style.width = pct + "%";
      // HUD warns past the printed goal for ceiling/range. Scoring bands stay in Phases.classify.
      const isOver = Phases.hudBarOver(mean, g, Phases.BANDS[key]);
      fill.classList.toggle("over", isOver);
      val.classList.toggle("over", isOver);
      const right = goalLabel(goal, key, unit);
      if (id === "kcal") val.textContent = g ? `${fmt(mean)} / ${right}` : `${fmt(mean)}`;
      else val.textContent = g ? `${fmt(mean)} / ${right}` : unit ? `${fmt(mean)} ${unit}` : `${fmt(mean)}`;
    };
    $("#v-kcal-big").textContent = fmt(totals.kcal.mean);
    const lo = Math.max(0, Math.round(totals.kcal.mean - totals.kcal.sd));
    const hi = Math.round(totals.kcal.mean + totals.kcal.sd);
    const bumpNote = bumps && bumps.kcal
      ? ` · target ${fmt(goals.kcal)} (${bumps.kcal > 0 ? "+" : ""}${fmt(bumps.kcal)} bump)`
      : "";
    $("#kcal-range").textContent = totals.count ? `likely ${fmt(lo)}–${fmt(hi)}${bumpNote}` : "—";
    set("kcal", totals.kcal.mean, goals.kcal, "kcal", "");
    set("p", totals.p.mean, goals.protein, "protein", "g");
    set("c", totals.c.mean, goals.carbs, "carbs", "g");
    set("f", totals.f.mean, goals.fat, "fat", "g");
    set("fb", totals.fb.mean, goals.fiber, "fiber", "g");
    set("sodium", totals.na.mean, goals.sodium, "sodium", "mg");
    const naLine = $("#v-na");
    if (naLine) naLine.textContent = "";
  }

  const MEALS = ["breakfast", "lunch", "dinner", "snack"];

  function entryTime(e) {
    if (!e.addedTs) return "";
    return new Date(e.addedTs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  /** Portion-scaled P/C/F/Fb/Na for Today cards and qty preview. */
  function fmtMacros(m) {
    if (!m) return "";
    return `P ${m.p} · C ${m.c} · F ${m.f} · Fb ${m.fb} · Na ${fmt(m.na || 0)}`;
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
                <span class="mini">P ${e.macros.p}</span>
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
      if (u === "batch" && food.batch) label = `batch (${food.batch.grams} g)`;
      return `<button type="button" class="uchip${u === unit ? " active" : ""}" data-unit="${u}">${esc(label)}</button>`;
    }).join("");
    const meal = (prefill && prefill.meal) || Foods.inferMeal();
    $("#qty-meals").innerHTML = MEALS.map((m) =>
      `<button type="button" class="uchip${m === meal ? " active" : ""}" data-meal="${m}">${m}</button>`
    ).join("");
    $("#qty-input").value = prefill && prefill.qty != null ? prefill.qty : hist.qty;
    fillQtySheet._imperial = !!imperial;
    updateQtyPreview(food);
    const removeBtn = $("#qty-remove");
    if (removeBtn) removeBtn.hidden = !(prefill && prefill.allowRemove);
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
    $("#rev-na").value = f.per100.na;
    $("#rev-batch-g").value = (f.batch && f.batch.grams) || "";
    $("#rev-batch-s").value = (f.batch && f.batch.servings) || "";
    const logAs = f.logAs === "piece" || (f.units && f.units.piece && f.logAs !== "grams") ? "piece" : "grams";
    const logRoot = $("#rev-log-as");
    if (logRoot) {
      logRoot.innerHTML = ["grams", "piece"].map((u) =>
        `<button type="button" class="uchip${u === logAs ? " active" : ""}" data-log-as="${u}">${u === "piece" ? "by count" : "by grams"}</button>`
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
      ["#rev-name", "#rev-kcal", "#rev-p", "#rev-c", "#rev-f"].forEach((sel) => {
        const n = $(sel); if (n) n.classList.remove("field-bad");
      });
      return;
    }
    el.hidden = false;
    el.textContent = reasons.join(" ");
    const draft = readReviewDraft();
    const mark = (sel, bad) => { const n = $(sel); if (n) n.classList.toggle("field-bad", !!bad); };
    mark("#rev-name", !draft.name);
    mark("#rev-kcal", draft.per100.kcal < 0 || draft.per100.kcal > 920);
    mark("#rev-p", draft.per100.p + draft.per100.c + draft.per100.f > 105);
    mark("#rev-c", draft.per100.p + draft.per100.c + draft.per100.f > 105);
    mark("#rev-f", draft.per100.p + draft.per100.c + draft.per100.f > 105);
  }

  function readReviewDraft(base) {
    const num = (id) => {
      const n = Number($(id).value);
      return Number.isFinite(n) ? n : 0;
    };
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
      per100: { kcal: num("#rev-kcal"), p: num("#rev-p"), c: num("#rev-c"), f: num("#rev-f"), fb: num("#rev-fb"), na: num("#rev-na") },
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
    const repairG = pieceG || (serv && +serv > 0 ? +serv : null)
      || (food.batch && food.batch.grams && food.batch.servings
        ? Math.round(food.batch.grams / food.batch.servings) : null);
    const showCountRepair = repairG && food.logAs !== "piece";
    const countRepair = showCountRepair
      ? `<button type="button" class="btn ghost full" data-action="enable-count-log" data-id="${esc(food.id)}" data-grams="${Math.round(repairG)}">Log by count (1 ${esc(noun)} = ${Math.round(repairG)} g)</button>`
      : "";
    const batch = food.batch && food.batch.grams
      ? `<div class="card-block"><b>Batch</b>: ${fmt(food.batch.grams)} g · ${food.batch.servings || 1} servings
          <button type="button" class="btn ghost full" style="margin-top:8px" data-action="scale-batch" data-id="${esc(food.id)}">Scale batch</button>
        </div>`
      : `<div class="card-block"><button type="button" class="btn ghost full" data-action="scale-batch" data-id="${esc(food.id)}">Set / scale batch</button></div>`;
    const logBtn = mode === "log"
      ? `<button type="button" class="btn full" data-action="log-this" data-id="${esc(food.id)}">Log this</button>`
      : `<button type="button" class="btn ghost full" data-action="log-this" data-id="${esc(food.id)}">Log this</button>`;
    const libraryPrimary = mode === "library"
      ? `<button type="button" class="btn full" data-action="edit-food" data-id="${esc(food.id)}">Edit food</button>
        <button type="button" class="btn ghost full" data-action="share-food" data-id="${esc(food.id)}">Share food</button>`
      : `<button type="button" class="btn ghost full" data-action="share-food" data-id="${esc(food.id)}">Share food</button>
        <button type="button" class="btn ghost full" data-action="edit-food" data-id="${esc(food.id)}">Edit food</button>`;
    const logHint = food.logAs === "piece" && pieceG
      ? `<div class="muted small" style="margin-top:6px">Logs by count: 1 ${esc(noun)} = ${Math.round(pieceG)} g${mPiece ? ` · ${fmt(mPiece.kcal)} kcal` : ""}</div>`
      : `<div class="muted small" style="margin-top:6px">Logs by weight (grams)</div>`;
    $("#detail-body").innerHTML = `
      <h3>${esc(food.name)}</h3>
      <p class="muted small">${esc(prov.label)}${prov.detail ? " · " + esc(prov.detail) : ""}</p>
      <p class="muted small">Logged ${food.useCount || 0} times${food.lastUsedAt ? " · last " + new Date(food.lastUsedAt).toLocaleDateString() : ""} · v${food.version || 1}</p>
      <div class="card-block">
        <div><b>Per 100 g</b>: ${fmt(food.per100.kcal)} kcal · P ${food.per100.p} · C ${food.per100.c} · F ${food.per100.f} · Fb ${food.per100.fb} · Na ${food.per100.na}</div>
        ${logHint}
        ${mServ ? `<div class="muted small" style="margin-top:6px">Optional serving (${serv} g): ${fmt(mServ.kcal)} kcal · P ${mServ.p}</div>` : ""}
      </div>
      ${batch}
      ${ings ? `<div class="card-block"><b>Ingredients</b><ul class="ing-list">${ings}</ul>${food.recipe.prep ? `<p class="small">${esc(food.recipe.prep)}</p>` : ""}</div>` : ""}
      <div class="col-actions">
        ${mode === "log" ? logBtn : ""}
        ${libraryPrimary}
        ${mode === "library" ? logBtn : ""}
        ${countRepair}
        <button type="button" class="btn ghost full" data-action="update-food" data-id="${esc(food.id)}">${prov.kind === "ref" ? "Refine with AI paste" : "Update from AI paste"}</button>
        <button type="button" class="btn ghost full" data-action="copy-update-prompt" data-id="${esc(food.id)}">${prov.kind === "ref" ? "Copy refine prompt" : "Copy update prompt"}</button>
        ${typeof navigator.share === "function" ? `<button type="button" class="btn ghost full" data-action="share-update-prompt" data-id="${esc(food.id)}">Share to AI</button>` : ""}
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

  /**
   * @param {object} opts
   * @param {number|string} opts.daysBack — number of days, or "phase"
   * @param {string} opts.nutrient — kcal|protein|carbs|fat|fiber|sodium
   * @param {string|null} opts.phaseId — selected phase for "phase" range
   * @param {object} opts.settings
   * @param {string} opts.todayKey
   * @param {(day:string)=>object} opts.goalsForDay
   */
  function renderTrends(opts) {
    const canvas = $("#trend-canvas");
    if (!canvas) return;
    const settings = (opts && opts.settings) || {};
    const todayKey = (opts && opts.todayKey) || Ledger.todayKey();
    const nutrient = (opts && opts.nutrient) || "kcal";
    const phaseId = opts && opts.phaseId;
    const goalsForDay = (opts && opts.goalsForDay) || ((day) =>
      (typeof Phases !== "undefined" ? Phases.goalsForDay(day, settings) : (settings.goals || {})));
    const end = new Date(todayKey + "T12:00:00");
    let keys = [];
    const daysBack = opts && opts.daysBack;
    let selectedPhase = null;
    if (daysBack === "phase" && typeof Phases !== "undefined") {
      selectedPhase = Phases.phaseById(settings.phases, phaseId) || Phases.activePhase(settings.phases);
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

    const nutKey = {
      kcal: { total: (t) => t.kcal.mean, goal: (g) => g.kcal, unit: "kcal", label: "kcal", overMul: 1.10, underMul: 0.90 },
      protein: { total: (t) => t.p.mean, goal: (g) => g.protein, unit: "g", label: "protein", overMul: 1.20, underMul: 0.95 },
      carbs: { total: (t) => t.c.mean, goal: (g) => g.carbs, unit: "g", label: "carbs", overMul: 1.15, underMul: 0.85 },
      fat: { total: (t) => t.f.mean, goal: (g) => g.fat, unit: "g", label: "fat", overMul: 1.15, underMul: 0.85 },
      fiber: { total: (t) => t.fb.mean, goal: (g) => g.fiber, unit: "g", label: "fiber", overMul: 1.30, underMul: 0.90 },
      sodium: { total: (t) => t.na.mean, goal: (g) => g.sodium, unit: "mg", label: "sodium", overMul: 1.05, underMul: 0 },
    }[nutrient] || {
      total: (t) => t.kcal.mean, goal: (g) => g.kcal, unit: "kcal", label: "kcal", overMul: 1.10, underMul: 0.90,
    };

    const totalsMap = {};
    keys.forEach((day) => { totalsMap[day] = Ledger.totalsFor(day); });
    const points = keys.map((day) => {
      const t = totalsMap[day];
      const g = goalsForDay(day);
      return {
        day,
        value: t.count ? nutKey.total(t) : null,
        kcal: t.count ? t.kcal.mean : null,
        p: t.count ? t.p.mean : null,
        c: t.count ? t.c.mean : null,
        f: t.count ? t.f.mean : null,
        fb: t.count ? t.fb.mean : null,
        na: t.count ? t.na.mean : null,
        count: t.count,
        goal: nutKey.goal(g),
      };
    });
    const logged = points.filter((p) => p.count);

    const ctxHeader = $("#phase-context");
    const backBtn = $("#btn-phase-current");
    if (ctxHeader && typeof Phases !== "undefined") {
      const ctxPhase = daysBack === "phase" ? selectedPhase : Phases.activePhase(settings.phases);
      ctxHeader.textContent = Phases.phaseContext(settings, todayKey, ctxPhase);
    }
    if (backBtn) {
      const viewingPast = daysBack === "phase" && selectedPhase && selectedPhase.endDay != null;
      backBtn.hidden = !viewingPast;
    }

    // Phase history list (hidden until 2+ phases)
    const histRoot = $("#phase-history");
    const histList = $("#phase-history-list");
    const histSum = $("#phase-history-summary");
    if (histRoot && histList && typeof Phases !== "undefined") {
      const rows = Phases.phaseHistoryRows(settings, todayKey, (day) => Ledger.totalsFor(day));
      if (rows.length < 2) {
        histRoot.hidden = true;
      } else {
        histRoot.hidden = false;
        if (histSum) histSum.textContent = `Phase history (${rows.length})`;
        const selId = daysBack === "phase" && selectedPhase
          ? selectedPhase.id
          : (Phases.activePhase(settings.phases) || {}).id;
        histList.innerHTML = rows.map((r) => {
          const logs = r.logged
            ? `${r.logged}/${r.days} logged`
            : (r.days ? "no logs" : "0 d");
          const bits = [r.rangeLabel, `${r.days} d`, logs];
          if (r.kcalLabel) bits.push(r.kcalLabel);
          if (r.weightLabel) bits.push(r.weightLabel);
          const activeCls = r.id === selId ? " active" : "";
          const chip = r.active ? '<span class="phase-chip">Active</span>' : "";
          return `<button type="button" class="phase-hist-row${activeCls}" data-phase-id="${esc(r.id)}">
            <span class="phase-hist-title">${esc(r.name)} · ${esc(r.kindLabel)} ${chip}</span>
            <span class="muted small">${esc(bits.join(" · "))}</span>
          </button>`;
        }).join("");
      }
    }

    const nutPills = $("#insight-nutrient");
    if (nutPills) {
      nutPills.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("active", b.dataset.nutrient === nutrient)
      );
    }

    const w = canvas.clientWidth || 320;
    const h = 168;
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(2, 2);
    ctx.clearRect(0, 0, w, h);
    const maxV = Math.max(
      ...points.map((p) => p.goal || 0),
      ...logged.map((p) => p.value),
      1
    ) * 1.15;
    const pad = { l: 8, r: 8, t: 12, b: 28 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const barW = Math.max(2, iw / keys.length - 2);

    // Step goal line (per-day targets for selected nutrient)
    ctx.strokeStyle = "rgba(61,153,112,0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x0 = pad.l + i * (iw / keys.length);
      const x1 = pad.l + (i + 1) * (iw / keys.length);
      const gy = pad.t + ih * (1 - (p.goal || 0) / maxV);
      if (i === 0) ctx.moveTo(x0, gy);
      else ctx.lineTo(x0, gy);
      ctx.lineTo(x1, gy);
    });
    ctx.stroke();
    ctx.lineWidth = 1;

    // Phase start markers
    if (typeof Phases !== "undefined" && Array.isArray(settings.phases)) {
      ctx.strokeStyle = "rgba(80,100,90,0.35)";
      ctx.setLineDash([3, 3]);
      for (const ph of settings.phases) {
        const idx = keys.indexOf(ph.startDay);
        if (idx < 0) continue;
        const x = pad.l + idx * (iw / keys.length);
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + ih);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    points.forEach((p, i) => {
      if (p.value == null) return;
      const x = pad.l + (i + 0.15) * (iw / keys.length);
      const bh = (p.value / maxV) * ih;
      const over = p.goal && p.value > p.goal * nutKey.overMul;
      const under = nutKey.underMul > 0 && p.goal && p.value < p.goal * nutKey.underMul;
      ctx.fillStyle = over ? "#d0703c" : under ? "#6a8f7a" : "#3d9970";
      ctx.fillRect(x, pad.t + ih - bh, barW, bh);
    });

    ctx.fillStyle = "rgba(100,100,100,0.85)";
    ctx.font = "10px system-ui,sans-serif";
    ctx.textAlign = "center";
    // Fit labels to chart width so 14/30/90d never collide (MM-DD ≈ 34px)
    const labelW = 34;
    const maxLabels = Math.max(2, Math.min(keys.length, Math.floor(iw / labelW)));
    const labelIdx = [];
    if (keys.length <= maxLabels) {
      for (let i = 0; i < keys.length; i++) labelIdx.push(i);
    } else {
      for (let k = 0; k < maxLabels; k++) {
        labelIdx.push(Math.round((k * (keys.length - 1)) / (maxLabels - 1)));
      }
    }
    const seen = new Set();
    let lastX = -Infinity;
    labelIdx.forEach((i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const x = pad.l + (i + 0.5) * (iw / keys.length);
      if (x - lastX < labelW * 0.9) return; // skip if still too close
      lastX = x;
      ctx.fillText(keys[i].slice(5), x, h - 8);
    });
    ctx.textAlign = "start";
    _trendHit = { keys, pad, iw, w };

    const avg = (key) => logged.length ? logged.reduce((s, p) => s + p[key], 0) / logged.length : 0;
    const avgSel = logged.length ? logged.reduce((s, p) => s + p.value, 0) / logged.length : 0;
    const weekKeys = keys.slice(-7);
    const weekLogged = weekKeys.map((d) => totalsMap[d]).filter((t) => t && t.count);
    const weekAvg = weekLogged.length
      ? Math.round(weekLogged.reduce((s, t) => s + nutKey.total(t), 0) / weekLogged.length)
      : 0;
    const viewingPastPhase = daysBack === "phase" && selectedPhase && selectedPhase.endDay != null;
    const streak = streakEndingToday();
    const rangeLabel = daysBack === "phase" && selectedPhase
      ? selectedPhase.name
      : `${keys.length} days`;
    const unitSuffix = nutKey.unit === "kcal" ? " kcal" : ` ${nutKey.unit}`;
    const streakBit = viewingPastPhase ? "" : ` · streak ${streak}d`;
    $("#trend-summary").textContent = logged.length
      ? `${logged.length} of ${keys.length} days logged (${rangeLabel}) · avg ${fmt(avgSel)}${unitSuffix} ${nutKey.label} · P ${fmt(avg("p"))} · C ${fmt(avg("c"))} · F ${fmt(avg("f"))} · 7d ${fmt(weekAvg)}${unitSuffix}${streakBit}`
      : "No logged days in this range yet.";

    // Scorecard + callouts
    const scoreRoot = $("#insight-scorecard");
    const callRoot = $("#insight-callouts");
    if (scoreRoot && typeof Phases !== "undefined") {
      const excludeToday = viewingPastPhase
        ? null
        : (!totalsMap[todayKey] || !totalsMap[todayKey].count ? todayKey : null);
      const scorecard = Phases.scoreRange(
        keys,
        (day) => totalsMap[day],
        settings,
        { excludeDay: excludeToday }
      );
      const unit = (k) => (k === "kcal" ? "" : k === "sodium" ? " mg" : " g");
      scoreRoot.innerHTML = scorecard.logged
        ? `<b>Target scorecard</b><ul class="score-list">${scorecard.nutrients.map((n) => {
            const avg = n.n ? `${n.avgDelta >= 0 ? "+" : ""}${fmt(n.avgDelta)}${unit(n.key)}` : "—";
            return `<li><span class="score-name">${esc(n.label)}</span>
              <span class="score-counts">${n.hit} hit · ${n.under} under · ${n.over} over</span>
              <span class="muted small">avg ${avg}</span></li>`;
          }).join("")}</ul>`
        : `<span class="muted">Target hit rates appear after a few logged days.</span>`;

      const calls = Phases.callouts(scorecard);
      const bal = Phases.kcalBalance(keys, (day) => totalsMap[day], settings);
      const wDelta = keys.length
        ? Phases.weightDelta(settings, keys[0], keys[keys.length - 1])
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
        const wu = (settings.weightUnit === "kg") ? "kg" : "lb";
        const f = wu === "kg" ? wDelta.first : wDelta.first / 0.45359237;
        const l = wu === "kg" ? wDelta.last : wDelta.last / 0.45359237;
        const d = wu === "kg" ? wDelta.delta : wDelta.delta / 0.45359237;
        bits.push(`<p class="muted small">Weight: ${f.toFixed(1)} → ${l.toFixed(1)} ${wu} (${sign}${d.toFixed(1)} ${wu}, ${wDelta.n} weigh-ins).</p>`);
      }
      if (callRoot) callRoot.innerHTML = bits.join("") || "";
    }

    renderDayDetail(null);

    const contrib = new Map();
    for (const day of keys) {
      for (const e of Ledger.entriesFor(day)) {
        const cur = contrib.get(e.name) || 0;
        contrib.set(e.name, cur + (e.macros.kcal || 0));
      }
    }
    const top = [...contrib.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const totalTop = top.reduce((s, [, k]) => s + k, 0) || 1;
    $("#top-foods").innerHTML = top.length
      ? `<b>Top foods</b> (kcal share)<ul class="ing-list">${top.map(([n, k]) =>
          `<li>${esc(n)} — ${fmt(k)} kcal (${Math.round((k / totalTop) * 100)}%)</li>`
        ).join("")}</ul>`
      : `<span class="muted">Top foods will appear as you log.</span>`;
  }

  function insightRangeKeys(opts) {
    const settings = (opts && opts.settings) || {};
    const todayKey = (opts && opts.todayKey) || Ledger.todayKey();
    const phaseId = opts && opts.phaseId;
    const daysBack = opts && opts.daysBack;
    const end = new Date(todayKey + "T12:00:00");
    let keys = [];
    let selectedPhase = null;
    if (daysBack === "phase" && typeof Phases !== "undefined") {
      selectedPhase = Phases.phaseById(settings.phases, phaseId) || Phases.activePhase(settings.phases);
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

  function renderWeightTrend(opts) {
    const canvas = $("#weight-canvas");
    const summary = $("#weight-summary");
    if (!canvas || !summary) return;
    if (typeof Phases === "undefined") {
      summary.textContent = "";
      return;
    }
    const { keys, selectedPhase, daysBack, settings } = insightRangeKeys(opts);
    const unit = settings.weightUnit === "kg" ? "kg" : "lb";
    const toDisplay = (kg) => (unit === "kg" ? kg : kg / 0.45359237);

    const byDay = {};
    const series = keys.map((day) => {
      const kg = Phases.weightForDay(settings, day);
      const value = kg == null ? null : toDisplay(kg);
      if (value != null) byDay[day] = value;
      return { day, value };
    });
    const logged = series.filter((p) => p.value != null);

    const w = canvas.clientWidth || 320;
    const h = 150;
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(2, 2);
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 28, r: 10, t: 12, b: 28 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    _weightHit = { keys, pad, iw, w, byDay, unit };

    if (logged.length < 2) {
      summary.textContent = logged.length === 1
        ? `One weigh-in in range (${logged[0].value.toFixed(1)} ${unit}). Log another day to see a trend.`
        : "Log weight on Today (2+ days in this range) to see a trend.";
      ctx.fillStyle = "rgba(100,100,100,0.7)";
      ctx.font = "12px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Need 2+ weigh-ins", w / 2, h / 2);
      ctx.textAlign = "start";
      return;
    }

    let minV = Math.min(...logged.map((p) => p.value));
    let maxV = Math.max(...logged.map((p) => p.value));
    if (maxV - minV < 1) {
      minV -= 1;
      maxV += 1;
    }
    const padY = (maxV - minV) * 0.12;
    minV -= padY;
    maxV += padY;
    const yAt = (v) => pad.t + ih * (1 - (v - minV) / (maxV - minV));
    const xAt = (i) => pad.l + (i + 0.5) * (iw / keys.length);

    // Y-axis ticks
    ctx.fillStyle = "rgba(100,100,100,0.85)";
    ctx.font = "10px system-ui,sans-serif";
    ctx.textAlign = "right";
    const ticks = 3;
    for (let t = 0; t < ticks; t++) {
      const v = minV + ((maxV - minV) * t) / (ticks - 1);
      const y = yAt(v);
      ctx.strokeStyle = "rgba(120,120,120,0.15)";
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + iw, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(0), pad.l - 4, y + 3);
    }
    ctx.textAlign = "start";

    // Line through weigh-ins in calendar order
    ctx.strokeStyle = "#d0703c";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    series.forEach((p, i) => {
      if (p.value == null) return;
      const x = xAt(i);
      const y = yAt(p.value);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineWidth = 1;

    // Hollow dots
    const cardFill = getComputedStyle(document.documentElement).getPropertyValue("--card").trim() || "#fff";
    series.forEach((p, i) => {
      if (p.value == null) return;
      const x = xAt(i);
      const y = yAt(p.value);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = cardFill;
      ctx.fill();
      ctx.strokeStyle = "#d0703c";
      ctx.stroke();
    });

    // X labels (same spacing heuristic as nutrition chart)
    ctx.fillStyle = "rgba(100,100,100,0.85)";
    ctx.font = "10px system-ui,sans-serif";
    ctx.textAlign = "center";
    const labelW = 34;
    const maxLabels = Math.max(2, Math.min(keys.length, Math.floor(iw / labelW)));
    const labelIdx = [];
    if (keys.length <= maxLabels) {
      for (let i = 0; i < keys.length; i++) labelIdx.push(i);
    } else {
      for (let k = 0; k < maxLabels; k++) {
        labelIdx.push(Math.round((k * (keys.length - 1)) / (maxLabels - 1)));
      }
    }
    const seen = new Set();
    let lastX = -Infinity;
    labelIdx.forEach((i) => {
      if (seen.has(i)) return;
      seen.add(i);
      const x = xAt(i);
      if (x - lastX < labelW * 0.9) return;
      lastX = x;
      ctx.fillText(keys[i].slice(5), x, h - 8);
    });
    ctx.textAlign = "start";

    const first = logged[0];
    const last = logged[logged.length - 1];
    const delta = last.value - first.value;
    const sign = delta >= 0 ? "+" : "";
    const rangeLabel = daysBack === "phase" && selectedPhase
      ? selectedPhase.name
      : `${keys.length} days`;
    summary.textContent =
      `${logged.length} weigh-ins (${rangeLabel}) · ${first.value.toFixed(1)} → ${last.value.toFixed(1)} ${unit} (${sign}${delta.toFixed(1)} ${unit}). Tap a point for the day.`;
  }

  function trendDayAtClientX(clientX) {
    if (!_trendHit) return null;
    const canvas = $("#trend-canvas");
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { keys, pad, iw } = _trendHit;
    if (x < pad.l || x > pad.l + iw) return null;
    const i = Math.min(keys.length - 1, Math.max(0, Math.floor(((x - pad.l) / iw) * keys.length)));
    return keys[i];
  }

  /** Nearest day with a weigh-in near the tap; null if none close. */
  function weightDayAtClientX(clientX) {
    if (!_weightHit) return null;
    const canvas = $("#weight-canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const { keys, pad, iw, byDay, unit } = _weightHit;
    if (x < pad.l || x > pad.l + iw || !keys.length) return null;
    const i = Math.min(keys.length - 1, Math.max(0, Math.floor(((x - pad.l) / iw) * keys.length)));
    // Prefer exact day, else nearest weigh-in within ~1.5 day slots
    if (byDay[keys[i]] != null) return { day: keys[i], value: byDay[keys[i]], unit };
    let best = null;
    let bestDist = Infinity;
    for (let j = 0; j < keys.length; j++) {
      if (byDay[keys[j]] == null) continue;
      const dist = Math.abs(j - i);
      if (dist < bestDist) { bestDist = dist; best = keys[j]; }
    }
    if (best == null || bestDist > 2) return null;
    return { day: best, value: byDay[best], unit };
  }

  function renderDayDetail(dayKey) {
    const root = $("#day-detail");
    if (!root) return;
    if (!dayKey) { root.innerHTML = ""; return; }
    const entries = Ledger.entriesFor(dayKey);
    const t = Ledger.totalsFor(dayKey);
    const d = new Date(dayKey + "T12:00:00");
    const label = d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    if (!entries.length) {
      root.innerHTML = `<div class="card-block"><b>${esc(label)}</b><p class="muted small">No entries.</p></div>`;
      return;
    }
    root.innerHTML = `<div class="card-block">
      <b>${esc(label)}</b> · ${fmt(t.kcal.mean)} kcal · P ${fmt(t.p.mean)} · C ${fmt(t.c.mean)} · F ${fmt(t.f.mean)} · Fb ${fmt(t.fb.mean)} · Na ${fmt(t.na.mean)}
      <ul class="ing-list">${entries.map((e) =>
        `<li>${esc(e.name)} · ${esc(e.displayQty)} · ${fmt(e.macros.kcal)} kcal · P ${fmt(e.macros.p)}</li>`
      ).join("")}</ul>
      <button type="button" class="btn ghost full" data-action="goto-day" data-day="${esc(dayKey)}">Open this day</button>
    </div>`;
  }

  function fillMealChips(rootId, meal) {
    const root = $(rootId);
    if (!root) return;
    const m0 = meal || Foods.inferMeal();
    root.innerHTML = MEALS.map((m) =>
      `<button type="button" class="uchip${m === m0 ? " active" : ""}" data-meal="${m}">${m}</button>`
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

  function showOnboarding(show) {
    $("#onboarding").hidden = !show;
  }

  /** Remaining blurb for gap sheet / Today. Fiber = report only; sodium = ceiling headroom. */
  function formatGapRemaining(remaining, goals) {
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
      if (g > 0) {
        if (Number.isFinite(r) && r < 0) bits.push(`Na over ${fmt(Math.abs(r))} mg`);
        else bits.push(`Na room +${fmt(Number.isFinite(r) ? r : g)} mg`);
      } else if (Number.isFinite(r) && r !== 0) {
        bits.push(`Na ${fmt(Math.abs(r))} mg`);
      }
    }
    return bits.length ? `Gap: ${bits.join(" · ")}` : "Targets already met (or no goals set).";
  }

  /** Live end-of-day projection line for the plan sheet. */
  function formatPlanProjection(projected, goals, opts) {
    if (!projected) return "";
    const o = opts || {};
    const pair = (label, key, unit) => {
      const v = Number(projected[key]);
      if (!Number.isFinite(v)) return "";
      const g = Number(goals && goals[key]) || 0;
      const head = label ? `${label} ` : "";
      return g ? `${head}${fmt(v)} / ${fmt(g)}${unit}` : `${head}${fmt(v)}${unit}`;
    };
    const bits = [
      `~${pair("", "kcal", "")} kcal`,
      pair("P", "protein", ""),
      pair("C", "carbs", ""),
      pair("F", "fat", ""),
      pair("Fb", "fiber", ""),
      pair("Na", "sodium", ""),
    ].filter(Boolean);
    const flags = [];
    const pFloor = Number(goals && goals.protein) || 0;
    const naCap = Number(goals && goals.sodium) || 0;
    if (pFloor && Phases.classify(projected.protein, pFloor, Phases.BANDS.protein) === "under") flags.push("P short");
    if (naCap && Phases.classify(projected.sodium, naCap, Phases.BANDS.sodium) === "over") flags.push("Na over");
    if (o.unresolved > 0) flags.push(`${o.unresolved} food not in library`);
    const lead = o.source === "ai" ? "AI projected end of day" : "With remaining plan";
    return `${lead} → ${bits.join(" · ")}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  }

  /**
   * Multi-select food list for gap plan.
   * rows: [{ key, name, sub, selected }] — selected rows are expected first.
   * opts.queryActive: true when a search string is present (show empty results under selected).
   */
  function renderGapSelectList(rows, opts) {
    const root = $("#gap-select-list");
    if (!root) return;
    const queryActive = !!(opts && opts.queryActive);
    if (!rows || !rows.length) {
      root.innerHTML = `<div class="empty small">No foods match. Add foods to My Foods or search the catalog.</div>`;
      return;
    }
    const rowHtml = (r) => `
      <button type="button" class="gap-select-row${r.selected ? " selected" : ""}" data-action="gap-toggle" data-key="${esc(r.key)}">
        <input type="checkbox" tabindex="-1" ${r.selected ? "checked" : ""} aria-hidden="true">
        <div class="gap-meta">
          <div class="r-name">${esc(r.name)}</div>
          <div class="r-qty">${esc(r.sub || "")}</div>
        </div>
      </button>`;
    const selected = rows.filter((r) => r.selected);
    const rest = rows.filter((r) => !r.selected);
    let html = "";
    if (selected.length) {
      html += `<div class="meal-label">Selected (${selected.length})</div>`;
      html += selected.map(rowHtml).join("");
    }
    if (rest.length) {
      if (selected.length) html += `<div class="meal-label">Foods</div>`;
      html += rest.map(rowHtml).join("");
    } else if (selected.length && queryActive) {
      html += `<div class="empty small">No foods match. Try a different search.</div>`;
    }
    root.innerHTML = html;
  }

  /**
   * Plan items list. pending first, then logged.
   * items: [{ id, name, qtyLabel, sub, status }]
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
      return `
        <button type="button" class="gap-plan-item${logged ? " logged" : ""}" data-action="log-gap-item" data-id="${esc(it.id)}" ${logged ? "disabled" : ""}>
          <div class="r-name">${esc(it.name)}</div>
          <div class="r-qty">${esc(it.qtyLabel || "")}${it.sub ? ` · ${esc(it.sub)}` : ""}${logged ? " · logged" : ""}</div>
        </button>`;
    }).join("");
  }

  function showGapStep(step) {
    const select = $("#gap-step-select");
    const prompt = $("#gap-step-prompt");
    const choose = $("#gap-step-choose");
    const plan = $("#gap-step-plan");
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
  }

  /**
   * options: [{ index, label, reachable, note, summary, itemLines }]
   */
  function renderGapOptions(options) {
    const root = $("#gap-option-list");
    if (!root) return;
    if (!options || !options.length) {
      root.innerHTML = `<div class="empty small">No options parsed.</div>`;
      return;
    }
    root.innerHTML = options.map((o, i) => {
      const reach = o.reachable === false
        ? `<span class="muted small">Misses protein or exceeds sodium — see note</span>`
        : `<span class="muted small">Protein + sodium OK</span>`;
      const items = (o.itemLines || []).map((l) => `<li>${esc(l)}</li>`).join("");
      return `
        <div class="phase-option">
          <h4>${esc(o.label || `Option ${o.index || i + 1}`)}</h4>
          ${reach}
          <p class="muted small">${esc(o.summary || "")}</p>
          ${o.note ? `<p class="small">${esc(o.note)}</p>` : ""}
          ${items ? `<ul class="ing-list">${items}</ul>` : ""}
          <button type="button" class="btn full ai-apply-opt" data-action="apply-gap-option" data-opt="${i}">Use this plan</button>
        </div>`;
    }).join("");
  }

  return {
    $, $$, fmt, esc, toast, openSheet, closeSheet, closeAllSheets, topSheetId, setDayLabel, updateHUD,
    renderDayLog, toggleEntryExpand, renderFoods, renderPicker, fillQtySheet, updateQtyPreview, selectedUnit, selectedMeal, selectedMealIn,
    showPastePrompt, showPromptFallback, showReview, setReviewErrors, filterCategories, readReviewDraft,
    syncReviewLogAsUI, renderFoodDetail, renderTrends, renderWeightTrend, trendDayAtClientX, weightDayAtClientX, renderDayDetail, fillMealChips, setSyncPill, showOnboarding, MEALS,
    formatGapRemaining, formatPlanProjection, renderGapSelectList, renderGapPlanList, showGapStep, renderGapOptions,
  };
})();
