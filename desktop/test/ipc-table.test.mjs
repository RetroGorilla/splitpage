/* desktop/test/ipc-table.test.mjs: the IPC channel table against the three
 * files that use it.
 *
 * Node built-ins only, no Electron — requiring 'electron' outside Electron
 * fails, and main.js and both preloads do. So this reads them as TEXT and
 * holds the table and the source to each other in both directions: every
 * channel string either preload names is a row of the table for that
 * preload's origin, every row for that origin is named by that preload, and
 * main registers a handler for every row it is supposed to and for nothing
 * else. desktop/ipc-channels.js itself is plain CommonJS data, so that one
 * is loaded for real.
 *
 * What this cannot cover is a running app: that is desktop/test/smoke.mjs,
 * which needs Windows and a real Electron binary.
 *
 * Prints ALL PASS and exits 0, or lists the failures and exits 1.
 *
 * Run: node desktop/test/ipc-table.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");

const table = require(path.join(desktop, "ipc-channels.js"));
const { IPC_CHANNELS, APP_ORIGIN, TABSTRIP_ORIGIN, channelFor, channelsForOrigin, checkArgs } = table;

const read = (name) => fs.readFileSync(path.join(desktop, name), "utf8");
const MAIN = read("main.js");
const PRELOADS = [
  { file: "preload.js", origin: APP_ORIGIN, src: read("preload.js") },
  { file: "tabstrip-preload.js", origin: TABSTRIP_ORIGIN, src: read("tabstrip-preload.js") }
];

const key = (name, direction) => `${name} (${direction})`;

/* ------------------------------------------------------------------
   Reading the sources.

   A preload reaches main four ways, and each has a wrapper of its own
   (invoke/send/sendSync/receive) plus the raw ipcRenderer call it is built
   on — the table read itself is raw, because it is how the table arrives.
   Both spellings are scanned, so this test keeps working if a call ever
   goes back to ipcRenderer directly.
   ------------------------------------------------------------------ */

const RAW_DIRECTION = { invoke: "invoke", send: "send", sendSync: "sendSync", on: "receive" };

function callsIn(src) {
  const found = new Set();
  for (const [, method, name] of src.matchAll(/ipcRenderer\.(invoke|send|sendSync|on)\(\s*"(splitpage:[^"]+)"/g)) {
    found.add(key(name, RAW_DIRECTION[method]));
  }
  for (const [, wrapper, name] of src.matchAll(/(?<![.\w])(invoke|sendSync|send|receive)\(\s*"(splitpage:[^"]+)"/g)) {
    found.add(key(name, wrapper === "receive" ? "receive" : wrapper));
  }
  return found;
}

/* Every channel string in a file, whether it is called or not: a name
   sitting in a constant still has to be one this origin owns. Matched on
   the shape a channel name actually has, so the two origin URLs and the
   "splitpage: " that starts a thrown message are not mistaken for one. */
function literalsIn(src) {
  return new Set([...src.matchAll(/"(splitpage:[a-z0-9-]+)"/g)].map((m) => m[1]));
}

/* main.js registers through ipcHandle/ipcOn/ipcOnSync and nothing else. */
const REGISTRAR_DIRECTION = { ipcHandle: "invoke", ipcOn: "send", ipcOnSync: "sendSync" };
const registrations = [...MAIN.matchAll(/\b(ipcHandle|ipcOnSync|ipcOn)\(\s*"(splitpage:[^"]+)"/g)]
  .map((m) => ({ name: m[2], direction: REGISTRAR_DIRECTION[m[1]], at: m.index }));

const registerIpcAt = MAIN.indexOf("function registerIpc() {");
const testModeAt = MAIN.indexOf("\n  if (TEST_MODE) {", registerIpcAt);

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/* ------------------------------------------------------------------
   The table's own shape.
   ------------------------------------------------------------------ */

test("the table is frozen all the way down", () => {
  assert.equal(Object.isFrozen(IPC_CHANNELS), true, "the list");
  for (const c of IPC_CHANNELS) {
    assert.equal(Object.isFrozen(c), true, `row ${key(c.name, c.direction)}`);
    assert.equal(Object.isFrozen(c.argsSchema), true, `argsSchema of ${c.name}`);
    assert.equal(Object.isFrozen(c.allowedOrigins), true, `allowedOrigins of ${c.name}`);
  }
  assert.throws(() => { IPC_CHANNELS.push({}); }, "the list cannot be added to");
});

test("every row has a name, a direction, a schema and at least one origin", () => {
  const seen = new Set();
  for (const c of IPC_CHANNELS) {
    assert.match(c.name, /^splitpage:[a-z0-9-]+$/, `channel name ${c.name}`);
    assert.ok(["invoke", "send", "sendSync", "receive"].includes(c.direction), `direction of ${c.name}`);
    assert.ok(Array.isArray(c.argsSchema), `argsSchema of ${c.name}`);
    assert.ok(c.allowedOrigins.length > 0, `${c.name} is usable by nobody`);
    for (const o of c.allowedOrigins) {
      assert.ok([APP_ORIGIN, TABSTRIP_ORIGIN].includes(o), `${c.name} names origin ${o}`);
    }
    assert.equal(seen.has(key(c.name, c.direction)), false, `duplicate row ${key(c.name, c.direction)}`);
    seen.add(key(c.name, c.direction));
    if (c.direction === "sendSync") {
      assert.ok("refusal" in c, `${c.name} is sendSync and must declare a refusal value`);
    }
  }
});

/* Invariant #43 as data: the strip's origin shares nothing with the app's
   but the one channel that hands out the table. */
test("the two origins share only the table read", () => {
  const app = new Set(channelsForOrigin(APP_ORIGIN).map((c) => key(c.name, c.direction)));
  const strip = new Set(channelsForOrigin(TABSTRIP_ORIGIN).map((c) => key(c.name, c.direction)));
  const both = [...app].filter((k) => strip.has(k));
  assert.deepEqual(both, ["splitpage:ipc-table-sync (sendSync)"]);
  for (const k of strip) {
    if (k === "splitpage:ipc-table-sync (sendSync)") continue;
    assert.match(k, /^splitpage:tabstrip-/, `${k} is reachable from the strip`);
  }
});

/* ------------------------------------------------------------------
   The preloads, both ways.
   ------------------------------------------------------------------ */

for (const preload of PRELOADS) {
  test(`${preload.file}: every channel it calls is in the table for its origin`, () => {
    for (const k of callsIn(preload.src)) {
      const [name, direction] = [k.slice(0, k.indexOf(" (")), k.slice(k.indexOf("(") + 1, -1)];
      const row = channelFor(name, direction);
      assert.ok(row, `${k} is called by ${preload.file} and is not in the table`);
      assert.ok(
        row.allowedOrigins.includes(preload.origin),
        `${k} is called by ${preload.file}, whose origin the table does not allow`
      );
    }
  });

  test(`${preload.file}: every channel string in it is one its origin owns`, () => {
    for (const name of literalsIn(preload.src)) {
      const rows = IPC_CHANNELS.filter((c) => c.name === name && c.allowedOrigins.includes(preload.origin));
      assert.ok(rows.length, `${preload.file} names ${name}, which is not this origin's`);
    }
  });

  test(`${preload.file}: every row for its origin is exposed by it`, () => {
    const called = callsIn(preload.src);
    for (const row of channelsForOrigin(preload.origin)) {
      assert.ok(
        called.has(key(row.name, row.direction)),
        `${key(row.name, row.direction)} is in the table for ${preload.origin} and ${preload.file} never uses it`
      );
    }
  });
}

test("neither preload can reach the other's channels", () => {
  const stripNames = new Set(channelsForOrigin(TABSTRIP_ORIGIN).map((c) => c.name));
  const appOnly = channelsForOrigin(APP_ORIGIN).filter((c) => !stripNames.has(c.name));
  const strip = PRELOADS.find((p) => p.origin === TABSTRIP_ORIGIN).src;
  for (const c of appOnly) {
    assert.equal(strip.includes(c.name), false, `the strip's preload names ${c.name}`);
  }
});

/* ------------------------------------------------------------------
   main.js, both ways.
   ------------------------------------------------------------------ */

test("main.js registers nothing through ipcMain directly", () => {
  const direct = [...MAIN.matchAll(/ipcMain\.(handle|on)\(\s*"/g)];
  assert.deepEqual(direct.map((m) => m[0]), [], "every registration goes through ipcHandle/ipcOn/ipcOnSync");
});

test("every channel main.js registers is in the table, with that direction", () => {
  for (const r of registrations) {
    const row = channelFor(r.name, r.direction);
    assert.ok(row, `main.js registers ${key(r.name, r.direction)}, which is not in the table`);
    assert.ok(row.allowedOrigins.length > 0, `${r.name} has no origin`);
  }
});

test("main.js registers a handler for every inbound row, exactly once", () => {
  for (const row of IPC_CHANNELS) {
    if (row.direction === "receive") continue;
    const hits = registrations.filter((r) => r.name === row.name && r.direction === row.direction);
    assert.equal(hits.length, 1, `${key(row.name, row.direction)} is registered ${hits.length} times in main.js`);
  }
});

test("main.js sends every main -> renderer row and registers none of them", () => {
  const sends = new Set([...MAIN.matchAll(/\.send\(\s*"(splitpage:[^"]+)"/g)].map((m) => m[1]));
  const inbound = new Set(IPC_CHANNELS.filter((c) => c.direction !== "receive").map((c) => c.name));
  for (const row of IPC_CHANNELS) {
    if (row.direction !== "receive") continue;
    assert.ok(sends.has(row.name), `${row.name} is in the table and main.js never sends it`);
    /* splitpage:update-status is deliberately both — a push from main and a
       question the page can ask — so a name that is also an inbound row is
       expected to be registered. Any other one must not be. */
    if (!inbound.has(row.name)) {
      assert.equal(
        registrations.some((r) => r.name === row.name),
        false,
        `${row.name} is only a push from main and must not be registered as a handler`
      );
    }
  }
});

test("a TEST_MODE-only row is registered inside the TEST_MODE block, and nothing else is", () => {
  assert.ok(registerIpcAt > 0, "registerIpc() found");
  assert.ok(testModeAt > registerIpcAt, "the TEST_MODE block inside registerIpc() found");
  for (const r of registrations) {
    const row = channelFor(r.name, r.direction);
    if (row.testOnly) {
      assert.ok(r.at > testModeAt, `${r.name} is testOnly and is registered outside the TEST_MODE block`);
    } else {
      assert.ok(r.at < testModeAt, `${r.name} is not testOnly and is registered inside the TEST_MODE block`);
    }
  }
});

test("every testOnly channel is a __test hook and nothing else is", () => {
  for (const row of IPC_CHANNELS) {
    assert.equal(
      !!row.testOnly,
      row.name.startsWith("splitpage:test-"),
      `${row.name}: testOnly and the name disagree`
    );
  }
});

/* ------------------------------------------------------------------
   The validator.
   ------------------------------------------------------------------ */

test("checkArgs accepts what the channels really send", () => {
  const tab = "0123456789abcdef0123456789abcdef";
  const doc = "d0123456789abcdef0123456789abcdef";
  assert.equal(checkArgs(channelFor("splitpage:tabstrip-reorder", "send").argsSchema, [tab, 3]), null);
  assert.equal(checkArgs(channelFor("splitpage:tabstrip-tear-off", "send").argsSchema, [tab, 12, 40]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-list", "invoke").argsSchema, [null]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-list", "invoke").argsSchema, [doc]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-get", "invoke").argsSchema, [{ docId: doc }, "snap-1"]), null);
  assert.equal(checkArgs(channelFor("splitpage:write-file", "invoke").argsSchema, ["f1", "text"]), null);
  assert.equal(checkArgs(channelFor("splitpage:write-file", "invoke").argsSchema, ["f1", new Uint8Array(2)]), null);
  assert.equal(checkArgs(channelFor("splitpage:update-check", "invoke").argsSchema, []), null);
  assert.equal(checkArgs(channelFor("splitpage:test-shell", "invoke").argsSchema, ["listTargets", null]), null);
  assert.equal(checkArgs(channelFor("splitpage:test-draft-status", "invoke").argsSchema, []), null);
  assert.equal(checkArgs(channelFor("splitpage:test-draft-status", "invoke").argsSchema, [tab]), null);
  assert.equal(checkArgs(channelFor("splitpage:draft-write", "invoke").argsSchema, [{ seq: 1 }]), null);
});

test("checkArgs refuses the shapes the handlers used to refuse for themselves", () => {
  const bad = (name, direction, args) => checkArgs(channelFor(name, direction).argsSchema, args);
  assert.ok(bad("splitpage:tabstrip-activate", "send", ["not-a-tab-id"]), "a tab id that is not 32 hex");
  assert.ok(bad("splitpage:tabstrip-activate", "send", []), "no tab id at all");
  assert.ok(bad("splitpage:tabstrip-reorder", "send", ["0".repeat(32), 1.5]), "a fractional index");
  assert.ok(bad("splitpage:history-put", "invoke", ["_older", {}, "{}", []]), "the Older bucket as a docId");
  assert.ok(bad("splitpage:history-get", "invoke", [{}, "../escape"]), "a snapshot id that is a path");
  assert.ok(bad("splitpage:update-install", "invoke", ["C:\\anything.exe"]), "an argument to an argument-free call");
  assert.ok(bad("splitpage:write-file", "invoke", ["f1", { not: "bytes" }]), "a body that is not bytes");
  assert.ok(bad("splitpage:open-external", "send", [{ url: "https://x" }]), "a url that is not a string");
  assert.ok(bad("splitpage:set-document-state", "send", [null]), "a null document state");
  assert.ok(bad("splitpage:read-file", "invoke", ["a", "b"]), "more arguments than the channel takes");
});

/* Issue #86 is the update bridge's contract again (invariant #28): the page
   asks for "what I am showing" to be opened in the browser and names
   nothing — no URL, no path, no document id. */
test("the teleprompter's Open in browser takes no argument, from the app page only", () => {
  const row = channelFor("splitpage:prompter-open-in-browser", "invoke");
  assert.ok(row, "declared");
  assert.deepEqual([...row.argsSchema], []);
  assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN]);
  assert.equal(checkArgs(row.argsSchema, []), null);
  assert.ok(checkArgs(row.argsSchema, ["http://evil.example/"]), "a URL");
  assert.ok(checkArgs(row.argsSchema, ["C:\\Users\\me\\script.md"]), "a path");
  assert.ok(checkArgs(row.argsSchema, [{ doc: "abc" }]), "a document id");
  assert.ok(!channelsForOrigin(TABSTRIP_ORIGIN).some((c) => c.name === row.name), "never the tab strip's");
});

/* Issue #10 is the same contract a third time: main holds the OAuth
   listener and the tokens, so signing in, signing out and asking for status
   name nothing, and the Drive calls name a Drive id or an upload request —
   never a URL, and nothing the tab strip can reach. The id's shape and the
   upload's fields are checked in desktop/google-drive.js (its own test). */
test("the Google Drive channels: argument-free account calls, id-only Drive calls, app page only", () => {
  const row = (name) => channelFor(name, "invoke");
  for (const name of ["splitpage:drive-status", "splitpage:drive-sign-in", "splitpage:drive-sign-out"]) {
    assert.ok(row(name), name + " declared");
    assert.deepEqual([...row(name).argsSchema], [], name + " takes no argument");
    assert.ok(checkArgs(row(name).argsSchema, ["https://accounts.google.com/o/oauth2/v2/auth?client_id=evil"]), name + " refuses a URL");
    assert.ok(checkArgs(row(name).argsSchema, [{ clientId: "evil" }]), name + " refuses a client");
  }
  assert.deepEqual([...row("splitpage:drive-list").argsSchema], ["string"]);
  assert.deepEqual([...row("splitpage:drive-download").argsSchema], ["string"]);
  assert.deepEqual([...row("splitpage:drive-upload").argsSchema], ["object"]);
  assert.ok(checkArgs(row("splitpage:drive-list").argsSchema, []), "a list with no folder");
  assert.ok(checkArgs(row("splitpage:drive-list").argsSchema, ["root", "https://www.googleapis.com/"]), "a second argument");
  assert.ok(checkArgs(row("splitpage:drive-upload").argsSchema, ["name", "bytes"]), "an upload that is not one request object");
  const drive = IPC_CHANNELS.filter((c) => c.name.startsWith("splitpage:drive-"));
  assert.equal(drive.length, 6);
  for (const c of drive) {
    assert.deepEqual([...c.allowedOrigins], [APP_ORIGIN], c.name);
    assert.equal(c.direction, "invoke", c.name);
    assert.ok(!c.testOnly, c.name);
  }
});

/* A malformed draft payload must reach the handler, which answers with a
   code the renderer can back off on rather than a rejection (DRAFT-STORE). */
test("the draft channels let a bad payload through to their own answer", () => {
  for (const name of ["splitpage:draft-write", "splitpage:draft-discard"]) {
    assert.equal(checkArgs(channelFor(name, "invoke").argsSchema, ["nonsense"]), null, name);
    assert.equal(checkArgs(channelFor(name, "invoke").argsSchema, [null]), null, name);
  }
});

/* ------------------------------------------------------------------ */

const failures = [];
for (const c of cases) {
  try {
    await c.fn();
    console.log(`ok   - ${c.name}`);
  } catch (err) {
    failures.push(c.name);
    console.log(`FAIL - ${c.name}\n       ${String((err && err.stack) || err).split("\n").slice(0, 6).join("\n       ")}`);
  }
}

if (failures.length) {
  console.log(`\n${failures.length} FAILED of ${cases.length}`);
  process.exit(1);
}
console.log(`\nALL PASS (${cases.length} cases, ${IPC_CHANNELS.length} channels)`);
