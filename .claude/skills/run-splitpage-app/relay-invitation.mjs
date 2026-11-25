import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { setTimeout as delayFor } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import { build } from "../../../build.mjs";
import { ORIGIN, serverHarness } from "../../../tests/adapters/collab/native/server-harness.ts";
import { seedRelaySession } from "../../../tests/adapters/collab/native/relay-harness.ts";
import { imageRecordOf } from "../../../src/core/document/media.ts";

const exec = promisify(execFile);
const driver = fileURLToPath(new URL("./driver.mjs", import.meta.url));

async function freePort() {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
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
    const transaction = db.transaction(["memberships", "invitations", "replicas", "journals", "shared-script-catalogue"], "readonly");
    const records = await Promise.all(["memberships", "invitations", "shared-script-catalogue"].map(store => read(transaction.objectStore(store).count(scope))));
    const replicas = await read(transaction.objectStore("replicas").count(IDBKeyRange.bound([scope, 0], [scope, Number.MAX_SAFE_INTEGER])));
    const journal = await read(transaction.objectStore("journals").count(scope));
    return records.every(count => count === 0) && replicas === 0 && journal === 0;
  } finally {
    db.close();
  }
}

function browserExpression(fn, argument) {
  return `(${fn.toString().replaceAll(/\s*\r?\n\s*/g, " ")})(${JSON.stringify(argument)})`;
}

async function relayIngress(t, port, relayPort, { tls, incompatible, unreachable }) {
  let reachable = !unreachable;
  const forward = (incoming, outgoing) => {
    if (!reachable && incoming.method === "HEAD" && incoming.url === "/index.html") {
      outgoing.writeHead(503).end();
      return;
    }
    const upstream = request({ host: "127.0.0.1", port: relayPort, path: incoming.url, method: incoming.method,
      headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { outgoing.writeHead(502); outgoing.end(); });
    incoming.pipe(upstream);
  };
  const proxy = tls ? createHttpsServer({
    key: await readFile(process.env.SPLITPAGE_TEST_TLS_KEY), cert: await readFile(process.env.SPLITPAGE_TEST_TLS_CERT)
  }, forward) : createHttpServer(forward);
  const upgrades = new Set();
  let attempts = 0;
  proxy.on("upgrade", (incoming, client, head) => {
    attempts++;
    const upstream = connect(relayPort, "127.0.0.1");
    upgrades.add(client);
    client.on("close", () => { upgrades.delete(client); upstream.destroy(); });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    const headers = [];
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.push(incoming.rawHeaders[i] + ": " + incoming.rawHeaders[i + 1]);
    const path = incompatible ? incoming.url.replace(/([?&])wire=1(?=&|$)/, "$1wire=2") : incoming.url;
    upstream.write([incoming.method + " " + path + " HTTP/1.1", ...headers, "", ""].join("\r\n"));
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
  return {
    attempts: () => attempts,
    restore() { reachable = true; },
    cutFirst() {
      const first = upgrades.values().next().value;
      assert.ok(first);
      first.destroy();
    }
  };
}

for (const variant of ["accepted", "refused", "deleted", "pictures", "replacement", "restart", "unsupported-version", "retry"]) test(variant === "replacement"
  ? "replacing an invited script stops its pending picture download"
  : variant === "pictures"
  ? "a relay invitation hydrates initial pictures and keeps active transfers independent of entry"
  : variant === "accepted"
  ? "a browser joins a seeded relay invitation, opens shared history and reopens its retained copy"
  : variant === "restart" ? "a dropped snapshot connection restarts exactly once and the browser joins"
  : variant === "unsupported-version" ? "the Join screen explains a real relay version refusal"
  : variant === "retry" ? "Try again checks the same invitation after the relay recovers and joins after another script opens"
  : "a browser scrubs a " + variant + " invitation without retaining membership", { timeout: 65_000 }, async t => {
  const accepted = !["refused", "deleted", "unsupported-version"].includes(variant);
  const pictures = variant === "pictures" || variant === "replacement" ? [1, 2, 3, 4].map(suffix => {
    const bytes = Buffer.concat([Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"), Buffer.from([suffix])]);
    const ref = imageRecordOf(bytes);
    assert.ok(ref);
    return { ref, bytes };
  }) : [];
  const kit = serverHarness(t, 60_000);
  const port = await freePort();
  const tls = Boolean(process.env.SPLITPAGE_TEST_TLS_KEY);
  const useProxy = tls || ["restart", "unsupported-version", "retry"].includes(variant);
  const relayPort = useProxy ? await freePort() : port;
  const origin = (tls ? "https" : "http") + "://127.0.0.1:" + port;
  const deployment = randomUUID();
  const shell = join(kit.directory, "shell");
  const fixture = join(kit.directory, "browser");
  await Promise.all([mkdir(shell), mkdir(fixture)]);
  await writeFile(join(shell, "index.html"), build(true));
  for (const file of ["sw.js", "manifest.webmanifest", "icon.svg", "icon-maskable.svg"]) {
    await copyFile(new URL("../../../" + file, import.meta.url), join(shell, file));
  }
  let state = kit.seed();
  if (pictures.length) {
    const source = seedRelaySession();
    try {
      const id = source.document().rows[0].id;
      assert.equal(source.commands.setField({ kind: "gallery", id }, { imageRef: pictures[0].ref }).kind, "written");
      state = source.encodeState();
    } finally { source.close(); }
  }
  const run = kit.launch({
    SPLITPAGE_PORT: String(relayPort), SPLITPAGE_ALLOWED_ORIGINS: [origin, ORIGIN].join(","),
    SPLITPAGE_DEPLOYMENT_ID: deployment, SPLITPAGE_APP_DIR: shell, SPLITPAGE_TEST_REPORT_AUTH: "1"
  });
  const script = await run.createScript(randomUUID(), state);
  const invitation = await run.owner(`scripts/${script}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "guest", label: "Browser fixture" })
  });
  assert.equal(invitation.status, 201);
  const { id, token } = await invitation.json();
  if (variant === "refused") assert.equal((await run.owner("invitations/" + id, { method: "DELETE" })).status, 204);
  if (variant === "deleted") {
    run.send("delete:" + script);
    await kit.until(() => run.messages.includes("deleted") || undefined);
  }
  if (variant === "accepted" || variant === "restart") {
    run.send("hold-invitation-load");
    await kit.until(() => run.messages.includes("load-armed") || undefined);
  }
  const ingress = useProxy ? await relayIngress(t, port, relayPort, {
    tls, incompatible: variant === "unsupported-version", unreachable: variant === "retry"
  }) : null;
  const target = origin + "/?join=" + script;
  await writeFile(join(fixture, "invite.html"), `<!doctype html><title>Invitation fixture</title><a id="invite" href="${target}#${token}">Open invitation</a>`);
  const exactUrl = `location.href===${JSON.stringify(target)}`;
  const seeded = 'window.__sharedTest?.read().app?.rows[0]?.audioText==="word"';
  const suite = join(kit.directory, "join.txt");
  const pictureUrl = index => origin + "/api/scripts/" + script + "/pictures/" + pictures[index].ref.sha256;
  const resources = index => `performance.getEntriesByName(${JSON.stringify(pictureUrl(index))})`;
  const pending = index => resources(index) + ".some(entry=>entry.responseStatus===404)";
  const rendered = index => `document.querySelector('#rows .visual-media img[data-blob="${pictures[index].ref.sha256}"]')?.naturalWidth===1`;
  const replace = `window.__splitpageFormats.openFile(new File([JSON.stringify({schema:2,title:"Separate script",paragraphsDecided:true,rows:[{id:"separate",audioText:"Separate narration"}]})],"separate.splitpage"))`;
  const reenter = ["open /invite.html", "click #invite", "wait " + exactUrl];
  const summary = "wait !document.querySelector('#join-script-summary')?.hidden && !!document.querySelector('#join-script-summary h3')?.textContent";
  const name = "eval {const name=document.querySelector('#join-script-name');name.value='Guest Editor';document.querySelector('input[name=join-colour][aria-label=Amber]').checked=true;}true";
  const confirmJoin = "click #join-script-modal [type=submit]";
  const cancel = "click #join-script-modal [data-dialog-cancel]";
  const leave = ["click #btn-file", "click [data-file-action=leave-shared-script]",
    "expect document.querySelector('[data-save-copy]')?.textContent.includes('Save a copy first')",
    "click #leave-script-modal [data-leave-script]"];
  const delay = ms => `eval new Promise(resolve=>setTimeout(()=>resolve(true),${ms}))`;
  const pictureSteps = variant === "replacement" ? [
    ...reenter, summary, name, confirmJoin,
    "wait " + pending(0),
    'eval "publish-initial"',
    "wait window.__sharedTest.invitationConnected()", "wait " + rendered(0),
    'eval "show-replacement-reference"',
    "wait " + pending(3), "eval " + replace,
    "wait !window.__sharedTest.invitationConnected()&&window.__splitpageFormats.state().title==='Separate script'",
    "eval window.getCount=" + resources(3) + ".length;true",
    delay(1_750),
    "expect window.getCount===" + resources(3) + ".length"
  ] : variant === "pictures" ? [
    ...reenter, summary, name, confirmJoin,
    "wait " + pending(0),
    "expect !window.__sharedTest.invitationSettled()&&!(" + seeded + ")",
    cancel,
    "wait window.__sharedTest.invitationSettled() && !document.querySelector('#join-script-modal')",
    "expect " + browserExpression(membershipAbsent, deployment + "/" + script),
    'eval "stream-initial-picture"',
    ...reenter, summary, confirmJoin,
    "wait document.querySelector('#join-script-status').textContent.startsWith('Downloading pictures')",
    delay(16_000),
    "expect document.querySelector('#join-script-status').textContent.startsWith('Downloading pictures')",
    "wait " + seeded, "wait window.__sharedTest.invitationConnected()", "wait " + rendered(0),
    'eval "verify-single-provider"',
    delay(15_250),
    'eval "show-late-reference"',
    "wait " + pending(1),
    `wait document.querySelector('#rows .visual-media img[data-blob="${pictures[1]?.ref.sha256}"]')?.alt==="Picture not uploaded yet"`,
    'eval "publish-late"',
    "wait " + rendered(1),
    'eval "show-leave-reference"',
    "wait " + pending(2),
    ...leave,
    "wait !window.__sharedTest.invitationConnected()",
    "expect " + browserExpression(membershipAbsent, deployment + "/" + script),
    "eval window.getCount=" + resources(2) + ".length;true",
    delay(1_750),
    "expect window.getCount===" + resources(2) + ".length"
  ] : null;
  const joinSteps = ["wait " + seeded, "wait window.__sharedTest.invitationConnected()",
    "expect !document.querySelector('#join-script-modal')"];
  const restartSteps = [
    ...reenter, "wait document.querySelector('#join-script-status')?.textContent.startsWith('Loading script')",
    'eval "restart-initial-snapshot"', summary, name, confirmJoin, ...joinSteps
  ];
  const retrySteps = [
    ...reenter, "wait document.querySelector('#join-script-status')?.textContent.startsWith('Could not reach the relay.')",
    "expect document.querySelector('#join-script-modal [type=submit]').textContent==='Try again'",
    'eval "restore-relay"', confirmJoin, summary,
    "eval " + replace, "wait window.__splitpageFormats.state().title==='Separate script'",
    name, confirmJoin, ...joinSteps
  ];
  const refusal = variant === "deleted" ? "was deleted" : variant === "unsupported-version"
    ? "needs a newer version of Splitpage" : "reset or revoked";
  const steps = pictureSteps ?? (variant === "restart" ? restartSteps : variant === "retry" ? retrySteps : [
    "open /invite.html",
    ...(accepted ? ["eval window.open(document.querySelector('#invite').href,'join-peer');true"] : []),
    "click #invite",
    "wait " + exactUrl,
    "expect history.state===null&&history.length===3",
    ...(accepted ? [
      "wait document.querySelector('#join-script-status')?.textContent.startsWith('Loading script')",
      'eval "delay-initial-snapshot"', delay(16_100), summary,
      "expect document.querySelector('#join-script-summary p').textContent==='1 beat · 0 pictures'",
      "expect !document.querySelector('#join-script-identity').hidden",
      name, confirmJoin, "wait window.__sharedTest?.invitationSettled()",
      "wait " + seeded, "wait window.__sharedTest.invitationConnected()",
      "expect localStorage.getItem('splitpage-comment-author')==='Guest Editor'",
      "expect localStorage.getItem('splitpage-person-color')==='#F9B64F'",
      "click #btn-file", "click [data-file-action=history]",
      "wait document.querySelector('[data-shared-version]')",
      "expect document.querySelector('#history-older').hidden",
      "click [data-shared-version]",
      "wait document.querySelector('[aria-label=\"Read-only version\"] article')?.textContent.includes('word')",
      "expect document.querySelector('[data-shared-history=save]').textContent==='Save a copy…'",
      "expect document.querySelector('[data-shared-history=put-back]').textContent==='Put this beat back'",
      "click [data-shared-history=back]", "wait document.querySelector('[data-shared-version]')",
      "click #history-close",
      "eval window.joinPeer=window.open('','join-peer');true",
      "wait window.joinPeer?.document.querySelector('#join-script-summary')?.hidden===false",
      "eval {const peer=window.joinPeer.document;peer.querySelector('#join-script-name').value='Other Editor';peer.querySelector('#join-script-modal [type=submit]').click();}true",
      "wait window.joinPeer.document.querySelector('#join-script-status')?.textContent==='This shared script is already open in another tab.'",
      "eval window.joinPeer.close();true"
    ] : [
      "wait window.__sharedTest?.invitationSettled()",
      "expect document.querySelector('#join-script-status').textContent.includes(" +
        JSON.stringify(refusal) + ")",
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
      "wait " + exactUrl + "&&performance.getEntriesByType('navigation')[0]?.type==='reload'&&(" + seeded + ")",
      "expect !document.querySelector('#join-script-modal')",
      "eval window.__newTab.open();true",
      "wait document.querySelector('#newtab-recents-label')?.textContent==='Shared scripts on this device'",
      "expect document.querySelector('#newtab-recents-list')?.textContent.includes('Your browser can clear local copies.')",
      "expect document.querySelector('#newtab-recents-list')?.textContent.includes('you need to be able to load this app')",
      "expect !!document.querySelector('#newtab-recents-list button[data-shared]')",
      "eval window.__newTab.isOpen() && document.querySelector('[data-newtab-action=dismiss]').click();true",
      ...leave,
      "wait !document.querySelector('#leave-script-modal')",
      "expect " + browserExpression(membershipAbsent, deployment + "/" + script)
    ] : ["expect " + browserExpression(membershipAbsent, deployment + "/" + script)])
  ]);
  await writeFile(suite, steps.join("\n"));
  let peer;
  const writeRef = async index => {
    peer ??= kit.copy(relayPort, undefined, script, token);
    await kit.until(() => peer.relay.status().firstSyncDone || undefined);
    const id = peer.session.document().rows[0].id;
    assert.equal(peer.session.commands.setField({ kind: "gallery", id }, { imageRef: pictures[index].ref }).kind, "written");
  };
  const publish = async index => {
    const response = await fetch(pictureUrl(index), {
      method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": pictures[index].ref.mime },
      body: new Uint8Array(pictures[index].bytes)
    });
    assert.equal(response.status, 201);
  };
  const actions = new Map([
    ["delay-initial-snapshot", async () => {
      await kit.until(() => run.messages.includes("loading") || undefined);
      await delayFor(16_000, undefined, { signal: t.signal });
      run.send("release-invitation-load");
    }],
    ["restart-initial-snapshot", async () => {
      await kit.until(() => run.messages.includes("loading") || undefined);
      assert.equal(ingress?.attempts(), 1);
      ingress.cutFirst();
      await kit.until(() => run.messages.filter(message => message === "authentication-attempted").length === 2 || undefined);
      run.send("release-invitation-load");
    }],
    ["restore-relay", () => ingress.restore()],
    ["stream-initial-picture", async () => {
      run.send({ streamPicture: { sha: pictures[0].ref.sha256, base64: pictures[0].bytes.toString("base64") } });
      await kit.until(() => run.messages.includes("picture-stream-ready") || undefined);
    }],
    ["publish-initial", () => publish(0)], ["show-late-reference", () => writeRef(1)],
    ["publish-late", () => publish(1)], ["show-leave-reference", () => writeRef(2)],
    ["show-replacement-reference", () => writeRef(3)],
    ["verify-single-provider", async () => {
      const status = await (await run.owner("status")).json();
      assert.equal(status.connections.authenticated, 1);
    }]
  ]);
  for (const marker of actions.keys()) if (!steps.includes(`eval "${marker}"`)) actions.delete(marker);
  let result;
  let actionFailure;
  try {
    const running = exec(process.execPath, [driver, "--script", suite, "--port", "0", "--cdp-port", String(await freePort()),
      "--root", fixture, "--shot-dir", kit.directory, "--log-console"], { timeout: 55_000, signal: t.signal });
    let updates = Promise.resolve();
    let seen = "";
    running.child.stdout.on("data", chunk => {
      seen += chunk;
      for (const [marker, action] of actions) {
        if (!seen.split(/\r?\n/).includes(marker)) continue;
        actions.delete(marker);
        updates = updates.then(action);
        void updates.catch(error => { actionFailure = error; running.child.kill(); });
      }
    });
    result = await running;
    await updates;
    assert.equal(actions.size, 0);
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
  if (actionFailure) throw actionFailure;
  assert.ok(!result.code && !result.killed, logs);
  if (variant === "restart") assert.equal(ingress?.attempts(), 3);
  if (variant === "pictures") assert.ok(run.messages.includes("picture-stream-started"));
  assert.match(result.stdout, /RESULT: \d+\/\d+ checks passed/);
  assert.ok(run.messages.filter(message => message === "authentication-attempted").length >= (accepted ? 2 : variant === "deleted" ? 0 : 1));
});

test("a browser joins a passworded relay, re-enters after a live change and a restart, and loses access after reset", { timeout: 60_000 }, async t => {
  const kit = serverHarness(t, 55_000);
  const port = await freePort();
  const origin = "http://127.0.0.1:" + port;
  const deployment = randomUUID();
  const passwords = ["Initial", "Changed", "After reload"].map(prefix => prefix + " " + randomUUID());
  const [initial, changed, restarted] = passwords;
  await writeFile(join(kit.directory, "index.html"), build(true));
  const run = kit.launch({
    SPLITPAGE_PORT: String(port), SPLITPAGE_ALLOWED_ORIGINS: origin, SPLITPAGE_DEPLOYMENT_ID: deployment,
    SPLITPAGE_APP_DIR: kit.directory, SPLITPAGE_TEST_REPORT_AUTH: "1"
  });
  const { scriptId: script, owner, guest } = await run.createScriptWithCredentials(randomUUID(), kit.seed(), undefined, initial);
  const target = origin + "/?join=" + script;
  await writeFile(join(kit.directory, "invite.html"), `<!doctype html><a id="invite" href="${target}#${guest.token}">Open invitation</a>`);
  const banner = "document.getElementById('collab-access-banner')";
  const recovery = "#collab-access-reenter-password";
  const reentryInput = "#link-password-modal input[type=password]";
  const joinSubmit = "click #join-script-modal [type=submit]";
  const connected = "window.__sharedTest?.read().app?.rows[0]?.audioText==='word' && " +
    "document.getElementById('shared-pill')?.getAttribute('aria-label')==='Shared · Connected'";
  const standalone = `window.__splitpageFormats.openFile(new File([JSON.stringify({
    schema: 2, title: "Separate script", paragraphsDecided: true, rows: [{ id: "separate", audioText: "Separate narration" }]
  })], "separate.splitpage"))`.replaceAll(/\s*\r?\n\s*/g, " ");
  const fill = (selector, value) => `eval {document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};}true`;
  const reenter = password => [
    "click " + recovery, "wait document.querySelector(" + JSON.stringify(reentryInput + ":not(:disabled)") + ")",
    fill(reentryInput, password), "click #link-password-modal [type=submit]",
    "wait " + connected, "expect !document.querySelector('#link-password-modal') && " + banner + ".hidden"
  ];
  const commands = [
    "open /invite.html", "click #invite", "wait location.href===" + JSON.stringify(target),
    "wait document.querySelector('#join-script-password-label')?.hidden===false",
    "expect document.activeElement.id==='join-script-password'",
    fill("#join-script-password", "wrong password"), joinSubmit,
    "wait document.querySelector('#join-script-status')?.textContent.startsWith('The password is incorrect')",
    "expect document.querySelector('#join-script-password').value===''",
    fill("#join-script-password", initial), joinSubmit,
    "wait document.querySelector('#join-script-summary')?.hidden===false",
    fill("#join-script-name", "Guest"), joinSubmit, "wait " + connected,
    'eval "change-live"', "wait !" + banner + ".hidden && !document.querySelector('" + recovery + "').hidden",
    ...reenter(changed),
    "eval location.reload();true",
    "wait performance.getEntriesByType('navigation')[0]?.type==='reload' && (" + connected + ")",
    "open /invite.html", "wait location.pathname==='/invite.html'",
    'eval "change-offline"', "wait fetch('/offline-ready.txt', {cache:'no-store'}).then(response=>response.ok)",
    "goto " + origin + "/", "wait window.__splitpageFormats",
    "eval " + standalone,
    "wait window.__splitpageFormats.state().title==='Separate script' && !document.getElementById('shared-pill')",
    "eval window.__newTab.open();true",
    "wait document.querySelector('#newtab-recents-list button[data-shared]')",
    "click #newtab-recents-list button[data-shared]",
    "wait document.querySelector('#newtab-page')?.hidden === true",
    "wait window.__sharedTest?.read().app?.rows[0]?.audioText==='word'",
    "wait !" + banner + ".hidden && !document.querySelector('" + recovery + "').hidden",
    'eval "start-retry-check"', "eval new Promise(resolve=>setTimeout(()=>resolve(true), 2300))", 'eval "check-no-retry"',
    ...reenter(restarted),
    'eval "reset-link"', "wait !" + banner + ".hidden && document.querySelector('" + recovery + "').hidden",
    "expect !document.querySelector('#collab-access-export').hidden && !document.querySelector('#collab-access-leave').hidden",
    "quit"
  ];
  const suite = join(kit.directory, "password-join.txt");
  await writeFile(suite, commands.join("\n"));
  const change = async password => {
    const response = await run.owner(`scripts/${script}/password`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password })
    }, owner.token);
    assert.equal(response.status, 204);
  };
  const attempts = () => run.messages.filter(message => message === "authentication-attempted").length;
  let before = 0;
  const actions = new Map([
    ["change-live", () => change(changed)],
    ["change-offline", async () => {
      await change(restarted);
      await writeFile(join(kit.directory, "offline-ready.txt"), "ready");
    }],
    ["start-retry-check", () => { before = attempts(); }],
    ["check-no-retry", () => { assert.equal(attempts(), before); }],
    ["reset-link", async () => {
      assert.equal((await run.owner(`scripts/${script}/reset`, { method: "POST" }, owner.token)).status, 200);
    }]
  ]);
  const running = exec(process.execPath, [driver, "--script", suite, "--port", "0", "--cdp-port", String(await freePort()),
    "--root", kit.directory, "--shot-dir", kit.directory, "--log-console"], { timeout: 45_000, signal: t.signal });
  let seen = "";
  let work = Promise.resolve();
  let actionFailure;
  running.child.stdout.on("data", chunk => {
    seen += chunk;
    for (const [marker, action] of actions) {
      if (!seen.split(/\r?\n/).includes(marker)) continue;
      actions.delete(marker);
      work = work.then(action);
      void work.catch(error => { actionFailure = error; running.child.kill(); });
    }
  });
  const result = await running.catch(error => error);
  await work;
  await run.stop("clean");
  const logs = [result.stdout, result.stderr, run.output(), run.errors()].join("\n");
  for (const secret of [...passwords, guest.token, owner.token]) {
    assert.equal(logs.includes(secret), false, "captured logs must exclude passwords and invitations");
  }
  if (actionFailure) throw actionFailure;
  assert.ok(!result.code && !result.killed, logs);
  assert.equal(actions.size, 0);
  assert.match(result.stdout, /RESULT: \d+\/\d+ checks passed/);
});
