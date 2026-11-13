import type { SharedContentRef, SharedJsonFields, SharedJsonValue, SharedRecordCreate, SharedRecordSet } from "../../core/collab/operations.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import type { DocumentComment, DocumentReply, ValidatedDocument } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, CommandRefusal, DocumentView, Plan } from "../session/document-session.ts";
import type { Clock, StampPorts } from "../session/ports.ts";
import { applyRewrites, realRewrites, rewriteChanges, withFields } from "./document-edit.ts";
import type { RewritePlanner } from "./document-edit.ts";

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

type SharedAuthor = { readonly author: () => { readonly id: string; readonly by: string } };
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
        ...by ? { shared: { operations: [commentSet(by, commentId, "resolution-stamp", { at, by: name, resolution }), commentSet(by, commentId, "updatedAt", at)] } } : {}
      };
    }
  };
}

export function deleteCommentCommand(commentId: string, unwrap: RewritePlanner): Command {
  return {
    name: "delete-comment",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (commentAt(doc, commentId) === -1) return null;
      const rewrites = realRewrites(doc, unwrap(doc));
      return {
        changes: withFields(rewriteChanges(rewrites, false, rewrites.length > 0), ["comments"], true),
        apply: function (live) {
          applyRewrites(live, rewrites, null);
          live.comments.splice(commentAt(live, commentId), 1);
        }
      };
    }
  };
}

export function unwrapCommentAnchorCommand(unwrap: RewritePlanner): Command {
  return {
    name: "unwrap-comment-anchor",
    needs: "nothing",
    plan: function (doc, capability): Plan | CommandRefusal | null {
      const can = capability.comment();
      if (!can.allowed) return { refused: can.reason };
      const rewrites = realRewrites(doc, unwrap(doc));
      if (!rewrites.length) return null;
      return {
        changes: rewriteChanges(rewrites, false, true),
        apply: function (live) { applyRewrites(live, rewrites, null); }
      };
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
