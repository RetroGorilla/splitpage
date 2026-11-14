import type { SharedContentRef, SharedJsonFields, SharedJsonValue, SharedOperation, SharedRecordCreate, SharedRecordSet } from "../../core/collab/operations.ts";
import { sharedCommentMarkRemovals, sharedCommentRewriteRefused } from "../../core/collab/comment-mark-operations.ts";
import type { SharedCommentCell, SharedCommentUnwrap } from "../../core/collab/comment-mark-operations.ts";
import type { Run } from "../../core/text/runs.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import type { DocumentComment, DocumentReply, ValidatedDocument } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, CommandRefusal, DocumentView, Plan } from "../session/document-session.ts";
import type { Clock, StampPorts } from "../session/ports.ts";
import { applyRewrites, realRewrites, rewriteChanges, withFields } from "./document-edit.ts";
import type { CellRewrite, RewritePlanner } from "./document-edit.ts";

export type ConflictValue =
  | { readonly kind: "title"; readonly title: string }
  | { readonly kind: "image"; readonly imageRef: unknown }
  | { readonly kind: "text"; readonly html: string };

export const ASSIGNEE_MAX = 80;

function commentsChange(): ChangeSet {
  return changeSet({ docFields: ["comments"], saveNow: true });
}

function postedChange(): ChangeSet {
  return changeSet({ docFields: ["comments"] });
}

function copied<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function commentAt(doc: DocumentView | ValidatedDocument, id: string): number {
  return doc.comments.findIndex(function (c) { return c.id === id; });
}

function liveComment(live: ValidatedDocument, id: string): DocumentComment {
  const c = live.comments[commentAt(live, id)];
  if (!c) throw new Error("comment " + id + " left the document before it was changed");
  return c;
}

export interface SharedCommentPorts {
  readonly author: () => { readonly id: string; readonly by: string } | null;
  readonly cells: (html: string | null | undefined) => readonly Run[];
}
type SharedAuthor = Pick<SharedCommentPorts, "author">;
type Bag = Record<string, unknown>;

const COMMENT_RECORD_FIELDS = Object.freeze(["rowId", "field", "anchorId", "createdAt", "updatedAt", "assignee", "kind", "imageValue", "conflictField", "emptyValue", "titleValue"]);

function rank(index: number): string { return String(index).padStart(10, "0"); }

function recordFields(source: Bag, kept: readonly string[], special: readonly string[], text: readonly [string, string][]): SharedJsonFields {
  const fields: Bag = {};
  for (const key of kept) if (source[key] !== undefined) fields[key] = source[key];
  for (const [from, to] of text) if (source[from] !== undefined) fields[to] = source[from];
  const rest = Object.keys(source).filter(key => !kept.includes(key) && !special.includes(key) && !text.some(([from]) => from === key) && source[key] !== undefined).sort();
  fields.extra = JSON.stringify(Object.fromEntries(rest.map(key => [key, source[key]])));
  return copied(fields) as SharedJsonFields;
}

function replyCreate(by: { readonly id: string; readonly by: string }, commentId: string, reply: DocumentReply, index: number): SharedRecordCreate {
  const fields = { ...recordFields(reply, ["id", "author", "createdAt"], [], [["body", "text"]]), commentId, rank: rank(index) };
  return { kind: "record-create", id: (by.id + ":reply:" + index) as SharedContentRef, by: by.by,
    target: { collection: "replies", record: JSON.stringify([commentId, reply.id]) as SharedContentRef }, fields };
}

function commentSet(by: { readonly id: string; readonly by: string }, commentId: string, field: string, value: SharedJsonValue): SharedRecordSet {
  return { kind: "record-set", id: (by.id + ":" + field) as SharedContentRef, by: by.by, target: { collection: "comments", record: commentId as SharedContentRef }, field, value };
}

export function addCommentCommand(comment: DocumentComment, shared?: SharedAuthor): Command {
  return {
    name: "add-comment",
    needs: "nothing",
    plan: function (doc, capability): Plan | CommandRefusal | null {
      const can = capability.comment();
      if (!can.allowed) return { refused: can.reason };
      if (commentAt(doc, comment.id) !== -1) return null;
      const by = shared?.author(), replies = Array.isArray(comment.replies) ? comment.replies : [];
      const resolution = Object.fromEntries(["resolved", "resolvedAt", "resolvedBy"].filter(key => comment[key] !== undefined).map(key => [key, comment[key]]));
      return {
        changes: postedChange(),
        apply: function (live) { live.comments.push(copied(comment)); },
        ...by ? { shared: { operations: [{ kind: "record-create" as const, id: (by.id + ":comment") as SharedContentRef, by: by.by,
          target: { collection: "comments", record: comment.id as SharedContentRef },
          fields: { ...recordFields(comment, ["id", "author", ...COMMENT_RECORD_FIELDS], ["resolved", "resolvedAt", "resolvedBy", "replies"],
            [["body", "text"], ["quotedText", "quote"]]), resolution: copied(resolution) as SharedJsonFields, rank: rank(doc.comments.length) } },
        ...replies.map((reply, index) => replyCreate(by, comment.id, reply, index))] } } : {}
      };
    }
  };
}

export function addReplyCommand(commentId: string, reply: DocumentReply, clock: Clock, shared?: SharedAuthor): Command {
  return {
    name: "add-reply",
    needs: "nothing",
    plan: function (doc, capability): Plan | CommandRefusal | null {
      const can = capability.comment();
      if (!can.allowed) return { refused: can.reason };
      const at = commentAt(doc, commentId);
      if (at === -1) return null;
      const by = shared?.author(), count = doc.comments[at]?.replies?.length ?? 0;
      return {
        changes: postedChange(),
        apply: function (live) {
          const c = liveComment(live, commentId);
          if (!Array.isArray(c.replies)) c.replies = [];
          c.replies.push(copied(reply));
          c.updatedAt = clock.nowIso();
        },
        ...by ? { shared: { operations: [replyCreate(by, commentId, reply, count), commentSet(by, commentId, "updatedAt", clock.nowIso())] } } : {}
      };
    }
  };
}

export function setCommentAssigneeCommand(commentId: string, name: string | null | undefined, clock: Clock, shared?: SharedAuthor): Command {
  const assignee = cappedText(name || "", ASSIGNEE_MAX);
  return {
    name: "set-comment-assignee",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (commentAt(doc, commentId) === -1) return null;
      const by = shared?.author();
      return {
        changes: commentsChange(),
        apply: function (live) {
          const c = liveComment(live, commentId);
          c.assignee = assignee;
          c.updatedAt = clock.nowIso();
        },
        ...by ? { shared: { operations: [commentSet(by, commentId, "assignee", assignee), commentSet(by, commentId, "updatedAt", clock.nowIso())] } } : {}
      };
    }
  };
}

export function toggleResolveCommand(commentId: string, stamps: StampPorts, shared?: SharedAuthor): Command {
  return {
    name: "toggle-resolve-comment",
    needs: "edit",
    plan: function (doc): Plan | null {
      const seen = doc.comments[commentAt(doc, commentId)];
      if (!seen) return null;
      const by = shared?.author(), at = by ? stamps.clock.nowIso() : "", name = by ? stamps.editor.name() : "";
      // why: assumed rule 49 on #1414: a resolve or reopen is a stamp, so the later one shows on every copy.
      const resolution = seen.resolved ? { resolved: false, resolvedAt: null, resolvedBy: null } : { resolved: true, resolvedAt: at, resolvedBy: name };
      return {
        changes: commentsChange(),
        apply: function (live) {
          const c = liveComment(live, commentId);
          c.resolved = !c.resolved;
          c.updatedAt = stamps.clock.nowIso();
          if (c.resolved) { c.resolvedBy = stamps.editor.name(); c.resolvedAt = c.updatedAt; }
          else { c.resolvedBy = null; c.resolvedAt = null; }
        },
        // why: assumed rule 35 on #1414: the list holds only stamps, which undo leaves, so it records no undo entry.
        ...by ? { shared: { operations: [commentSet(by, commentId, "resolution-stamp", { at, by: name, resolution }), commentSet(by, commentId, "updatedAt", at)],
          undo: false as const } } : {}
      };
    }
  };
}

export interface SharedAnchorUnwrap {
  readonly ports: SharedCommentPorts;
  readonly anchor: string;
}
type SharedRemoval = { readonly operations: readonly SharedOperation[]; readonly cells: readonly CellRewrite[] };
const TEXT_FIELDS = Object.freeze(["audioText", "visualText"] as const);

function textField(field: string): field is typeof TEXT_FIELDS[number] {
  return (TEXT_FIELDS as readonly string[]).includes(field);
}

function rewritesRefused(doc: DocumentView, planned: readonly CellRewrite[], anchor: string, shared: SharedCommentPorts): boolean {
  const rows = planned.map(function (rewrite) { return doc.rows.find(function (r) { return r.id === rewrite.rowId; }); });
  if (planned.some(function (rewrite, index) { return !rows[index] || !textField(rewrite.field); })) return true;
  const unwraps: SharedCommentUnwrap[] = realRewrites(doc, planned).map(function (rewrite) {
    const row = doc.rows.find(function (r) { return r.id === rewrite.rowId; });
    return { owner: rewrite.rowId, field: rewrite.field as typeof TEXT_FIELDS[number], before: shared.cells(row?.[rewrite.field] as string | undefined), after: shared.cells(rewrite.html) };
  });
  return sharedCommentRewriteRefused(anchor, unwraps);
}

function removalMarks(doc: DocumentView, anchor: string, shared: SharedCommentPorts): ReturnType<typeof sharedCommentMarkRemovals> {
  const cells: SharedCommentCell[] = doc.rows.flatMap(function (row) {
    return TEXT_FIELDS.map(function (field) { return { owner: row.id, field, runs: shared.cells(row[field] as string | undefined) }; });
  });
  return sharedCommentMarkRemovals(anchor, cells);
}

function sharedRemoval(marks: ReturnType<typeof sharedCommentMarkRemovals>, by: { readonly id: string; readonly by: string }): SharedRemoval {
  return {
    operations: marks.map(function (operation, index) { return { ...operation, id: (by.id + ":" + index) as SharedContentRef, by: by.by }; }),
    cells: marks.map(function (operation) { return { rowId: operation.target.owner, field: operation.target.field, html: "" }; })
  };
}

export function deleteCommentCommand(commentId: string, unwrap: RewritePlanner, shared?: SharedCommentPorts): Command {
  return {
    name: "delete-comment",
    needs: "edit",
    plan: function (doc): Plan | CommandRefusal | null {
      const seen = doc.comments[commentAt(doc, commentId)];
      if (!seen) return null;
      const planned = unwrap(doc), rewrites = realRewrites(doc, planned);
      const plan: Plan = {
        changes: withFields(rewriteChanges(rewrites, false, rewrites.length > 0), ["comments"], true),
        apply: function (live) {
          applyRewrites(live, rewrites, null);
          live.comments.splice(commentAt(live, commentId), 1);
        }
      };
      const by = shared ? shared.author() : null;
      if (!shared || !by) return plan;
      const anchor = seen.anchorId || commentId;
      if (rewritesRefused(doc, planned, anchor, shared)) return { refused: "comment-unwrap-rewrite" };
      const marks = sharedRemoval(removalMarks(doc, anchor, shared), by);
      const replies = Array.isArray(seen.replies) ? seen.replies : [];
      const removed: SharedOperation[] = [...replies.map(function (reply) { return JSON.stringify([commentId, reply.id]); }), null].map(function (reply, index) {
        return { kind: "record-delete" as const, id: (by.id + ":delete:" + index) as SharedContentRef, by: by.by,
          target: reply === null ? { collection: "comments" as const, record: commentId as SharedContentRef } : { collection: "replies" as const, record: reply as SharedContentRef } };
      });
      return { ...plan, changes: withFields(rewriteChanges(marks.cells, false, marks.cells.length > 0), ["comments"], true),
        shared: { operations: [...marks.operations, ...removed] } };
    }
  };
}

export function unwrapCommentAnchorCommand(unwrap: RewritePlanner, shared?: SharedAnchorUnwrap): Command {
  return {
    name: "unwrap-comment-anchor",
    needs: "nothing",
    plan: function (doc, capability): Plan | CommandRefusal | null {
      const can = capability.comment();
      if (!can.allowed) return { refused: can.reason };
      const planned = unwrap(doc), rewrites = realRewrites(doc, planned);
      const plan: Plan = {
        changes: rewriteChanges(rewrites, false, true),
        apply: function (live) { applyRewrites(live, rewrites, null); }
      };
      if (!shared) return rewrites.length ? plan : null;
      const marks = removalMarks(doc, shared.anchor, shared.ports);
      if (!rewrites.length && !marks.length) return null;
      const by = shared.ports.author();
      if (!by) return rewrites.length ? plan : null;
      if (rewritesRefused(doc, planned, shared.anchor, shared.ports)) return { refused: "comment-unwrap-rewrite" };
      const removal = sharedRemoval(marks, by);
      return { ...plan, changes: rewriteChanges(removal.cells, false, true), shared: { operations: removal.operations } };
    }
  };
}

export function restoreConflictCommand(commentId: string, value: ConflictValue, stamps: StampPorts): Command {
  return {
    name: "restore-conflict-value",
    needs: "edit",
    plan: function (doc): Plan | null {
      const at = commentAt(doc, commentId);
      const c = doc.comments[at];
      if (!c) return null;
      if (value.kind === "title") {
        return {
          changes: changeSet({ docFields: ["title", "comments"], saveNow: true }),
          apply: function (live) {
            live.title = value.title;
            live.comments.splice(commentAt(live, commentId), 1);
          }
        };
      }
      const rowId = String(c["rowId"]);
      const field = String(c["field"]);
      if (!doc.rows.some(function (r) { return r.id === rowId; })) return null;
      const fields = value.kind === "image" ? ["visualImage", "imageRef"] : [field];
      return {
        changes: changeSet({
          cells: fields.concat(["updatedAt", "updatedBy"]).map(function (f) { return { rowId: rowId, field: f }; }),
          docFields: ["comments"],
          saveNow: true
        }),
        apply: function (live) {
          const row = live.rows.find(function (r) { return r.id === rowId; });
          if (!row) throw new Error("scene " + rowId + " left the document before its value was restored");
          if (value.kind === "image") {
            Reflect.deleteProperty(row, "visualImage");
            row["imageRef"] = copied(value.imageRef);
          } else {
            row[field] = value.html;
          }
          row["updatedAt"] = stamps.clock.nowIso();
          row["updatedBy"] = stamps.editor.name();
          live.comments.splice(commentAt(live, commentId), 1);
        }
      };
    }
  };
}
