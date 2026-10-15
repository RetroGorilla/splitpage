import { owned } from "../features/routing/owned.ts";
import { runFromButton } from "../legacy/app-actions.ts";
import { mountComments } from "../features/comments/mount.ts";
import { S } from "./_state.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import { storedImageHtml } from "./04-richtext.js";
import { typePendingMarks } from "./05-render.js";
import {
  appendDraftMedia,
  draftRedo,
  draftUndo,
  isDraftBox,
  noteDraftBeforeInput,
  noteDraftComposition,
  noteDraftFocus,
  pasteIntoDraft
} from "./05d-draft-edit.js";
import { compressImageFile } from "./06-rows.js";
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
  toggleResolve
} from "./10-comments.js";
import { showToast } from "./12-dirty-toast.js";
import {
  onRootClick,
  onRootFocusOut,
  onRootInput,
  onRootKeydown,
  onRootMouseDown,
  onRootPaste,
  routeRootClick
} from "./22a-editor-wiring.js";

var comments = owned();

export function mountCommentsFeature() {
  return comments.replace(function () {
    return mountComments({
    window: window,
    ports: {
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
      sortMode: function () { return S.commentSortMode; },
      captureReplies: captureReplyDrafts,
      sort: setCommentSortMode,
      closeComposer: closeCommentComposer,
      post: postComment,
      captureComposer: captureCommentComposer,
      compressImage: compressImageFile,
      appendImage: function (box, dataUrl) {
        var rec = internDataUrl(dataUrl);
        if (!rec) throw new Error("not a picture the registry takes");
        persist([rec.sha256]);
        appendDraftMedia(box, storedImageHtml(rec));
      },
      imageError: function () { showToast("Could not use that image.", "error"); },
      reset: resetCommentBindings
    }
    });
  }, function (owner) {
    return [
      function () { return routeRootClick("comments", function (e) { return owner.click(e); }); },
      function () { return routeRootClick("comments-jump", function (e) { return owner.jumpClick(e); }); }
    ];
  });
}

export var stopCommentsFeature = comments.stop;
