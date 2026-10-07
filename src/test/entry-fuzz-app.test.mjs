import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { S } from "../js/_state.js";
import {
  KNOWN_REV_NAN, TABLE_304, chance, judge, knownThrow, pick, rawObject, seeded, table304Document, text, upTo
} from "../../tests/application/raw-inputs.ts";

await bootApp();

const { liveSession } = await import("../legacy/session-bridge.ts");
const { migrateRows } = await import("../js/02-state.js");
const { applyMerge, cloneState } = await import("../js/03-sync.js");
const { flushEdits } = await import("../js/12a-undo.js");
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

const KNOWN_HALF_APPLIED = "a comment createdAt that is not a string makes render throw after applyMerge handed the document to the session and S.state, so the merge's report, dirty marking and autosave never run (#410)";

const SHOT_AUDIO_REF = /^\.brollShots\[\d+\]\.audioRef "[^]*<[^]*>/;

function allowed(path) {
  return SHOT_AUDIO_REF.test(path) ? KNOWN_SHOT_AUDIO_REF : null;
}

const errors = [];

async function quietly(run) {
  const was = window.console.error;
  window.console.error = (e) => { errors.push(e); };
  try { return await run(); } finally { window.console.error = was; }
}

function settle(doc) {
  S.state = doc;
  flushEdits();
  heard.length = 0;
}

function bump(into, key) {
  into[key] = (into[key] || 0) + 1;
}

function startingDocument(title) {
  return migrateRows(table304Document(title));
}

const ENTRIES = {
  draft: {
    kind: "adopt",
    opens: true,
    run: (raw) => quietly(() => applyTakenDraft({ header: { origin: { kind: "untitled" } }, stateJson: JSON.stringify(raw) }))
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
  let outcome, thrown = null;
  try {
    outcome = await entry.run(raw, base, mine);
  } catch (e) {
    thrown = e;
  }
  if (thrown || outcome === "failed" || outcome === "nothing-unsaved") {
    if (thrown) {
      const known = knownThrow(thrown);
      assert.ok(known, where + " threw: " + (thrown && thrown.stack));
      bump(tally.known, known);
      if (S.state !== before) {
        assert.match(String(thrown.stack), /\n\s+at render \(/, where + ": only render throws once the document is in: " + thrown.stack);
        assert.equal(held(), S.state, where + ": the session holds what the app shows");
        bump(tally.known, KNOWN_HALF_APPLIED);
        settle(startingDocument("After " + where));
        return;
      }
    } else {
      bump(tally.typed, name + ":" + outcome);
      errors.forEach((e) => {
        const known = knownThrow(e);
        assert.ok(known, where + " failed on: " + (e && e.stack));
        bump(tally.known, known);
      });
    }
    assert.equal(S.state, before, where + ": a failed entry keeps the document" + (thrown ? " (" + thrown.stack + ")" : ""));
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

test("booted app: seeded raw documents through a draft adoption, a server update, a merge and a recovery merge end in a valid fixed point or a typed failure", async (t) => {
  const tally = { kinds: {}, known: {}, typed: {} };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = seeded(0x3100 + seed);
    settle(startingDocument("Seed " + seed));
    for (const name of Object.keys(ENTRIES)) {
      if (!chance(r, 0.75)) continue;
      const raw = rawObject(r);
      await through(name, raw, "seed " + seed + " " + name, tally);
      if (Array.isArray(S.state) || !Array.isArray(S.state.rows)) settle(startingDocument("Reset " + seed));
    }
  }
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
  const tally = { kinds: {}, known: {}, typed: {} };
  const r = seeded(0x3100 + 400);
  settle(startingDocument("Seed 400"));
  for (const name of Object.keys(ENTRIES)) {
    if (!chance(r, 0.75)) continue;
    await through(name, rawObject(r), "seed 400 " + name, tally);
    if (Array.isArray(S.state) || !Array.isArray(S.state.rows)) settle(startingDocument("Reset 400"));
  }
  assert.ok((tally.known[KNOWN_SHOT_AUDIO_REF] || 0) > 0, JSON.stringify(tally));
});

test("today a comment createdAt whose toString is not a function survives migration, and render then throws out of applyMerge after the session and S.state took the document (#410)", async () => {
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
  assert.throws(() => applyMerge({ base: cloneState(before), mine: cloneState(before), theirs: theirs, source: "server-resume", report: true }),
    (e) => knownThrow(e) !== null && /\n\s+at render \(/.test(e.stack));
  assert.notEqual(S.state, before);
  assert.equal(held(), S.state);
  assert.deepEqual(heard, ["recovery"]);
  assert.equal(session.epoch(), epoch + 1);
  assert.equal(S.dirty, false, "the merge was never reported, so nothing marked it unsaved");
  settle(startingDocument("After half"));
});

test("today seed 467's recovery still finds the half-applied merge (#410)", async () => {
  const tally = { kinds: {}, known: {}, typed: {} };
  const r = seeded(0x3100 + 467);
  settle(startingDocument("Seed 467"));
  for (const name of Object.keys(ENTRIES)) {
    if (!chance(r, 0.75)) continue;
    await through(name, rawObject(r), "seed 467 " + name, tally);
    if (Array.isArray(S.state) || !Array.isArray(S.state.rows)) settle(startingDocument("Reset 467"));
  }
  assert.ok((tally.known[KNOWN_HALF_APPLIED] || 0) > 0, JSON.stringify(tally));
});

test("today a merge with a raw theirs whose rev is a string leaves the session holding rev NaN (#412)", async () => {
  settle(startingDocument("Rev"));
  const theirs = table304Document("Theirs");
  theirs.rev = "seven";
  applyMerge({ base: cloneState(S.state), mine: cloneState(S.state), theirs: theirs, source: "server-conflict", report: false });
  assert.equal(held(), S.state);
  assert.equal(Number.isNaN(S.state.rev), true);
  assert.equal(JSON.parse(JSON.stringify(S.state)).rev, null);
  assert.equal(migrateRows(cloneState(S.state)).rev, 0);
});

test("today seed 21's merge still finds the NaN rev (#412)", async () => {
  const tally = { kinds: {}, known: {}, typed: {} };
  const r = seeded(0x3100 + 21);
  settle(startingDocument("Seed 21"));
  for (const name of Object.keys(ENTRIES)) {
    if (!chance(r, 0.75)) continue;
    await through(name, rawObject(r), "seed 21 " + name, tally);
    if (Array.isArray(S.state) || !Array.isArray(S.state.rows)) settle(startingDocument("Reset 21"));
  }
  assert.ok((tally.known[KNOWN_REV_NAN] || 0) > 0, JSON.stringify(tally));
});

test("the reload seed that found #411 now ends in a migrateRows fixed point", async () => {
  const r = seeded(0x3200 + 1);
  await openImport();
  await reloadWith(fileText(r));
  assert.deepEqual(judge(S.state, migrate, allowed), { problems: [], known: [] });
});
