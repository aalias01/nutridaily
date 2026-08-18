/* List utterance parser unit tests (no DOM / speech required). */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

const foodmatchPath = path.join(__dirname, "..", "js", "foodmatch.js");
global.FoodMatch = require(foodmatchPath);
const Voice = require(path.join(__dirname, "..", "js", "voice.js"));

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${msg}${detail != null ? ` — ${detail}` : ""}`);
  }
}

console.log("\n[voice] parse utterance");

ok(Voice.parseNumberWords("37") === 37, "digit number words");
ok(Voice.parseNumberWords("thirty-seven") === 37, "hyphenated thirty-seven");
ok(Voice.parseNumberWords("thirty seven") === 37, "spaced thirty seven");
ok(Voice.parseNumberWords("a hundred") === 100, "a hundred");
ok(Voice.parseNumberWords("one hundred and twenty") === 120, "one hundred and twenty");

{
  const r = Voice.parseUtterance("100 g orange and 2 chapati");
  ok(r.ok && r.segments.length === 2, "orange + chapati splits to 2 segments", JSON.stringify(r.segments));
  ok(r.segments[0].spokenLabel.toLowerCase().includes("orange") && r.segments[0].qty === 100 && r.segments[0].unit === "g",
    "first segment is 100 g orange", JSON.stringify(r.segments[0]));
  ok(/chapati/i.test(r.segments[1].spokenLabel) && r.segments[1].qty === 2 && r.segments[1].unit === "piece",
    "second segment is 2 chapati as pieces", JSON.stringify(r.segments[1]));
}

{
  const r = Voice.parseUtterance("100g of orange, 2 chapatis");
  ok(r.ok && r.segments.length === 2, "comma split with 100g of / chapatis", r.segments.length);
  ok(r.segments[0].qty === 100 && r.segments[0].unit === "g", "100g of → g");
  ok(r.segments[1].qty === 2 && r.segments[1].unit === "piece", "2 chapatis → piece");
}

{
  const r = Voice.parseUtterance("thirty-seven grams of rice");
  ok(r.ok && r.segments.length === 1, "spoken grams of rice is one segment");
  ok(r.segments[0].qty === 37 && r.segments[0].unit === "g" && /rice/i.test(r.segments[0].spokenLabel),
    "thirty-seven grams of rice", JSON.stringify(r.segments[0]));
}

{
  const r = Voice.parseUtterance("almonds");
  ok(r.ok && r.segments.length === 1 && r.segments[0].issue === "no-qty",
    "label-only keeps segment with no-qty issue");
}

{
  const r = Voice.parseUtterance("");
  ok(!r.ok && r.segments.length === 0, "empty utterance fails soft");
}

{
  const parts = Voice.splitUtterance("one hundred and twenty grams of rice");
  ok(parts.length === 1 && /hundred and twenty/i.test(parts[0]),
    "does not split inside hundred and twenty", JSON.stringify(parts));
}

{
  const r = Voice.parseUtterance("200 g chicken 100 g rice 2 eggs");
  ok(r.ok && r.segments.length === 3, "no-comma qty-boundary → 3", JSON.stringify(r.segments));
  ok(r.segments[0].qty === 200 && /chicken/i.test(r.segments[0].spokenLabel), "seg0 chicken 200 g", JSON.stringify(r.segments[0]));
  ok(r.segments[1].qty === 100 && /rice/i.test(r.segments[1].spokenLabel), "seg1 rice 100 g", JSON.stringify(r.segments[1]));
  ok(r.segments[2].qty === 2 && r.segments[2].unit === "piece" && /egg/i.test(r.segments[2].spokenLabel),
    "seg2 2 eggs", JSON.stringify(r.segments[2]));
}

{
  const r = Voice.parseUtterance("200g chicken, 100g rice, 2 eggs");
  ok(r.ok && r.segments.length === 3, "compact comma list → 3", r.segments.length);
}

{
  const r = Voice.parseUtterance("200 grams chicken and 100 grams rice");
  ok(r.ok && r.segments.length === 2, "and-split grams → 2", JSON.stringify(r.segments));
}

{
  const r = Voice.parseUtterance("two hundred grams chicken one hundred grams rice");
  ok(r.ok && r.segments.length === 2, "spoken no-comma → 2", JSON.stringify(r.segments));
  ok(r.segments[0].qty === 200 && /chicken/i.test(r.segments[0].spokenLabel), "spoken chicken 200", JSON.stringify(r.segments[0]));
  ok(r.segments[1].qty === 100 && /rice/i.test(r.segments[1].spokenLabel), "spoken rice 100", JSON.stringify(r.segments[1]));
}

{
  const r = Voice.parseUtterance("chicken 200 g rice 100 g");
  ok(r.ok && r.segments.length === 2, "food-then-qty → 2", JSON.stringify(r.segments));
  ok(/chicken/i.test(r.segments[0].spokenLabel) && r.segments[0].qty === 200 && r.segments[0].unit === "g",
    "chicken 200 g", JSON.stringify(r.segments[0]));
  ok(/rice/i.test(r.segments[1].spokenLabel) && r.segments[1].qty === 100, "rice 100 g", JSON.stringify(r.segments[1]));
}

{
  const r = Voice.parseUtterance("chicken breast 200 grams and 2 eggs");
  ok(r.ok && r.segments.length === 2, "food-then-qty + and eggs → 2", JSON.stringify(r.segments));
  ok(/chicken/i.test(r.segments[0].spokenLabel) && r.segments[0].qty === 200, "chicken breast 200", JSON.stringify(r.segments[0]));
  ok(r.segments[1].qty === 2 && /egg/i.test(r.segments[1].spokenLabel), "and 2 eggs", JSON.stringify(r.segments[1]));
}

{
  const r = Voice.parseUtterance("100 g spinach plus 50 g rice");
  ok(r.ok && r.segments.length === 2, "plus connector → 2", JSON.stringify(r.segments));
}

{
  const r = Voice.parseUtterance("a banana and 2 eggs");
  ok(r.ok && r.segments.length === 2, "a banana and 2 eggs → 2", JSON.stringify(r.segments));
  ok(r.segments[0].qty === 1 && r.segments[0].unit === "piece" && /banana/i.test(r.segments[0].spokenLabel),
    "a banana → 1 piece", JSON.stringify(r.segments[0]));
}

{
  const r = Voice.parseUtterance("100 g rice\n50 g apple");
  ok(r.ok && r.segments.length === 2, "newline-separated → 2", JSON.stringify(r.segments));
}

{
  const r = Voice.parseUtterance("78 G spinach");
  ok(r.ok && r.segments.length === 1 && r.segments[0].qty === 78 && r.segments[0].unit === "g",
    "STT lone G → grams", JSON.stringify(r.segments[0]));
}

{
  const r = Voice.parseUtterance("apple, banana, rice");
  ok(r.ok && r.segments.length === 3 && r.segments.every((s) => s.issue === "no-qty"),
    "name-only comma list keeps 3 no-qty segments", JSON.stringify(r.segments));
}

{
  const r = Voice.parseUtterance("eggs 2");
  ok(r.ok && r.segments[0].qty === 2 && r.segments[0].unit === "piece", "eggs 2 → piece", JSON.stringify(r.segments[0]));
}

{
  const sw = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
  ok(/js\/voice\.js/.test(sw), "service worker SHELL includes js/voice.js");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  ok(/js\/voice\.js/.test(html), "index.html loads js/voice.js");
  ok(/sheet-voice-confirm/.test(html) && /btn-voice-find/.test(html) && /sheet-add-list/.test(html),
    "index mounts several-foods list + confirm");
  ok(/btn-open-add-list/.test(html) && /Type or dictate a list/.test(html), "index mounts list entry");
  ok(/id="add-list-hint"/.test(html) && /id="voice-confirm-hint"/.test(html),
    "index mounts list and confirm hints for gap vs log copy");
  ok(/id="add-title"/.test(html), "index mounts Add food title");
  ok(!/sheet-voice"/.test(html.replace(/sheet-voice-confirm/g, "")), "sheet-voice list sheet removed");
}

console.log(`\nvoice: ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
