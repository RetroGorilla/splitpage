import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import {
  TABLE_304, chance, judge, pick, rawObject, seeded, table304Document, text, upTo
} from "../../tests/application/raw-inputs.ts";

await bootApp();

const { liveSession } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { applyMerge, cloneState } = await import("../js/03-sync.js");
const { flushEdits } = await import("../js/12a-undo.js");
const { SERVER_RESUME_KEY, finishServerDetect, openServerDoc, saveToServer } = await import("../js/13-hosted.js");
const { browserDraftKey, createIdbDraftStore, draftBaseOf } = await import("../js/03d-drafts-idb.js");
const { openProjectFile, reloadFileFromDisk } = await import("../js/18-local-files.js");
const { applyTakenDraft } = await import("../js/20g-drafts.js");

after(closeApp);

const SEEDS = Math.max(40, Math.round((Number(process.env.SPLITPAGE_FUZZ_SEEDS) || 0) / 4));
const RELOADS = Math.max(24, Math.round((Number(process.env.SPLITPAGE_FUZZ_SEEDS) || 0) / 6));

const session = liveSession();
const heard = [];
session.subscribe((c) => heard.push(c.kind));
const held = () => session.read((doc) => doc);
const migrate = (raw) => migrateRows(raw);

const KNOWN_SHOT_AUDIO_REF = "the b-roll repair at render writes shots migrateRows then changes: an audioRef with angle brackets, or a shot with no name (#325)";

const SHOT_AUDIO_REF = /^\.brollShots\[\d+\]\.audioRef "[^]*<[^]*>/;

function allowed(path) {
  return SHOT_AUDIO_REF.test(path) ? KNOWN_SHOT_AUDIO_REF : null;
}

const errors = [];

async function quietly(run) {
  const consoles = [...new Set([window.console, globalThis.console])];
  const was = consoles.map((c) => c.error);
  consoles.forEach((c) => { c.error = (e) => { errors.push(e); }; });
  try { return await run(); } finally { consoles.forEach((c, i) => { c.error = was[i]; }); }
}

function settle(doc) {
  S.state = doc;
  flushEdits();
  heard.length = 0;
}

function bump(into, key) {
  into[key] = (into[key] || 0) + 1;
}

function noDocument(raw) {
  return raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw);
}

function startingDocument(title) {
  return migrateRows(table304Document(title));
}

const ENTRIES = {
  draft: {
    kind: "adopt",
    opens: true,
    run: (raw) => applyTakenDraft({ header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(raw) })
  },
  server: {
    kind: "server",
    opens: false,
    run: (raw) => applyMerge({ theirs: raw, source: "server-conflict", unchanged: true, report: false })
  },
  merge: {
    kind: "server",
    opens: false,
    run: (raw, base, mine) => applyMerge({ base: base, mine: mine, theirs: raw, source: "server-conflict", report: false })
  },
  recovery: {
    kind: "recovery",
    opens: true,
    run: (raw, base, mine) => applyMerge({ base: base, mine: mine, theirs: raw, source: "server-resume", report: false })
  }
};

async function through(name, raw, where, tally, spoilMine) {
  const entry = ENTRIES[name];
  const base = cloneState(S.state);
  const mine = cloneState(S.state);
  if (mine.rows[0]) mine.rows[0].audioText = "Mine, " + where + ".";
  if (spoilMine) spoilMine(mine);
  const before = S.state, beforeText = JSON.stringify(S.state);
  errors.length = 0;
  const epoch = session.epoch(), gen = session.generation();
  heard.length = 0;
  let outcome;
  try {
    outcome = await quietly(() => entry.run(raw, base, mine));
  } catch (e) {
    assert.fail(where + " threw: " + (e && e.stack));
  }
  const refused = noDocument(raw);
  assert.deepEqual(errors.map((e) => String((e && e.stack) || e)), [], where + " logged an error");
  if (refused || outcome === "failed" || outcome === "nothing-unsaved") {
    bump(tally.typed, name + ":" + (refused ? "no document" : outcome));
    if (refused && name === "draft") assert.equal(outcome, "failed", where + ": a draft that is no document is a typed failure");
    assert.equal(S.state, before, where + ": a failed entry keeps the document");
    assert.equal(JSON.stringify(S.state), beforeText, where + ": and leaves it as it was");
    assert.equal(held(), S.state, where + ": the session still holds it");
    assert.deepEqual([session.epoch(), session.generation()], [epoch, gen], where + ": no epoch, no generation");
    assert.deepEqual(heard, [], where + ": nothing published");
    return;
  }
  bump(tally.kinds, name);
  assert.deepEqual(heard, [entry.kind], where + ": published");
  assert.equal(session.epoch(), epoch + (entry.opens ? 1 : 0), where + ": epoch");
  assert.equal(session.generation(), gen, where + ": generation");
  assert.equal(held(), S.state, where + ": the session holds the document the app shows");
  assert.equal(JSON.stringify(before), beforeText, where + ": the replaced document was not written into");
  const verdict = verdictOf(S.state, tally);
  assert.deepEqual(verdict.problems, [], where + ": " + JSON.stringify(S.state).slice(0, 400));
  verdict.known.forEach((k) => bump(tally.known, k));
}

function verdictOf(doc, tally) {
  let judged = doc;
  if (Array.isArray(judged.brollShots) && judged.brollShots.some((b) => b && b.name === "")) {
    bump(tally.known, KNOWN_SHOT_AUDIO_REF);
    judged = { ...judged, brollShots: judged.brollShots.filter((b) => !b || b.name !== "") };
  }
  return judge(judged, migrate, allowed);
}

async function seedEntries(seed, tally = { kinds: {}, known: {}, typed: {} }) {
  const r = seeded(0x3100 + seed);
  settle(startingDocument("Seed " + seed));
  for (const name of Object.keys(ENTRIES)) {
    if (!chance(r, 0.75)) continue;
    await through(name, rawObject(r), "seed " + seed + " " + name, tally);
  }
  return tally;
}

test("booted app: seeded raw documents through a draft adoption, a server update, a merge and a recovery merge end in a valid fixed point, a typed failure or a refusal that changes nothing", async (t) => {
  const tally = { kinds: {}, known: {}, typed: {} };
  for (let seed = 1; seed <= SEEDS; seed++) await seedEntries(seed, tally);
  flushEdits();
  t.diagnostic(JSON.stringify(tally));
  for (const name of Object.keys(ENTRIES)) assert.ok((tally.kinds[name] || 0) >= SEEDS / 4, "every entry point lands: " + name + " " + JSON.stringify(tally.kinds));
});

for (const row of TABLE_304) {
  test("booted app, #304's table, " + row.label + ": applyMerge with that raw theirs, merged, unchanged or recovered, ends in a valid fixed point", async () => {
    const tally = { kinds: {}, known: {}, typed: {} };
    for (const name of ["merge", "server", "recovery"]) {
      settle(startingDocument("Table"));
      const theirs = table304Document("Theirs");
      row.spoil(theirs);
      await through(name, theirs, row.label + " " + name, tally, row.bothSides ? row.spoil : null);
      assert.equal(tally.kinds[name], 1, name);
    }
    assert.deepEqual(tally.known, {});
  });
}

const CELLS = ["Wide", "Close on the #kettle", "Mara mends nets.", "B-roll: harbour at dawn", "VO: Every morning.", "\"quoted, with a comma\"", "<b>bold</b>", "a\ttab", ""];

function fileText(r) {
  const lines = [];
  const n = 1 + upTo(r, 4);
  const cell = () => (chance(r, 0.6) ? pick(r, CELLS) : text(r).replace(/[\r\n]/g, " "));
  const form = pick(r, ["tab", "labels", "table", "csv", "paragraphs", "heading"]);
  if (form === "table") lines.push("| Visual | Audio |", "| --- | --- |");
  if (form === "csv") lines.push("Visual,Audio");
  if (form === "heading") lines.push("# " + cell());
  for (let i = 0; i < n; i++) {
    if (form === "tab") lines.push(cell() + "\t" + cell());
    else if (form === "labels") lines.push("Visual: " + cell(), "Audio: " + cell());
    else if (form === "table") lines.push("| " + cell() + " | " + cell() + " |");
    else if (form === "csv") lines.push('"' + cell().replace(/"/g, '""') + '","' + cell().replace(/"/g, '""') + '"');
    else lines.push(cell(), "");
  }
  return { body: lines.join(chance(r, 0.2) ? "\r\n" : "\n"), name: form === "csv" ? "reload.csv" : form === "table" ? "reload.md" : "reload.txt" };
}

let disk = null;
const handle = { kind: "file", name: "reload.txt", getFile: async () => disk };

async function openImport() {
  disk = new File(["Wide\tOne.\nClose\tTwo."], "reload.txt", { lastModified: 1 });
  handle.name = "reload.txt";
  await openProjectFile(disk, handle, { skipSnapshot: true });
}

async function reloadWith(file) {
  disk = new File([file.body], file.name, { lastModified: Date.now() });
  handle.name = file.name;
  const host = document.getElementById("toast-host");
  const shown = new Set(host.children);
  await reloadFileFromDisk();
  const failed = [...host.children].filter((el) => !shown.has(el) && el.classList.contains("error"));
  assert.deepEqual(failed.map((el) => el.textContent), [], file.name + ": the reload threw and showed an error");
}

test("booted app: seeded files reloaded in place keep the epoch and generation, and end in the same document with the file's scenes or a typed refusal", async (t) => {
  const tally = { kinds: {}, known: {}, typed: {} };
  await openImport();
  for (let seed = 1; seed <= RELOADS; seed++) {
    const r = seeded(0x3200 + seed);
    const file = fileText(r);
    const where = "reload seed " + seed + " (" + file.name + ")";
    flushEdits();
    const before = S.state, beforeText = JSON.stringify(S.state);
    const epoch = session.epoch(), gen = session.generation();
    heard.length = 0;
    await reloadWith(file);
    assert.equal(S.state, before, where + ": reloaded in place");
    assert.equal(held(), S.state, where + ": the session holds it");
    assert.deepEqual([session.epoch(), session.generation()], [epoch, gen], where + ": no epoch, no generation");
    if (!heard.length) {
      bump(tally.typed, "refused");
      assert.equal(JSON.stringify(S.state), beforeText, where + ": a refused reload changes nothing");
      continue;
    }
    bump(tally.kinds, "reload");
    assert.deepEqual(heard, ["reload"], where);
    const verdict = verdictOf(S.state, tally);
    assert.deepEqual(verdict.problems, [], where + ": " + JSON.stringify(S.state).slice(0, 400));
    verdict.known.forEach((k) => bump(tally.known, k));
  }
  t.diagnostic(JSON.stringify(tally));
  assert.ok((tally.kinds.reload || 0) >= RELOADS / 2, JSON.stringify(tally));
});

test("a reload in place migrates the reloaded scenes: each has its status, and the held document is a migrateRows fixed point (#411)", async () => {
  await openImport();
  const doc = S.state;
  await reloadWith({ body: "Wide\tPut the #kettle on.\nClose\tTwo.", name: "reload.txt" });
  assert.equal(S.state, doc);
  assert.equal(held(), doc);
  assert.deepEqual(doc.rows.map((row) => row.status), ["todo", "todo"]);
  assert.deepEqual(judge(doc, migrate, allowed), { problems: [], known: [] });
});

test("a reload in place takes the title from the file's first heading (#411)", async () => {
  await openImport();
  const doc = S.state;
  assert.equal(doc.title, "reload");
  await reloadWith({ body: "# Harbour at dawn\n\nWide\tOne.\nClose\tTwo.", name: "reload.md" });
  assert.equal(S.state, doc);
  assert.equal(held(), doc);
  assert.equal(doc.title, "Harbour at dawn");
});

test("a reload in place of a file with no heading takes the title from the file's name (#411)", async () => {
  await openImport();
  const doc = S.state;
  assert.equal(doc.title, "reload");
  await reloadWith({ body: "Wide\tOne.\nClose\tTwo.", name: "Kettle notes.txt" });
  assert.equal(S.state, doc);
  assert.equal(held(), doc);
  assert.equal(doc.title, "Kettle notes");
});

test("today a shot's audioRef taken from a line that reads like a tag keeps the brackets, and the next migration strips them (#325)", async () => {
  const raw = migrateRows({
    schema: 2, title: "Brackets", docId: "d" + "5".repeat(32),
    rows: [{ id: "r1", visualText: "B-roll: harbour", audioText: "Say &lt;b&gt;now&lt;/b&gt;", status: "todo" }]
  });
  await through("server", raw, "brackets", { kinds: {}, known: {}, typed: {} });
  const shot = held().brollShots.find((b) => /<b>/.test(b.audioRef));
  assert.ok(shot, JSON.stringify(held().brollShots));
  assert.equal(migrateRows(cloneState(held())).brollShots.find((b) => b.id === shot.id).audioRef, shot.audioRef.replace(/<[^>]*>/g, ""));
  assert.deepEqual(judge(held(), migrate, allowed), { problems: [], known: [KNOWN_SHOT_AUDIO_REF] });
});

test("today a bare \"B-roll:\" line makes the render-time repair add a shot with no name, which the next migration drops (#325)", async () => {
  const raw = migrateRows({
    schema: 2, title: "Bare", docId: "d" + "6".repeat(32),
    rows: [{ id: "r1", visualText: "B-roll:", audioText: "One.", status: "todo" }]
  });
  await through("server", raw, "bare", { kinds: {}, known: {}, typed: {} });
  assert.deepEqual(held().brollShots.map((b) => b.name), [""]);
  assert.deepEqual(migrateRows(cloneState(held())).brollShots, []);
});

test("today seed 400's recovery still finds the shot with no name (#325)", async () => {
  const tally = await seedEntries(400);
  assert.ok((tally.known[KNOWN_SHOT_AUDIO_REF] || 0) > 0, JSON.stringify(tally));
});

test("a comment createdAt whose toString is not a function migrates to null, so applyMerge renders, reports the merge and marks it unsaved (#410)", async () => {
  settle(startingDocument("Half"));
  const before = S.state;
  const theirs = table304Document("Theirs");
  theirs.comments = [
    { id: "c1", rowId: "r1", field: "audioText", body: "One", createdAt: "2026-10-07T09:00:00.000Z" },
    { id: "c2", rowId: "r1", field: "audioText", body: "Two", createdAt: JSON.parse('{"toString":1}') }
  ];
  const epoch = session.epoch();
  heard.length = 0;
  S.dirty = false;
  applyMerge({ base: cloneState(before), mine: cloneState(before), theirs: theirs, source: "server-resume", report: true, noAutoSave: true });
  assert.notEqual(S.state, before);
  assert.equal(held(), S.state);
  assert.equal(heard[0], "recovery");
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(S.dirty, true, "the merge was reported, so it is marked unsaved");
  assert.equal(S.state.comments.find((c) => c.id === "c2").createdAt, null);
  assert.deepEqual(judge(S.state, migrate, allowed).problems, []);
  settle(startingDocument("After half"));
});

test("seed 467's entries, whose recovery found #410, now all land in a valid fixed point", async () => {
  const tally = await seedEntries(467);
  assert.ok(tally.kinds.recovery, JSON.stringify(tally));
});

test("a merge whose raw theirs has a string rev migrates theirs first, so the merged rev is one past mine's (#412)", async () => {
  const start = startingDocument("Rev");
  start.rev = 5;
  settle(start);
  const theirs = table304Document("Theirs");
  theirs.rev = "seven";
  applyMerge({ base: cloneState(S.state), mine: cloneState(S.state), theirs: theirs, source: "server-conflict", report: false });
  assert.equal(held(), S.state);
  assert.equal(S.state.rev, 6);
  assert.deepEqual(judge(S.state, migrate, allowed).problems, []);
});

test("seed 21's entries, whose merge found #412, now all land in a valid fixed point", async () => {
  const tally = await seedEntries(21);
  assert.ok(tally.kinds.merge, JSON.stringify(tally));
});

function twoScenes(title) {
  const doc = startingDocument(title);
  settle(doc);
  const mine = cloneState(doc);
  mine.rows[0].audioText = "Mine, edited.";
  return { doc: doc, base: cloneState(doc), mine: mine, text: JSON.stringify(doc) };
}

function unchangedBy(where, start, epoch, gen) {
  assert.equal(S.state, start.doc, where + ": the document on screen is kept");
  assert.equal(JSON.stringify(S.state), start.text, where + ": and changes nothing");
  assert.equal(held(), S.state, where + ": the session still holds it");
  assert.deepEqual([session.epoch(), session.generation()], [epoch, gen], where + ": no epoch, no generation");
  assert.deepEqual(heard, [], where + ": nothing published");
}

const NOT_DOCUMENTS = [[{ id: "r1", audioText: "x" }], [], 7, "doc", true, null];

test("applyMerge refuses a theirs or a mine that is no document, and nothing changes: an array no longer merges in as an empty script that deletes the scenes mine didn't touch (#407)", () => {
  const calls = {
    server: (raw) => ({ theirs: raw, source: "server-conflict", unchanged: true, report: false }),
    merge: (raw, start) => ({ base: start.base, mine: start.mine, theirs: raw, source: "server-conflict", report: true, undoPoint: cloneState(start.doc) }),
    recovery: (raw, start) => ({ base: start.base, mine: start.mine, theirs: raw, source: "server-resume", report: true }),
    mine: (raw, start) => ({ base: start.base, mine: raw, theirs: table304Document("Theirs"), source: "server-conflict", report: true })
  };
  for (const raw of NOT_DOCUMENTS) {
    for (const [name, call] of Object.entries(calls)) {
      const start = twoScenes("Refused " + name);
      const opts = call(raw, start);
      const where = name + " " + JSON.stringify(raw);
      const epoch = session.epoch(), gen = session.generation();
      const undo = S.lastMergeUndo;
      heard.length = 0;
      S.dirty = false;
      const out = applyMerge(opts);
      unchangedBy(where, start, epoch, gen);
      assert.deepEqual([out.state, out.result, out.snapshot], [S.state, null, null], where + ": answers the document it kept");
      assert.equal(S.dirty, false, where + ": not marked unsaved");
      assert.equal(S.lastMergeUndo, undo, where + ": no merge to undo");
      assert.deepEqual(S.state.rows.map((row) => row.id), ["r1", "r2"], where + ": both scenes stay");
    }
  }
  settle(startingDocument("After refusals"));
});

test("applyMerge takes a base that is no document as no base, the way it takes a missing one (#407)", () => {
  const merged = (base) => {
    const start = twoScenes("Base");
    const theirs = table304Document("Untitled Script");
    theirs.rows[1].audioText = "Theirs, edited.";
    const out = applyMerge({ base: base === "start" ? start.base : base, mine: start.mine, theirs: theirs, source: "server-conflict", mergeOnly: true });
    return { title: out.state.title, stats: out.result.stats, conflicts: out.result.conflicts.map((c) => c.field), rows: out.state.rows.map((row) => [row.id, row.audioText]) };
  };
  const none = merged(null);
  assert.deepEqual([none.title, none.conflicts.includes("title")], ["Untitled Script", true], "with no base, both titles count as changed");
  for (const raw of [[{ id: "r1", audioText: "x" }], [], 7, "doc", true]) assert.deepEqual(merged(raw), none, JSON.stringify(raw));
  assert.notDeepEqual(merged("start"), none, "a real base still makes a three-way merge");
  settle(startingDocument("After bases"));
});

test("the reload seed that found #411 now ends in a migrateRows fixed point", async () => {
  const r = seeded(0x3200 + 1);
  await openImport();
  await reloadWith(fileText(r));
  assert.deepEqual(judge(S.state, migrate, allowed), { problems: [], known: [] });
});

const toastHost = () => document.getElementById("toast-host");
const toasts = () => Array.from(toastHost().querySelectorAll(".toast")).map((t) => t.textContent);
const idle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function reply(status, body) {
  return { status: status, ok: status >= 200 && status < 300, redirected: false, headers: { get: () => "application/json" }, json: async () => body };
}

async function withServer(answer, run) {
  const was = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url).replace(/^.*?(?=api\/)/, "");
    const method = (init && init.method) || "GET";
    asked.push(method + " " + path);
    return answer(method + " " + path) || reply(404, { error: "not-found" });
  };
  try { return await run(asked); } finally { globalThis.fetch = was; }
}

function holding(title) {
  twoScenes(title);
  heard.length = 0;
  toastHost().textContent = "";
  return { doc: S.state, text: JSON.stringify(S.state), epoch: session.epoch(), gen: session.generation() };
}

test("opening a legacy .html file whose state is no document is refused as not a Splitpage file, as a .splitpage file already is, and nothing changes (#407)", async () => {
  for (const raw of NOT_DOCUMENTS) {
    for (const [name, body] of [
      ["old.html", '<!doctype html><html><body><script id="state-data" type="application/json">' + JSON.stringify(raw) + "</script></body></html>"],
      ["old.splitpage", JSON.stringify(raw)]
    ]) {
      const start = holding("Open " + name);
      const opened = await openProjectFile(new File([body], name, { lastModified: 1 }), null, {});
      assert.equal(opened, false, name + " " + JSON.stringify(raw));
      assert.deepEqual(toasts(), [name + " doesn't look like a Splitpage file."]);
      unchangedBy(name + " " + JSON.stringify(raw), start, start.epoch, start.gen);
    }
  }
});

test("opening a server document whose state is no document is refused like an empty one, and nothing changes (#407)", async () => {
  for (const raw of NOT_DOCUMENTS) {
    const start = holding("Server open");
    const opened = await withServer((ask) => ask === "GET api/docs/doc-open" ? reply(200, { id: "doc-open", rev: 4, state: raw }) : null, () => openServerDoc("doc-open"));
    assert.equal(opened, false, JSON.stringify(raw));
    assert.deepEqual(toasts(), ["That document is empty."]);
    unchangedBy("open " + JSON.stringify(raw), start, start.epoch, start.gen);
  }
});

test("a server update whose state is no document is refused like one with no state: no merge, and the rev the tab knows stays (#407)", async () => {
  for (const raw of NOT_DOCUMENTS) {
    twoScenes("Pull");
    window.__hostedTest.setSession({ docId: "doc-pull", rev: 1 });
    const start = { doc: S.state, text: JSON.stringify(S.state) };
    const epoch = session.epoch(), gen = session.generation();
    heard.length = 0;
    await withServer((ask) => ask === "GET api/docs/doc-pull" ? reply(200, { id: "doc-pull", rev: 2, state: raw, updatedBy: "Ann" }) : null, async (asked) => {
      window.__hostedTest.noteRev({ docId: "doc-pull", rev: 2 });
      await idle();
      assert.deepEqual(asked, ["GET api/docs/doc-pull"]);
    });
    unchangedBy("pull " + JSON.stringify(raw), start, epoch, gen);
    assert.equal(window.__hostedTest.home().rev, 1);
  }
  window.__hostedTest.setSession({ docId: null });
});

test("a save conflict whose state is no document is not merged: the save fails as a conflict with no state does, and both scenes stay (#407)", async () => {
  for (const raw of NOT_DOCUMENTS) {
    twoScenes("Conflict");
    window.__hostedTest.setSession({ docId: "doc-save", rev: 1 });
    const doc = S.state, rows = JSON.stringify(S.state.rows);
    const epoch = session.epoch(), gen = session.generation();
    heard.length = 0;
    toastHost().textContent = "";
    const saved = await withServer((ask) => ask === "PUT api/docs/doc-save" ? reply(409, { error: "conflict", rev: 3, state: raw }) : null, () => saveToServer());
    assert.equal(saved, false, JSON.stringify(raw));
    assert.equal(S.state, doc);
    assert.equal(JSON.stringify(S.state.rows), rows);
    assert.equal(held(), S.state);
    assert.deepEqual([session.epoch(), session.generation(), heard], [epoch, gen, []]);
    assert.deepEqual(toasts().map((t) => t.split(" — ")[0]), ["Could not save to the server"]);
    assert.equal(window.__hostedTest.home().rev, 1);
  }
  window.__hostedTest.setSession({ docId: null });
});

test("reopening a server document after a reload refuses a state that is no document as a server open does: \"That document is empty.\", nothing changes and the reopen stays pending (#407)", async () => {
  for (const me of [{ role: "edit" }, { role: "edit", scope: "doc-resume" }]) {
    for (const raw of NOT_DOCUMENTS) {
      const where = "resume " + JSON.stringify(me) + " " + JSON.stringify(raw);
      const start = holding("Resume");
      const pending = JSON.stringify({ id: "doc-resume", rev: 1 });
      sessionStorage.setItem(SERVER_RESUME_KEY, pending);
      await withServer((ask) => ask === "GET api/me" ? reply(200, me) : ask === "GET api/docs/doc-resume" ? reply(200, { id: "doc-resume", rev: 2, state: raw }) : null, async (asked) => {
        await finishServerDetect();
        await idle();
        assert.deepEqual(asked, ["GET api/me", "GET api/docs/doc-resume"], where);
      });
      assert.deepEqual(toasts(), ["That document is empty."], where);
      unchangedBy(where, start, start.epoch, start.gen);
      assert.notEqual(window.__hostedTest.home().kind, "server");
      assert.equal(sessionStorage.getItem(SERVER_RESUME_KEY), pending);
      sessionStorage.removeItem(SERVER_RESUME_KEY);
    }
  }
  window.__hostedTest.setSession({ docId: null });
  settle(startingDocument("After the server"));
});

test("a reopen after a reload whose fetch fails still falls back to the link's document", async () => {
  const start = holding("Resume offline");
  sessionStorage.setItem(SERVER_RESUME_KEY, JSON.stringify({ id: "doc-resume", rev: 1 }));
  await withServer((ask) => {
    if (ask === "GET api/me") return reply(200, { role: "edit", scope: "doc-resume" });
    if (ask === "GET api/docs/doc-resume") throw new Error("offline");
    return null;
  }, async (asked) => {
    await finishServerDetect();
    await idle();
    assert.deepEqual(asked, ["GET api/me", "GET api/docs/doc-resume", "GET api/docs/doc-resume"]);
  });
  assert.equal(S.state, start.doc);
  sessionStorage.removeItem(SERVER_RESUME_KEY);
  window.__hostedTest.setSession({ docId: null });
  settle(startingDocument("After the server"));
});

test("a reopen after a reload that is refused as no document does not stop the document the link names from opening", async () => {
  for (const link of [{ role: "edit", scope: "doc-other" }, { role: "edit", scope: "doc-resume" }]) {
    const opensOther = link.scope === "doc-other";
    const where = "reopen " + JSON.stringify(link);
    const start = holding("Resume then link");
    const pending = JSON.stringify({ id: "doc-resume", rev: 1 });
    sessionStorage.setItem(SERVER_RESUME_KEY, pending);
    await withServer((ask) => {
      if (ask === "GET api/me") return reply(200, link);
      if (ask === "GET api/docs/doc-resume") return reply(200, { id: "doc-resume", rev: 2, state: [] });
      if (ask === "GET api/docs/doc-other") return reply(200, { id: "doc-other", rev: 5, state: startingDocument("Other") });
      return null;
    }, async (asked) => {
      await finishServerDetect();
      await idle();
      assert.deepEqual(asked, ["GET api/me", "GET api/docs/doc-resume"].concat(opensOther ? ["GET api/docs/doc-other"] : []), where);
    });
    if (opensOther) {
      assert.equal(toasts().length, 2, where);
      assert.equal(toasts()[0], "That document is empty.", where);
      assert.match(toasts()[1], /^Opened .* from the server — \d+ scenes?$/, where);
      assert.equal(window.__hostedTest.home().kind, "server", where);
      assert.equal(window.__hostedTest.home().id, "doc-other", where);
      assert.notEqual(S.state, start.doc, where);
    } else {
      assert.deepEqual(toasts(), ["That document is empty."], where);
      assert.equal(S.state, start.doc, where);
    }
    assert.equal(sessionStorage.getItem(SERVER_RESUME_KEY), pending, where);
    sessionStorage.removeItem(SERVER_RESUME_KEY);
    window.__hostedTest.setSession({ docId: null });
    settle(startingDocument("After the server"));
  }
});

test("a server open that takes a pending browser draft and finds a state that is no document answers not opened: the picker stays open and the message shows once", async () => {
  const store = createIdbDraftStore();
  const key = browserDraftKey(draftBaseOf("", window.location.href), "doc-draft");
  const draft = JSON.stringify(startingDocument("Draft"));
  const put = await store.put({
    key: key, base: draftBaseOf("", window.location.href), docId: "doc-draft", rev: 1, title: "Draft",
    writerId: "another-tab", editSeq: 1, schema: 2, docIdWrittenOut: true, stateJson: draft, baseJson: draft
  });
  assert.equal(put.ok, true);
  const start = holding("Server pick");
  const modal = document.getElementById("server-modal");
  modal.hidden = false;
  S.serverMode.checked = true;
  const opened = await withServer((ask) => ask === "GET api/docs/doc-draft" ? reply(200, { id: "doc-draft", rev: 2, state: [] }) : null, async (asked) => {
    const result = await openServerDoc("doc-draft");
    assert.deepEqual(asked, ["GET api/docs/doc-draft"]);
    return result;
  });
  assert.ok(S.draftServerResume, "the browser draft was taken");
  assert.equal(opened, false);
  assert.deepEqual(toasts(), ["That document is empty."]);
  assert.equal(modal.hidden, false);
  unchangedBy("server open with a draft", start, start.epoch, start.gen);
  assert.notEqual(window.__hostedTest.home().kind, "server");
  S.draftServerResume.onDone("not-found");
  await idle();
  await store.remove(key);
  modal.hidden = true;
  window.__hostedTest.setSession({ docId: null });
  settle(startingDocument("After the server"));
});
