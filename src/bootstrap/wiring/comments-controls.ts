import { sharedPorts } from "./shared-ports.ts";
import { editableCellHtml } from "../../js/05-render.js";
import type { CommentsPorts } from "../../features/comments/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { runFromButton } from "../../legacy/app-actions.ts";
import { mountComments } from "../../features/comments/mount.ts";
import { internDataUrl, persist } from "../../adapters/storage/02c-blobs.js";
import { storedImageHtml } from "../../js/04-richtext.js";
import { typePendingMarks } from "../../js/05-render.js";
import {
  appendDraftMedia,
  draftRedo,
  draftUndo,
  noteDraftBeforeInput,
  noteDraftComposition,
  noteDraftFocus,
  pasteIntoDraft
} from "../../js/05d-draft-edit.js";
import { isDraftBox } from "../../features/editing/cell-page.ts";
import { compressImageFile } from "../../js/06-rows.js";
import {
  AUTHOR_NAME_FIELDS,
  armDeleteComment,
  captureReplyDrafts,
  captureCommentComposer,
  closeCommentComposer,
  closeCommentsPanel,
  jumpToAnchor,
  limitAuthorNameField,
  postComment,
  postReply,
  restoreConflictValue,
  resetCommentBindings,
  setCommentAssignee,
  setCommentAssigneeFilter,
  setCommentFilterMode,
  setCommentSortMode,
  toggleCommentMenu,
  toggleReplyComposer,
  toggleResolve,
  mountCommentsState as initializeComments
} from "./comments.ts";
import { showToast } from "../../legacy/effects-bridge.ts";
import {
  onRootClick,
  onRootFocusOut,
  onRootInput,
  onRootKeydown,
  onRootMouseDown,
  onRootPaste,
  routeRootClick
} from "./editor.ts";
import { commentSortMode } from "../../application/comment-sort.ts";

const comments = owned<ReturnType<typeof mountComments>>();

export function mountCommentsFeature(): ReturnType<typeof mountComments> {
  return comments.replace(function () {
    const ports: CommentsPorts = {
      rootClick: onRootClick,
      rootMouseDown: onRootMouseDown,
      rootInput: onRootInput,
      rootFocusOut: onRootFocusOut,
      rootPaste: onRootPaste,
      rootKeydown: onRootKeydown,
      authorFields: AUTHOR_NAME_FIELDS,
      limitAuthor: limitAuthorNameField,
      isDraft: isDraftBox,
      draftUndo: draftUndo,
      draftRedo: draftRedo,
      typeMarks: typePendingMarks,
      beforeInput: noteDraftBeforeInput,
      focusDraft: noteDraftFocus,
      composeDraft: noteDraftComposition,
      pasteDraft: pasteIntoDraft,
      toggleResolve: toggleResolve,
      filter: setCommentFilterMode,
      toggleReply: toggleReplyComposer,
      postReply: postReply,
      deleteComment: armDeleteComment,
      restoreConflict: restoreConflictValue,
      menu: toggleCommentMenu,
      jump: jumpToAnchor,
      openPanel: function () { runFromButton("panel-comments"); },
      closePanel: closeCommentsPanel,
      assigneeFilter: setCommentAssigneeFilter,
      assignee: setCommentAssignee,
      sortMode: function () { return commentSortMode(); },
      captureReplies: captureReplyDrafts,
      sort: setCommentSortMode,
      closeComposer: closeCommentComposer,
      post: postComment,
      captureComposer: captureCommentComposer,
      compressImage: compressImageFile,
      appendImage: function (box, dataUrl) {
        const rec = internDataUrl(dataUrl);
        if (!rec) throw new Error("not a picture the registry takes");
        persist([rec.sha256]);
        appendDraftMedia(box, storedImageHtml(rec));
      },
      imageError: function () { showToast("Could not use that image.", "error"); },
      reset: resetCommentBindings
    };
    return mountComments({ window: window, ports: ports });
  }, function (owner) {
    return [
      function () { return routeRootClick("comments", function (e) { return owner.click(e); }); },
      function () { return routeRootClick("comments-jump", function (e) { return owner.jumpClick(e); }); }
    ];
  });
}

export const stopCommentsFeature = comments.stop;

export function mountCommentsState(): void {
  initializeComments({ selection: sharedPorts().selection, editableCellHtml });
}
