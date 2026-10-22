import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DOCUMENT } from "../../src/application/session/document-session.ts";
import { changeSet } from "../../src/application/session/change-set.ts";
import type { Command, DocumentView } from "../../src/application/session/document-session.ts";
import type { IdSource } from "../../src/core/document/ports.ts";
import type { StampPorts } from "../../src/application/session/ports.ts";
import { targetLengthCommand, wordsPerMinuteCommand } from "../../src/application/commands/document-settings.ts";
import { documentIdStamp, editStamp } from "../../src/application/commands/save-stamps.ts";
import { rewriteCellsCommand, rewrittenCopies } from "../../src/application/commands/document-edit.ts";
import type { CellRewrite } from "../../src/application/commands/document-edit.ts";
import {
  addPersonCommand,
  deletePersonCommand,
  deleteTagsCommand,
  gearQuickAddCommand,
  registerTagCommand,
  retagCommand,
  tagCellsCommand,
  updateTagsCommand
} from "../../src/application/commands/production-records.ts";
import {
  addShotCommand,
  addShotPropCommand,
  deleteShotCommand,
  removeShotPropCommand,
  setShotsCommand
} from "../../src/application/commands/broll-records.ts";
import {
  addCommentCommand,
  addReplyCommand,
  deleteCommentCommand,
  restoreConflictCommand,
  setCommentAssigneeCommand,
  toggleResolveCommand,
  unwrapCommentAnchorCommand
} from "../../src/application/commands/comments.ts";
import { harness, rawScript, runConfined } from "./session-fakes.ts";

const STAMP = "2026-10-22T12:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";
const SAVED = ["undo.record", "dirty:1", "draft:1", "save:1", "publish:edit"];

type Opened = ReturnType<typeof harness>;

function stamps(): StampPorts {
  return {
    clock: { nowIso: function () { return STAMP; } },
    editor: { name: function () { return "Adam"; } }
  };
}

function ids(): IdSource {
  let n = 0;
  return { id: function (prefix) { return prefix + "-new" + (++n); }, docId: function () { return "d" + "1".repeat(32); } };
}

function scripted(): Record<string, unknown> {
  const raw = rawScript("Harbour");
  (raw.rows as Record<string, unknown>[]).forEach(function (row) { row.updatedAt = OLD; row.updatedBy = "Sam"; });
  raw.wordsPerMinute = 150;
  raw.productionTags = [
    { id: "t1", cat: "prop", name: "Net", status: "needed", owner: "", notes: "" },
    { id: "t2", cat: "gear", name: "Drone", status: "needed", owner: "", notes: "" }
  ];
  raw.people = [{ id: "p1", name: "Mara" }];
  raw.brollShots = [{ id: "b1", name: "Pier", status: "todo", owner: "p1", props: [{ id: "t1", name: "Net" }] }];
  return raw;
}

function opened(): Opened {
  const h = harness();
  h.session.adopt(scripted());
  h.log.length = 0;
  h.published.length = 0;
  return h;
}

function snapshot(h: Opened): string {
  return h.session.read(function (doc) { return JSON.stringify(doc); });
}

function read<T>(h: Opened, pick: (doc: DocumentView) => T): T {
  const text = JSON.stringify(h.session.read(function (doc) { return doc ? pick(doc) : null; }));
  return (text === undefined ? undefined : JSON.parse(text)) as T;
}

function applied(h: Opened, command: Command, log: readonly string[] = SAVED): void {
  const out = runConfined(h.session, command);
  assert.equal(out.kind, "applied", command.name + " applied");
  assert.equal(h.session.generation(), 1, command.name + " is one generation");
  assert.deepEqual(h.log, log, command.name + " records undo once and runs one effect pass");
}

function noop(h: Opened, command: Command): void {
  const before = snapshot(h);
  assert.deepEqual(runConfined(h.session, command), { kind: "noop" }, command.name + " is a no-op");
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(h.log, [], command.name + " records no undo and runs no effects");
  assert.equal(snapshot(h), before);
}

function refused(command: Command): void {
  const h = opened();
  const before = snapshot(h);
  h.deny("review");
  assert.deepEqual(runConfined(h.session, command), { kind: "rejected", reason: "review" }, command.name + " is refused in review");
  assert.deepEqual(h.log, []);
  assert.equal(snapshot(h), before);
  assert.deepEqual(runConfined(harness().session, command), { kind: "rejected", reason: NO_DOCUMENT }, command.name + " is refused with no document");
}

function personId(h: Opened, name: string): unknown {
  return read(h, function (doc) { const people = doc["people"]; const list: { id?: unknown; name?: unknown }[] = Array.isArray(people) ? people : []; return list.find(function (p) { return p.name === name; })?.id; });
}

function netId(h: Opened): string {
  return String(read(h, function (doc) { return doc.productionTags.find(function (t) { return !!t && t.cat === "prop"; })?.id; }));
}

function rowField(h: Opened, rowId: string, field: string): unknown {
  return read(h, function (doc) { const row = doc.rows.find(function (r) { return r.id === rowId; }); return row ? row[field] : undefined; });
}

function tagOf(h: Opened, cat: string, name: string): Record<string, unknown> | undefined {
  return read(h, function (doc) { return doc.productionTags.find(function (t) { return !!t && t.cat === cat && t.name === name; }); }) ?? undefined;
}

const rewriteAudio = function (html: string): (doc: DocumentView) => readonly CellRewrite[] {
  return function () { return [{ rowId: "r1", field: "audioText", html: html }]; };
};

test("target length and pace are one undoable, saved edit each; the same value again is a no-op; review refuses both", () => {
  let h = opened();
  applied(h, targetLengthCommand(120));
  assert.equal(read(h, function (doc) { return doc["targetSeconds"]; }), 120);
  h = opened();
  noop(h, targetLengthCommand(null));
  h = opened();
  applied(h, wordsPerMinuteCommand(171.6));
  assert.equal(read(h, function (doc) { return doc["wordsPerMinute"]; }), 172);
  h = opened();
  noop(h, wordsPerMinuteCommand(150));
  noop(h, wordsPerMinuteCommand(20));
  noop(h, wordsPerMinuteCommand(Number.NaN));
  refused(targetLengthCommand(90));
  refused(wordsPerMinuteCommand(180));
});

test("rewriting cells stamps only the cells that change, and an unchanged rewrite is a no-op", () => {
  const h = opened();
  applied(h, rewriteCellsCommand("replace", rewriteAudio("Every evening."), stamps(), { needs: "edit", stamped: true }));
  assert.equal(rowField(h, "r1", "audioText"), "Every evening.");
  assert.equal(rowField(h, "r1", "updatedAt"), STAMP);
  assert.equal(rowField(h, "r2", "updatedAt"), OLD);
  noop(opened(), rewriteCellsCommand("replace", rewriteAudio("Every morning."), stamps(), { needs: "edit", stamped: true }));
  refused(rewriteCellsCommand("replace", rewriteAudio("Every evening."), stamps(), { needs: "edit", stamped: true }));
});

test("rewritten copies report only the cells the rewrite changed", () => {
  const h = opened();
  const planner = rewrittenCopies(["audioText", "visualText"], function (rows) { const first = rows[0]; if (first) first["visualText"] = "Wider"; });
  const found = h.session.read(function (doc) { return doc ? planner(doc) : []; });
  assert.deepEqual(found, [{ rowId: "r1", field: "visualText", html: "Wider" }]);
});

test("registering a tag and adding a person are one edit each; known ones are no-ops", () => {
  let h = opened();
  applied(h, registerTagCommand({ cat: "prop", name: "Rope" }));
  assert.equal(tagOf(h, "prop", "Rope")?.cat, "prop");
  noop(opened(), registerTagCommand({ cat: "prop", name: "net" }));
  h = opened();
  applied(h, addPersonCommand("Sam", ids()));
  assert.deepEqual(read(h, function (doc) { return doc["people"]; }), [{ id: "p1", name: "Mara" }, { id: personId(h, "Sam"), name: "Sam" }]);
  assert.match(String(personId(h, "Sam")), /^p-new/);
  noop(opened(), addPersonCommand(" mara ", ids()));
  refused(registerTagCommand({ cat: "prop", name: "Rope" }));
  refused(addPersonCommand("Sam", ids()));
});

test("tagging cells relabels and registers in one step; registering alone still counts", () => {
  let h = opened();
  applied(h, tagCellsCommand("apply-tag", rewriteAudio("Every <b>morning</b>."), { cat: "location", name: "Pier" }, stamps()));
  assert.equal(rowField(h, "r1", "audioText"), "Every <b>morning</b>.");
  assert.equal(rowField(h, "r1", "updatedBy"), "Adam");
  assert.equal(tagOf(h, "location", "Pier")?.name, "Pier");
  h = opened();
  noop(h, tagCellsCommand("apply-tag", rewriteAudio("Every morning."), { cat: "location", name: "Pier" }, stamps()));
  h = opened();
  applied(h, tagCellsCommand("apply-tag", rewriteAudio("Every morning."), { cat: "location", name: "Pier" }, stamps(), true));
  assert.equal(rowField(h, "r1", "updatedAt"), OLD, "no cell changed, so none is stamped");
  noop(opened(), tagCellsCommand("apply-tag", rewriteAudio("Every morning."), { cat: "prop", name: "Net" }, stamps(), true));
  refused(tagCellsCommand("apply-tag", rewriteAudio("x"), null, stamps()));
});

test("renaming a tag renames its entry and the shot props that point at it; renaming onto another merges", () => {
  let h = opened();
  applied(h, retagCommand({ cat: "prop", name: "Net" }, "Trawl", function () { return []; }, stamps()));
  assert.equal(tagOf(h, "prop", "Trawl")?.id, netId(h));
  assert.deepEqual(read(h, function (doc) { return doc.brollShots[0]?.props; }), [{ id: netId(h), name: "Trawl" }]);
  h = opened();
  runConfined(h.session, registerTagCommand({ cat: "prop", name: "Rope" }));
  h.log.length = 0;
  const out = runConfined(h.session, retagCommand({ cat: "prop", name: "Net" }, "Rope", function () { return []; }, stamps()));
  assert.equal(out.kind, "applied", "a rename onto an existing tag reports the merge");
  assert.equal(tagOf(h, "prop", "Net"), undefined);
  noop(opened(), retagCommand({ cat: "prop", name: "Net" }, "Net", function () { return []; }, stamps()));
  noop(opened(), retagCommand({ cat: "prop", name: "Net" }, null, function () { return []; }, stamps()));
  refused(retagCommand({ cat: "prop", name: "Net" }, "Trawl", function () { return []; }, stamps()));
});

test("deleting tags removes their entries; deleting tags that are gone is a no-op", () => {
  const h = opened();
  applied(h, deleteTagsCommand([{ cat: "gear", name: "Drone", unlabel: true }], function () { return []; }, stamps()));
  assert.equal(tagOf(h, "gear", "Drone"), undefined);
  noop(opened(), deleteTagsCommand([{ cat: "gear", name: "Crane", unlabel: true }], function () { return []; }, stamps()));
  refused(deleteTagsCommand([{ cat: "gear", name: "Drone", unlabel: true }], function () { return []; }, stamps()));
});

test("quick-add gear applies its plan in one edit and an empty plan is a no-op", () => {
  const h = opened();
  const rec = { id: "t9", cat: "gear", name: "Gimbal", status: "needed" as const, owner: "", notes: "" };
  applied(h, gearQuickAddCommand(function () { return { added: 1, removed: 1, remove: ["Drone"], register: [rec] }; }));
  assert.equal(tagOf(h, "gear", "Drone"), undefined);
  assert.equal(tagOf(h, "gear", "Gimbal")?.id, "t9");
  noop(opened(), gearQuickAddCommand(function () { return { added: 0, removed: 0, remove: [], register: [] }; }));
  refused(gearQuickAddCommand(function () { return { added: 1, removed: 0, remove: [], register: [rec] }; }));
});

test("updating tags sets status, owner and notes, registering missing entries and new owners in the same step", () => {
  let h = opened();
  applied(h, updateTagsCommand([{ cat: "prop", name: "Net" }, { cat: "prop", name: "Rope" }], { status: "ready", owner: { name: "Sam" }, notes: "Dry" }, ids()));
  assert.equal(tagOf(h, "prop", "Net")?.status, "ready");
  assert.equal(tagOf(h, "prop", "Rope")?.owner, personId(h, "Sam"));
  assert.equal(tagOf(h, "prop", "Rope")?.notes, "Dry");
  h = opened();
  applied(h, updateTagsCommand([{ cat: "prop", name: "Net" }], { status: { next: true } }, ids()));
  assert.notEqual(tagOf(h, "prop", "Net")?.status, "needed");
  noop(opened(), updateTagsCommand([{ cat: "prop", name: "Net" }], { status: "needed", owner: { id: "" } }, ids()));
  noop(opened(), updateTagsCommand([{ cat: "prop", name: "Net" }], { owner: { name: "   " } }, ids()));
  refused(updateTagsCommand([{ cat: "prop", name: "Net" }], { notes: "Dry" }, ids()));
});

test("deleting a person clears them as owner of tags and shots", () => {
  const h = opened();
  applied(h, updateTagsCommand([{ cat: "prop", name: "Net" }], { owner: { id: "p1" } }, ids()));
  h.log.length = 0;
  const out = runConfined(h.session, deletePersonCommand("p1"));
  assert.equal(out.kind, "applied");
  assert.deepEqual(read(h, function (doc) { return doc["people"]; }), []);
  assert.equal(tagOf(h, "prop", "Net")?.owner, "");
  assert.equal(read(h, function (doc) { return doc.brollShots[0]?.owner; }), "");
  noop(opened(), deletePersonCommand("p9"));
  refused(deletePersonCommand("p1"));
});

test("b-roll shots are added, changed and deleted as one edit each; repeats are no-ops", () => {
  let h = opened();
  applied(h, addShotCommand({ id: "b2", name: "Gulls" }));
  assert.equal(read(h, function (doc) { return doc.brollShots.length; }), 2);
  noop(opened(), addShotCommand({ id: "b1", name: "Again" }));
  h = opened();
  applied(h, setShotsCommand(["b1"], { status: "shot" }));
  assert.equal(read(h, function (doc) { return doc.brollShots[0]?.status; }), "shot");
  noop(opened(), setShotsCommand(["b1"], { status: "unshot" }));
  noop(opened(), setShotsCommand(["b9"], { status: "shot" }));
  h = opened();
  applied(h, setShotsCommand(["b1"], {}, { name: "Sam" }, ids()));
  assert.equal(read(h, function (doc) { return doc.brollShots[0]?.owner; }), personId(h, "Sam"));
  noop(opened(), setShotsCommand(["b1"], {}, { id: "p1" }));
  h = opened();
  applied(h, deleteShotCommand("b1"));
  assert.equal(read(h, function (doc) { return doc.brollShots.length; }), 0);
  noop(opened(), deleteShotCommand("b9"));
  refused(addShotCommand({ id: "b2" }));
  refused(setShotsCommand(["b1"], { status: "shot" }));
  refused(deleteShotCommand("b1"));
});

test("shot props register a missing prop tag with the prop and remove by reference", () => {
  let h = opened();
  applied(h, addShotPropCommand("b1", "Rope"));
  assert.equal(tagOf(h, "prop", "Rope")?.cat, "prop");
  assert.equal(read(h, function (doc) { return doc.brollShots[0]?.props?.length; }), 2);
  noop(opened(), addShotPropCommand("b1", "net"));
  noop(opened(), addShotPropCommand("b9", "Rope"));
  h = opened();
  applied(h, removeShotPropCommand("b1", netId(h)));
  assert.deepEqual(read(h, function (doc) { return doc.brollShots[0]?.props; }), []);
  noop(opened(), removeShotPropCommand("b1", "zz"));
  refused(addShotPropCommand("b1", "Rope"));
  refused(removeShotPropCommand("b1", netId(opened())));
});

test("posting comments and replies is allowed while reviewing and leaves the save to the poster", () => {
  const h = opened();
  h.deny("review");
  const out = runConfined(h.session, addCommentCommand({ id: "c2", rowId: "r2", field: "audioText", body: "Why?", replies: [] }));
  assert.equal(out.kind, "applied");
  assert.equal(h.published[0]?.changes.saveNow, false);
  h.log.length = 0;
  const gen = h.session.generation();
  assert.deepEqual(runConfined(h.session, addCommentCommand({ id: "c2", body: "again" })), { kind: "noop" });
  assert.equal(h.session.generation(), gen);
});

test("a reply is added to its comment and stamps it; a reply to a missing comment is a no-op", () => {
  const h = opened();
  h.deny("review");
  const out = runConfined(h.session, addReplyCommand("c1", { id: "x1", body: "Done" }, stamps().clock));
  assert.equal(out.kind, "applied");
  assert.deepEqual(read(h, function (doc) { return doc.comments[0]?.replies; }), [{ id: "x1", body: "Done" }]);
  assert.equal(read(h, function (doc) { return doc.comments[0]?.updatedAt; }), STAMP);
  noop(opened(), addReplyCommand("c9", { id: "x1" }, stamps().clock));
});

test("assigning and resolving comments are saved edits; review refuses them", () => {
  let h = opened();
  applied(h, setCommentAssigneeCommand("c1", "Sam", stamps().clock));
  assert.equal(read(h, function (doc) { return doc.comments[0]?.["assignee"]; }), "Sam");
  noop(opened(), setCommentAssigneeCommand("c9", "Sam", stamps().clock));
  h = opened();
  applied(h, toggleResolveCommand("c1", stamps()));
  assert.equal(read(h, function (doc) { return doc.comments[0]?.["resolvedBy"]; }), "Adam");
  assert.equal(read(h, function (doc) { return doc.comments[0]?.resolvedAt; }), STAMP);
  noop(opened(), toggleResolveCommand("c9", stamps()));
  refused(setCommentAssigneeCommand("c1", "Sam", stamps().clock));
  refused(toggleResolveCommand("c1", stamps()));
});

test("deleting a comment unwraps its anchor in the same step", () => {
  const h = opened();
  applied(h, deleteCommentCommand("c1", rewriteAudio("Every morning!")), ["reconcile"].concat(SAVED));
  assert.equal(read(h, function (doc) { return doc.comments.length; }), 0);
  assert.equal(rowField(h, "r1", "audioText"), "Every morning!");
  assert.equal(rowField(h, "r1", "updatedAt"), OLD, "unwrapping an anchor stamps no scene");
  noop(opened(), deleteCommentCommand("c9", rewriteAudio("x")));
  refused(deleteCommentCommand("c1", rewriteAudio("x")));
});

test("cancelling a draft comment unwraps its anchor even while reviewing; nothing to unwrap is a no-op", () => {
  const h = opened();
  h.deny("review");
  assert.equal(runConfined(h.session, unwrapCommentAnchorCommand(rewriteAudio("Every morning!"))).kind, "applied");
  assert.equal(rowField(h, "r1", "audioText"), "Every morning!");
  noop(opened(), unwrapCommentAnchorCommand(rewriteAudio("Every morning.")));
});

test("restoring a conflict value writes it back, stamps the scene and drops the conflict comment", () => {
  let h = opened();
  applied(h, restoreConflictCommand("c1", { kind: "text", html: "Every dawn." }, stamps()));
  assert.equal(rowField(h, "r1", "audioText"), "Every dawn.");
  assert.equal(rowField(h, "r1", "updatedBy"), "Adam");
  assert.equal(read(h, function (doc) { return doc.comments.length; }), 0);
  h = opened();
  applied(h, restoreConflictCommand("c1", { kind: "title", title: "Old title" }, stamps()));
  assert.equal(read(h, function (doc) { return doc.title; }), "Old title");
  noop(opened(), restoreConflictCommand("c9", { kind: "text", html: "x" }, stamps()));
  refused(restoreConflictCommand("c1", { kind: "text", html: "x" }, stamps()));
});

test("a save stamp writes through the session with no generation, no undo record, no effect pass and no publication, and is not refused while reviewing", () => {
  const h = opened();
  h.deny("review");
  const out = h.session.stamp(editStamp({ rev: 4, lastEditedBy: "Adam", lastEditedAt: STAMP }));
  assert.equal(out.kind, "applied");
  assert.equal(h.session.generation(), 0, "a save is not an edit, so the generation saves compare against stays put");
  assert.deepEqual(h.log, []);
  assert.deepEqual(h.published, []);
  assert.equal(read(h, function (doc) { return doc.rev; }), 4);
  assert.equal(read(h, function (doc) { return doc["lastEditedBy"]; }), "Adam");
  assert.equal(h.clock.armed(), 0, "no refresh is scheduled");
});

test("a document id stamp moves only from the expected id and never to the same id", () => {
  const h = opened();
  const was = read(h, function (doc) { return doc.docId; });
  assert.deepEqual(h.session.stamp(documentIdStamp("d" + "9".repeat(32), "d" + "2".repeat(32))), { kind: "noop" });
  assert.deepEqual(h.session.stamp(documentIdStamp(null, was)), { kind: "noop" });
  assert.deepEqual(h.log, []);
  assert.equal(h.session.stamp(documentIdStamp(was, "d" + "2".repeat(32))).kind, "applied");
  assert.equal(read(h, function (doc) { return doc.docId; }), "d" + "2".repeat(32));
  assert.deepEqual(h.log, []);
  assert.equal(h.session.generation(), 0);
  assert.deepEqual(harness().session.stamp(documentIdStamp(null, "d" + "2".repeat(32))), { kind: "rejected", reason: NO_DOCUMENT });
});

test("a stamp whose plan throws leaves the document as it was", () => {
  const h = opened();
  const before = snapshot(h);
  const out = h.session.stamp({
    name: "broken",
    plan: function () {
      return { changes: changeSet({ docFields: ["lastEditedBy"] }), apply: function (live) { live["lastEditedBy"] = "x"; throw new Error("boom"); } };
    }
  });
  assert.equal(out.kind, "failed");
  assert.equal(snapshot(h), before);
  assert.equal(h.session.generation(), 0);
});
