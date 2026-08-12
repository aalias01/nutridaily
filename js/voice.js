/* NutriDaily — voice / paste multi-entry: STT wrapper + deterministic utterance parse.
 * Speech is progressive enhancement (Web Speech API). Parsing is local and free.
 */
const Voice = (() => {
  const ONES = {
    zero: 0, oh: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19,
  };
  const TENS = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };

  function preprocess(raw) {
    return String(raw || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u00A0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Convert spoken number words / digits into a finite number, or null. */
  function parseNumberWords(text) {
    const raw = String(text || "").toLowerCase().trim();
    if (!raw) return null;
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    // "thirty-seven" / "thirty seven" / "a hundred"
    const tokens = raw.replace(/-/g, " ").split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    let total = 0;
    let current = 0;
    let saw = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "and") continue;
      if (/^\d+(\.\d+)?$/.test(t)) {
        current += Number(t);
        saw = true;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(ONES, t)) {
        current += ONES[t];
        saw = true;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(TENS, t)) {
        current += TENS[t];
        saw = true;
        continue;
      }
      if (t === "hundred") {
        current = (current || 1) * 100;
        saw = true;
        continue;
      }
      if (t === "thousand") {
        total += (current || 1) * 1000;
        current = 0;
        saw = true;
        continue;
      }
      return null;
    }
    if (!saw) return null;
    const n = total + current;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function unitTables() {
    const mass = (typeof FoodMatch !== "undefined" && FoodMatch.MASS_UNITS) || {
      g: 1, gram: 1, grams: 1, gm: 1, gms: 1, oz: 28.35, ounce: 28.35, ounces: 28.35,
    };
    const syn = (typeof FoodMatch !== "undefined" && FoodMatch.UNIT_SYNONYMS) || {
      chapati: "piece", chapatis: "piece", roti: "piece", rotis: "piece",
      pc: "piece", pcs: "piece", pieces: "piece",
    };
    const count = (typeof FoodMatch !== "undefined" && FoodMatch.COUNT_NOUNS) || [
      "chapati", "roti", "egg", "banana", "slice", "bar",
    ];
    return { mass, syn, count };
  }

  function normalizeUnitToken(tok) {
    const { mass, syn } = unitTables();
    const t = String(tok || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!t) return null;
    if (mass[t] != null) return t === "gram" || t === "grams" || t === "gm" || t === "gms" ? "g" : (t === "ounce" || t === "ounces" ? "oz" : t);
    if (syn[t]) return syn[t];
    if (t === "piece" || t === "serving" || t === "cup" || t === "scoop" || t === "slice") return t;
    return null;
  }

  function isCountNoun(tok) {
    const { count, syn } = unitTables();
    const t = String(tok || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!t) return false;
    if (count.includes(t)) return true;
    if (syn[t] === "piece") return true;
    // plural: chapatis → chapati
    if (t.endsWith("s") && count.includes(t.slice(0, -1))) return true;
    if (t.endsWith("es") && count.includes(t.slice(0, -2))) return true;
    return false;
  }

  /**
   * Split an utterance into candidate phrase chunks.
   * Avoid splitting "one hundred and twenty" mid-number.
   */
  function splitUtterance(text) {
    const cleaned = preprocess(text);
    if (!cleaned) return [];
    // Newlines and commas are hard splits.
    const soft = cleaned
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    for (const part of soft) {
      // Split on " and " only when it looks like a food separator (qty follows or precedes).
      const bits = part.split(/\s+and\s+/i);
      if (bits.length === 1) {
        out.push(part);
        continue;
      }
      let buf = bits[0];
      for (let i = 1; i < bits.length; i++) {
        const next = bits[i];
        const leftEndsHundred = /\bhundred\s*$/i.test(buf);
        const rightContinuesNumber = /^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine)\b/i.test(next);
        // "one hundred and twenty grams…" — keep the number intact.
        if (leftEndsHundred && rightContinuesNumber) {
          buf = `${buf} and ${next}`;
          continue;
        }
        const leftLooksNumber = /(?:\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b)\s*$/i.test(buf);
        const rightStartsQty = /^(?:\d|[a-z]+(?:[-\s][a-z]+)?\s+(?:g|gram|grams|oz|ounce|ounces|piece|pieces|chapati|chapatis|roti|rotis)\b)/i.test(next)
          || /^(?:\d+(?:\.\d+)?\s*(?:g|gram|grams|oz)?\b)/i.test(next)
          || /^(?:\d+\s+)/i.test(next);
        if (leftLooksNumber && /^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine)\b/i.test(next)
            && !rightStartsQty) {
          buf = `${buf} and ${next}`;
        } else if (rightStartsQty || /^(?:\d)/.test(next)) {
          out.push(buf.trim());
          buf = next;
        } else {
          out.push(buf.trim());
          buf = next;
        }
      }
      if (buf.trim()) out.push(buf.trim());
    }
    return out.filter(Boolean);
  }

  /**
   * Parse one phrase into { spokenLabel, qty, unit, rawText, issue? }.
   */
  function parseSegment(raw) {
    const text = preprocess(raw);
    const base = { rawText: text, spokenLabel: "", qty: null, unit: null, issue: null };
    if (!text) {
      return { ...base, issue: "empty" };
    }

    // Pattern A: "100g of orange" / "100 g orange" / "100 grams of rice"
    let m = text.match(/^(\d+(?:\.\d+)?)\s*(g|grams?|gm|gms|oz|ounces?)\s+(?:of\s+)?(.+)$/i);
    if (m) {
      const unit = normalizeUnitToken(m[2]) || "g";
      const label = m[3].trim();
      if (!label) return { ...base, qty: Number(m[1]), unit, issue: "no-label" };
      return { rawText: text, spokenLabel: label, qty: Number(m[1]), unit, issue: null };
    }

    // Pattern B: "two chapatis" / "2 chapati" / "2 pieces of tofu"
    m = text.match(/^(\d+(?:\.\d+)?)\s+(chapatis?|rotis?|pieces?|pcs?|eggs?|bananas?|slices?|bars?|servings?)\s*(?:of\s+)?(.*)$/i);
    if (m) {
      const unitTok = m[2];
      const rest = (m[3] || "").trim();
      const unit = normalizeUnitToken(unitTok) || (isCountNoun(unitTok) ? "piece" : "piece");
      const label = rest || unitTok.replace(/s$/i, "").replace(/es$/i, "");
      // Prefer keeping "chapati" as label when count noun is the food itself
      const spokenLabel = rest
        ? rest
        : (isCountNoun(unitTok) ? unitTok.replace(/s$/i, "").replace(/chapatie$/i, "chapati") : label);
      let cleanLabel = spokenLabel;
      if (/^chapat/i.test(unitTok) && !rest) cleanLabel = "chapati";
      if (/^roti/i.test(unitTok) && !rest) cleanLabel = "roti";
      if (/^eggs?$/i.test(unitTok) && !rest) cleanLabel = "egg";
      return {
        rawText: text,
        spokenLabel: cleanLabel,
        qty: Number(m[1]),
        unit: /^pieces?$|^pcs?$/i.test(unitTok) && rest ? "piece" : (isCountNoun(unitTok) && !rest ? "piece" : unit),
        issue: null,
      };
    }

    // Pattern C: spoken number + unit + food — "thirty seven grams of rice"
    m = text.match(/^([a-z]+(?:[-\s][a-z]+){0,4})\s+(g|grams?|gm|gms|oz|ounces?|chapatis?|rotis?|pieces?)\s+(?:of\s+)?(.+)$/i);
    if (m) {
      const qty = parseNumberWords(m[1]);
      if (qty != null) {
        const unitTok = m[2];
        const label = m[3].trim();
        const unit = normalizeUnitToken(unitTok) || (isCountNoun(unitTok) ? "piece" : "g");
        if (!label) return { ...base, qty, unit, issue: "no-label" };
        return { rawText: text, spokenLabel: label, qty, unit, issue: null };
      }
    }

    // Pattern D: "thirty-seven grams rice" without of
    m = text.match(/^([a-z0-9]+(?:[-\s][a-z0-9]+){0,4})\s+(grams?|g|oz|ounces?)\s+(.+)$/i);
    if (m) {
      const qty = parseNumberWords(m[1]);
      if (qty != null) {
        return {
          rawText: text,
          spokenLabel: m[3].trim(),
          qty,
          unit: normalizeUnitToken(m[2]) || "g",
          issue: null,
        };
      }
    }

    // Pattern E: leading digits then food with implied grams if unit missing — "100 orange"
    m = text.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (m) {
      const rest = m[2].trim();
      const words = rest.split(/\s+/);
      const maybeUnit = normalizeUnitToken(words[0]);
      if (maybeUnit && words.length > 1) {
        return {
          rawText: text,
          spokenLabel: words.slice(1).join(" ").replace(/^of\s+/i, "").trim(),
          qty: Number(m[1]),
          unit: maybeUnit,
          issue: null,
        };
      }
      // Count noun as second token: "2 fresh chapati" unlikely; "2 orange" → qty + label, unit g default? Better no-qty-unit
      if (isCountNoun(words[words.length - 1]) && words.length === 1) {
        return {
          rawText: text,
          spokenLabel: words[0].replace(/s$/i, ""),
          qty: Number(m[1]),
          unit: "piece",
          issue: null,
        };
      }
      return {
        rawText: text,
        spokenLabel: rest.replace(/^of\s+/i, "").trim(),
        qty: Number(m[1]),
        unit: "g",
        issue: null,
      };
    }

    // Label only — keep visible for confirm UI
    return {
      rawText: text,
      spokenLabel: text,
      qty: null,
      unit: null,
      issue: "no-qty",
    };
  }

  /**
   * @returns {{ ok: boolean, segments: Array, warnings: string[] }}
   */
  function parseUtterance(raw) {
    const text = preprocess(raw);
    const warnings = [];
    if (!text) {
      return { ok: false, segments: [], warnings: ["Nothing to parse"] };
    }
    const parts = splitUtterance(text);
    const segments = parts.map((p, i) => {
      const seg = parseSegment(p);
      return { id: `seg_${i}`, ...seg };
    });
    if (!segments.length) {
      return { ok: false, segments: [], warnings: ["Could not split that into foods"] };
    }
    for (const s of segments) {
      if (s.issue === "no-qty") warnings.push(`No amount for “${s.spokenLabel}”`);
      if (s.issue === "no-label") warnings.push("A line was missing a food name");
    }
    return { ok: segments.some((s) => s.spokenLabel), segments, warnings };
  }

  // ---------------------------------------------------------------- speech

  function speechSupported() {
    if (typeof window === "undefined") return false;
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  let _rec = null;
  let _listening = false;

  /**
   * Start listening. callbacks: { onPartial(text), onFinal(text), onError(msg), onEnd() }
   */
  function startListening(callbacks) {
    const cb = callbacks || {};
    if (!speechSupported()) {
      if (cb.onError) cb.onError("Speech recognition is not available in this browser");
      return false;
    }
    stopListening();
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Ctor();
    _rec = rec;
    _listening = true;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
    let finalText = "";
    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const t = r[0] && r[0].transcript ? r[0].transcript : "";
        if (r.isFinal) finalText = `${finalText} ${t}`.trim();
        else interim += t;
      }
      const shown = `${finalText} ${interim}`.trim();
      if (cb.onPartial) cb.onPartial(shown);
      if (finalText && cb.onFinal) cb.onFinal(finalText);
    };
    rec.onerror = (e) => {
      const msg = (e && e.error) ? String(e.error) : "speech-error";
      if (cb.onError) cb.onError(msg);
    };
    rec.onend = () => {
      _listening = false;
      _rec = null;
      if (cb.onEnd) cb.onEnd(finalText);
    };
    try {
      rec.start();
      return true;
    } catch (err) {
      _listening = false;
      _rec = null;
      if (cb.onError) cb.onError(String(err && err.message || err));
      return false;
    }
  }

  function stopListening() {
    if (_rec) {
      try { _rec.stop(); } catch (_) { /* ignore */ }
      try { _rec.abort(); } catch (_) { /* ignore */ }
    }
    _rec = null;
    _listening = false;
  }

  function isListening() {
    return _listening;
  }

  return {
    preprocess,
    parseNumberWords,
    parseUtterance,
    parseSegment,
    splitUtterance,
    speechSupported,
    startListening,
    stopListening,
    isListening,
  };
})();

if (typeof module !== "undefined") module.exports = Voice;
