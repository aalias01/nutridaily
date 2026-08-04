/* NutriDaily — serverless recipe sharing.
 * A recipe packs into a compact code: "NCR1.<base64url JSON>".
 * Prefer sharing the bare code (short). Full #recipe= links still import.
 * Decoding VALIDATES everything: untrusted input.
 */
const Share = (() => {
  const PREFIX = "NCR1.";
  const LEGACY_MACROS = ["kcal", "p", "c", "f", "fb", "na"];
  const MACROS = [...LEGACY_MACROS, "k"];
  const UNIT_KEYS = { serving: "s", piece: "p", bowl: "b" };
  const MAX_INPUT_CHARS = 65536;
  const MAX_ENCODED_CHARS = 16384;
  const MAX_DECODED_CHARS = 12288;

  const _btoa = typeof btoa !== "undefined" ? btoa : (s) => Buffer.from(s, "binary").toString("base64");
  const _atob = typeof atob !== "undefined" ? atob : (s) => Buffer.from(s, "base64").toString("binary");

  const b64urlEncode = (str) => _btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(_atob(s)));
  }

  const r1 = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
  };

  function packNutrient(value, nullable) {
    if (nullable && (value == null || value === "")) return null;
    if (value == null || value === "") return null; // required null is rejected by v4 decoding
    const n = Number(value);
    // A non-number sentinel survives JSON serialization so it cannot be
    // confused with a legitimately unknown nullable mineral.
    return Number.isFinite(n) ? r1(n) : "invalid";
  }

  function ingredientLines(food) {
    return ((food.recipe && food.recipe.ingredients) || []).slice(0, 12).map((x) => {
      if (typeof x === "string") return x.slice(0, 40);
      return String((x && (x.text || x.name)) || "").slice(0, 40);
    }).filter(Boolean);
  }

  function packUnits(units) {
    const out = {};
    for (const [name, short] of Object.entries(UNIT_KEYS)) {
      const n = Number(units && units[name]);
      if (Number.isFinite(n) && n > 0 && n <= 2000) out[short] = n;
    }
    return out;
  }

  function packBatch(batch) {
    if (!batch) return null;
    const grams = Number(batch.grams);
    const servings = Number(batch.servings);
    return {
      g: Number.isFinite(grams) ? grams : null,
      s: Number.isFinite(servings) ? servings : null,
      w: batch.weighed == null ? false : (typeof batch.weighed === "boolean" ? batch.weighed : "invalid"),
    };
  }

  /** personal food → compact share code (v4: nullable minerals + exact logging/batch semantics). */
  function pack(food) {
    const per100 = food && food.per100 ? food.per100 : {};
    const m = ["kcal", "p", "c", "f", "fb"].map((k) => packNutrient(per100[k], false));
    m.push(packNutrient(per100.na, true));
    m.push(packNutrient(per100.k, true));
    const units = packUnits(food.units);
    const payload = {
      v: 4,
      n: String(food.name).slice(0, 80),
      m,
      g: Number((food.units && (food.units.serving || food.units.piece)) || 100),
    };
    if (Object.keys(units).length) payload.u = units;
    if (food.logAs === "piece" || food.logAs === "grams") payload.l = food.logAs;
    if (food.countLabel) payload.c = String(food.countLabel).slice(0, 32);
    const batch = packBatch(food.batch);
    if (batch) payload.b = batch;
    const ings = ingredientLines(food);
    if (ings.length || (food.recipe && food.recipe.servings)) {
      payload.r = {
        s: Number((food.recipe && food.recipe.servings) || 1),
        i: ings,
      };
    }
    const encoded = b64urlEncode(JSON.stringify(payload));
    if (encoded.length > MAX_ENCODED_CHARS) throw new Error("Recipe is too large to share.");
    return PREFIX + encoded;
  }

  function per100FromPayload(p) {
    const per100 = {};
    if (Array.isArray(p.m) && p.m.length >= 6) {
      const v4 = p.v >= 4;
      if (v4 && p.m.length !== MACROS.length) return { err: "Recipe has invalid nutrition values." };
      const required = ["kcal", "p", "c", "f", "fb"];
      for (let i = 0; i < required.length; i++) {
        const raw = p.m[i];
        if (v4 && typeof raw !== "number") return { err: "Recipe has invalid nutrition values." };
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) return { err: "Recipe has invalid nutrition values." };
        per100[required[i]] = r1(v);
      }
      const mineralIndexes = { na: 5, k: 6 };
      for (const [key, index] of Object.entries(mineralIndexes)) {
        const raw = p.m.length > index ? p.m[index] : null;
        // v1-v3 sodium was required and historically decoded as a number.
        if (raw == null || raw === "") {
          if (!v4 && key === "na") return { err: "Recipe has invalid nutrition values." };
          per100[key] = null;
          continue;
        }
        if (v4 && typeof raw !== "number") return { err: `Recipe has invalid ${key === "na" ? "sodium" : "potassium"}.` };
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) return { err: `Recipe has invalid ${key === "na" ? "sodium" : "potassium"}.` };
        per100[key] = r1(value);
      }
      return { per100 };
    }
    if (p.v < 4 && p.per100 && typeof p.per100 === "object") {
      for (const k of LEGACY_MACROS) {
        const v = Number(p.per100[k] == null || p.per100[k] === "" ? 0 : p.per100[k]);
        if (!Number.isFinite(v) || v < 0) return { err: "Recipe has invalid nutrition values." };
        per100[k] = r1(v);
      }
      if (p.per100.k == null || p.per100.k === "") per100.k = null;
      else {
        const k = Number(p.per100.k);
        if (!Number.isFinite(k) || k < 0) return { err: "Recipe has invalid potassium." };
        per100.k = r1(k);
      }
      return { per100 };
    }
    return { err: "Unrecognized recipe format." };
  }

  function validateNutrition(per100) {
    if (per100.kcal > 920) return "Recipe rejected: more than 9.2 kcal/g is physically impossible.";
    if ([per100.p, per100.c, per100.f, per100.fb].some((v) => v > 100) ||
        per100.p + per100.c + per100.f > 105) {
      return "Recipe rejected: macros exceed 100 g per 100 g of food.";
    }
    if (per100.na != null && per100.na > 40000) {
      return "Recipe rejected: sodium per 100 g looks impossibly high (over 40000 mg).";
    }
    if (per100.k != null && per100.k > 60000) {
      return "Recipe rejected: potassium per 100 g looks impossibly high (over 60000 mg).";
    }
    return null;
  }

  function unpackBatch(value) {
    if (value == null) return { batch: null };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { err: "Recipe has an invalid batch size." };
    if (Object.keys(value).some((key) => !["g", "s", "w"].includes(key))) return { err: "Recipe has an invalid batch size." };
    if (typeof value.g !== "number" || !Number.isFinite(value.g) || value.g <= 0 || value.g > 1000000 ||
        typeof value.s !== "number" || !Number.isFinite(value.s) || value.s <= 0 || value.s > 10000 ||
        (value.w != null && typeof value.w !== "boolean")) {
      return { err: "Recipe has an invalid batch size." };
    }
    return { batch: { grams: value.g, servings: value.s, weighed: value.w === true } };
  }

  /** share code (or any text containing one) → { ok, food | err }. Fully validated. */
  function unpack(text) {
    const input = String(text || "");
    if (input.length > MAX_INPUT_CHARS) return { ok: false, err: "Recipe code is too large." };
    const m = input.match(/NCR1\.([A-Za-z0-9\-_]+)/);
    if (!m) return { ok: false, err: "That doesn't look like a NutriDaily recipe code." };
    if (m[1].length > MAX_ENCODED_CHARS) return { ok: false, err: "Recipe code is too large." };
    let p;
    try {
      const decoded = b64urlDecode(m[1]);
      if (decoded.length > MAX_DECODED_CHARS) return { ok: false, err: "Recipe code is too large." };
      p = JSON.parse(decoded);
    }
    catch (e) { return { ok: false, err: "Recipe code is corrupted. Ask them to share it again." }; }
    if (!p || ![1, 2, 3, 4].includes(p.v) || typeof p.n !== "string" || !p.n.trim() ||
        (p.v >= 4 && p.n.length > 80)) {
      return { ok: false, err: "Unrecognized recipe format." };
    }

    const macros = per100FromPayload(p);
    if (macros.err) return { ok: false, err: macros.err };
    const per100 = macros.per100;
    const nutritionError = validateNutrition(per100);
    if (nutritionError) return { ok: false, err: nutritionError };

    if (p.v >= 4 && typeof p.g !== "number") return { ok: false, err: "Recipe has an invalid serving size." };
    const rawG = Number(p.g == null ? 100 : p.g);
    if (!Number.isFinite(rawG) || rawG <= 0 || rawG > 2000) return { ok: false, err: "Recipe has an invalid serving size." };
    const g = p.v >= 4 ? rawG : Math.max(10, Math.round(rawG));
    const name = p.n.trim().slice(0, 80);
    const units = {};
    if (p.v >= 3 && p.u != null) {
      if (!p.u || typeof p.u !== "object" || Array.isArray(p.u)) return { ok: false, err: "Recipe has invalid serving units." };
      const allowed = new Set(Object.values(UNIT_KEYS));
      for (const key of Object.keys(p.u)) {
        if (!allowed.has(key)) return { ok: false, err: "Recipe has an unrecognized serving unit." };
      }
      for (const [nameKey, short] of Object.entries(UNIT_KEYS)) {
        if (p.u[short] == null) continue;
        if (p.v >= 4 && typeof p.u[short] !== "number") return { ok: false, err: "Recipe has an invalid serving unit." };
        const n = Number(p.u[short]);
        if (!Number.isFinite(n) || n <= 0 || n > 2000) return { ok: false, err: "Recipe has an invalid serving unit." };
        units[nameKey] = p.v >= 4 ? n : Math.round(n * 10) / 10;
      }
    } else {
      // v1/v2 encoded one ambiguous size; retain their historical behaviour.
      units.serving = g;
      units.piece = g;
      units.bowl = g;
    }
    if (p.v >= 3 && p.l != null && p.l !== "grams" && p.l !== "piece") {
      return { ok: false, err: "Recipe has an invalid logging mode." };
    }
    if (p.v >= 4 && p.c != null && (typeof p.c !== "string" || p.c.length > 32)) {
      return { ok: false, err: "Recipe has an invalid count label." };
    }
    const decodedBatch = p.v >= 4 ? unpackBatch(p.b) : { batch: null };
    if (decodedBatch.err) return { ok: false, err: decodedBatch.err };
    const food = {
      id: null,
      name,
      aliases: [name.toLowerCase()],
      per100,
      units,
      logAs: p.v >= 3 ? (p.l || (units.piece ? "piece" : "grams")) : (units.piece ? "piece" : "grams"),
      countLabel: p.v >= 3 && typeof p.c === "string" ? p.c.trim().slice(0, 32) || null : null,
      batch: decodedBatch.batch,
      cat: "dish",
      source: "shared",
    };
    if (p.r != null && (!p.r || typeof p.r !== "object" || Array.isArray(p.r) || !Array.isArray(p.r.i))) {
      return { ok: false, err: "Recipe has invalid ingredients." };
    }
    if (p.r && Array.isArray(p.r.i)) {
      if (p.r.i.length > 30 || p.r.i.some((x) => typeof x !== "string" || x.length > 60)) {
        return { ok: false, err: "Recipe has invalid ingredients." };
      }
      if (p.v >= 4 && typeof p.r.s !== "number") return { ok: false, err: "Recipe has an invalid recipe yield." };
      const rawServings = p.r.s == null ? 1 : Number(p.r.s);
      if (!Number.isFinite(rawServings) || rawServings <= 0 || rawServings > 1000) {
        return { ok: false, err: "Recipe has an invalid recipe yield." };
      }
      const servings = p.v >= 4 ? rawServings : Math.min(100, Math.max(1, Math.round(rawServings)));
      food.recipe = {
        servings,
        ingredients: p.r.i.map((x) => ({ text: x })),
        totalGrams: g * servings,
        prep: "",
        notes: "Imported from a shared NutriDaily food",
      };
    }
    return { ok: true, food };
  }

  /** Clean app URL (no #recipe=). Chat apps use this for OG / favicon preview. */
  function appUrl() {
    if (typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:")) {
      const path = location.pathname && location.pathname !== "/" ? location.pathname : "/";
      return `${location.origin}${path === "/" ? "/" : path}`;
    }
    return "https://nutridaily.vercel.app/";
  }

  /** Short paste-friendly message: site URL (icon preview) + bare NCR1 code. */
  function shareText(food) {
    const code = pack(food);
    const name = String(food.name || "Food").slice(0, 48);
    return `${name} — NutriDaily\n${appUrl()}\n\n${code}\n\nPaste the code in Foods → Import shared food`;
  }

  /** Web Share payload: url triggers app icon / link preview; text carries the code. */
  function shareData(food) {
    const code = pack(food);
    const name = String(food.name || "Food").slice(0, 48);
    return {
      title: `${name} — NutriDaily`,
      text: `${code}\n\nPaste in NutriDaily → Foods → Import shared food`,
      url: appUrl(),
    };
  }

  /** Optional deep link (longer). Prefer shareData / shareText for messaging apps. */
  function shareLink(food) {
    const code = pack(food);
    const base = appUrl().replace(/\/$/, "");
    return `${base}/#recipe=${code}`;
  }

  const looksLikeCode = (text) => {
    const input = String(text || "");
    return input.length <= MAX_INPUT_CHARS && /NCR1\.[A-Za-z0-9\-_]+/.test(input);
  };

  return { pack, unpack, shareText, shareData, shareLink, appUrl, looksLikeCode, PREFIX };
})();

if (typeof module !== "undefined") module.exports = Share;
