/* NutriDaily — serverless recipe sharing.
 * A recipe (name + per-100g macros + serving size + ingredients) packs into a
 * compact code: "NCR1.<base64url JSON>". Shared as a URL fragment
 * (…/index.html#recipe=NCR1.xxx) — fragments are never sent to any server —
 * or pasted directly into the chat. Decoding VALIDATES everything: this is
 * untrusted input (bounds-checked numbers, length-capped strings, no HTML).
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

  /** personal food → compact share code */
  function pack(food) {
    const per100 = {};
    for (const k of MACROS) per100[k] = r1(food.per100[k]);
    const payload = {
      v: 1,
      n: String(food.name).slice(0, 80),
      per100,
      g: Math.round((food.units && (food.units.serving || food.units.piece)) || 100),
    };
    if (food.recipe) {
      payload.r = {
        s: Math.max(1, Math.round(food.recipe.servings || 1)),
        i: (food.recipe.ingredients || []).slice(0, 30).map((x) => String(x).slice(0, 60)),
      };
    }
    return PREFIX + b64urlEncode(JSON.stringify(payload));
  }

  /** share code (or any text containing one) → { ok, food | err }. Fully validated. */
  function unpack(text) {
    const m = String(text || "").match(/NCR1\.([A-Za-z0-9\-_]+)/);
    if (!m) return { ok: false, err: "That doesn't look like a NutriDaily recipe code." };
    let p;
    try { p = JSON.parse(b64urlDecode(m[1])); }
    catch (e) { return { ok: false, err: "Recipe code is corrupted — ask them to share it again." }; }
    if (!p || p.v !== 1 || typeof p.n !== "string" || !p.n.trim() || !p.per100) return { ok: false, err: "Unrecognized recipe format." };

    const per100 = {};
    for (const k of MACROS) {
      const v = +p.per100[k] || 0;
      if (!isFinite(v) || v < 0) return { ok: false, err: "Recipe has invalid nutrition values." };
      per100[k] = r1(v);
    }
    if (per100.kcal > 920) return { ok: false, err: "Recipe rejected: more than 9.2 kcal/g is physically impossible." };
    if (per100.p + per100.c + per100.f > 105) return { ok: false, err: "Recipe rejected: macros exceed 100 g per 100 g of food." };

    const g = Math.min(2000, Math.max(10, Math.round(+p.g || 100)));
    const name = p.n.trim().slice(0, 80).toLowerCase();
    const food = {
      id: null, // assigned on accept
      name,
      aliases: [name],
      per100,
      units: { serving: g, piece: g, bowl: g },
      cat: "dish",
      source: "shared",
    };
    if (p.r && Array.isArray(p.r.i)) {
      const servings = Math.min(100, Math.max(1, Math.round(+p.r.s || 1)));
      food.recipe = { servings, ingredients: p.r.i.slice(0, 30).map((x) => String(x).slice(0, 60)), totalGrams: g * servings };
    }
    return { ok: true, food };
  }

  /** Full link when hosted; bare code on file:// (still paste-able into any NutriDaily). */
  function shareText(food) {
    const code = pack(food);
    if (typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:")) {
      return `${location.origin}${location.pathname}#recipe=${code}`;
    }
    return code;
  }

  const looksLikeCode = (text) => /NCR1\.[A-Za-z0-9\-_]+/.test(String(text || ""));

  return { pack, unpack, shareText, looksLikeCode, PREFIX };
})();

if (typeof module !== "undefined") module.exports = Share;
