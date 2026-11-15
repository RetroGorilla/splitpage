import { appJs } from "../build.mjs";
import { HISTORY_TEST_NAMES, STILL_IN_RELEASE, historyTestNames, hookNames, leakedHooks } from "./release-hooks.mjs";

const APPROVED = Object.freeze([]);

const CONVERTED = Object.freeze([
  "__annotateTest",
  "__appDataTest",
  "__blobsTest",
  "__brollTest",
  "__cacheTest",
  "__commandTest",
  "__desktopTest",
  "__documentGuardTest",
  "__exportTest",
  "__fileMenuTest",
  "__historyTest",
  "__prompterTest",
  "__renderTest",
  "__rundownTest",
  "__saveStatusTest",
  "__sceneSelectTest",
  "__settingsTest",
  "__sharedTest",
  "__splitpageFormats",
  "__targetTest",
  "__undoTest",
  "__updateTest",
  "__videoTest",
  "__writerFlowTest"
]);

const FAKE_DESKTOP = Object.freeze(["_failNextDraftWrites", "_blobFailNext", "0.0.0-test"]);

const HOOK_ONLY = Object.freeze(["idbRecord", "idleFlushes"]);

const SHARED_HOOK_ONLY = Object.freeze([
  "The peer has left",
  "The peer beat is missing",
  "The peer buffer is unavailable",
  "draft-not-kept",
  "The shared session did not start",
  "The draft writer did not detach",
  "Your writing was kept in recovery.",
  "This line changed. Try writing again.",
  "The Writer could not settle",
  "ownershipScans",
  "appliedUpdates",
  "The late joiner has not joined",
  "The name is already given to another identity",
  "lateJoiner",
  "joinerType",
  "joinerUndo",
  "recoveryEntries",
  "nameIdentities",
  "nameBeat",
  "enterFrom",
  "refusedUpdate",
  "stopReplay",
  "There is no refused update of that kind",
  "The stored shared state is incomplete",
  "splitpage.timingMarks"
]);

const TIMING_MARKS = Object.freeze(["trial", "live-apply", "mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry", "render",
  "input-handler", "input-command", "input-write"].flatMap((seam) => [`measure:${seam}:start`, `measure:${seam}:end`]));

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log("  ok   " + name); return; }
  failures.push(name + (detail ? " — " + detail : ""));
  console.log("  FAIL " + name + (detail ? " — " + detail : ""));
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log("\nthe hook scan:\n");

eq("names are found once each and sorted", hookNames("window.__bTest=1;a.__aTest;window.__bTest"), ["__aTest", "__bTest"]);
eq("a longer name is not a hook name", hookNames("__historyTester __history"), []);
eq("the formats global is a hook name too", hookNames("window.__splitpageFormats.state();a.__splitpageFormatsX"), ["__splitpageFormats"]);
eq("a hook outside the list is leaked", leakedHooks("window.__newThingTest=1;window.__blobsTest=1"), ["__blobsTest", "__newThingTest"]);
eq("every history fault and distinctive control name is rejected", leakedHooks(HISTORY_TEST_NAMES.join(" ")), [...HISTORY_TEST_NAMES].sort());
eq("a longer word is not a history control", historyTestNames("inspection resetForTester failNextTime"), []);
eq("the list is sorted with no repeats", [...new Set(STILL_IN_RELEASE)].sort(), [...STILL_IN_RELEASE]);
eq("the list adds no hook and brings none back: every name is in the approved snapshot", STILL_IN_RELEASE.filter((name) => !APPROVED.includes(name)), []);
eq("a converted hook leaves the approved snapshot too, so it cannot come back later", APPROVED.filter((name) => !STILL_IN_RELEASE.includes(name)), []);
console.log("\nthe release build (node build.mjs):\n");

const release = appJs(false);
eq("it exposes exactly the hooks still on the list, so a converted hook leaves the list", hookNames(release), [...STILL_IN_RELEASE]);
eq("no converted hook name is left in it", CONVERTED.filter((name) => release.includes(name)), []);
check("the build flag is replaced, not left as a name", !release.includes("SPLITPAGE_TEST_HOOKS"), null);
eq("the fake desktop backend and its fault switches are left out", FAKE_DESKTOP.filter((marker) => release.includes(marker)), []);
eq("the render counters and blob store controls are left out", HOOK_ONLY.filter((marker) => release.includes(marker)), []);
eq("history fault queues, controls and inspection code are left out", historyTestNames(release), []);
eq("the shared session hook, its peer and their notices are left out", SHARED_HOOK_ONLY.filter((marker) => release.includes(marker)), []);
eq("no timing mark is left in it", TIMING_MARKS.filter((mark) => release.includes(mark)), []);
check("no timing mark name of any kind is left in it", !release.includes("measure:"), null);

console.log("\nthe test build (node build.mjs --test):\n");

const testBuild = appJs(true);
eq("it exposes every hook, the converted ones included", hookNames(testBuild), [...STILL_IN_RELEASE, ...CONVERTED].sort());
eq("a converted hook is never also on the list", CONVERTED.filter((name) => STILL_IN_RELEASE.includes(name)), []);
eq("it keeps the fake desktop backend and its fault switches", FAKE_DESKTOP.filter((marker) => !testBuild.includes(marker)), []);
eq("it keeps the render counters and blob store controls", HOOK_ONLY.filter((marker) => !testBuild.includes(marker)), []);
eq("it keeps every history fault and distinctive control name", historyTestNames(testBuild), [...HISTORY_TEST_NAMES].sort());
eq("it keeps the shared session hook, its peer and their notices", SHARED_HOOK_ONLY.filter((marker) => !testBuild.includes(marker)), []);
eq("it keeps every timing mark", TIMING_MARKS.filter((mark) => !testBuild.includes(mark)), []);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
