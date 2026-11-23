import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { scriptAccess } from "../../../../collab-server/access.ts";
import { DB_NAME, openWriter } from "../../../../collab-server/storage.ts";
import { openNativeRelay } from "../../../../src/adapters/collab/native/relay.ts";
import type { NativeRelayEvent } from "../../../../src/adapters/collab/native/relay.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import type { NativeSessionSource } from "../../../../src/adapters/collab/native/session.ts";
import { seedRelaySession } from "./relay-harness.ts";

export const NAME = "test-script";
export const ORIGIN = "splitpage://app";
const OPTIONS = { actor: "writer", sanitize: (text: unknown) => typeof text === "string" ? text : "" };
const ENTRY = new URL("./server-process.ts", import.meta.url);

export function serverHarness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "splitpage-relay-"));
  const invitations = new Map<string, { id: string; token: string }>();
  const changed = new EventEmitter();
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(25_000)]);
  const stopProcesses: (() => Promise<unknown>)[] = [];
  const copies: ReturnType<typeof openNativeRelay>[] = [];
  const WebSocketBefore = globalThis.WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true, writable: true, value: class extends WebSocket {
      constructor(url: string) { super(url, { origin: ORIGIN }); }
    }
  });
  t.after(async () => {
    try {
      for (const copy of copies) copy.close();
      await Promise.all(stopProcesses.map(stop => stop()));
    } finally {
      Object.defineProperty(globalThis, "WebSocket", { value: WebSocketBefore });
      rmSync(directory, { recursive: true, force: true, maxRetries: 4 });
    }
  });

  async function until<T>(read: () => T | undefined): Promise<T> {
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      await once(changed, "change", { signal });
    }
  }

  function provision(name: string, target = directory) {
    using db = openWriter(target);
    const access = scriptAccess(db);
    const exists = db.prepare("SELECT 1 FROM scripts WHERE name = ?").get(name);
    if (!exists) access.register(name, "active");
    const existing = invitations.get(name);
    if (exists && existing) return existing;
    const invitation = access.issue(name, "test invitation");
    invitations.set(name, invitation);
    return invitation;
  }

  function launch(settings: NodeJS.ProcessEnv = {}, entry = ENTRY) {
    if (entry === ENTRY) provision(NAME, settings.SPLITPAGE_DATA_DIR);
    const child = fork(fileURLToPath(entry), {
      env: {
        ...process.env,
        SPLITPAGE_DATA_DIR: directory,
        SPLITPAGE_ALLOWED_ORIGINS: ORIGIN,
        SPLITPAGE_PORT: "0",
        SPLITPAGE_STORE_DEBOUNCE_MS: "40",
        SPLITPAGE_STORE_MAX_DEBOUNCE_MS: "100",
        SPLITPAGE_BACKUP_KEEP: "2",
        ...settings
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: []
    });
    const messages: unknown[] = [];
    let output = "", errors = "", finished = false;
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; changed.emit("change"); });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { errors += chunk; changed.emit("change"); });
    child.on("message", message => { messages.push(message); changed.emit("change"); });
    const exit = new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>(resolve => {
      child.once("error", error => { errors += error.message; });
      child.once("close", (code, exitSignal) => {
        finished = true;
        resolve({ code, exitSignal });
        changed.emit("change");
      });
    });
    const run = {
      messages, exit, output: () => output, errors: () => errors,
      send: (message: string) => child.send(message),
      async provision(name: string) {
        child.send(`provision:${name}`);
        const invitation = await until(() => messages.find((message): message is { name: string; id: string; token: string } =>
          !!message && typeof message === "object" && "name" in message && message.name === name &&
          "id" in message && typeof message.id === "string" && "token" in message && typeof message.token === "string"));
        invitations.set(name, invitation);
      },
      async port() {
        return until(() => {
          if (finished) throw new Error(`Relay exited before listening. ${errors}`);
          return messages.find((message): message is number => typeof message === "number");
        });
      },
      requestStop() {
        if (process.platform === "win32") child.send("stop");
        else child.kill("SIGTERM");
      },
      async stop(how: "clean" | "kill") {
        if (!finished) {
          if (how === "clean") run.requestStop();
          else child.kill("SIGKILL");
        }
        if (!finished) await once(child, "close", { signal: AbortSignal.timeout(5000) });
        return exit;
      }
    };
    stopProcesses.push(() => run.stop("kill"));
    return run;
  }

  function copy(port: number, source: NativeSessionSource = { kind: "empty" }, name = NAME, token = invitations.get(name)?.token ?? "") {
    const session = openNativeSession(source, OPTIONS);
    const events: NativeRelayEvent[] = [];
    session.subscribe(() => changed.emit("change"));
    const relay = openNativeRelay(session, {
      url: `ws://127.0.0.1:${port}`, name, token, sessionOptions: OPTIONS,
      onEvent(event) { events.push(event); changed.emit("change"); }
    });
    copies.push(relay);
    return {
      session, events, relay,
      text: () => session.document().rows[0]?.audioText,
      pending: () => relay.status().pendingChangeCount,
      close: relay.close
    };
  }

  function seed(name = NAME) {
    const session = seedRelaySession();
    const state = session.encodeState();
    session.close();
    using db = openWriter(directory);
    db.prepare("INSERT INTO documents VALUES (?, ?)").run(name, state);
    return state;
  }

  function invitation(name = NAME) {
    const result = invitations.get(name);
    assert.ok(result);
    return result;
  }

  return { directory, launch, copy, seed, until, provision, invitation };
}

export function storedState(directory: string, name = NAME) {
  using db = new DatabaseSync(join(directory, DB_NAME), { readOnly: true });
  const state = db.prepare("SELECT state FROM documents WHERE name = ?").get(name)?.state;
  assert.ok(state instanceof Uint8Array);
  return state;
}

export function storedText(directory: string, name = NAME) {
  const session = openNativeSession({ kind: "state", state: storedState(directory, name) }, OPTIONS);
  try {
    return session.document().rows[0]?.audioText;
  } finally {
    session.close();
  }
}

export function appendText(session: ReturnType<typeof openNativeSession>, text: string, at: number): void {
  const anchor = session.commands.anchorText({ beat: "R", cell: "narration" }, at);
  assert.equal(anchor.kind, "anchored");
  assert.equal(session.commands.typeText(anchor.range, text, {}).kind, "written");
}
