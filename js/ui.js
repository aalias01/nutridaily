/* NutriDaily — DOM rendering for the diary UI. */
const UI = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function openSheet(id) {
    const el = $(`#${id}`);
    if (!el) return;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("open"));
  }
  function closeSheet(id) {
    const el = typeof id === "string" ? $(`#${id}`) : id;
    if (!el) return;
    el.classList.remove("open");
    setTimeout(() => { el.hidden = true; }, 200);
  }
  function closeAllSheets() {
    $$(".sheet.open").forEach((el) => closeSheet(el));
  }

  function setDayLabel(dayKey, isToday) {
    const d = new Date(dayKey + "T12:00:00");
    const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    $("#day-label").textContent = isToday ? `${label} · today` : label;
    $("#btn-day-next").disabled = isToday;
  }

  function updateHUD(totals, goals) {
    const set = (id, mean, goal) => {
      const fill = $(`#f-${id}`), val = $(`#v-${id}`);
      if (!fill || !val) return;
      const pct = goal ? Math.min(100, (mean / goal) * 100) : 0;
      fill.style.width = pct + "%";
      fill.classList.toggle("over", goal && mean > goal * 1.05);
      if (id === "kcal") val.textContent = `${fmt(mean)} / ${fmt(goal)}`;
      else val.textContent = `${fmt(mean)} / ${fmt(goal)} g`;
    };
    $("#v-kcal-big").textContent = fmt(totals.kcal.mean);
    const lo = Math.max(0, Math.round(totals.kcal.mean - totals.kcal.sd));
    const hi = Math.round(totals.kcal.mean + totals.kcal.sd);
    $("#kcal-range").textContent = totals.count ? `likely ${fmt(lo)}–${fmt(hi)}` : "—";
    set("kcal", totals.kcal.mean, goals.kcal);
    set("p", totals.p.mean, goals.protein);
    set("c", totals.c.mean, goals.carbs);
    set("f", totals.f.mean, goals.fat);
    set("fb", totals.fb.mean, goals.fiber);
    $("#v-na").textContent = totals.count ? `Sodium ${fmt(totals.na.mean)} mg` : "";
  }

  const MEALS = ["breakfast", "lunch", "dinner", "snack"];

  function renderDayLog(dayKey, entries) {
    const root = $("#day-log");
    if (!entries.length) {
      root.innerHTML = `<div class="empty">Nothing logged yet.<br><span class="muted small">Tap + to add a food.</span></div>`;
      return;
    }
    const groups = {};
    for (const m of MEALS) groups[m] = [];
    for (const e of entries) {
      const m = MEALS.includes(e.meal) ? e.meal : "snack";
      groups[m].push(e);
    }
    root.innerHTML = MEALS.filter((m) => groups[m].length).map((meal) => {
      const rows = groups[meal].map((e) => {
        const edited = e.history && e.history.length ? `<span class="tag tag-edit">edited</span>` : "";
        return `<button type="button" class="log-row" data-action="edit-entry" data-id="${esc(e.id)}">
          <div>
            <div class="r-name">${esc(e.name)} ${edited}</div>
            <div class="r-qty">${esc(e.displayQty)}</div>
          </div>
          <div class="r-macros">
            <span class="mini">${fmt(e.macros.kcal)} kcal</span>
            <span class="mini">P ${e.macros.p}</span>
          </div>
        </button>`;
      }).join("");
      return `<div class="meal-group"><div class="meal-label">${esc(meal)}</div>${rows}</div>`;
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
      root.innerHTML = `<div class="empty">${q ? "No matches." : "No foods yet.<br><span class=\"muted small\">Add one from a ChatGPT paste.</span>"}</div>`;
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

  function renderPicker(personal, query, showCatalog) {
    const q = String(query || "").trim();
    const root = $("#pick-list");
    const recent = q ? [] : Foods.recent(personal, 8);
    const recentIds = new Set(recent.map((f) => f.id));
    const freq = q ? [] : Foods.frequent(personal, 8, recentIds);
    let all = Foods.active(personal);
    if (q) {
      all = all.filter((f) => FoodMatch.scoreMatch(q, f.name) >= 0.35 || (f.aliases || []).some((a) => FoodMatch.scoreMatch(q, a) >= 0.35))
        .sort((a, b) => FoodMatch.scoreMatch(q, b.name) - FoodMatch.scoreMatch(q, a.name));
    } else {
      all = Foods.sortForPicker(personal).filter((f) => !recentIds.has(f.id) && !freq.find((x) => x.id === f.id));
    }

    const section = (title, items) => {
      if (!items.length) return "";
      return `<div class="pick-section"><div class="meal-label">${esc(title)}</div>${items.map((f) =>
        `<button type="button" class="log-row" data-action="pick-food" data-id="${esc(f.id)}">
          <div class="r-name">${esc(f.name)}</div>
          <span class="mini">${fmt(f.per100.kcal)} /100g</span>
        </button>`
      ).join("")}</div>`;
    };

    let html = "";
    if (!q) {
      html += section("Recent", recent);
      html += section("Frequent", freq);
      html += section("All foods", all.slice(0, 40));
    } else {
      html += section("Matches", all.slice(0, 40));
    }

    if (showCatalog) {
      const DB = typeof FOOD_DB !== "undefined" ? FOOD_DB : [];
      let cats = DB;
      if (q) {
        cats = DB.filter((f) => FoodMatch.scoreMatch(q, f.name) >= 0.45 || (f.aliases || []).some((a) => FoodMatch.scoreMatch(q, a) >= 0.45))
          .sort((a, b) => FoodMatch.scoreMatch(q, b.name) - FoodMatch.scoreMatch(q, a.name))
          .slice(0, 20);
      } else cats = [];
      if (cats.length) {
        html += `<div class="pick-section"><div class="meal-label">Reference catalog</div>${cats.map((f) =>
          `<button type="button" class="log-row" data-action="pick-catalog" data-id="${esc(f.id)}">
            <div class="r-name">${esc(f.name)} <span class="tag tag-mine">catalog</span></div>
            <span class="mini">${fmt(f.per100.kcal)} /100g</span>
          </button>`
        ).join("")}</div>`;
      }
    }

    if (!html) html = `<div class="empty small">No foods yet. Paste a ChatGPT block to add one.</div>`;
    root.innerHTML = html;
  }

  function fillQtySheet(food, imperial, prefill) {
    $("#qty-name").textContent = food.name;
    $("#qty-per100").textContent = `per 100 g: ${fmt(food.per100.kcal)} kcal · P ${food.per100.p} · C ${food.per100.c} · F ${food.per100.f}`;
    const units = ["g"];
    if (food.units && food.units.serving) units.push("serving");
    if (food.units && food.units.piece) units.push("piece");
    if (food.batch && food.batch.grams) units.push("batch");
    if (imperial) units.push("oz");
    const unit = (prefill && prefill.unit) || "g";
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
    updateQtyPreview(food);
  }

  function selectedUnit() {
    const el = $("#qty-units .uchip.active");
    return el ? el.dataset.unit : "g";
  }
  function selectedMeal() {
    const el = $("#qty-meals .uchip.active");
    return el ? el.dataset.meal : Foods.inferMeal();
  }

  function updateQtyPreview(food) {
    const qty = Number($("#qty-input").value);
    if (!Number.isFinite(qty) || qty <= 0) {
      $("#qty-preview").textContent = "Enter an amount";
      return null;
    }
    const entry = Foods.entryFromQty(food, qty, selectedUnit(), selectedMeal());
    $("#qty-preview").textContent = `${fmt(entry.macros.kcal)} kcal · P ${entry.macros.p} · C ${entry.macros.c} · F ${entry.macros.f}`;
    return entry;
  }

  function showPastePrompt() {
    $("#paste-step-prompt").hidden = false;
    $("#paste-step-review").hidden = true;
    $("#paste-title").textContent = "Add food from ChatGPT";
  }

  function showReview(parsed, opts) {
    $("#paste-step-prompt").hidden = true;
    $("#paste-step-review").hidden = false;
    $("#paste-title").textContent = opts && opts.updateId ? "Update food" : "Review food";
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
    $("#detail-body").innerHTML = `
      <h3>${esc(food.name)}</h3>
      <p class="muted small">Logged ${food.useCount || 0} times${food.lastUsedAt ? " · last " + new Date(food.lastUsedAt).toLocaleDateString() : ""} · v${food.version || 1}</p>
      <div class="card-block">
        <div><b>Per 100 g</b>: ${fmt(food.per100.kcal)} kcal · P ${food.per100.p} · C ${food.per100.c} · F ${food.per100.f} · Fb ${food.per100.fb} · Na ${food.per100.na}</div>
        ${mServ ? `<div style="margin-top:6px"><b>Per serving (${serv} g)</b>: ${fmt(mServ.kcal)} kcal · P ${mServ.p}</div>` : ""}
      </div>
      ${ings ? `<div class="card-block"><b>Ingredients</b><ul class="ing-list">${ings}</ul>${food.recipe.prep ? `<p class="small">${esc(food.recipe.prep)}</p>` : ""}</div>` : ""}
      <div class="col-actions">
        <button type="button" class="btn full" data-action="log-this" data-id="${esc(food.id)}">Log this</button>
        <button type="button" class="btn ghost full" data-action="update-food" data-id="${esc(food.id)}">Update from ChatGPT</button>
        <button type="button" class="btn ghost full" data-action="copy-update-prompt" data-id="${esc(food.id)}">Copy update prompt</button>
        <button type="button" class="btn ghost full danger" data-action="delete-food" data-id="${esc(food.id)}">Delete</button>
      </div>`;
  }

  function renderTrends(goals, daysBack) {
    const canvas = $("#trend-canvas");
    if (!canvas) return;
    const end = new Date();
    const keys = [];
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      keys.push(Ledger.todayKey(d));
    }
    const points = keys.map((day) => {
      const t = Ledger.totalsFor(day);
      return { day, kcal: t.count ? t.kcal.mean : null, p: t.count ? t.p.mean : null, count: t.count };
    });
    const logged = points.filter((p) => p.count);
    const w = canvas.clientWidth || 320;
    const h = 160;
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    ctx.scale(2, 2);
    ctx.clearRect(0, 0, w, h);
    const maxK = Math.max(goals.kcal * 1.2, ...logged.map((p) => p.kcal), 1);
    const pad = { l: 28, r: 8, t: 12, b: 22 };
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const barW = Math.max(2, iw / keys.length - 2);
    ctx.strokeStyle = "rgba(61,153,112,0.45)";
    ctx.beginPath();
    const gy = pad.t + ih * (1 - goals.kcal / maxK);
    ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + iw, gy); ctx.stroke();
    points.forEach((p, i) => {
      if (p.kcal == null) return;
      const x = pad.l + (i + 0.15) * (iw / keys.length);
      const bh = (p.kcal / maxK) * ih;
      ctx.fillStyle = p.kcal > goals.kcal * 1.05 ? "#d0703c" : "#3d9970";
      ctx.fillRect(x, pad.t + ih - bh, barW, bh);
    });
    const avgK = logged.length ? logged.reduce((s, p) => s + p.kcal, 0) / logged.length : 0;
    const avgP = logged.length ? logged.reduce((s, p) => s + p.p, 0) / logged.length : 0;
    $("#trend-summary").textContent = logged.length
      ? `${logged.length} of ${daysBack} days logged · avg ${fmt(avgK)} kcal · ${fmt(avgP)} g protein`
      : "No logged days in this range yet.";

    // top contributors
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
    $, $$, fmt, esc, toast, openSheet, closeSheet, closeAllSheets, setDayLabel, updateHUD,
    renderDayLog, renderFoods, renderPicker, fillQtySheet, updateQtyPreview, selectedUnit, selectedMeal,
    showPastePrompt, showReview, readReviewDraft, renderFoodDetail, renderTrends, setSyncPill, showOnboarding,
  };
})();
