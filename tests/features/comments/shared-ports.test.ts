import "../../../src/test/_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { deriveDocumentNumbering } from "../../../src/core/document/numbering.ts";
import type { CommentStatePorts } from "../../../src/features/comments/ports.ts";
import type { Command } from "../../../src/application/session/document-session.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { armDeleteComment, closeCommentComposer, openCommentComposer, setCommentAssignee, startComments, toggleResolve } from "../../../src/features/comments/comments.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";

const AT = "2026-11-13T10:00:00.000Z";
const SOURCE: Record<string, unknown> = {
  rows: [{ id: "R1", audioText: 'a<span class="cmt-anchor" data-cmt="C1">bc</span>d', visualText: "" }],
  comments: [{ id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", quotedText: "bc", author: "Ann", body: "note", resolved: false, resolvedBy: null,
    resolvedAt: null, assignee: "", createdAt: AT, updatedAt: AT, kind: "anchor", replies: [] }]
};
const DOC: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...SOURCE };

function fixture() {
  document.body.innerHTML = '<div id="comment-modal" hidden><div id="comment-modal-quote"></div><input id="comment-name"><div id="comment-body-editable"></div></div>'
    + '<div id="comments-panel" hidden></div>';
  const commands: Command[] = [];
  const clock = { nowIso: () => AT };
  const ports: CommentStatePorts = {
    sort: { current: () => "position", choose: () => "position" },
    document: { numbering: () => deriveDocumentNumbering({ rows: [] }), current: () => DOC, read: (select) => select(DOC) },
    edits: { edit: (command) => { commands.push(command); return true; },
      stamps: { clock, editor: { name: () => "Ada" } } },
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
  openCommentComposer({ id: "C1", rowId: "R1", field: "audioText", quotedText: "bc" });
  closeCommentComposer(true);
}

test("D26: standalone comment controls plan resolve, assignment, removal and unwrap", () => {
  const fake = fixture();
  const owner = startComments(fake.ports);
  try {
    drive();
    assert.deepEqual(planned(fake.commands), [undefined, undefined, undefined, undefined]);
  } finally { owner.dispose(); }
});
