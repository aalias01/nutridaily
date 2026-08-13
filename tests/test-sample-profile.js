/* Unit tests for SampleProfile session helpers (no DOM). */
"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function load(name) {
  const code = fs.readFileSync(path.join(ROOT, "js", name), "utf8");
  const sandbox = {
    console,
    module: { exports: {} },
    exports: {},
    SAMPLE_SEED: undefined,
    localStorage: undefined,
    sessionStorage: undefined,
  };
  const mem = Object.create(null);
  const sess = Object.create(null);
  sandbox.localStorage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
    _mem: mem,
  };
  sandbox.sessionStorage = {
    getItem: (k) => (k in sess ? sess[k] : null),
    setItem: (k, v) => { sess[k] = String(v); },
    removeItem: (k) => { delete sess[k]; },
  };
  vm.createContext(sandbox);
  if (name === "sample-profile.js") {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "js/sample-seed.js"), "utf8"), sandbox);
  }
  vm.runInContext(code + `\nthis.__out = (typeof SampleProfile !== "undefined") ? SampleProfile : module.exports;`, sandbox);
  return { SampleProfile: sandbox.__out, localStorage: sandbox.localStorage, sessionStorage: sandbox.sessionStorage };
}

let failed = 0;
function ok(cond, msg, detail) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failed += 1;
    console.log(`  FAIL ${msg}${detail ? " — " + detail : ""}`);
  }
}

console.log("[sample-profile]");
const { SampleProfile, localStorage } = load("sample-profile.js");

ok(!!SampleProfile && typeof SampleProfile.bootstrap === "function", "SampleProfile exports bootstrap");

const applied = [];
SampleProfile.bootstrap({
  todayKey: () => "2026-08-13",
  applyWorkingKeys: (k) => applied.push(k.events),
  reloadActive: () => {},
});
ok(SampleProfile.isSample(), "empty storage boots Sample");
ok(applied[0] === "nd_sample_events_v1", "working events key is sample", applied[0]);
ok(!SampleProfile.sampleStoreEmpty(), "sample store seeded with events");
const sampleEvents = JSON.parse(localStorage.getItem("nd_sample_events_v1"));
ok(Array.isArray(sampleEvents) && sampleEvents.length > 100, "seed has a rich event log", String(sampleEvents && sampleEvents.length));
const sampleWeights = JSON.parse(localStorage.getItem("nd_sample_settings_v1")).weights;
ok(sampleWeights && Object.keys(sampleWeights).length >= 80, "seed has daily weights");

SampleProfile.createReal("Alvin");
ok(!SampleProfile.isSample(), "createReal switches to Real");
ok(SampleProfile.realCreated(), "realCreated flag set");
ok(SampleProfile.realDisplayName() === "Alvin", "display name stored");
ok(JSON.parse(localStorage.getItem("nd_events_v1") || "[]").length === 0, "Real events start empty");

const back = SampleProfile.switchTo("sample");
ok(back.ok && SampleProfile.isSample(), "can switch back to Sample");
ok(SampleProfile.warnNeeded(), "re-entering Sample arms warnings");

SampleProfile.markWarnDismissed();
ok(!SampleProfile.warnNeeded(), "warn cooldown suppresses immediate re-warn");

SampleProfile.resetSample("2026-08-13");
const afterReset = JSON.parse(localStorage.getItem("nd_sample_events_v1"));
ok(Array.isArray(afterReset) && afterReset.length > 100, "resetSample restores rich seed");

// Sync gate helpers: sample keys stay separate from real
ok(localStorage.getItem("nd_events_v1") === "[]" || localStorage.getItem("nd_events_v1") === "[]",
  "Real events remain empty after sample reset");

if (failed) {
  console.log(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("sample-profile tests passed");
