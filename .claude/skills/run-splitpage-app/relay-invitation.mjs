import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer } from "node:net";
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

async function membershipAbsent(scope) {
  const idb = globalThis.indexedDB;
  const name = "splitpage-native-replica-log";
  if (!(await idb.databases()).some(database => database.name === name)) return true;
  const read = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await read(idb.open(name));
  try {
    const transaction = db.transaction(["memberships", "invitations"], "readonly");
    const records = await Promise.all(["memberships", "invitations"].map(store => read(transaction.objectStore(store).count(scope))));
    return records.every(count => count === 0);
  } finally {
    db.close();
  }
}

function browserExpression(fn, argument) {
  return `(${fn.toString().replaceAll(/\s*\r?\n\s*/g, " ")})(${JSON.stringify(argument)})`;
}

async function tlsIngress(t, port, relayPort) {
  const [key, cert] = await Promise.all([readFile(process.env.SPLITPAGE_TEST_TLS_KEY), readFile(process.env.SPLITPAGE_TEST_TLS_CERT)]);
  const proxy = createHttpsServer({ key, cert }, (incoming, outgoing) => {
    const upstream = request({ host: "127.0.0.1", port: relayPort, path: incoming.url, method: incoming.method,
      headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  });
  const upgrades = new Set();
  proxy.on("upgrade", (incoming, client, head) => {
    const upstream = connect(relayPort, "127.0.0.1");
    upgrades.add(client);
    client.on("close", () => { upgrades.delete(client); upstream.destroy(); });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    const headers = [];
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.push(incoming.rawHeaders[i] + ": " + incoming.rawHeaders[i + 1]);
    upstream.write([incoming.method + " " + incoming.url + " HTTP/1.1", ...headers, "", ""].join("\r\n"));
    upstream.write(head);
    upstream.pipe(client).pipe(upstream);
  });
  t.after(() => {
    for (const socket of upgrades) socket.destroy();
    proxy.closeAllConnections();
    return new Promise(resolve => proxy.close(resolve));
  });
  proxy.listen(port, "127.0.0.1");
  await once(proxy, "listening");
}

for (const accepted of [true, false]) test(accepted
  ? "a browser joins a seeded relay invitation and reopens its retained copy"
  : "a browser scrubs a rejected invitation without retaining membership", { timeout: 65_000 }, async t => {
  const kit = serverHarness(t);
  const port = await freePort();
  const tls = Boolean(process.env.SPLITPAGE_TEST_TLS_KEY);
  const relayPort = tls ? await freePort() : port;
  const origin = (tls ? "https" : "http") + "://127.0.0.1:" + port;
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
    SPLITPAGE_PORT: String(relayPort), SPLITPAGE_ALLOWED_ORIGINS: origin,
    SPLITPAGE_DEPLOYMENT_ID: deployment, SPLITPAGE_APP_DIR: shell, SPLITPAGE_TEST_REPORT_AUTH: "1"
  });
  const script = await run.createScript(randomUUID(), state);
  const invitation = await run.owner(`scripts/${script}/invitations`, { method: "POST", body: "Browser fixture" });
  assert.equal(invitation.status, 201);
  const { id, token } = await invitation.json();
  if (!accepted) assert.equal((await run.owner("invitations/" + id, { method: "DELETE" })).status, 204);
  if (tls) await tlsIngress(t, port, relayPort);
  const target = origin + "/?join=" + script;
  await writeFile(join(fixture, "invite.html"), `<!doctype html><title>Invitation fixture</title><a id="invite" href="${target}#${token}">Open invitation</a>`);
  const exactUrl = `location.href===${JSON.stringify(target)}`;
  const seeded = 'window.__sharedTest?.read().app?.rows[0]?.audioText==="word"';
  const entry = { deployment, script };
  const suite = join(kit.directory, "join.txt");
  await writeFile(suite, [
    "open /invite.html",
    "click #invite",
    "wait " + exactUrl,
    "expect history.state===null&&history.length===3",
    "wait window.__sharedTest?.invitationSettled()",
    ...(accepted ? ["wait " + seeded, "wait window.__sharedTest.invitationConnected()"] : [
      "expect !(" + seeded + ")&&!window.__sharedTest.invitationConnected()",
      "expect " + browserExpression(membershipAbsent, deployment + "/" + script)
    ]),
    "eval history.back();true",
    'wait location.pathname==="/invite.html"',
    "eval history.forward();true",
    "wait " + exactUrl,
    "expect history.state===null",
    ...(accepted ? [
      "eval location.reload();true",
      "wait " + exactUrl + "&&!!window.__sharedTest&&!(" + seeded + ")",
      "wait " + browserExpression(retainedEntryOpened, entry),
      "expect " + seeded
    ] : ["expect " + browserExpression(membershipAbsent, deployment + "/" + script)])
  ].join("\n"));
  let result;
  try {
    result = await exec(process.execPath, [driver, "--script", suite, "--port", "0", "--cdp-port", String(await freePort()),
      "--root", fixture, "--shot-dir", kit.directory, "--log-console"], { timeout: 55_000, signal: t.signal });
  } catch (error) {
    result = error;
  }
  let logs;
  try {
    await run.stop("clean");
  } finally {
    logs = [result.stdout, result.stderr, run.output(), run.errors()].join("\n");
    assert.equal(logs.includes(token), false, "captured browser and relay logs exclude the token");
  }
  assert.ok(!result.code && !result.killed, logs);
  assert.match(result.stdout, /RESULT: \d+\/\d+ checks passed/);
  assert.ok(run.messages.filter(message => message === "authentication-attempted").length >= (accepted ? 2 : 1));
  if (!accepted) assert.match(result.stdout, /Could not open the shared invitation/);
});
