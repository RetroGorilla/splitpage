import { appJs } from "../build.mjs";
import { STILL_IN_RELEASE, hookNames, leakedHooks } from "./release-hooks.mjs";

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
eq("a hook outside the list is leaked", leakedHooks("window.__newThingTest=1;window.__undoTest=1"), ["__newThingTest"]);
eq("the list is sorted with no repeats", [...new Set(STILL_IN_RELEASE)].sort(), [...STILL_IN_RELEASE]);

console.log("\nthe release build (node build.mjs):\n");

const release = appJs(false);
eq("it exposes exactly the hooks still on the list, so a converted hook leaves the list", hookNames(release), [...STILL_IN_RELEASE]);
check("it does not expose __historyTest", !release.includes("__historyTest"), null);
check("the build flag is replaced, not left as a name", !release.includes("SPLITPAGE_TEST_HOOKS"), null);

console.log("\nthe test build (node build.mjs --test):\n");

const testBuild = appJs(true);
eq("it exposes every hook, the converted ones included", hookNames(testBuild), [...new Set([...STILL_IN_RELEASE, "__historyTest"])].sort());

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
