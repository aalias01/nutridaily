/* NutriDaily — list utterance parse (type or keyboard mic). Local, deterministic. */
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
  const FALLBACK_COUNT = [
    "chapati", "roti", "egg", "banana", "apple", "orange", "slice", "bar",
    "bagel", "cookie", "tortilla", "wrap",
  ];
  const MASS_ALT = "g|grams?|gm|gms|oz|ounces?";
  const COUNT_ALT = "pieces?|pcs?|eggs?|bananas?|apples?|oranges?|slices?|bars?|chapatis?|rotis?|bagels?|cookies?|tortillas?|wraps?|servings?";
  const SPOKEN_NUM = "(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(?:[\\s-]+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and))*";
  const CONNECTOR = /\s+(?:and|plus|with|then|also)\s+/i;

  function preprocess(raw, opts) {
    const keepNewlines = !!(opts && opts.keepNewlines);
    let s = String(raw || "")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, "-")
      .replace(/\u00A0/g, " ")
      .replace(/\.+$/g, "");
    // STT often yields "78 G spinach" — treat lone G/GM as grams near digits.
    s = s.replace(/(\d)\s*[Gg](?=\s|$)/g, "$1 g");
    s = s.replace(/(\d)\s*[Gg][Mm][Ss]?(?=\s|$)/g, "$1 g");
    if (keepNewlines) {
      s = s.replace(/[^\S\n]+/g, " ").replace(/\n+/g, "\n").trim();
    } else {
      s = s.replace(/\s+/g, " ").trim();
    }
    return s;
  }

  /** Convert spoken number words / digits into a finite number, or null. */
  function parseNumberWords(text) {
    const raw = String(text || "").toLowerCase().trim();
    if (!raw) return null;
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
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
    const count = (typeof FoodMatch !== "undefined" && FoodMatch.COUNT_NOUNS) || FALLBACK_COUNT;
    return { mass, syn, count };
  }

  function normalizeUnitToken(tok) {
    const { mass, syn } = unitTables();
    const t = String(tok || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!t) return null;
    if (mass[t] != null) {
      if (t === "gram" || t === "grams" || t === "gm" || t === "gms") return "g";
      if (t === "ounce" || t === "ounces") return "oz";
      return t;
    }
    if (syn[t]) return syn[t];
    if (t === "piece" || t === "serving" || t === "cup" || t === "scoop" || t === "slice") return t;
    return null;
  }

  function isCountNoun(tok) {
    const { count, syn } = unitTables();
    const t = String(tok || "").toLowerCase().replace(/[^a-z]/g, "");
    if (!t) return false;
    if (count.includes(t)) return true;
    if (FALLBACK_COUNT.includes(t)) return true;
    if (syn[t] === "piece") return true;
    if (t.endsWith("s") && (count.includes(t.slice(0, -1)) || FALLBACK_COUNT.includes(t.slice(0, -1)))) return true;
    if (t.endsWith("es") && (count.includes(t.slice(0, -2)) || FALLBACK_COUNT.includes(t.slice(0, -2)))) return true;
    return false;
  }

  function singularCountLabel(tok) {
    const t = String(tok || "").toLowerCase().replace(/[^a-z]/g, "");
    if (/^chapat/.test(t)) return "chapati";
    if (/^roti/.test(t)) return "roti";
    if (/^eggs?$/.test(t)) return "egg";
    if (/^bananas?$/.test(t)) return "banana";
    if (/^apples?$/.test(t)) return "apple";
    if (/^oranges?$/.test(t)) return "orange";
    if (t.endsWith("ies")) return `${t.slice(0, -3)}y`;
    if (t.endsWith("oes")) return t.slice(0, -2);
    if (t.endsWith("ses") || t.endsWith("xes") || t.endsWith("zes")) return t.slice(0, -2);
    if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
    return t || tok;
  }

  function looksLikeQtyStart(s) {
    const t = String(s || "").trim();
    if (!t) return false;
    if (new RegExp(`^\\d+(?:\\.\\d+)?\\s*(?:${MASS_ALT})\\b`, "i").test(t)) return true;
    if (new RegExp(`^\\d+(?:\\.\\d+)?\\s+(?:${COUNT_ALT})\\b`, "i").test(t)) return true;
    if (/^\d+(?:\.\d+)?\s+[a-z]/i.test(t)) return true;
    if (new RegExp(`^${SPOKEN_NUM}\\s+(?:${MASS_ALT}|${COUNT_ALT})\\b`, "i").test(t)) return true;
    if (/^(?:a|an|one)\s+[a-z]/i.test(t) && isCountNoun(t.split(/\s+/)[1])) return true;
    return false;
  }

  function softSplitConnectors(part) {
    const bits = part.split(CONNECTOR);
    if (bits.length === 1) return [part];
    const out = [];
    let buf = bits[0];
    for (let i = 1; i < bits.length; i++) {
      const next = bits[i];
      const leftEndsHundred = /\bhundred\s*$/i.test(buf);
      const rightContinuesNumber = /^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine)\b/i.test(next);
      if (leftEndsHundred && rightContinuesNumber) {
        buf = `${buf} and ${next}`;
        continue;
      }
      const leftLooksNumber = /(?:\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b)\s*$/i.test(buf);
      const rightStartsQty = looksLikeQtyStart(next);
      if (leftLooksNumber && /^(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|one|two|three|four|five|six|seven|eight|nine)\b/i.test(next)
          && !rightStartsQty) {
        buf = `${buf} and ${next}`;
      } else {
        if (buf.trim()) out.push(buf.trim());
        buf = next;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out.filter(Boolean);
  }

  /** Split qty-then-food runs: "200 g chicken 100 g rice 2 eggs" (digits only). */
  function splitOnQtyStarts(chunk) {
    // Food-first lists ("chicken 200 g …") are handled by splitAfterFoodQty.
    if (!/^\d/.test(String(chunk || "").trim())) return [chunk];
    const re = new RegExp(
      `\\s+(?=(?:\\d+(?:\\.\\d+)?\\s*(?:${MASS_ALT})\\b)|(?:\\d+(?:\\.\\d+)?\\s+(?:${COUNT_ALT})\\b)|(?:\\d+(?:\\.\\d+)?\\s+[a-z]))`,
      "gi"
    );
    const parts = chunk.split(re).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [chunk];
  }

  /**
   * Food-then-qty runs: "chicken 200 g rice 100 g".
   * Digit qty only; skip "grams of …".
   */
  function splitAfterFoodQty(chunk) {
    if (!/^[a-z]/i.test(chunk)) return [chunk];
    const re = new RegExp(`\\b(\\d+(?:\\.\\d+)?\\s*(?:${MASS_ALT}))\\b`, "gi");
    const cuts = [];
    let m;
    while ((m = re.exec(chunk))) {
      const end = m.index + m[0].length;
      const rest = chunk.slice(end);
      if (/^\s+of\b/i.test(rest)) continue;
      if (!/^\s+[a-z]/i.test(rest)) continue;
      // Only cut when another amount follows (multi-item food-then-qty).
      if (!/\d+(?:\.\d+)?\s*(?:g|grams?|gm|gms|oz|ounces?)\b/i.test(rest)
          && !new RegExp(`\\d+(?:\\.\\d+)?\\s+(?:${COUNT_ALT})\\b`, "i").test(rest)) {
        continue;
      }
      cuts.push(end);
    }
    if (!cuts.length) return [chunk];
    const out = [];
    let start = 0;
    for (const c of cuts) {
      const bit = chunk.slice(start, c).trim();
      if (bit) out.push(bit);
      start = c;
    }
    const tail = chunk.slice(start).trim();
    if (tail) out.push(tail);
    return out.length ? out : [chunk];
  }

  /** Spoken qty-then-food chains: "two hundred grams chicken one hundred grams rice". */
  function splitSpokenQtyThenFood(chunk) {
    const re = new RegExp(`^(${SPOKEN_NUM})\\s+(${MASS_ALT})\\s+(.+)$`, "i");
    const m = chunk.match(re);
    if (!m) return [chunk];
    const label = m[3];
    const nextRe = new RegExp(`\\s(?=${SPOKEN_NUM}\\s+(?:${MASS_ALT})\\b)`, "i");
    const idx = label.search(nextRe);
    if (idx < 0) return [chunk];
    const food1 = label.slice(0, idx).trim();
    const rest = label.slice(idx).trim();
    if (!food1) return [chunk];
    return [`${m[1]} ${m[2]} ${food1}`, ...splitSpokenQtyThenFood(rest)];
  }

  function splitUtterance(text) {
    const cleaned = preprocess(text, { keepNewlines: true });
    if (!cleaned) return [];
    const hard = cleaned
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    for (const part of hard) {
      for (const soft of softSplitConnectors(part)) {
        for (const qtyPart of splitOnQtyStarts(soft)) {
          for (const foodPart of splitAfterFoodQty(qtyPart)) {
            for (const bit of splitSpokenQtyThenFood(foodPart)) {
              out.push(bit);
            }
          }
        }
      }
    }
    return out.filter(Boolean);
  }

  function parseSegment(raw) {
    const text = preprocess(raw);
    const base = { rawText: text, spokenLabel: "", qty: null, unit: null, issue: null };
    if (!text) return { ...base, issue: "empty" };

    // Pattern A: "100g of orange" / "100 g orange" / "100 grams of rice"
    let m = text.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${MASS_ALT})\\s+(?:of\\s+)?(.+)$`, "i"));
    if (m) {
      const unit = normalizeUnitToken(m[2]) || "g";
      const label = m[3].trim();
      if (!label) return { ...base, qty: Number(m[1]), unit, issue: "no-label" };
      return { rawText: text, spokenLabel: label, qty: Number(m[1]), unit, issue: null };
    }

    // Pattern B: "2 eggs" / "2 pieces of tofu" / "3 bananas"
    m = text.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(${COUNT_ALT})\\s*(?:of\\s+)?(.*)$`, "i"));
    if (m) {
      const unitTok = m[2];
      const rest = (m[3] || "").trim();
      const unit = normalizeUnitToken(unitTok) || "piece";
      let cleanLabel = rest || singularCountLabel(unitTok);
      if (!rest && isCountNoun(unitTok)) cleanLabel = singularCountLabel(unitTok);
      return {
        rawText: text,
        spokenLabel: cleanLabel,
        qty: Number(m[1]),
        unit: /^pieces?$|^pcs?$/i.test(unitTok) && rest ? "piece" : (isCountNoun(unitTok) && !rest ? "piece" : unit),
        issue: null,
      };
    }

    // Pattern C: spoken number + unit + food — "thirty seven grams of rice"
    m = text.match(new RegExp(`^(${SPOKEN_NUM})\\s+(${MASS_ALT}|${COUNT_ALT})\\s+(?:of\\s+)?(.+)$`, "i"));
    if (m) {
      const qty = parseNumberWords(m[1]);
      if (qty != null) {
        const unitTok = m[2];
        const label = m[3].trim();
        const unit = normalizeUnitToken(unitTok) || (isCountNoun(unitTok) ? "piece" : "g");
        if (!label) return { ...base, qty, unit, issue: "no-label" };
        const spokenLabel = isCountNoun(unitTok) && !label ? singularCountLabel(unitTok) : label;
        return { rawText: text, spokenLabel: spokenLabel || label, qty, unit, issue: null };
      }
    }

    // Pattern D: spoken + mass without requiring "of" already covered; keep digit-free mass path
    m = text.match(new RegExp(`^(${SPOKEN_NUM})\\s+(${MASS_ALT})\\s+(.+)$`, "i"));
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

    // Pattern F: food then qty — "chicken 200 g" / "chicken breast 200 grams"
    m = text.match(new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*(${MASS_ALT})\\s*$`, "i"));
    if (m) {
      const label = m[1].trim();
      if (label && !/^\d/.test(label)) {
        return {
          rawText: text,
          spokenLabel: label.replace(/^of\s+/i, "").trim(),
          qty: Number(m[2]),
          unit: normalizeUnitToken(m[3]) || "g",
          issue: null,
        };
      }
    }

    // Pattern G: food then spoken qty — "chicken two hundred grams"
    m = text.match(new RegExp(`^(.+?)\\s+(${SPOKEN_NUM})\\s+(${MASS_ALT})\\s*$`, "i"));
    if (m) {
      const qty = parseNumberWords(m[2]);
      const label = m[1].trim();
      if (qty != null && label && !/^\d/.test(label)) {
        return {
          rawText: text,
          spokenLabel: label,
          qty,
          unit: normalizeUnitToken(m[3]) || "g",
          issue: null,
        };
      }
    }

    // Pattern H: food then bare count — "eggs 2" / "banana 1"
    m = text.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*$/i);
    if (m) {
      const label = m[1].trim();
      const qty = Number(m[2]);
      if (label && !/^\d/.test(label) && (isCountNoun(label.split(/\s+/).pop()) || isCountNoun(label))) {
        return {
          rawText: text,
          spokenLabel: singularCountLabel(label.split(/\s+/).pop()) || label,
          qty,
          unit: "piece",
          issue: null,
        };
      }
    }

    // Pattern I: "a banana" / "an egg" / "one apple"
    m = text.match(/^(?:a|an|one)\s+(.+)$/i);
    if (m) {
      const label = m[1].trim();
      const last = label.split(/\s+/).pop();
      if (isCountNoun(last) || isCountNoun(label)) {
        return {
          rawText: text,
          spokenLabel: singularCountLabel(last),
          qty: 1,
          unit: "piece",
          issue: null,
        };
      }
    }

    // Pattern E: leading digits then food — "100 orange" / "100 of rice"
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
      if (words.length === 1 && isCountNoun(words[0])) {
        return {
          rawText: text,
          spokenLabel: singularCountLabel(words[0]),
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
    const text = preprocess(raw, { keepNewlines: true });
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

  return {
    preprocess,
    parseNumberWords,
    parseUtterance,
    parseSegment,
    splitUtterance,
  };
})();

if (typeof module !== "undefined") module.exports = Voice;
