import { ESLint } from "eslint";
import { REPO } from "./source-scan.mjs";

const eslint = new ESLint({ cwd: REPO });
const expectations = [
  ["desktop/dist/win-unpacked/resources/app/main.js", true],
  ["dist/index.js", true],
  ["desktop/main.ts", false],
  ["desktop/tabstrip/tabstrip.js", false],
  ["desktop/distribution.mjs", false]
];

let failed = 0;
for (const [path, ignored] of expectations) {
  const actual = await eslint.isPathIgnored(path);
  const ok = actual === ignored;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${path} is ${ignored ? "" : "not "}ignored by lint`);
}
console.log(failed ? `\n${failed} failed` : `\nall ${expectations.length} passed`);
process.exitCode = failed ? 1 : 0;
