import { commentsPanelActions as panelDefinitions, commentsHelpActions as helpDefinitions, commentsOpenActions as openDefinitions } from "../../features/comments/actions.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { edits as portEdits, selection as portSelection } from "./ports/editing.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { preferenceValues as portPreferences } from "./ports/preferences.ts";
import { review as portReview } from "./ports/location.ts";
import { panelControl as portSidePanels } from "./ports/panels.ts";
import { text as portText } from "./ports/text.ts";
import { ids as portIds, clock as portClock } from "./ports/identity.ts";
import { saves as portSaves, ownership as portOwnership } from "./ports/saving.ts";
import { deletion as portDeletion } from "./ports/production.ts";
import { pictures as portPictures } from "./ports/pictures.ts";
import { screen as portScreen } from "./ports/screen.ts";
import { startComments as mountCommentState } from "../../features/comments/comments.js";
import type { CommentStatePorts } from "../../features/comments/ports.ts";

import { keepSnapshot } from "../../legacy/transition-bridge.ts";
import { presence } from "../../legacy/presence-bridge.ts";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";
import { onCommentsSent } from "../../js/13-hosted.js";
import { resetDraftHistory } from "../../features/editing/draft-edit.js";
import type { CommentsPorts } from "../../features/comments/mount.ts";
import { owned } from "../../features/routing/owned.ts";
import { runFromButton } from "../../legacy/app-actions.ts";
import { mountComments } from "../../features/comments/mount.ts";
import { internDataUrl, persist } from "../../adapters/storage/02c-blobs.js";
import { storedImageHtml } from "../../core/document/text-policy.ts";
import { typePendingMarks } from "../../js/05-render.js";
import {
  appendDraftMedia,
  draftRedo,
  draftUndo,
  noteDraftBeforeInput,
  noteDraftComposition,
  noteDraftFocus,
  pasteIntoDraft
} from "../../features/editing/draft-edit.js";
import { isDraftBox } from "../../features/editing/cell-page.ts";
import { compressImageFile } from "../../features/rows/scene-media.js";
import {
  AUTHOR_NAME_FIELDS,
  armDeleteComment,
  captureReplyDrafts,
  captureCommentComposer,
  closeCommentComposer,
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
} from "../../features/comments/comments.js";
import { showToast } from "../../legacy/effects-bridge.ts";
import { sidePanels } from "../../legacy/panels-bridge.ts";
import {
  onRootClick,
  onRootFocusOut,
  onRootInput,
  onRootKeydown,
  onRootMouseDown,
  onRootPaste,
  routeRootClick
} from "./editor.ts";
import { commentSortMode, setCommentSort } from "../../application/comment-sort.ts";

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
      closePanel: () => { sidePanels().close("comments-panel"); },
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

const state = owned<ReturnType<typeof mountCommentState>>();

export function mountCommentsLogicFeature(): ReturnType<typeof mountCommentState> {
  return state.replace(() => {
    const ports: CommentStatePorts = {
      sort: { current: commentSortMode, choose: setCommentSort },
      document: portDocument,
      edits: portEdits,
      notices: portNotices,
      preferences: portPreferences,
      review: portReview,
      sidePanels: portSidePanels,
      text: portText,
      ids: portIds,
      clock: portClock,
      saves: portSaves,
      selection: portSelection,
      deletion: portDeletion,
      ownership: portOwnership,
      history: { keep: keepSnapshot },
      presence: { personColor: (name) => presence().personColor(name) },
      shots: { reveal: (id) => shotHiding().reveal(id) },
      pictures: portPictures,
      clearDraftUndo: resetDraftHistory,
      onThreadsSent: onCommentsSent
    };
    return mountCommentState(ports);
  });
}

export const stopCommentsLogicFeature = state.stop;

export function commentsPanelActions() {
  return panelDefinitions(portScreen, portSidePanels);
}

export function commentsHelpActions() {
  return helpDefinitions(portScreen);
}

export function commentsOpenActions() {
  return openDefinitions();
}
