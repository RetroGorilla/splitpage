import { test } from "node:test";
import assert from "node:assert/strict";
import { createOperations } from "../../src/application/session/operation.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";
import { createTransitions } from "../../src/application/transitions/transitions.ts";
import type { Transitions } from "../../src/application/transitions/transitions.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { rawScript } from "./session-fakes.ts";

interface Destination {
  readonly name: string;
}

interface World {
  transitions: Transitions<Destination>;
  log: string[];
  live: () => ValidatedDocument | null;
  destination: () => Destination;
  baseline: () => string | null;
  writtenOut: () => boolean;
  epoch: () => number;
  capture: () => OperationContext;
  setDestination: (d: Destination) => void;
  setConnection: (c: object) => void;
}

const FILE: Destination = Object.freeze({ name: "file" });
const NOWHERE: Destination = Object.freeze({ name: "none" });
const SERVER: Destination = Object.freeze({ name: "server" });

function idOf(digit: string): string {
  return "d" + digit.repeat(32);
}

function world(opened?: { doc: ValidatedDocument; writtenOut: boolean; destination: Destination }): World {
  const migration = fakeMigration();
  const log: string[] = [];
  let live: ValidatedDocument | null = opened ? opened.doc : null;
  let held: ValidatedDocument | null = live;
  let epoch = opened ? 1 : 0;
  let destination: Destination = opened ? opened.destination : NOWHERE;
  let baseline: string | null = opened ? JSON.stringify(opened.doc) : null;
  let writtenOut = opened ? opened.writtenOut : false;
  let connection: object = {};
  let minted = 0;
  const operations = createOperations({
    session: { epoch: function () { return epoch; }, generation: function () { return 0; } },
    document: { id: function () { return held ? held.docId : null; } },
    destination: { identity: function () { return destination; }, generation: function () { return 0; }, revision: function () { return null; } },
    connection: { current: function () { return connection; } }
  });
  const transitions = createTransitions<Destination>({
    entry: function (raw) { log.push("entry"); return migrateRows(raw, migration.ports); },
    live: {
      current: function () { return live; },
      assign: function (doc) {
        log.push("assign:" + doc.title);
        live = doc;
        held = doc;
        epoch++;
      },
      stamp: function (task) {
        const doc = live;
        const plan = doc ? task.plan(doc) : null;
        if (!doc || !plan) return { kind: "noop" };
        plan.apply(doc);
        return { kind: "applied", generation: 0, changes: plan.changes };
      }
    },
    destination: {
      set: function (d) { log.push("destination:" + d.name); destination = d; },
      confirm: function (doc, reason) { log.push("baseline:" + (doc ? doc.title : "none") + ":" + reason); baseline = doc ? JSON.stringify(doc) : null; }
    },
    identity: {
      mint: function () { minted++; return idOf(String(minted + 4)); },
      writtenOut: function () { return writtenOut; },
      markWrittenOut: function (out) { log.push("writtenOut:" + String(out)); writtenOut = out; }
    },
    history: {
      keep: function (label, doc) {
        log.push("keep:" + label + ":" + (doc ? doc.title : (live ? live.title : "none")));
        return label === "not stored" ? null : { label: label };
      }
    },
    ownership: operations
  });
  return {
    transitions: transitions,
    log: log,
    live: function () { return live; },
    destination: function () { return destination; },
    baseline: function () { return baseline; },
    writtenOut: function () { return writtenOut; },
    epoch: function () { return epoch; },
    capture: operations.capture,
    setDestination: function (d) { destination = d; },
    setConnection: function (c) { connection = c; }
  };
}

function scriptWith(title: string, docId: string): ValidatedDocument {
  return migrateRows({ ...rawScript(title), docId: docId }, fakeMigration().ports);
}

function opened(writtenOut: boolean, destination: Destination = FILE): World {
  return world({ doc: scriptWith("Open", idOf("1")), writtenOut: writtenOut, destination: destination });
}

test("startNew hands the document to the live-document port, which replaces the held one, before any destination, baseline or identity write", () => {
  const w = opened(true);
  const next = scriptWith("New", idOf("2"));
  const arrived = w.transitions.startNew({ from: { document: next }, reason: "a new script", destination: NOWHERE });
  assert.equal(arrived.document, next);
  assert.equal(arrived.forkedFrom, null);
  assert.deepEqual(w.log, ["assign:New", "destination:none", "baseline:New:a new script", "writtenOut:false"]);
  assert.equal(w.live(), next);
  assert.equal(w.epoch(), 2, "a new epoch");
  assert.equal(w.baseline(), JSON.stringify(next), "the new document is its own confirmed baseline");
  assert.equal(w.writtenOut(), false, "a new document's id has not been written out anywhere");
  assert.equal(next.docId, idOf("2"), "it keeps the id it was made with");
});

test("startNew with no destination leaves the destination as it was", () => {
  const w = opened(true, SERVER);
  w.transitions.startNew({ from: { document: scriptWith("New", idOf("2")) }, reason: "a new tab" });
  assert.equal(w.destination(), SERVER);
  assert.equal(w.log.some(function (l) { return l.startsWith("destination:"); }), false);
});

test("open migrates raw input once, keeps its id, and sets the destination, baseline and written-out flag it is given", () => {
  const w = opened(false);
  const arrived = w.transitions.open({ from: { raw: { ...rawScript("From disk"), docId: idOf("3") } }, reason: "opened", destination: FILE, writtenOut: true });
  assert.deepEqual(w.log, ["entry", "assign:From disk", "destination:file", "baseline:From disk:opened", "writtenOut:true"]);
  assert.equal(arrived.document.docId, idOf("3"), "open keeps the file's id");
  assert.equal(w.writtenOut(), true);
});

test("open with no written-out flag leaves it as it was (the boot document decides it before it opens)", () => {
  const w = opened(true);
  w.transitions.open({ from: { document: scriptWith("Boot", idOf("3")) }, reason: "boot" });
  assert.deepEqual(w.log, ["assign:Boot", "baseline:Boot:boot"]);
  assert.equal(w.writtenOut(), true);
});

test("a same-id reopen keeps the id and is a new epoch all the same", () => {
  const w = opened(true);
  const epoch = w.epoch();
  const again = w.transitions.open({ from: { document: scriptWith("Open", idOf("1")) }, reason: "reopened", destination: FILE });
  assert.equal(again.document.docId, idOf("1"));
  assert.equal(w.epoch(), epoch + 1);
});

test("restore keeps the open document's id and writes no destination, baseline or identity", () => {
  const w = opened(true);
  const version = scriptWith("An older version", idOf("6"));
  const arrived = w.transitions.restore({ from: { document: version } });
  assert.equal(arrived.document.docId, idOf("1"), "restore keeps the open document's id");
  assert.deepEqual(w.log, ["assign:An older version"]);
  assert.equal(w.destination(), FILE);
  assert.equal(w.writtenOut(), true);
});

test("a detached recovery forks the id; an attached one keeps it", () => {
  const detached = opened(true);
  const copy = scriptWith("Recovered", idOf("4"));
  const forked = detached.transitions.recover({ from: { document: copy }, reason: "a copy with no home", detached: true, baseline: null, destination: NOWHERE, writtenOut: true });
  assert.notEqual(forked.document.docId, idOf("4"), "a detached recovery gets a new id");
  assert.equal(forked.forkedFrom, idOf("4"), "and names the id it forked from, for the history copy");
  assert.equal(detached.writtenOut(), false, "the new id has been written out nowhere");
  assert.equal(detached.baseline(), null);
  const attached = opened(false);
  const kept = attached.transitions.recover({ from: { document: scriptWith("Untitled draft", idOf("7")) }, reason: "the draft's own base", detached: false, baseline: null, writtenOut: true });
  assert.equal(kept.document.docId, idOf("7"));
  assert.equal(kept.forkedFrom, null);
  assert.equal(attached.writtenOut(), true);
});

test("INV-36: a copy written elsewhere forks the id once it was written out, and keeps it before", () => {
  const written = opened(true);
  assert.notEqual(written.transitions.copyId(), idOf("1"));
  const fresh = opened(false);
  assert.equal(fresh.transitions.copyId(), idOf("1"));
});

test("INV-36: planning a fork changes neither the id nor the destination, so a cancelled or failed Save As leaves both", () => {
  const w = opened(true);
  const before = { id: w.live()?.docId, destination: w.destination(), baseline: w.baseline() };
  w.transitions.copyId();
  assert.deepEqual({ id: w.live()?.docId, destination: w.destination(), baseline: w.baseline() }, before);
  assert.deepEqual(w.log, []);
});

test("publish moves the open document to its new destination under the id it was published with", () => {
  const w = opened(true, NOWHERE);
  const ctx = w.capture();
  const docId = w.transitions.copyId();
  const accepted = scriptWith("Open", docId);
  const outcome = w.transitions.publish(ctx, { destination: SERVER, docId: docId, baseline: accepted, reason: "what the server accepted" });
  assert.deepEqual(outcome, { kind: "published", forkedFrom: idOf("1") });
  assert.equal(w.live()?.docId, docId);
  assert.equal(w.destination(), SERVER);
  assert.equal(w.writtenOut(), true);
  assert.deepEqual(w.log, ["destination:server", "baseline:Open:what the server accepted", "writtenOut:true"]);
});

test("publish of a document never written out keeps its id", () => {
  const w = opened(false, NOWHERE);
  const ctx = w.capture();
  const docId = w.transitions.copyId();
  assert.deepEqual(w.transitions.publish(ctx, { destination: SERVER, docId: docId, baseline: scriptWith("Open", docId), reason: "published" }), { kind: "published", forkedFrom: null });
  assert.equal(w.live()?.docId, idOf("1"));
});

test("#247: a publish that lands after the document was replaced, reopened, moved or reconnected changes nothing", () => {
  const cases: [string, (w: World) => void][] = [
    ["replaced", function (w) { w.transitions.startNew({ from: { document: scriptWith("Other", idOf("8")) }, reason: "new" }); }],
    ["reopened with the same id", function (w) { w.transitions.open({ from: { document: scriptWith("Open", idOf("1")) }, reason: "reopened" }); }],
    ["given another destination", function (w) { w.setDestination(FILE); }],
    ["on another connection instance", function (w) { w.setConnection({}); }]
  ];
  for (const [name, change] of cases) {
    const w = opened(true, NOWHERE);
    const ctx = w.capture();
    const docId = w.transitions.copyId();
    change(w);
    const doc = w.live();
    const before = { doc: JSON.stringify(doc), destination: w.destination(), baseline: w.baseline(), writtenOut: w.writtenOut() };
    w.log.length = 0;
    const outcome = w.transitions.publish(ctx, { destination: SERVER, docId: docId, baseline: scriptWith("Open", docId), reason: "late" });
    assert.deepEqual(outcome, { kind: "obsolete" }, name);
    assert.equal(w.live(), doc, name);
    assert.deepEqual({ doc: JSON.stringify(w.live()), destination: w.destination(), baseline: w.baseline(), writtenOut: w.writtenOut() }, before, name);
    assert.deepEqual(w.log, [], name);
  }
});

test("a transition with keep snapshots the live document through the history port before it is replaced, and says so", () => {
  const w = opened(true);
  const arrived = w.transitions.open({ from: { document: scriptWith("From disk", idOf("2")) }, reason: "opened", keep: "Before opening From disk", destination: FILE, writtenOut: true });
  assert.equal(arrived.kept, true);
  assert.deepEqual(w.log, ["keep:Before opening From disk:Open", "assign:From disk", "destination:file", "baseline:From disk:opened", "writtenOut:true"]);
});

test("startNew and recover take the same snapshot before the document is replaced", () => {
  const fresh = opened(true);
  assert.equal(fresh.transitions.startNew({ from: { document: scriptWith("New", idOf("2")) }, reason: "new", keep: "Before starting a new script" }).kept, true);
  assert.deepEqual(fresh.log.slice(0, 2), ["keep:Before starting a new script:Open", "assign:New"]);
  const recovered = opened(true);
  const arrived = recovered.transitions.recover({ from: { document: scriptWith("Recovered", idOf("3")) }, reason: "recovered", keep: "Before recovering", detached: true, baseline: null });
  assert.equal(arrived.kept, true);
  assert.deepEqual(recovered.log.slice(0, 2), ["keep:Before recovering:Open", "assign:Recovered"]);
});

test("no snapshot is taken without keep, with no live document, or with a live document that has no rows; restore never takes one", () => {
  const plain = opened(true);
  assert.equal(plain.transitions.open({ from: { document: scriptWith("Plain", idOf("2")) }, reason: "plain" }).kept, false);
  assert.ok(!plain.log.some((line) => line.startsWith("keep:")), "no keep, no snapshot");
  const empty = world();
  assert.equal(empty.transitions.open({ from: { document: scriptWith("First", idOf("2")) }, reason: "first", keep: "Before opening First" }).kept, false);
  assert.ok(!empty.log.some((line) => line.startsWith("keep:")), "nothing live, nothing to keep");
  const rowless = world({ doc: migrateRows({ ...rawScript("Rowless"), rows: [] }, fakeMigration().ports), writtenOut: true, destination: FILE });
  assert.equal(rowless.live()?.rows.length, 0);
  assert.equal(rowless.transitions.open({ from: { document: scriptWith("Next", idOf("2")) }, reason: "next", keep: "Before opening Next" }).kept, false);
  assert.ok(!rowless.log.some((line) => line.startsWith("keep:")), "a document with no rows is not kept");
  const restored = opened(true);
  assert.equal(restored.transitions.restore({ from: { document: scriptWith("Older", idOf("2")) } }).kept, false);
});

test("a snapshot the history port does not store reports kept false, and the transition still runs", () => {
  const w = opened(true);
  const arrived = w.transitions.open({ from: { document: scriptWith("From disk", idOf("2")) }, reason: "opened", keep: "not stored" });
  assert.equal(arrived.kept, false);
  assert.equal(w.live()?.title, "From disk");
});
