import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import { createEncoder, toUint8Array, writeVarString, writeVarUint } from "lib0/encoding";
import { WebSocket } from "ws";
import type { RelayStatusSnapshot } from "../../../../collab-server/status.ts";
import { openNativeRelay } from "../../../../src/adapters/collab/native/relay.ts";
import type { NativeRelayEvent } from "../../../../src/adapters/collab/native/relay.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { seedRelaySession } from "./relay-harness.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ORIGIN = "splitpage://app";
const SESSION_OPTIONS = { actor: "writer", sanitize: (text: unknown) => typeof text === "string" ? text : "" };

function makePng(tag: string): { bytes: Buffer; sha: string } {
  const header = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
  const bytes = Buffer.concat([header, Buffer.from(tag, "utf8")]);
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

function docker(args: string[], options: { cwd?: string; input?: string } = {}): string {
  return execFileSync("docker", args, {
    cwd: options.cwd ?? REPO,
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined> | T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  docker(["info", "--format", "{{.ServerVersion}}"]);

  const runId = randomUUID().slice(0, 8);
  const image = `splitpage-relay-smoke:${runId}`;
  const containerA = `splitpage-relay-smoke-${runId}-a`;
  const containerB = `splitpage-relay-smoke-${runId}-b`;
  const volume = `splitpage-relay-smoke-data-${runId}`;
  const temp = mkdtempSync(join(tmpdir(), "splitpage-relay-smoke-"));
  const managementSecret = randomBytes(32).toString("base64url");
  const wrongSecret = randomBytes(32).toString("base64url");
  const deployment = randomUUID();
  const envFile = join(temp, "relay.env");
  const relays: ReturnType<typeof openNativeRelay>[] = [];
  const sockets: WebSocket[] = [];
  const WebSocketBefore = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true, writable: true, value: class extends WebSocket {
      constructor(url: string) { super(url, { origin: ORIGIN }); }
    }
  });

  function startContainer(name: string): void {
    docker([
      "run", "-d",
      "--name", name,
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--cpus", "2",
      "--memory", "2g",
      "--pids-limit", "128",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--stop-timeout", "20",
      "--publish", "127.0.0.1::8080",
      "--env-file", envFile,
      "--mount", `type=volume,source=${volume},target=/data`,
      image
    ]);
  }

  async function waitForPort(name: string): Promise<number> {
    await waitFor(`${name} listening log`, () => {
      const logs = docker(["logs", name]);
      return logs.includes("Relay listening on port 8080.") ? true : undefined;
    });
    const portLine = docker(["port", name, "8080/tcp"]).split(/\r?\n/)[0] ?? "";
    const port = Number(/:(\d+)$/.exec(portLine)?.[1]);
    assert.ok(Number.isInteger(port) && port > 0, `Could not resolve container port from "${portLine}".`);
    return port;
  }

  try {
    docker(["build", "-f", "collab-server/Dockerfile", "-t", image, "."]);
    docker(["volume", "create", volume]);

    writeFileSync(envFile, [
      "SPLITPAGE_DATA_DIR=/data",
      "SPLITPAGE_PORT=8080",
      "TMPDIR=/tmp",
      `SPLITPAGE_ALLOWED_ORIGINS=${ORIGIN}`,
      `SPLITPAGE_MANAGEMENT_SECRET=${managementSecret}`,
      `SPLITPAGE_DEPLOYMENT_ID=${deployment}`,
      "SPLITPAGE_STORE_DEBOUNCE_MS=40",
      "SPLITPAGE_STORE_MAX_DEBOUNCE_MS=100",
      "SPLITPAGE_BACKUP_KEEP=2",
      "SPLITPAGE_MAX_CONNECTIONS=4",
      "SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION=2",
      "SPLITPAGE_MAX_MESSAGES_PER_SECOND=6",
      "SPLITPAGE_MAX_UPLOADS_IN_FLIGHT=2"
    ].join("\n") + "\n", { mode: 0o600 });

    startContainer(containerA);
    const portA = await waitForPort(containerA);

    const probeResult = JSON.parse(docker([
      "exec", containerA, "node", "-e", [
        "import { writeFileSync, unlinkSync } from 'node:fs';",
        "let rootCode = '';",
        "try { writeFileSync(process.cwd() + '/ro-probe', 'x'); } catch (e) { rootCode = e.code; }",
        "writeFileSync('/tmp/rw-probe', 'ok'); unlinkSync('/tmp/rw-probe');",
        "let tmpLimitCode = '';",
        "try { writeFileSync('/tmp/overflow-probe', Buffer.alloc(17 * 1024 * 1024)); } catch (e) { tmpLimitCode = e.code; }",
        "try { unlinkSync('/tmp/overflow-probe'); } catch {}",
        "process.stdout.write(JSON.stringify({ uid: process.getuid(), rootCode, tmpLimitCode }));"
      ].join("\n")
    ])) as { uid: number; rootCode: string; tmpLimitCode: string };
    assert.notEqual(probeResult.uid, 0);
    assert.equal(probeResult.rootCode, "EROFS");
    assert.equal(probeResult.tmpLimitCode, "ENOSPC");

    const baseHttpA = `http://127.0.0.1:${portA}`;
    const wsUrlA = `ws://127.0.0.1:${portA}`;
    const shell = await fetch(baseHttpA + "/");
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(shell.headers.get("splitpage-deployment"), deployment);
    assert.equal(shell.headers.get("cache-control"), "no-cache");
    const html = await shell.text();
    assert.match(html, /<title>Splitpage<\/title>/i);
    assert.match(html, /id="state-data"/);
    assert.equal(html.includes("{{SEED_STATE}}"), false);
    const shellHead = await fetch(baseHttpA + "/index.html", { method: "HEAD" });
    assert.equal(shellHead.status, 200);
    assert.equal(shellHead.headers.get("splitpage-deployment"), deployment);
    assert.equal(Number(shellHead.headers.get("content-length")), Buffer.byteLength(html));
    assert.equal(await shellHead.text(), "");

    for (const [path, contentType, marker] of [
      ["/sw.js", "text/javascript; charset=utf-8", /splitpage-\d/],
      ["/manifest.webmanifest", "application/manifest+json", /"name"\s*:\s*"Splitpage"/i],
      ["/icon.svg", "image/svg+xml", /<svg\b/],
      ["/icon-maskable.svg", "image/svg+xml", /<svg\b/]
    ] as const) {
      const asset = await fetch(baseHttpA + path);
      assert.equal(asset.status, 200, path);
      assert.equal(asset.headers.get("content-type"), contentType, path);
      assert.equal(asset.headers.get("splitpage-deployment"), null, path);
      assert.match(await asset.text(), marker, path);
    }

    async function ownerFetch(baseHttp: string, path: string, init: RequestInit = {}, secret: string | null = managementSecret) {
      const headers = new Headers(init.headers);
      if (secret !== null) headers.set("Authorization", `Bearer ${secret}`);
      return fetch(`${baseHttp}/api/${path}`, { ...init, headers });
    }

    const seed = seedRelaySession();
    const seedBytes = seed.encodeState();
    seed.close();
    const creationId = randomUUID();
    const seedHash = createHash("sha256").update(seedBytes).digest("hex");
    const createHeaders = { "Idempotency-Key": creationId, "Splitpage-Content-SHA256": seedHash };
    assert.equal((await ownerFetch(baseHttpA, "scripts", { method: "POST", headers: createHeaders, body: Buffer.from(seedBytes) }, null)).status, 401);
    assert.equal((await ownerFetch(baseHttpA, "scripts", { method: "POST", headers: createHeaders, body: Buffer.from(seedBytes) }, wrongSecret)).status, 401);
    const createdReply = await ownerFetch(baseHttpA, "scripts", { method: "POST", headers: createHeaders, body: Buffer.from(seedBytes) });
    assert.equal(createdReply.status, 200);
    const { scriptId } = await createdReply.json() as { scriptId: string };

    const issueReply1 = await ownerFetch(baseHttpA, `scripts/${scriptId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "owner", label: "Smoke One" })
    });
    const issueReply2 = await ownerFetch(baseHttpA, `scripts/${scriptId}/invitations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "guest", label: "Smoke Two" })
    });
    assert.equal(issueReply1.status, 201);
    assert.equal(issueReply2.status, 201);
    const firstInvite = await issueReply1.json() as { id: string; token: string };
    const secondInvite = await issueReply2.json() as { id: string; token: string };

    const badOrigin = new WebSocket(wsUrlA, { origin: "https://disallowed.example.test" });
    sockets.push(badOrigin);
    badOrigin.on("error", () => undefined);
    const [, badOriginResponse] = await once(badOrigin, "unexpected-response") as [unknown, IncomingMessage];
    assert.equal(badOriginResponse.statusCode, 401);

    const oversized = new WebSocket(wsUrlA, { origin: ORIGIN });
    sockets.push(oversized);
    oversized.on("error", () => undefined);
    await once(oversized, "open");
    const oversizedClosed = once(oversized, "close");
    oversized.send(Buffer.alloc(16_000_001));
    assert.equal((await oversizedClosed)[0], 1009);

    const pendingFlood = new WebSocket(wsUrlA, { origin: ORIGIN });
    sockets.push(pendingFlood);
    pendingFlood.on("error", () => undefined);
    await once(pendingFlood, "open");
    const pendingClosed = once(pendingFlood, "close");
    for (let i = 0; i <= 10; i++) {
      const encoder = createEncoder();
      writeVarString(encoder, `private-unauth-${i}`);
      writeVarUint(encoder, MessageType.Sync);
      pendingFlood.send(toUint8Array(encoder));
    }
    await pendingClosed;

    const changed = new EventEmitter();
    function openCopy(wsUrl: string, name: string, token: string) {
      const session = openNativeSession({ kind: "empty" }, SESSION_OPTIONS);
      const events: NativeRelayEvent[] = [];
      session.subscribe(() => changed.emit("change"));
      const relay = openNativeRelay(session, {
        url: wsUrl, name, token, sessionOptions: SESSION_OPTIONS,
        onEvent(event) { events.push(event); changed.emit("change"); }
      });
      relays.push(relay);
      return { session, events, relay, text: () => session.document().rows[0]?.audioText };
    }

    const wrong = openCopy(wsUrlA, scriptId, randomBytes(32).toString("base64url"));
    const wrongEvent = await waitFor("wrong token refusal", () =>
      wrong.events.find((event): event is Extract<NativeRelayEvent, { kind: "authentication-failed" }> =>
        event.kind === "authentication-failed"));
    assert.equal(wrongEvent.reason, "permission-denied");

    const unknown = openCopy(wsUrlA, "unknown-script", firstInvite.token);
    const unknownEvent = await waitFor("unknown script refusal", () =>
      unknown.events.find((event): event is Extract<NativeRelayEvent, { kind: "authentication-failed" }> =>
        event.kind === "authentication-failed"));
    assert.equal(unknownEvent.reason, "script-unknown");

    const badVersionEvents = new EventTarget();
    let badVersionReason = "";
    const badVersion = new HocuspocusProvider({
      url: `${wsUrlA}?wire=1&schema=99`, name: scriptId, token: firstInvite.token, awareness: null,
      onAuthenticationFailed({ reason }) { badVersionReason = reason; badVersionEvents.dispatchEvent(new Event("change")); }
    });
    try {
      while (!badVersionReason) await once(badVersionEvents, "change");
      assert.equal(badVersionReason, "unsupported-version");
    } finally {
      badVersion.destroy();
      badVersion.document.destroy();
    }

    const first = openCopy(wsUrlA, scriptId, firstInvite.token);
    const second = openCopy(wsUrlA, scriptId, firstInvite.token);
    await waitFor("two peers synced", () => (
      first.relay.status().firstSyncDone && second.relay.status().firstSyncDone &&
      first.text() === "word" && second.text() === "word"
    ) || undefined);

    const anchor = first.session.commands.anchorText({ beat: "R", cell: "narration" }, 4);
    assert.equal(anchor.kind, "anchored");
    assert.equal(first.session.commands.typeText(anchor.range, " container", {}).kind, "written");
    await waitFor("peer received edit", () => second.text() === "word container" || undefined);

    const third = openCopy(wsUrlA, scriptId, firstInvite.token);
    const perInviteRefusal = await waitFor("per-invitation refusal", () =>
      third.events.find((event): event is Extract<NativeRelayEvent, { kind: "temporary-refusal" }> =>
        event.kind === "temporary-refusal"));
    assert.equal(perInviteRefusal.reason, "too-many-connections");
    third.relay.close();

    async function readStatus(baseHttp: string): Promise<{ raw: string; data: RelayStatusSnapshot }> {
      const response = await ownerFetch(baseHttp, "status");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const raw = await response.text();
      return { raw, data: JSON.parse(raw) as RelayStatusSnapshot };
    }
    await waitFor("two open sockets before total-limit check", async () => {
      const { data } = await readStatus(baseHttpA);
      return data.connections.total === 2 ? true : undefined;
    });

    const extraA = new WebSocket(wsUrlA, { origin: ORIGIN });
    const extraB = new WebSocket(wsUrlA, { origin: ORIGIN });
    sockets.push(extraA, extraB);
    extraA.on("error", () => undefined);
    extraB.on("error", () => undefined);
    await Promise.all([once(extraA, "open"), once(extraB, "open")]);

    const overTotal = new WebSocket(wsUrlA, { origin: ORIGIN });
    sockets.push(overTotal);
    overTotal.on("error", () => undefined);
    const [, totalRefusal] = await once(overTotal, "unexpected-response") as [unknown, IncomingMessage];
    assert.equal(totalRefusal.statusCode, 503);
    assert.equal(totalRefusal.headers["retry-after"], "5");
    extraA.terminate();
    extraB.terminate();

    for (let i = 0; i < 12; i++) first.session.ydoc.getArray("smoke-burst").push([i]);
    const rateRefusal = await waitFor("rate limit refusal", () =>
      first.events.find((event): event is Extract<NativeRelayEvent, { kind: "temporary-refusal" }> =>
        event.kind === "temporary-refusal" && event.reason === "rate-limited"));
    assert.equal(rateRefusal.reason, "rate-limited");

    assert.equal((await ownerFetch(baseHttpA, "status", {}, null)).status, 401);
    assert.equal((await ownerFetch(baseHttpA, "status", {}, wrongSecret)).status, 401);
    assert.equal((await ownerFetch(baseHttpA, "status", { method: "POST" })).status, 405);
    const { data: beforeData } = await readStatus(baseHttpA);
    assert.ok(beforeData.connections.authenticated >= 1);
    assert.ok(beforeData.storedBytes > 0);
    assert.equal(beforeData.pictureBytes, 0);
    assert.equal(beforeData.lastStorageFailure, null);
    assert.equal(beforeData.lastBackupAt, null);

    const smokePngA = makePng("container-smoke-a");
    const smokePngB = makePng("container-smoke-b");
    const smokePngC = makePng("container-smoke-c");
    function startPictureUpload(picture: { bytes: Buffer; sha: string }) {
      const req = httpRequest(`${baseHttpA}/api/scripts/${scriptId}/pictures/${picture.sha}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${secondInvite.token}`,
          "content-type": "image/png",
          "content-length": String(picture.bytes.length)
        }
      });
      req.on("error", () => undefined);
      const response = new Promise<IncomingMessage>((resolve, reject) => {
        req.once("response", resolve);
        req.once("error", reject);
      });
      response.catch(() => undefined);
      req.write(picture.bytes.subarray(0, 12));
      return { req, response };
    }
    const uploadA = startPictureUpload(smokePngA);
    const uploadB = startPictureUpload(smokePngB);
    try {
      await waitFor("two in-flight picture uploads", async () => {
        const { data } = await readStatus(baseHttpA);
        return data.uploadsInFlight === 2 ? true : undefined;
      });
      const uploadC = startPictureUpload(smokePngC);
      try {
        const uploadRefused = await uploadC.response;
        assert.equal(uploadRefused.statusCode, 503);
        assert.equal(uploadRefused.headers["retry-after"], "5");
        assert.equal(uploadRefused.headers["cache-control"], "no-store");
        uploadRefused.resume();
      } finally {
        uploadC.req.destroy();
      }
      uploadA.req.destroy();
      uploadB.req.end(smokePngB.bytes.subarray(12));
      const uploadBReply = await uploadB.response;
      assert.equal(uploadBReply.statusCode, 201);
      uploadBReply.resume();
    } finally {
      uploadA.req.destroy();
      uploadB.req.destroy();
    }
    await waitFor("picture upload settled", async () => {
      const { data } = await readStatus(baseHttpA);
      return data.uploadsInFlight === 0 && data.pictureBytes === smokePngB.bytes.length ? true : undefined;
    });
    const downloadedA = await fetch(`${baseHttpA}/api/scripts/${scriptId}/pictures/${smokePngB.sha}`, {
      headers: { authorization: `Bearer ${secondInvite.token}` }
    });
    assert.equal(downloadedA.status, 200);
    assert.deepEqual(Buffer.from(await downloadedA.arrayBuffer()), smokePngB.bytes);
    assert.equal((await readStatus(baseHttpA)).data.lastBackupAt, null);

    const backupOutput = docker(["exec", containerA, "node", "backup-command.ts"]);
    assert.match(backupOutput, /^Verified relay backup relay-.*\.backup\.$/);

    const { raw: statusAfterRaw, data: afterData } = await readStatus(baseHttpA);
    assert.ok(afterData.lastBackupAt !== null);
    assert.match(afterData.lastBackupAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.equal(afterData.pictureBytes, smokePngB.bytes.length);
    for (const secretValue of [managementSecret, wrongSecret, firstInvite.token, secondInvite.token, scriptId, creationId, smokePngB.sha, "Smoke One", "word container"]) {
      assert.equal(statusAfterRaw.includes(secretValue), false);
    }

    assert.equal((await ownerFetch(baseHttpA, `invitations/${firstInvite.id}`, { method: "DELETE" })).status, 204);
    const revokedEvent = await waitFor("live revocation", () =>
      second.events.find((event): event is Extract<NativeRelayEvent, { kind: "authentication-failed" }> =>
        event.kind === "authentication-failed"));
    assert.equal(revokedEvent.reason, "access-removed");

    for (const relay of relays.splice(0)) relay.close();
    for (const ws of sockets.splice(0)) ws.terminate();
    docker(["stop", containerA]);
    assert.equal(docker(["inspect", containerA, "--format", "{{.State.ExitCode}}"]), "0");

    startContainer(containerB);
    const portB = await waitForPort(containerB);
    const baseHttpB = `http://127.0.0.1:${portB}`;
    const wsUrlB = `ws://127.0.0.1:${portB}`;

    const afterRestartStatus = await readStatus(baseHttpB);
    assert.equal(afterRestartStatus.data.lastBackupAt, afterData.lastBackupAt);
    assert.equal(afterRestartStatus.data.pictureBytes, smokePngB.bytes.length);
    const downloadedB = await fetch(`${baseHttpB}/api/scripts/${scriptId}/pictures/${smokePngB.sha}`, {
      headers: { authorization: `Bearer ${secondInvite.token}` }
    });
    assert.equal(downloadedB.status, 200);
    assert.deepEqual(Buffer.from(await downloadedB.arrayBuffer()), smokePngB.bytes);

    const revokedAfterRestart = openCopy(wsUrlB, scriptId, firstInvite.token);
    const revokedAfterRestartEvent = await waitFor("revoked refusal after restart", () =>
      revokedAfterRestart.events.find((event): event is Extract<NativeRelayEvent, { kind: "authentication-failed" }> =>
        event.kind === "authentication-failed"));
    assert.equal(revokedAfterRestartEvent.reason, "invitation-revoked");

    const survivor = openCopy(wsUrlB, scriptId, secondInvite.token);
    await waitFor("persisted edit after restart", () =>
      (survivor.relay.status().firstSyncDone && survivor.text() === "word container") || undefined);

    assert.equal((await ownerFetch(baseHttpB, `scripts/${scriptId}`, { method: "DELETE" })).status, 204);
    const deletedLive = await waitFor("delete closes active connection", () =>
      survivor.events.find((event): event is Extract<NativeRelayEvent, { kind: "authentication-failed" }> =>
        event.kind === "authentication-failed"));
    assert.equal(deletedLive.reason, "access-removed");

    const afterDelete = openCopy(wsUrlB, scriptId, secondInvite.token);
    const deletedRefusal = await waitFor("deleted script refusal", () =>
      afterDelete.events.find((event): event is Extract<NativeRelayEvent, { kind: "authentication-failed" }> =>
        event.kind === "authentication-failed"));
    assert.equal(deletedRefusal.reason, "script-deleted");

    for (const relay of relays.splice(0)) relay.close();
    docker(["stop", containerB]);
    assert.equal(docker(["inspect", containerB, "--format", "{{.State.ExitCode}}"]), "0");

    for (const name of [containerA, containerB]) {
      const logs = docker(["logs", name]);
      for (const secretValue of [managementSecret, wrongSecret, firstInvite.token, secondInvite.token, smokePngB.sha, "private-unauth-", "Smoke One", "word container"]) {
        assert.equal(logs.includes(secretValue), false);
      }
    }
    process.stdout.write("Read-only relay container smoke passed.\n");
  } finally {
    for (const relay of relays) {
      try { relay.close(); } catch {}
    }
    for (const ws of sockets) {
      try { ws.terminate(); } catch {}
    }
    Object.defineProperty(globalThis, "WebSocket", { value: WebSocketBefore });
    for (const cleanup of [
      ["rm", "-f", containerA, containerB],
      ["volume", "rm", "-f", volume],
      ["rmi", "-f", image]
    ]) {
      try { docker(cleanup); } catch {}
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
