import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { build } from "../../../../build.mjs";
import { readInvitationSnapshot } from "../../../../src/adapters/collab/native/invitation-snapshot.ts";
import { ORIGIN, serverHarness } from "./server-harness.ts";

test("the relay serves the shell and the gated app replaces the invite history entry", async t => {
  const kit = serverHarness(t);
  const shell = build(true);
  await writeFile(join(kit.directory, "index.html"), shell);
  for (const file of ["sw.js", "manifest.webmanifest", "icon.svg", "icon-maskable.svg"]) {
    await writeFile(join(kit.directory, file), await readFile(new URL("../../../../" + file, import.meta.url)));
  }
  const deployment = randomUUID();
  const state = kit.seed();
  const run = kit.launch({ SPLITPAGE_APP_DIR: kit.directory, SPLITPAGE_DEPLOYMENT_ID: deployment });
  const origin = "http://127.0.0.1:" + await run.port();
  const scriptId = await run.createScript(randomUUID(), state);
  const issued = await run.owner(`scripts/${scriptId}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "guest", label: "Browser fixture" })
  });
  assert.equal(issued.status, 201);
  const { token } = await issued.json();
  const path = "/?join=" + scriptId;
  const response = await globalThis.fetch(origin + path + "#" + token);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await response.text();
  assert.ok(html === shell);
  const head = await globalThis.fetch(origin + "/index.html", { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(shell)));
  assert.equal(head.headers.get("splitpage-deployment"), deployment);
  assert.equal(await head.text(), "");
  const desktopHead = await globalThis.fetch(origin + "/api/deployment", { method: "HEAD", headers: { Origin: ORIGIN } });
  assert.equal(desktopHead.headers.get("splitpage-deployment"), deployment);
  assert.equal(desktopHead.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(desktopHead.headers.get("access-control-expose-headers"), "Splitpage-Deployment");
  const unlisted = await globalThis.fetch(origin + "/api/deployment", { method: "HEAD", headers: { Origin: "https://unknown.invalid" } });
  assert.equal(unlisted.headers.get("access-control-allow-origin"), null);
  assert.equal(unlisted.headers.get("access-control-expose-headers"), null);
  const getDeployment = await globalThis.fetch(origin + "/api/deployment", { headers: { Origin: ORIGIN } });
  assert.equal(getDeployment.headers.get("splitpage-deployment"), null);
  assert.equal(await getDeployment.text(), "Welcome to Hocuspocus!");
  for (const file of ["sw.js", "manifest.webmanifest", "icon.svg", "icon-maskable.svg"]) {
    assert.equal((await globalThis.fetch(origin + "/" + file)).status, 200);
  }
  assert.equal(await (await globalThis.fetch(origin + "/api/index.html")).text(), "Welcome to Hocuspocus!");
  const picture = origin + "/api/scripts/" + scriptId + "/pictures/" + "0".repeat(64);
  assert.equal((await globalThis.fetch(picture)).status, 403);
  assert.equal((await globalThis.fetch(picture, { headers: { Authorization: "Bearer " + token } })).status, 404);

  const browserLogs = [];
  const virtualConsole = new VirtualConsole();
  for (const event of ["log", "info", "warn", "error", "debug", "jsdomError"]) {
    virtualConsole.on(event, (...args) => browserLogs.push(args.map(String).join(" ")));
  }
  const page = new JSDOM(html, { url: origin + path + "#" + token, runScripts: "outside-only", virtualConsole });
  t.after(() => page.window.close());
  const script = page.window.document.querySelector("#app-logic")?.textContent ?? "";
  const bundleStart = script.indexOf("(()=>");
  assert.ok(bundleStart > 0);
  page.window.eval(script.slice(0, bundleStart));
  assert.ok(page.window.location.href === origin + path);
  assert.equal(page.window.history.length, 1);
  assert.equal(page.window.history.state, null);
  assert.equal(build(false).includes('url.searchParams.has("join")'), true);
  assert.equal(build(false, false).includes('url.searchParams.has("join")'), false);
  const relay = origin.replace(/^http/, "ws");
  assert.deepEqual(await readInvitationSnapshot(relay, scriptId, token, t.signal), state);
  const wrongToken = randomBytes(32).toString("base64url");
  await assert.rejects(readInvitationSnapshot(relay, scriptId, wrongToken, t.signal), {
    message: "Could not load the shared script from the relay."
  });
  const logs = [run.output(), run.errors(), ...browserLogs].join("\n");
  assert.ok(!logs.includes(token) && !logs.includes(wrongToken));
});

test("deployment discovery returns 404 when the relay has no deployment ID", async t => {
  const run = serverHarness(t).launch({ SPLITPAGE_DEPLOYMENT_ID: undefined });
  const response = await globalThis.fetch("http://127.0.0.1:" + await run.port() + "/api/deployment", { method: "HEAD" });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("splitpage-deployment"), null);
});
