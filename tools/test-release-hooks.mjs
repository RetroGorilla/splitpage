import { appJs } from "../build.mjs";
import { STILL_IN_RELEASE, hookNames, leakedHooks } from "./release-hooks.mjs";

const APPROVED = Object.freeze([
  "__annotateTest",
  "__appDataTest",
  "__blobsTest",
  "__brollTest",
  "__cacheTest",
  "__commandTest",
  "__desktopTest",
  "__exportTest",
  "__fileMenuTest",
  "__prompterTest",
  "__renderTest",
  "__rundownTest",
  "__saveStatusTest",
  "__sceneSelectTest",
  "__settingsTest",
  "__targetTest",
  "__updateTest",
  "__videoTest"
]);

const CONVERTED = Object.freeze(["__documentGuardTest", "__historyTest", "__splitpageFormats", "__undoTest"]);

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
eq("a hook outside the list is leaked", leakedHooks("window.__newThingTest=1;window.__videoTest=1"), ["__newThingTest"]);
eq("the list is sorted with no repeats", [...new Set(STILL_IN_RELEASE)].sort(), [...STILL_IN_RELEASE]);
eq("the list adds no hook and brings none back: every name is in the approved snapshot", STILL_IN_RELEASE.filter((name) => !APPROVED.includes(name)), []);
eq("a converted hook leaves the approved snapshot too, so it cannot come back later", APPROVED.filter((name) => !STILL_IN_RELEASE.includes(name)), []);
console.log("\nthe release build (node build.mjs):\n");

const release = appJs(false);
eq("it exposes exactly the hooks still on the list, so a converted hook leaves the list", hookNames(release), [...STILL_IN_RELEASE]);
eq("no converted hook name is left in it", CONVERTED.filter((name) => release.includes(name)), []);
check("the build flag is replaced, not left as a name", !release.includes("SPLITPAGE_TEST_HOOKS"), null);

console.log("\nthe test build (node build.mjs --test):\n");

const testBuild = appJs(true);
eq("it exposes every hook, the converted ones included", hookNames(testBuild), [...STILL_IN_RELEASE, ...CONVERTED].sort());
eq("a converted hook is never also on the list", CONVERTED.filter((name) => STILL_IN_RELEASE.includes(name)), []);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
