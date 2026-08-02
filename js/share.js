/* NutriDaily — serverless recipe sharing.
 * A recipe packs into a compact code: "NCR1.<base64url JSON>".
 * Prefer sharing the bare code (short). Full #recipe= links still import.
 * Decoding VALIDATES everything: untrusted input.
 */
const Share = (() => {
  const PREFIX = "NCR1.";
  const MACROS = ["kcal", "p", "c", "f", "fb", "na"];

  const _btoa = typeof btoa !== "undefined" ? btoa : (s) => Buffer.from(s, "binary").toString("base64");
  const _atob = typeof atob !== "undefined" ? atob : (s) => Buffer.from(s, "base64").toString("binary");

  const b64urlEncode = (str) => _btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function b64urlDecode(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(_atob(s)));
  }

  const r1 = (x) => Math.round((+x || 0) * 10) / 10;

  function ingredientLines(food) {
    return ((food.recipe && food.recipe.ingredients) || []).slice(0, 12).map((x) => {
      if (typeof x === "string") return x.slice(0, 40);
      return String((x && (x.text || x.name)) || "").slice(0, 40);
    }).filter(Boolean);
  }

  /** personal food → compact share code (v2: short keys / macro array). */
  function pack(food) {
    const m = MACROS.map((k) => r1(food.per100[k]));
    const payload = {
      v: 2,
      n: String(food.name).slice(0, 48),
      m,
      g: Math.round((food.units && (food.units.serving || food.units.piece)) || 100),
    };
    const ings = ingredientLines(food);
    if (ings.length || (food.recipe && food.recipe.servings)) {
      payload.r = {
        s: Math.max(1, Math.round((food.recipe && food.recipe.servings) || 1)),
        i: ings,
      };
    }
    return PREFIX + b64urlEncode(JSON.stringify(payload));
  }

  function per100FromPayload(p) {
    const per100 = {};
    if (Array.isArray(p.m) && p.m.length >= 6) {
      for (let i = 0; i < MACROS.length; i++) {
        const v = +p.m[i] || 0;
        if (!isFinite(v) || v < 0) return { err: "Recipe has invalid nutrition values." };
        per100[MACROS[i]] = r1(v);
      }
      return { per100 };
    }
    if (p.per100 && typeof p.per100 === "object") {
      for (const k of MACROS) {
        const v = +p.per100[k] || 0;
        if (!isFinite(v) || v < 0) return { err: "Recipe has invalid nutrition values." };
        per100[k] = r1(v);
      }
      return { per100 };
    }
    return { err: "Unrecognized recipe format." };
  }

  /** share code (or any text containing one) → { ok, food | err }. Fully validated. */
  function unpack(text) {
    const m = String(text || "").match(/NCR1\.([A-Za-z0-9\-_]+)/);
    if (!m) return { ok: false, err: "That doesn't look like a NutriDaily recipe code." };
    let p;
    try { p = JSON.parse(b64urlDecode(m[1])); }
    catch (e) { return { ok: false, err: "Recipe code is corrupted. Ask them to share it again." }; }
    if (!p || (p.v !== 1 && p.v !== 2) || typeof p.n !== "string" || !p.n.trim()) {
      return { ok: false, err: "Unrecognized recipe format." };
    }

    const macros = per100FromPayload(p);
    if (macros.err) return { ok: false, err: macros.err };
    const per100 = macros.per100;
    if (per100.kcal > 920) return { ok: false, err: "Recipe rejected: more than 9.2 kcal/g is physically impossible." };
    if (per100.p + per100.c + per100.f > 105) return { ok: false, err: "Recipe rejected: macros exceed 100 g per 100 g of food." };

    const g = Math.min(2000, Math.max(10, Math.round(+p.g || 100)));
    const name = p.n.trim().slice(0, 80);
    const food = {
      id: null,
      name,
      aliases: [name.toLowerCase()],
      per100,
      units: { serving: g, piece: g, bowl: g },
      cat: "dish",
      source: "shared",
    };
    if (p.r && Array.isArray(p.r.i)) {
      const servings = Math.min(100, Math.max(1, Math.round(+p.r.s || 1)));
      food.recipe = {
        servings,
        ingredients: p.r.i.slice(0, 30).map((x) => ({ text: String(x).slice(0, 60) })),
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

  const looksLikeCode = (text) => /NCR1\.[A-Za-z0-9\-_]+/.test(String(text || ""));

  return { pack, unpack, shareText, shareData, shareLink, appUrl, looksLikeCode, PREFIX };
})();

if (typeof module !== "undefined") module.exports = Share;
