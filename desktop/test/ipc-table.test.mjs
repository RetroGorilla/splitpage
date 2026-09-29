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

function literalsIn(src) {
  return new Set([...src.matchAll(/"(splitpage:[a-z0-9-]+)"/g)].map((m) => m[1]));
}

const REGISTRAR_DIRECTION = { ipcHandle: "invoke", ipcOn: "send", ipcOnSync: "sendSync" };
const registrations = [...MAIN.matchAll(/\b(ipcHandle|ipcOnSync|ipcOn)\(\s*"(splitpage:[^"]+)"/g)]
  .map((m) => ({ name: m[2], direction: REGISTRAR_DIRECTION[m[1]], at: m.index }));

const registerIpcAt = MAIN.indexOf("function registerIpc() {");
const testModeAt = MAIN.indexOf("\n  if (TEST_MODE) {", registerIpcAt);

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

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

test("checkArgs accepts what the channels really send", () => {
  const tab = "0123456789abcdef0123456789abcdef";
  const doc = "d0123456789abcdef0123456789abcdef";
  assert.equal(checkArgs(channelFor("splitpage:tabstrip-reorder", "send").argsSchema, [tab, 3]), null);
  assert.equal(checkArgs(channelFor("splitpage:tabstrip-tear-off", "send").argsSchema, [tab, 12, 40]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-list", "invoke").argsSchema, [null]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-list", "invoke").argsSchema, [doc]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-get", "invoke").argsSchema, [{ docId: doc }, "snap-1"]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-put", "invoke").argsSchema, [doc, {}, "{}", { protect: [] }]), null);
  assert.equal(checkArgs(channelFor("splitpage:history-put", "invoke").argsSchema, [null, {}, "{}", { protect: [], older: true }]), null);
  assert.equal(checkArgs(channelFor("splitpage:write-file", "invoke").argsSchema, ["f1", "text"]), null);
  assert.equal(checkArgs(channelFor("splitpage:write-file", "invoke").argsSchema, ["f1", new Uint8Array(2)]), null);
  assert.equal(checkArgs(channelFor("splitpage:update-check", "invoke").argsSchema, []), null);
  assert.equal(checkArgs(channelFor("splitpage:test-shell", "invoke").argsSchema, ["listTargets", null]), null);
  assert.equal(checkArgs(channelFor("splitpage:test-draft-status", "invoke").argsSchema, []), null);
  assert.equal(checkArgs(channelFor("splitpage:test-draft-status", "invoke").argsSchema, [tab]), null);
  assert.equal(checkArgs(channelFor("splitpage:draft-write", "invoke").argsSchema, [{ seq: 1 }]), null);
});

test("checkArgs refuses the shapes the handlers used to refuse for themselves", () => {
  const doc = () => "d0123456789abcdef0123456789abcdef";
  const bad = (name, direction, args) => checkArgs(channelFor(name, direction).argsSchema, args);
  assert.ok(bad("splitpage:tabstrip-activate", "send", ["not-a-tab-id"]), "a tab id that is not 32 hex");
  assert.ok(bad("splitpage:tabstrip-activate", "send", []), "no tab id at all");
  assert.ok(bad("splitpage:tabstrip-reorder", "send", ["0".repeat(32), 1.5]), "a fractional index");
  assert.ok(bad("splitpage:history-put", "invoke", ["_older", {}, "{}", {}]), "the Older bucket as a docId");
  assert.ok(bad("splitpage:history-put", "invoke", ["_older", {}, "{}", { older: true }]), "the Older bucket as a docId, flag or no flag");
  assert.ok(bad("splitpage:history-put", "invoke", [doc(), {}, "{}", []]), "a bare protect list where the options bag goes");
  assert.ok(bad("splitpage:history-put", "invoke", [doc(), {}, "{}"]), "no options bag at all");
  assert.ok(bad("splitpage:history-get", "invoke", [{}, "../escape"]), "a snapshot id that is a path");
  assert.ok(bad("splitpage:update-install", "invoke", ["C:\\anything.exe"]), "an argument to an argument-free call");
  assert.ok(bad("splitpage:write-file", "invoke", ["f1", { not: "bytes" }]), "a body that is not bytes");
  assert.ok(bad("splitpage:open-external", "send", [{ url: "https://x" }]), "a url that is not a string");
  assert.ok(bad("splitpage:set-document-state", "send", [null]), "a null document state");
  assert.ok(bad("splitpage:read-file", "invoke", ["a", "b"]), "more arguments than the channel takes");
});

test("version history is exactly six app-only invoke channels", () => {
  const names = IPC_CHANNELS.filter((c) => c.name.startsWith("splitpage:history-")).map((c) => c.name).sort();
  assert.deepEqual(names, [
    "splitpage:history-copy", "splitpage:history-get", "splitpage:history-list",
    "splitpage:history-list-docs", "splitpage:history-put", "splitpage:history-touch"
  ]);
  for (const name of names) {
    const row = channelFor(name, "invoke");
    assert.ok(row, name + " is an invoke");
    assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN], name + " is the app page's alone");
  }
  assert.equal(channelFor("splitpage:history-usage", "invoke"), null, "usage folded into history-list");
  assert.equal(channelFor("splitpage:history-import-older", "invoke"), null, "import-older folded into history-put");
});

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

test("Use Chromium Speech Recognition takes no argument, from the app page only", () => {
  const row = channelFor("splitpage:prompter-open-in-chromium", "invoke");
  assert.ok(row, "declared");
  assert.deepEqual([...row.argsSchema], []);
  assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN]);
  assert.equal(checkArgs(row.argsSchema, []), null);
  assert.ok(checkArgs(row.argsSchema, ["C:\\Windows\\System32\\calc.exe"]), "a path");
  assert.ok(checkArgs(row.argsSchema, ["http://evil.example/"]), "a URL");
  assert.ok(!channelsForOrigin(TABSTRIP_ORIGIN).some((c) => c.name === row.name), "never the tab strip's");
});

test("Follow My Voice takes no argument, from the app page only", () => {
  for (const name of ["splitpage:voice-status", "splitpage:voice-start", "splitpage:voice-stop"]) {
    const row = channelFor(name, "invoke");
    assert.ok(row, name + " declared");
    assert.deepEqual([...row.argsSchema], [], name);
    assert.deepEqual([...row.allowedOrigins], [APP_ORIGIN], name);
    assert.equal(checkArgs(row.argsSchema, []), null, name);
    assert.ok(checkArgs(row.argsSchema, ["powershell.exe"]), name + ": an executable");
    assert.ok(checkArgs(row.argsSchema, ["C:\\evil.ps1"]), name + ": a script path");
    assert.ok(checkArgs(row.argsSchema, [{ lang: "en-US" }]), name + ": options");
    assert.ok(!channelsForOrigin(TABSTRIP_ORIGIN).some((c) => c.name === name), name + ": never the tab strip's");
  }
  const events = channelFor("splitpage:voice-event", "receive");
  assert.ok(events, "voice-event declared");
  assert.deepEqual([...events.allowedOrigins], [APP_ORIGIN]);
});

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

test("the blob channels: a typed sha256, app page only", () => {
  const sha = "0123456789abcdef".repeat(4);
  const row = (name) => channelFor(name, "invoke");
  assert.deepEqual([...row("splitpage:blob-put").argsSchema], ["sha256", "bytes"]);
  assert.deepEqual([...row("splitpage:blob-get").argsSchema], ["sha256"]);
  assert.deepEqual([...row("splitpage:blob-missing").argsSchema], ["array"]);
  assert.equal(checkArgs(row("splitpage:blob-put").argsSchema, [sha, new Uint8Array(4)]), null);
  assert.equal(checkArgs(row("splitpage:blob-get").argsSchema, [sha]), null);
  assert.equal(checkArgs(row("splitpage:blob-missing").argsSchema, [[sha]]), null);
  for (const bad of [sha.toUpperCase(), sha.slice(1), sha + "0", "../" + sha.slice(3),
    "C:\\Users\\me\\blobs\\" + sha, "https://evil.example/" + sha, "", null, 42, { sha }]) {
    assert.ok(checkArgs(row("splitpage:blob-get").argsSchema, [bad]), "blob-get refuses " + JSON.stringify(bad));
    assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [bad, new Uint8Array(4)]), "blob-put refuses " + JSON.stringify(bad));
  }
  assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [sha]), "a put with no bytes");
  assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [sha, { not: "bytes" }]), "a put whose body is not bytes");
  assert.ok(checkArgs(row("splitpage:blob-put").argsSchema, [sha, new Uint8Array(4), "image/svg+xml"]), "a caller-supplied mime");
  assert.ok(checkArgs(row("splitpage:blob-missing").argsSchema, [sha]), "a missing query that is not a list");
  const blob = IPC_CHANNELS.filter((c) => c.name.startsWith("splitpage:blob-"));
  assert.equal(blob.length, 3);
  for (const c of blob) {
    assert.deepEqual([...c.allowedOrigins], [APP_ORIGIN], c.name);
    assert.equal(c.direction, "invoke", c.name);
    assert.ok(!c.testOnly, c.name);
  }
});

test("the video thumbnail channel: a typed host and video ref, app page only", () => {
  const c = channelFor("splitpage:video-thumbnail", "invoke");
  assert.ok(c, "the channel exists");
  assert.deepEqual([...c.argsSchema], ["videoHost", "videoRef"]);
  assert.deepEqual([...c.allowedOrigins], [APP_ORIGIN]);
  assert.ok(!c.testOnly);
  for (const ok of [["youtube", "dQw4w9WgXcQ"], ["vimeo", "76979871"], ["vimeo", "76979871:abcdef1234"], ["youtube", "a-b_c-d_e-f"]]) {
    assert.equal(checkArgs(c.argsSchema, ok), null, JSON.stringify(ok));
  }
  for (const bad of [
    ["loom", "dQw4w9WgXcQ"], ["YouTube", "dQw4w9WgXcQ"], ["https://i.ytimg.com", "dQw4w9WgXcQ"],
    ["youtube", "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"], ["youtube", "../../etc/passwd"],
    ["youtube", "dQw4w9WgXc"], ["vimeo", "76979871:ABCDEF"], ["vimeo", "76979871:abcdef/../x"], ["youtube", ""],
    ["youtube"], ["youtube", 42], ["youtube", "dQw4w9WgXcQ", "https://evil.example/"]
  ]) {
    assert.ok(checkArgs(c.argsSchema, bad), "refuses " + JSON.stringify(bad));
  }
});

test("the draft channels let a bad payload through to their own answer", () => {
  for (const name of ["splitpage:draft-write", "splitpage:draft-discard"]) {
    assert.equal(checkArgs(channelFor(name, "invoke").argsSchema, ["nonsense"]), null, name);
    assert.equal(checkArgs(channelFor(name, "invoke").argsSchema, [null]), null, name);
  }
});

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
