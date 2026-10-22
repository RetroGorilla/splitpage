import { cappedText } from "../../core/document/text-policy.ts";
import type { DocumentComment, DocumentReply, ValidatedDocument } from "../../core/document/validated.ts";
import { changeSet } from "../session/change-set.ts";
import type { ChangeSet } from "../session/change-set.ts";
import type { Command, DocumentView, Plan } from "../session/document-session.ts";
import type { Clock, StampPorts } from "../session/ports.ts";
import { applyRewrites, realRewrites, rewriteChanges, withFields } from "./document-edit.ts";
import type { RewritePlanner } from "./document-edit.ts";

export type ConflictValue =
  | { readonly kind: "title"; readonly title: string }
  | { readonly kind: "image"; readonly imageRef: unknown }
  | { readonly kind: "text"; readonly html: string };

export const ASSIGNEE_MAX = 80;

const COMMENTS_CHANGE: ChangeSet = changeSet({ docFields: ["comments"], saveNow: true });

const POSTED_CHANGE: ChangeSet = changeSet({ docFields: ["comments"] });

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

export function addCommentCommand(comment: DocumentComment): Command {
  return {
    name: "add-comment",
    needs: "nothing",
    plan: function (doc): Plan | null {
      if (commentAt(doc, comment.id) !== -1) return null;
      return {
        changes: POSTED_CHANGE,
        apply: function (live) { live.comments.push(copied(comment)); }
      };
    }
  };
}

export function addReplyCommand(commentId: string, reply: DocumentReply, clock: Clock): Command {
  return {
    name: "add-reply",
    needs: "nothing",
    plan: function (doc): Plan | null {
      if (commentAt(doc, commentId) === -1) return null;
      return {
        changes: POSTED_CHANGE,
        apply: function (live) {
          const c = liveComment(live, commentId);
          if (!Array.isArray(c.replies)) c.replies = [];
          c.replies.push(copied(reply));
          c.updatedAt = clock.nowIso();
        }
      };
    }
  };
}

export function setCommentAssigneeCommand(commentId: string, name: string | null | undefined, clock: Clock): Command {
  const assignee = cappedText(name || "", ASSIGNEE_MAX);
  return {
    name: "set-comment-assignee",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (commentAt(doc, commentId) === -1) return null;
      return {
        changes: COMMENTS_CHANGE,
        apply: function (live) {
          const c = liveComment(live, commentId);
          c.assignee = assignee;
          c.updatedAt = clock.nowIso();
        }
      };
    }
  };
}

export function toggleResolveCommand(commentId: string, stamps: StampPorts): Command {
  return {
    name: "toggle-resolve-comment",
    needs: "edit",
    plan: function (doc): Plan | null {
      if (commentAt(doc, commentId) === -1) return null;
      return {
        changes: COMMENTS_CHANGE,
        apply: function (live) {
          const c = liveComment(live, commentId);
          c.resolved = !c.resolved;
          c.updatedAt = stamps.clock.nowIso();
          if (c.resolved) { c.resolvedBy = stamps.editor.name(); c.resolvedAt = c.updatedAt; }
          else { c.resolvedBy = null; c.resolvedAt = null; }
        }
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
    plan: function (doc): Plan | null {
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
