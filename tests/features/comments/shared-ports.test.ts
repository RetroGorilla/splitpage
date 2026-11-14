import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import type { CommentStatePorts } from "../../../src/features/comments/ports.ts";
import type { SharedCommentPorts } from "../../../src/application/commands/comments.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { armDeleteComment, setCommentAssignee, startComments, toggleResolve } from "../../../src/features/comments/comments.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const AT = "2026-11-13T10:00:00.000Z";
const SOURCE: Record<string, unknown> = {
  rows: [{ id: "R1", audioText: 'a<span class="cmt-anchor" data-cmt="C1">bc</span>d', visualText: "" }],
  comments: [{ id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", quotedText: "bc", author: "Ann", body: "note", resolved: false, resolvedBy: null,
    resolvedAt: null, assignee: "", createdAt: AT, updatedAt: AT, kind: "anchor", replies: [] }]
};
const DOC: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...SOURCE };

function fixture(shared: SharedCommentPorts | null) {
  document.body.innerHTML = '<div id="comment-modal" hidden><div id="comment-body-editable"></div></div><div id="comments-panel" hidden></div>';
  const commands: Command[] = [];
  const clock = { nowIso: () => AT };
  const ports: CommentStatePorts = {
    sort: { current: () => "position", choose: () => "position" },
    document: { numbering: () => deriveDocumentNumbering({ rows: [] }), current: () => DOC, read: (select) => select(DOC) },
    edits: { edit: (command) => { commands.push(command); return true; }, stamps: { clock, editor: { name: () => "Ada" } } },
    notices: { show: () => ({ isConnected: false, dismiss: () => {}, removeEventListener: () => {} }) },
    preferences: {
      clock: () => "24", commentAuthor: () => "Ada", rememberCommentAuthor: () => {}, commentsSort: () => "position", setCommentsSort: () => {},
      commentFilter: () => ({ mode: "open", assignee: "" }), setCommentFilter: () => {}, taggingHelpShown: () => {}, taggingHelpDismissed: () => {}
    },
    changes: { onChange: () => () => {} },
    sidePanels: { open: () => {}, close: () => {} },
    text: { inertBody: (html) => { const body = document.createElement("div"); body.innerHTML = String(html); return body; }, sanitizeHtml: (html) => String(html) },
    ids: { id: (prefix) => prefix + "_new" },
    clock,
    saves: { dueNow: () => {} },
    selection: { dropLink: () => {} },
    deletion: { armedId: () => "C1", arm: () => {}, disarm: () => {} },
    ownership: { capture: () => ({ epoch: 1, docId: "d1", destination: null, destinationGeneration: 1, generation: 1 }), stillOwns: () => true },
    history: { keep: () => {} },
    personColors: { personColor: () => "#000000" },
    shots: { reveal: () => {} },
    pictures: { imgHtml: () => "" },
    clearDraftUndo: () => {},
    shared: () => shared
  };
  return { ports, commands };
}

function planned(commands: readonly Command[]) {
  const capabilities = createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
  return commands.map(command => {
    const plan = command.plan(structuredClone(DOC), capabilities);
    assert.ok(plan && !("refused" in plan));
    return plan.shared;
  });
}

function drive() {
  toggleResolve("C1");
  setCommentAssignee("C1", "Bob");
  armDeleteComment(document.createElement("button"), "C1");
}

test("D26: the comment feature passes its shared ports to resolve, assign and delete", () => {
  let count = 0;
  const fake = fixture({ author: () => ({ id: "w1_" + ++count, by: "Ada" }), cells: createFlowLoadRuntime().cells });
  const owner = startComments(fake.ports);
  try {
    drive();
    const comment = { collection: "comments", record: "C1" };
    const set = (id: string, field: string, value: unknown) => ({ kind: "record-set", id, by: "Ada", target: comment, field, value });
    assert.deepEqual(planned(fake.commands), [
      { operations: [set("w1_1:resolution-stamp", "resolution-stamp", { at: AT, by: "Ada", resolution: { resolved: true, resolvedAt: AT, resolvedBy: "Ada" } }),
        set("w1_1:updatedAt", "updatedAt", AT)], undo: false },
      { operations: [set("w1_2:assignee", "assignee", "Bob"), set("w1_2:updatedAt", "updatedAt", AT)] },
      { operations: [{ kind: "mark", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: ['["flow-base","R1","audioText",1,3]'],
        mark: { kind: "comment", id: "C1", value: null }, id: "w1_3:0", by: "Ada" }, { kind: "record-delete", id: "w1_3:delete:0", by: "Ada", target: comment }] }
    ]);
  } finally { owner.dispose(); }
});

test("D26: with no shared ports the comment feature plans standalone commands", () => {
  const fake = fixture(null);
  const owner = startComments(fake.ports);
  try {
    drive();
    assert.deepEqual(planned(fake.commands), [undefined, undefined, undefined]);
  } finally { owner.dispose(); }
});
