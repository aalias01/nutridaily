/* Voice utterance parser unit tests (no DOM / speech required). */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

// Load FoodMatch first so Voice unit tables resolve in Node.
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

ok(typeof Voice.speechSupported === "function", "speechSupported exported");
ok(Voice.speechSupported() === false, "speechSupported is false in Node");

// Shell lists the new module.
{
  const sw = fs.readFileSync(path.join(__dirname, "..", "sw.js"), "utf8");
  ok(/js\/voice\.js/.test(sw), "service worker SHELL includes js/voice.js");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  ok(/js\/voice\.js/.test(html), "index.html loads js/voice.js");
  ok(/sheet-voice-confirm/.test(html) && /btn-voice-list/.test(html),
    "index mounts voice entry + confirm sheets");
}

console.log(`\nvoice: ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
