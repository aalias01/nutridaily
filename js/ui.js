/* NutriDaily — DOM rendering for the diary UI. */
const UI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let _focusStack = [];
  let _sheetStack = [];
  let _trendHit = null; // { keys, pad, iw, w }

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
      fill.classList.toggle("over", g && mean > g * 1.05);
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
    {
      const fill = $("#f-sodium"), val = $("#v-sodium");
      const mean = totals.na.mean, g = Number(goals.sodium) || 0;
      if (fill && val) {
        fill.style.width = (g ? Math.min(100, (mean / g) * 100) : 0) + "%";
        fill.classList.toggle("over", g && mean > g * 1.05);
        const right = goalLabel(goals.sodium, "sodium", "mg");
        val.textContent = g ? `${fmt(mean)} / ${right}` : `${fmt(mean)} mg`;
      }
    }
    const naLine = $("#v-na");
    if (naLine) naLine.textContent = "";
  }

  const MEALS = ["breakfast", "lunch", "dinner", "snack"];

  function entryTime(e) {
    if (!e.addedTs) return "";
    return new Date(e.addedTs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function renderDayLog(dayKey, entries) {
    const root = $("#day-log");
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
        const edited = e.history && e.history.length ? `<span class="tag tag-edit">edited</span>` : "";
        const t = entryTime(e);
        return `<div class="log-row-wrap">
          <button type="button" class="log-row" data-action="edit-entry" data-id="${esc(e.id)}">
            <div>
              <div class="r-name">${esc(e.name)} ${edited}</div>
              <div class="r-qty">${esc(e.displayQty)}${t ? ` · ${esc(t)}` : ""}</div>
            </div>
            <div class="r-macros">
              <span class="mini">${fmt(e.macros.kcal)} kcal</span>
              <span class="mini">P ${e.macros.p}</span>
            </div>
          </button>
          <button type="button" class="linkbtn again-btn" data-action="log-again" data-id="${esc(e.id)}" title="Log again">again</button>
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
      const serv = f.units && f.units.serving;
      const m = serv ? FoodMatch.computeMacros(f.per100, serv) : f.per100;
      const sub = serv
        ? `per serving (${serv} g): ${fmt(m.kcal)} kcal · P ${m.p}`
        : `per 100 g: ${fmt(f.per100.kcal)} kcal · P ${f.per100.p}`;
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
        html += `<p class="muted small pick-hint">Banana, eggs, rice, and more from the reference catalog (USDA-style averages). Search above, or paste a homemade dish below.</p>`;
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

  function fillQtySheet(food, imperial, prefill) {
    $("#qty-name").textContent = food.name;
    $("#qty-per100").textContent = `per 100 g: ${fmt(food.per100.kcal)} kcal · P ${food.per100.p} · C ${food.per100.c} · F ${food.per100.f}`;
    const prov = Foods.provenance(food);
    const src = $("#qty-source");
    if (src) {
      src.textContent = prov.label;
      src.title = prov.detail || "";
    }
    const units = ["g"];
    if (food.units && food.units.serving) units.push("serving");
    if (food.units && food.units.piece) units.push("piece");
    if (food.batch && food.batch.grams) units.push("batch");
    if (imperial) units.push("oz");
    let unit = (prefill && prefill.unit) || "g";
    // Keep prefilled unit visible even if food lost that measure (orphan / imperial off)
    if (unit && unit !== "kcal" && !units.includes(unit)) units.push(unit);
    if (unit === "kcal") unit = "g";
    $("#qty-units").innerHTML = units.map((u) => {
      let label = u;
      if (u === "serving" && food.units.serving) label = `serving (${food.units.serving} g)`;
      if (u === "piece" && food.units.piece) label = `piece (${food.units.piece} g)`;
      if (u === "batch" && food.batch) label = `batch (${food.batch.grams} g)`;
      return `<button type="button" class="uchip${u === unit ? " active" : ""}" data-unit="${u}">${esc(label)}</button>`;
    }).join("");
    const meal = (prefill && prefill.meal) || Foods.inferMeal();
    $("#qty-meals").innerHTML = MEALS.map((m) =>
      `<button type="button" class="uchip${m === meal ? " active" : ""}" data-meal="${m}">${m}</button>`
    ).join("");
    $("#qty-input").value = prefill && prefill.qty != null ? prefill.qty : (food.units && food.units.serving ? food.units.serving : 100);
    fillQtySheet._imperial = !!imperial;
    updateQtyPreview(food);
    const removeBtn = $("#qty-remove");
    if (removeBtn) removeBtn.hidden = !(prefill && prefill.allowRemove);
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
    $("#qty-preview").textContent = `${qtyLine} · ${fmt(entry.macros.kcal)} kcal · P ${entry.macros.p} · C ${entry.macros.c} · F ${entry.macros.f}`;
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
    $("#rev-serving").value = (f.units && f.units.serving) || "";
    $("#rev-piece").value = (f.units && f.units.piece) || "";
    $("#rev-batch-g").value = (f.batch && f.batch.grams) || "";
    $("#rev-batch-s").value = (f.batch && f.batch.servings) || "";
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
    const serving = Number($("#rev-serving").value);
    const piece = Number($("#rev-piece").value);
    const batchG = Number($("#rev-batch-g").value);
    const batchS = Number($("#rev-batch-s").value);
    const units = { ...(base && base.units) };
    if (Number.isFinite(serving) && serving > 0) units.serving = serving;
    else delete units.serving;
    if (Number.isFinite(piece) && piece > 0) units.piece = piece;
    else delete units.piece;
    if (Number.isFinite(batchG) && batchG > 0) units.batch = batchG;
    else delete units.batch;
    const ingredients = $("#rev-ingredients").value.split("\n").map((t) => t.trim()).filter(Boolean).map((text) => ({ text, grams: null }));
    return {
      name: $("#rev-name").value.trim(),
      aliases: $("#rev-aliases").value.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean),
      cat: $("#rev-cat").value,
      per100: { kcal: num("#rev-kcal"), p: num("#rev-p"), c: num("#rev-c"), f: num("#rev-f"), fb: num("#rev-fb"), na: num("#rev-na") },
      units,
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

  function renderFoodDetail(food) {
    const serv = food.units && food.units.serving;
    const mServ = serv ? FoodMatch.computeMacros(food.per100, serv) : null;
    const ings = ((food.recipe && food.recipe.ingredients) || []).map((i) => `<li>${esc(i.text)}</li>`).join("");
    const prov = Foods.provenance(food);
    const batch = food.batch && food.batch.grams
      ? `<div class="card-block"><b>Batch</b>: ${fmt(food.batch.grams)} g · ${food.batch.servings || 1} servings
          <button type="button" class="btn ghost full" style="margin-top:8px" data-action="scale-batch" data-id="${esc(food.id)}">Scale batch</button>
        </div>`
      : `<div class="card-block"><button type="button" class="btn ghost full" data-action="scale-batch" data-id="${esc(food.id)}">Set / scale batch</button></div>`;
    $("#detail-body").innerHTML = `
      <h3>${esc(food.name)}</h3>
      <p class="muted small">${esc(prov.label)}${prov.detail ? " · " + esc(prov.detail) : ""}</p>
      <p class="muted small">Logged ${food.useCount || 0} times${food.lastUsedAt ? " · last " + new Date(food.lastUsedAt).toLocaleDateString() : ""} · v${food.version || 1}</p>
      <div class="card-block">
        <div><b>Per 100 g</b>: ${fmt(food.per100.kcal)} kcal · P ${food.per100.p} · C ${food.per100.c} · F ${food.per100.f} · Fb ${food.per100.fb} · Na ${food.per100.na}</div>
        ${mServ ? `<div style="margin-top:6px"><b>Per serving (${serv} g)</b>: ${fmt(mServ.kcal)} kcal · P ${mServ.p}</div>` : ""}
      </div>
      ${batch}
      ${ings ? `<div class="card-block"><b>Ingredients</b><ul class="ing-list">${ings}</ul>${food.recipe.prep ? `<p class="small">${esc(food.recipe.prep)}</p>` : ""}</div>` : ""}
      <div class="col-actions">
        <button type="button" class="btn full" data-action="log-this" data-id="${esc(food.id)}">Log this</button>
        <button type="button" class="btn ghost full" data-action="edit-food" data-id="${esc(food.id)}">Edit food</button>
        <button type="button" class="btn ghost full" data-action="update-food" data-id="${esc(food.id)}">Update from AI paste</button>
        <button type="button" class="btn ghost full" data-action="copy-update-prompt" data-id="${esc(food.id)}">Copy update prompt</button>
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
    const goalsForDay = (opts && opts.goalsForDay) || ((day) =>
      (typeof Phases !== "undefined" ? Phases.goalsForDay(day, settings) : (settings.goals || {})));
    const end = new Date(todayKey + "T12:00:00");
    let keys = [];
    const daysBack = opts && opts.daysBack;
    if (daysBack === "phase" && typeof Phases !== "undefined") {
      const phase = Phases.activePhase(settings.phases);
      if (phase) {
        const start = new Date(phase.startDay + "T12:00:00");
        const cur = new Date(start);
        while (cur <= end) {
          keys.push(Ledger.todayKey(cur));
          cur.setDate(cur.getDate() + 1);
        }
      }
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
    if (ctxHeader && typeof Phases !== "undefined") {
      ctxHeader.textContent = Phases.phaseContext(settings, todayKey);
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
    const step = keys.length > 40 ? 7 : keys.length > 20 ? 4 : Math.max(1, Math.floor(keys.length / 6));
    keys.forEach((day, i) => {
      if (i % step !== 0 && i !== keys.length - 1) return;
      const x = pad.l + (i + 0.5) * (iw / keys.length);
      ctx.fillText(day.slice(5), x - 12, h - 8);
    });
    _trendHit = { keys, pad, iw, w };

    const avg = (key) => logged.length ? logged.reduce((s, p) => s + p[key], 0) / logged.length : 0;
    const avgSel = logged.length ? logged.reduce((s, p) => s + p.value, 0) / logged.length : 0;
    const weekKeys = keys.slice(-7);
    const weekLogged = weekKeys.map((d) => totalsMap[d]).filter((t) => t && t.count);
    const weekAvg = weekLogged.length
      ? Math.round(weekLogged.reduce((s, t) => s + nutKey.total(t), 0) / weekLogged.length)
      : 0;
    const streak = streakEndingToday();
    const rangeLabel = daysBack === "phase" ? "this phase" : `${keys.length} days`;
    const unitSuffix = nutKey.unit === "kcal" ? " kcal" : ` ${nutKey.unit}`;
    $("#trend-summary").textContent = logged.length
      ? `${logged.length} of ${keys.length} days logged (${rangeLabel}) · avg ${fmt(avgSel)}${unitSuffix} ${nutKey.label} · P ${fmt(avg("p"))} · C ${fmt(avg("c"))} · F ${fmt(avg("f"))} · 7d ${fmt(weekAvg)}${unitSuffix} · streak ${streak}d`
      : "No logged days in this range yet.";

    // Scorecard + callouts
    const scoreRoot = $("#insight-scorecard");
    const callRoot = $("#insight-callouts");
    if (scoreRoot && typeof Phases !== "undefined") {
      const excludeToday = !totalsMap[todayKey] || !totalsMap[todayKey].count ? todayKey : null;
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
      const phase = Phases.activePhase(settings.phases);
      const wDelta = phase
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
        bits.push(`<p class="muted small">Weight: ${wDelta.first.toFixed(1)} → ${wDelta.last.toFixed(1)} kg (${sign}${wDelta.delta.toFixed(1)} kg, ${wDelta.n} weigh-ins).</p>`);
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

  return {
    $, $$, fmt, esc, toast, openSheet, closeSheet, closeAllSheets, topSheetId, setDayLabel, updateHUD,
    renderDayLog, renderFoods, renderPicker, fillQtySheet, updateQtyPreview, selectedUnit, selectedMeal, selectedMealIn,
    showPastePrompt, showPromptFallback, showReview, setReviewErrors, filterCategories, readReviewDraft,
    renderFoodDetail, renderTrends, trendDayAtClientX, renderDayDetail, fillMealChips, setSyncPill, showOnboarding, MEALS,
  };
})();
