import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO, listRepoFiles } from "../../tools/source-scan.mjs";

const OWN_PROFILE = "--user-" + "data-dir";
const NO_SIGN_IN = "msImplicit" + "Signin";

test("every script that starts a browser with its own profile blocks Edge's implicit sign-in", () => {
  const launchers = listRepoFiles()
    .filter(path => /\.(?:mjs|cjs|js|ts|ps1)$/.test(path) && existsSync(join(REPO, path)))
    .filter(path => readFileSync(join(REPO, path), "utf8").includes(OWN_PROFILE));
  assert.ok(launchers.includes(".claude/skills/run-splitpage-app/driver.mjs"), "the scan should find the app's own driver");
  const missing = launchers.filter(path => !readFileSync(join(REPO, path), "utf8").includes(NO_SIGN_IN));
  assert.deepEqual(missing, []);
});
