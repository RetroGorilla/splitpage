import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import type { RelayStatusSnapshot } from "../../../../collab-server/status.ts";
import { openNativeRelay } from "../../../../src/adapters/collab/native/relay.ts";
import type { NativeRelayEvent } from "../../../../src/adapters/collab/native/relay.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { seedRelaySession } from "./relay-harness.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ORIGIN = "splitpage://app";
const SCRIPT_NAME = "container-smoke-script";
const SESSION_OPTIONS = { actor: "writer", sanitize: (text: unknown) => typeof text === "string" ? text : "" };

function docker(args: string[], options: { cwd?: string; input?: string } = {}): string {
  return execFileSync("docker", args, {
    cwd: options.cwd ?? REPO,
    encoding: "utf8",
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function usesRootBuildContext(): boolean {
  const dockerfile = readFileSync(join(REPO, "collab-server", "Dockerfile"), "utf8");
  return /\bCOPY\s+collab-server\//.test(dockerfile);
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
  const container = `splitpage-relay-smoke-${runId}`;
  const volume = `splitpage-relay-smoke-data-${runId}`;
  const temp = mkdtempSync(join(tmpdir(), "splitpage-relay-smoke-"));
  const managementSecret = randomBytes(32).toString("base64url");
  const wrongSecret = randomBytes(32).toString("base64url");
  const envFile = join(temp, "relay.env");
  const relays: ReturnType<typeof openNativeRelay>[] = [];
  const sockets: WebSocket[] = [];
  const WebSocketBefore = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true, writable: true, value: class extends WebSocket {
      constructor(url: string) { super(url, { origin: ORIGIN }); }
    }
  });

  try {
    const buildArgs = usesRootBuildContext()
      ? ["build", "-f", "collab-server/Dockerfile", "-t", image, "."]
      : ["build", "-t", image, "collab-server"];
    docker(buildArgs);

    docker(["volume", "create", volume]);

    const seed = seedRelaySession();
    const seedBase64 = Buffer.from(seed.encodeState()).toString("base64");
    seed.close();

    const provisionScript = [
      "import { openWriter } from './storage.ts';",
      "import { scriptAccess } from './access.ts';",
      "const [name, seedB64] = process.argv.slice(1);",
      "using db = openWriter('/data');",
      "const access = scriptAccess(db);",
      "access.register(name, 'active');",
      "db.prepare('INSERT INTO documents VALUES (?, ?)').run(name, Buffer.from(seedB64, 'base64'));",
      "const first = access.issue(name, 'smoke-one');",
      "const second = access.issue(name, 'smoke-two');",
      "process.stdout.write(JSON.stringify({ first, second }));"
    ].join("\n");
    const provisioned = JSON.parse(docker([
      "run", "--rm", "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--mount", `type=volume,source=${volume},target=/data`,
      "--entrypoint", "node",
      image, "-e", provisionScript, SCRIPT_NAME, seedBase64
    ])) as { first: { id: string; token: string }; second: { id: string; token: string } };

    writeFileSync(envFile, [
      "SPLITPAGE_DATA_DIR=/data",
      "SPLITPAGE_PORT=8080",
      "TMPDIR=/tmp",
      `SPLITPAGE_ALLOWED_ORIGINS=${ORIGIN}`,
      `SPLITPAGE_MANAGEMENT_SECRET=${managementSecret}`,
      "SPLITPAGE_STORE_DEBOUNCE_MS=40",
      "SPLITPAGE_STORE_MAX_DEBOUNCE_MS=100",
      "SPLITPAGE_BACKUP_KEEP=2",
      "SPLITPAGE_MAX_CONNECTIONS=4",
      "SPLITPAGE_MAX_CONNECTIONS_PER_INVITATION=2",
      "SPLITPAGE_MAX_MESSAGES_PER_SECOND=6"
    ].join("\n") + "\n", { mode: 0o600 });

    docker([
      "run", "-d",
      "--name", container,
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

    await waitFor("container listening log", () => {
      const logs = docker(["logs", container]);
      return logs.includes("Relay listening on port 8080.") ? true : undefined;
    });

    const portLine = docker(["port", container, "8080/tcp"]).split(/\r?\n/)[0] ?? "";
    const port = Number(/:(\d+)$/.exec(portLine)?.[1]);
    assert.ok(Number.isInteger(port) && port > 0, `Could not resolve container port from "${portLine}".`);

    const probeResult = JSON.parse(docker([
      "exec", container, "node", "-e", [
        "import { writeFileSync, unlinkSync } from 'node:fs';",
        "let rootCode = '';",
        "try { writeFileSync(process.cwd() + '/ro-probe', 'x'); } catch (e) { rootCode = e.code; }",
        "writeFileSync('/tmp/rw-probe', 'ok'); unlinkSync('/tmp/rw-probe');",
        "process.stdout.write(JSON.stringify({ uid: process.getuid(), rootCode }));"
      ].join("\n")
    ])) as { uid: number; rootCode: string };
    assert.notEqual(probeResult.uid, 0);
    assert.equal(probeResult.rootCode, "EROFS");

    const wsUrl = `ws://127.0.0.1:${port}`;
    const badOrigin = new WebSocket(wsUrl, { origin: "https://disallowed.example.test" });
    sockets.push(badOrigin);
    badOrigin.on("error", () => undefined);
    const [, badOriginResponse] = await once(badOrigin, "unexpected-response") as [unknown, IncomingMessage];
    assert.equal(badOriginResponse.statusCode, 401);

    const changed = new EventEmitter();
    function openCopy(name: string, token: string) {
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

    const wrong = openCopy(SCRIPT_NAME, randomBytes(32).toString("base64url"));
    const wrongEvent = await waitFor("wrong token refusal", () =>
      wrong.events.find((event): event is Extract<NativeRelayEvent, { kind: "authentication-failed" }> =>
        event.kind === "authentication-failed"));
    assert.equal(wrongEvent.reason, "permission-denied");

    const first = openCopy(SCRIPT_NAME, provisioned.first.token);
    const second = openCopy(SCRIPT_NAME, provisioned.first.token);
    await waitFor("two peers synced", () => (
      first.relay.status().firstSyncDone && second.relay.status().firstSyncDone &&
      first.text() === "word" && second.text() === "word"
    ) || undefined);

    const anchor = first.session.commands.anchorText({ beat: "R", cell: "narration" }, 4);
    assert.equal(anchor.kind, "anchored");
    assert.equal(first.session.commands.typeText(anchor.range, " container", {}).kind, "written");
    await waitFor("peer received edit", () => second.text() === "word container" || undefined);

    const third = openCopy(SCRIPT_NAME, provisioned.first.token);
    const perInviteRefusal = await waitFor("per-invitation refusal", () =>
      third.events.find((event): event is Extract<NativeRelayEvent, { kind: "temporary-refusal" }> =>
        event.kind === "temporary-refusal"));
    assert.equal(perInviteRefusal.reason, "too-many-connections");
    third.relay.close();

    const statusUrl = `http://127.0.0.1:${port}/api/status`;
    async function readStatus(): Promise<{ raw: string; data: RelayStatusSnapshot }> {
      const response = await fetch(statusUrl, { headers: { Authorization: `Bearer ${managementSecret}` } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const raw = await response.text();
      return { raw, data: JSON.parse(raw) as RelayStatusSnapshot };
    }
    await waitFor("two open sockets before total-limit check", async () => {
      const { data } = await readStatus();
      return data.connections.total === 2 ? true : undefined;
    });

    const extraA = new WebSocket(wsUrl, { origin: ORIGIN });
    const extraB = new WebSocket(wsUrl, { origin: ORIGIN });
    sockets.push(extraA, extraB);
    extraA.on("error", () => undefined);
    extraB.on("error", () => undefined);
    await Promise.all([once(extraA, "open"), once(extraB, "open")]);

    const overTotal = new WebSocket(wsUrl, { origin: ORIGIN });
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

    assert.equal((await fetch(statusUrl)).status, 401);
    assert.equal((await fetch(statusUrl, { headers: { Authorization: `Bearer ${wrongSecret}` } })).status, 401);
    const { data: beforeData } = await readStatus();
    assert.ok(beforeData.connections.authenticated >= 1);
    assert.ok(beforeData.storedBytes > 0);
    assert.equal(beforeData.pictureBytes, 0);
    assert.equal(beforeData.lastStorageFailure, null);
    assert.equal(beforeData.lastBackupAt, null);

    const backupOutput = docker(["exec", container, "node", "backup-command.ts"]);
    assert.match(backupOutput, /^Verified relay backup relay-.*\.sqlite\.$/);

    const { raw: statusAfterRaw, data: afterData } = await readStatus();
    assert.ok(afterData.lastBackupAt !== null);
    assert.match(afterData.lastBackupAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    for (const secretValue of [managementSecret, wrongSecret, provisioned.first.token, provisioned.second.token, SCRIPT_NAME, "word container"]) {
      assert.equal(statusAfterRaw.includes(secretValue), false);
    }

    for (const relay of relays) relay.close();
    for (const ws of sockets) ws.terminate();
    docker(["stop", container]);
    const exitCode = docker(["inspect", container, "--format", "{{.State.ExitCode}}"]);
    assert.equal(exitCode, "0");

    const logs = docker(["logs", container]);
    for (const secretValue of [managementSecret, wrongSecret, provisioned.first.token, provisioned.second.token, "word container"]) {
      assert.equal(logs.includes(secretValue), false);
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
      ["rm", "-f", container],
      ["volume", "rm", "-f", volume],
      ["rmi", "-f", image]
    ]) {
      try { docker(cleanup); } catch {}
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

await main();
