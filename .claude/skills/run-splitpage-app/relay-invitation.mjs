import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { build } from "../../../build.mjs";
import { serverHarness } from "../../../tests/adapters/collab/native/server-harness.ts";

const exec = promisify(execFile);
const driver = fileURLToPath(new URL("./driver.mjs", import.meta.url));

async function freePort() {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

function retainedEntryOpened(entry) {
  const browser = globalThis;
  browser.retainedAttempt ??= browser.__sharedTest.enterRetained(entry).then(result => {
    if (!result.ok && ["opening-pending", "startup-pending"].includes(result.reason)) {
      delete browser.retainedAttempt;
    } else {
      browser.retainedOpened = result.ok;
    }
  });
  return browser.retainedOpened === true;
}

test("a browser joins a seeded relay invitation and reopens its retained copy", { timeout: 65_000 }, async t => {
  const kit = serverHarness(t);
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  const deployment = randomUUID();
  const shell = join(kit.directory, "shell");
  const fixture = join(kit.directory, "browser");
  await Promise.all([mkdir(shell), mkdir(fixture)]);
  await writeFile(join(shell, "index.html"), build(true));
  for (const file of ["sw.js", "manifest.webmanifest", "icon.svg", "icon-maskable.svg"]) {
    await copyFile(new URL("../../../" + file, import.meta.url), join(shell, file));
  }
  const state = kit.seed();
  const run = kit.launch({
    SPLITPAGE_PORT: String(port), SPLITPAGE_ALLOWED_ORIGINS: origin,
    SPLITPAGE_DEPLOYMENT_ID: deployment, SPLITPAGE_APP_DIR: shell
  });
  const script = await run.createScript(randomUUID(), state);
  const invitation = await run.owner(`scripts/${script}/invitations`, { method: "POST", body: "Browser fixture" });
  assert.equal(invitation.status, 201);
  const { token } = await invitation.json();
  const target = origin + "/?join=" + script;
  await writeFile(join(fixture, "invite.html"), `<!doctype html><title>Invitation fixture</title><a id="invite" href="${target}#${token}">Open invitation</a>`);
  const exactUrl = `location.href===${JSON.stringify(target)}`;
  const seeded = 'window.__sharedTest?.read().app?.rows[0]?.audioText==="word"';
  const entry = JSON.stringify({ deployment, script });
  const suite = join(kit.directory, "join.txt");
  await writeFile(suite, [
    "open /invite.html",
    "click #invite",
    "wait " + exactUrl,
    "expect history.state===null&&history.length===3",
    "wait " + seeded,
    "wait window.__sharedTest.invitationConnected()",
    "eval history.back();true",
    'wait location.pathname==="/invite.html"',
    "eval history.forward();true",
    "wait " + exactUrl,
    "expect history.state===null",
    "eval location.reload();true",
    "wait " + exactUrl + "&&!!window.__sharedTest&&!(" + seeded + ")",
    `wait (${retainedEntryOpened.toString().replaceAll(/\s*\r?\n\s*/g, " ")})(${entry})`,
    "expect " + seeded,
    "logs"
  ].join("\n"));
  let result;
  try {
    result = await exec(process.execPath, [driver, "--script", suite, "--port", "0", "--cdp-port", String(await freePort()),
      "--root", fixture, "--shot-dir", kit.directory], { timeout: 55_000, signal: t.signal });
  } catch (error) {
    result = error;
  }
  const logs = [result.stdout, result.stderr, run.output(), run.errors()].join("\n");
  assert.ok(!logs.includes(token), "captured browser and relay logs exclude the token");
  assert.ok(!result.code && !result.killed, logs);
  assert.match(result.stdout, /RESULT: \d+\/\d+ checks passed/);
});
