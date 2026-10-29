import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";
import {
  TABLE_304, chance, judge, pick, rawObject, seeded, table304Document, text, upTo
} from "../../tests/application/raw-inputs.ts";
import { cloneState } from "../core/document/clone.ts";
import { confirmSavedNow, unsavedChanges } from "../legacy/save-bridge.ts";

await bootApp();

const { liveSession } = await import("../bootstrap/wiring/session-owner.ts");
const { migrateRows } = await import("../legacy/document-ports.ts");
const { applyMerge } = await import("../bootstrap/wiring/document-merge.ts");
const { mergeUndo } = await import("../bootstrap/wiring/editor-owners.ts");
const { undoOwner } = await import("../bootstrap/wiring/undo.ts");
const flushEdits = () => undoOwner().flush();
const { localFilesOwner } = await import("../bootstrap/wiring/local-files.ts");
const { applyTakenDraft } = await import("../bootstrap/wiring/drafts.ts");
const { loadTestDocument } = await import("./_document.mjs");
const { openDocument } = await import("../bootstrap/wiring/transition-owners.ts");

after(closeApp);

const SEEDS = Math.max(40, Math.round((Number(process.env.SPLITPAGE_FUZZ_SEEDS) || 0) / 4));
const RELOADS = Math.max(24, Math.round((Number(process.env.SPLITPAGE_FUZZ_SEEDS) || 0) / 6));

const session = liveSession();
const heard = [];
let stopHearing = session.subscribe((c) => heard.push(c.kind));

function hearReplacement() {
  stopHearing();
  stopHearing = session.subscribe((c) => heard.push(c.kind));
}
const held = () => session.read((doc) => doc);
const migrate = (raw) => migrateRows(raw);

function allowed() {
  return null;
}

const errors = [];

async function quietly(run) {
  const consoles = [...new Set([window.console, globalThis.console])];
  const was = consoles.map((c) => c.error);
  consoles.forEach((c) => { c.error = (e) => { errors.push(e); }; });
  try { return await run(); } finally { consoles.forEach((c, i) => { c.error = was[i]; }); }
}

function settle(doc) {
  loadTestDocument(doc);
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
    replaces: true,
    run: (raw) => applyTakenDraft({ header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(raw) })
  },
  server: {
    kind: "server",
    opens: false,
    run: (raw) => applyMerge({ theirs: raw, source: "stash", unchanged: true, report: false })
  },
  merge: {
    kind: "server",
    opens: false,
    run: (raw, base, mine) => applyMerge({ base: base, mine: mine, theirs: raw, source: "stash", report: false })
  },
  recovery: {
    kind: "recovery",
    opens: true,
    run: (raw, base, mine) => applyMerge({ base: base, mine: mine, theirs: raw, source: "stash", recovery: true, report: false })
  }
};

const RENDER_BROKE = "render broke (#418)";
const REDRAW = "Could not redraw the script after the update. Nothing was lost — press Redraw before you keep editing.";

function breakRender() {
  const box = document.getElementById("doc-title");
  const real = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(box, "value", { configurable: true, get() { return real.get.call(this); }, set() { throw new Error(RENDER_BROKE); } });
  return () => { delete box.value; };
}

function redrawOffered() {
  return Array.from(document.querySelectorAll("#toast-host .toast.has-action")).some((el) => el.firstChild.nodeValue === REDRAW);
}

async function through(name, raw, where, tally, spoilMine, broken) {
  const entry = ENTRIES[name];
  const base = cloneState(currentDocument());
  const mine = cloneState(currentDocument());
  if (mine.rows[0]) mine.rows[0].audioText = "Mine, " + where + ".";
  if (spoilMine) spoilMine(mine);
  const before = currentDocument(), beforeText = JSON.stringify(currentDocument());
  errors.length = 0;
  const epoch = session.epoch(), gen = session.generation();
  heard.length = 0;
  let outcome;
  const unbreak = broken ? breakRender() : null;
  try {
    outcome = await quietly(() => entry.run(raw, base, mine));
  } catch (e) {
    assert.fail(where + " threw: " + (e && e.stack));
  } finally {
    if (unbreak) unbreak();
  }
  const refused = noDocument(raw);
  const failed = refused || outcome === "failed" || outcome === "nothing-unsaved";
  const logged = errors.map((e) => broken && e && e.message === RENDER_BROKE ? RENDER_BROKE : String((e && e.stack) || e));
  assert.deepEqual(logged, broken && !failed ? [RENDER_BROKE] : [], where + " logged an error");
  if (broken) {
    assert.equal(redrawOffered(), !failed, where + ": the redraw toast");
    document.getElementById("toast-host").textContent = "";
  }
  if (failed) {
    bump(tally.typed, name + ":" + (refused ? "no document" : outcome));
    if (refused && name === "draft") assert.equal(outcome, "failed", where + ": a draft that is no document is a typed failure");
    assert.equal(currentDocument(), before, where + ": a failed entry keeps the document");
    assert.equal(JSON.stringify(currentDocument()), beforeText, where + ": and leaves it as it was");
    assert.equal(held(), currentDocument(), where + ": the session still holds it");
    assert.deepEqual([session.epoch(), session.generation()], [epoch, gen], where + ": no epoch, no generation");
    assert.deepEqual(heard, [], where + ": nothing published");
    return;
  }
  bump(tally.kinds, name);
  if (entry.replaces) {
    hearReplacement();
    assert.deepEqual(heard, [], where + ": a new session, so the old one's subscription heard nothing");
  } else {
    assert.deepEqual(heard, [entry.kind], where + ": published");
  }
  assert.equal(session.epoch(), epoch + (entry.opens ? 1 : 0), where + ": epoch");
  assert.equal(session.generation(), gen, where + ": generation");
  assert.equal(held(), currentDocument(), where + ": the session holds the document the app shows");
  assert.equal(JSON.stringify(before), beforeText, where + ": the replaced document was not written into");
  const verdict = verdictOf(currentDocument());
  assert.deepEqual(verdict.problems, [], where + ": " + JSON.stringify(currentDocument()).slice(0, 400));
  verdict.known.forEach((k) => bump(tally.known, k));
}

function verdictOf(doc) {
  return judge(doc, migrate, allowed);
}

async function seedEntries(seed, tally = { kinds: {}, known: {}, typed: {} }, broken = false) {
  const r = seeded(0x3100 + seed);
  settle(startingDocument("Seed " + seed));
  for (const name of Object.keys(ENTRIES)) {
    if (!chance(r, 0.75)) continue;
    await through(name, rawObject(r), "seed " + seed + " " + name + (broken ? ", render throwing" : ""), tally, null, broken);
  }
  return tally;
}

test("booted app: seeded raw documents through a draft adoption, a server update, a merge and a recovery merge end in a valid fixed point, a typed failure or a refusal that changes nothing", async (t) => {
  const tally = { kinds: {}, known: {}, typed: {} };
  for (let seed = 1; seed <= SEEDS; seed++) await seedEntries(seed, tally);
  flushEdits();
  t.diagnostic(JSON.stringify(tally));
  assert.deepEqual(tally.known, {});
  for (const name of Object.keys(ENTRIES)) assert.ok((tally.kinds[name] || 0) >= SEEDS / 4, "every entry point lands: " + name + " " + JSON.stringify(tally.kinds));
});

test("booted app: with render() throwing, the same seeded entries still land whole, publish, stay held and end in a valid fixed point; the render error is logged once and Redraw is offered (#418)", async (t) => {
  const tally = { kinds: {}, known: {}, typed: {} };
  for (let seed = 1; seed <= SEEDS; seed++) await seedEntries(seed, tally, true);
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
  await openDocument({ kind: "file", file: disk, handle: handle, options: { skipSnapshot: true } });
  hearReplacement();
}

async function reloadWith(file) {
  disk = new File([file.body], file.name, { lastModified: Date.now() });
  handle.name = file.name;
  const host = document.getElementById("toast-host");
  const shown = new Set(host.children);
  await localFilesOwner().reloadFileFromDisk();
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
    const before = currentDocument(), beforeText = JSON.stringify(currentDocument());
    const epoch = session.epoch(), gen = session.generation();
    heard.length = 0;
    await reloadWith(file);
    assert.equal(currentDocument(), before, where + ": reloaded in place");
    assert.equal(held(), currentDocument(), where + ": the session holds it");
    assert.deepEqual([session.epoch(), session.generation()], [epoch, gen], where + ": no epoch, no generation");
    if (!heard.length) {
      bump(tally.typed, "refused");
      assert.equal(JSON.stringify(currentDocument()), beforeText, where + ": a refused reload changes nothing");
      continue;
    }
    bump(tally.kinds, "reload");
    assert.deepEqual(heard, ["reload"], where);
    const verdict = verdictOf(currentDocument());
    assert.deepEqual(verdict.problems, [], where + ": " + JSON.stringify(currentDocument()).slice(0, 400));
    verdict.known.forEach((k) => bump(tally.known, k));
  }
  t.diagnostic(JSON.stringify(tally));
  assert.ok((tally.kinds.reload || 0) >= RELOADS / 2, JSON.stringify(tally));
});

test("a reload in place migrates the reloaded scenes: each has its status, and the held document is a migrateRows fixed point (#411)", async () => {
  await openImport();
  const doc = currentDocument();
  await reloadWith({ body: "Wide\tPut the #kettle on.\nClose\tTwo.", name: "reload.txt" });
  assert.equal(currentDocument(), doc);
  assert.equal(held(), doc);
  assert.deepEqual(doc.rows.map((row) => row.status), ["todo", "todo"]);
  assert.deepEqual(judge(doc, migrate, allowed), { problems: [], known: [] });
});

test("a reload in place takes the title from the file's first heading (#411)", async () => {
  await openImport();
  const doc = currentDocument();
  assert.equal(doc.title, "reload");
  await reloadWith({ body: "# Harbour at dawn\n\nWide\tOne.\nClose\tTwo.", name: "reload.md" });
  assert.equal(currentDocument(), doc);
  assert.equal(held(), doc);
  assert.equal(doc.title, "Harbour at dawn");
});

test("a reload in place of a file with no heading takes the title from the file's name (#411)", async () => {
  await openImport();
  const doc = currentDocument();
  assert.equal(doc.title, "reload");
  await reloadWith({ body: "Wide\tOne.\nClose\tTwo.", name: "Kettle notes.txt" });
  assert.equal(currentDocument(), doc);
  assert.equal(held(), doc);
  assert.equal(doc.title, "Kettle notes");
});

test("a shot's audioRef taken from a line that reads like a tag is stored without the brackets, so the next migration changes nothing (#325 H)", async () => {
  const raw = migrateRows({
    schema: 2, title: "Brackets", docId: "d" + "5".repeat(32),
    rows: [{ id: "r1", visualText: "B-roll: harbour", audioText: "Say &lt;b&gt;now&lt;/b&gt;", status: "todo" }]
  });
  await through("server", raw, "brackets", { kinds: {}, known: {}, typed: {} });
  assert.deepEqual(held().brollShots.map((b) => [b.name, b.audioRef]), [["harbour", "Say now"]]);
  assert.deepEqual(migrateRows(cloneState(held())).brollShots, held().brollShots);
  assert.deepEqual(judge(held(), migrate, allowed), { problems: [], known: [] });
});

test("a bare \"B-roll:\" line makes no shot, at entry or at render (#325 H)", async () => {
  const raw = migrateRows({
    schema: 2, title: "Bare", docId: "d" + "6".repeat(32),
    rows: [{ id: "r1", visualText: "B-roll:", audioText: "One.", status: "todo" }]
  });
  await through("server", raw, "bare", { kinds: {}, known: {}, typed: {} });
  assert.deepEqual(held().brollShots, []);
  assert.deepEqual(migrateRows(cloneState(held())).brollShots, []);
});

test("seed 400's recovery, which used to find a shot with no name, ends in a valid fixed point with nothing allowed (#325 H)", async () => {
  const tally = await seedEntries(400);
  assert.deepEqual(tally.known, {});
});

test("a comment createdAt whose toString is not a function migrates to null, so applyMerge renders, reports the merge and marks it unsaved (#410)", async () => {
  settle(startingDocument("Half"));
  const before = currentDocument();
  const theirs = table304Document("Theirs");
  theirs.comments = [
    { id: "c1", rowId: "r1", field: "audioText", body: "One", createdAt: "2026-10-07T09:00:00.000Z" },
    { id: "c2", rowId: "r1", field: "audioText", body: "Two", createdAt: JSON.parse('{"toString":1}') }
  ];
  const epoch = session.epoch();
  heard.length = 0;
  confirmSavedNow();
  applyMerge({ base: cloneState(before), mine: cloneState(before), theirs: theirs, source: "stash", recovery: true, report: true, noAutoSave: true });
  assert.notEqual(currentDocument(), before);
  assert.equal(held(), currentDocument());
  assert.equal(heard[0], "recovery");
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(unsavedChanges(), true, "the merge was reported, so it is marked unsaved");
  assert.equal(currentDocument().comments.find((c) => c.id === "c2").createdAt, null);
  assert.deepEqual(judge(currentDocument(), migrate, allowed).problems, []);
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
  applyMerge({ base: cloneState(currentDocument()), mine: cloneState(currentDocument()), theirs: theirs, source: "stash", report: false });
  assert.equal(held(), currentDocument());
  assert.equal(currentDocument().rev, 6);
  assert.deepEqual(judge(currentDocument(), migrate, allowed).problems, []);
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
  assert.equal(currentDocument(), start.doc, where + ": the document on screen is kept");
  assert.equal(JSON.stringify(currentDocument()), start.text, where + ": and changes nothing");
  assert.equal(held(), currentDocument(), where + ": the session still holds it");
  assert.deepEqual([session.epoch(), session.generation()], [epoch, gen], where + ": no epoch, no generation");
  assert.deepEqual(heard, [], where + ": nothing published");
}

const NOT_DOCUMENTS = [[{ id: "r1", audioText: "x" }], [], 7, "doc", true, null];

test("applyMerge refuses a theirs or a mine that is no document, and nothing changes: an array no longer merges in as an empty script that deletes the scenes mine didn't touch (#407)", () => {
  const calls = {
    server: (raw) => ({ theirs: raw, source: "stash", unchanged: true, report: false }),
    merge: (raw, start) => ({ base: start.base, mine: start.mine, theirs: raw, source: "stash", report: true, undoPoint: cloneState(start.doc) }),
    recovery: (raw, start) => ({ base: start.base, mine: start.mine, theirs: raw, source: "stash", recovery: true, report: true }),
    mine: (raw, start) => ({ base: start.base, mine: raw, theirs: table304Document("Theirs"), source: "stash", report: true })
  };
  for (const raw of NOT_DOCUMENTS) {
    for (const [name, call] of Object.entries(calls)) {
      const start = twoScenes("Refused " + name);
      const opts = call(raw, start);
      const where = name + " " + JSON.stringify(raw);
      const epoch = session.epoch(), gen = session.generation();
      const undo = mergeUndo().last();
      heard.length = 0;
      confirmSavedNow();
      const out = applyMerge(opts);
      unchangedBy(where, start, epoch, gen);
      assert.deepEqual([out.state, out.result, out.snapshot], [currentDocument(), null, null], where + ": answers the document it kept");
      assert.equal(unsavedChanges(), false, where + ": not marked unsaved");
      assert.equal(mergeUndo().last(), undo, where + ": no merge to undo");
      assert.deepEqual(currentDocument().rows.map((row) => row.id), ["r1", "r2"], where + ": both scenes stay");
    }
  }
  settle(startingDocument("After refusals"));
});

test("applyMerge takes a base that is no document as no base, the way it takes a missing one (#407)", () => {
  const merged = (base) => {
    const start = twoScenes("Base");
    const theirs = table304Document("Untitled Script");
    theirs.rows[1].audioText = "Theirs, edited.";
    const out = applyMerge({ base: base === "start" ? start.base : base, mine: start.mine, theirs: theirs, source: "stash", mergeOnly: true });
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
  assert.deepEqual(judge(currentDocument(), migrate, allowed), { problems: [], known: [] });
});

const toastHost = () => document.getElementById("toast-host");
const toasts = () => Array.from(toastHost().querySelectorAll(".toast")).map((t) => t.textContent);
function holding(title) {
  twoScenes(title);
  heard.length = 0;
  toastHost().textContent = "";
  return { doc: currentDocument(), text: JSON.stringify(currentDocument()), epoch: session.epoch(), gen: session.generation() };
}

test("opening a legacy .html file whose state is no document is refused as not a Splitpage file, as a .splitpage file already is, and nothing changes (#407)", async () => {
  for (const raw of NOT_DOCUMENTS) {
    for (const [name, body] of [
      ["old.html", '<!doctype html><html><body><script id="state-data" type="application/json">' + JSON.stringify(raw) + "</script></body></html>"],
      ["old.splitpage", JSON.stringify(raw)]
    ]) {
      const start = holding("Open " + name);
      const opened = await openDocument({ kind: "file", file: new File([body], name, { lastModified: 1 }), handle: null, options: {} });
      assert.equal(opened, false, name + " " + JSON.stringify(raw));
      assert.deepEqual(toasts(), [name + " doesn't look like a Splitpage file."]);
      unchangedBy(name + " " + JSON.stringify(raw), start, start.epoch, start.gen);
    }
  }
});

