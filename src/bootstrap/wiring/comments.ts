import type { ActionRegistry } from "../../application/actions.ts";
import type { EditorSelectionPort } from "../../application/editing/selection.ts";
import type { Operations } from "../../application/session/operation.ts";
import type { HistoryPort } from "../../application/transitions/ports.ts";
import { registerCommentAction } from "../../features/comments/actions.ts";
import type { CommentActionSlot } from "../../features/comments/actions.ts";
import { AUTHOR_NAME_FIELDS, createComments } from "../../features/comments/comments.js";
import { formatTimestampAbsolute } from "../../adapters/formats/export-projections.ts";
import { makeId, nowIso } from "../../adapters/identity/ids.ts";
import { blobImgHtml } from "../../adapters/storage/02c-blobs.js";
import { deleteConfirmation } from "../../legacy/production-editing-bridge.ts";
import { captureOperation, keepSnapshot, stillOwns } from "../../legacy/transition-bridge.ts";
import { preferences } from "../../legacy/preferences-bridge.ts";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";
import { presence } from "../../legacy/presence-bridge.ts";
import { sidePanels } from "../../legacy/panels-bridge.ts";
import { showToast } from "../../legacy/effects-bridge.ts";
import { autoSavePolicy, resumeAutoSave } from "../../legacy/save-bridge.ts";
import { currentDocument, readSession, runDocumentEdit, sessionStamps } from "../../legacy/session-bridge.ts";
import { reviewBlocked, reviewMode } from "../../legacy/location-bridge.ts";
import { screenNow } from "../../legacy/screen-state.ts";
import { inertBody, plainText, safeId, sanitizeHtml } from "../../js/04-richtext.js";
import { resetDraftHistory } from "../../js/05d-draft-edit.js";

interface CommentsViewPorts {
  readonly selection: EditorSelectionPort;
  readonly editableCellHtml: (options: { value?: string; placeholder: string; toolbar: string }) => string;
}

let viewPorts: CommentsViewPorts | null = null;

function views(): CommentsViewPorts {
  if (!viewPorts) throw new Error("The comments view is not mounted yet");
  return viewPorts;
}

type Comments = ReturnType<typeof createComments>;

let implementation: Comments | null = null;
const operations: Operations = { capture: captureOperation, stillOwns };
const history: HistoryPort = { keep: keepSnapshot };

function currentComments(): Comments {
  if (!implementation) {
    implementation = createComments({
      deleteConfirmation, operations, history, preferences, shotHiding, presence,
      formatTimestampAbsolute, makeId, nowIso,
      blobImgHtml, inertBody, plainText, safeId, sanitizeHtml, resetDraftHistory,
      editableCellHtml: (options: { value?: string; placeholder: string; toolbar: string }) => views().editableCellHtml(options),
      currentDocument, readSession,
      runDocumentEdit, sessionStamps,
      selection: { dropLink: () => views().selection.dropLink() }, showToast,
      sidePanels, autoSavePolicy,
      resumeAutoSave, reviewBlocked, reviewMode
    });
  }
  return implementation;
}

export { AUTHOR_NAME_FIELDS };
export { cleanAuthorName } from "../../features/comments/comments.js";
export { commentBodyText, commentEntries } from "../../adapters/formats/export-projections.ts";

export const showTaggingHelp = (...args: Parameters<Comments["showTaggingHelp"]>): ReturnType<Comments["showTaggingHelp"]> => currentComments().showTaggingHelp(...args);
export const hideTaggingHelp = (...args: Parameters<Comments["hideTaggingHelp"]>): ReturnType<Comments["hideTaggingHelp"]> => currentComments().hideTaggingHelp(...args);
export const updateTaggingHelpCover = (...args: Parameters<Comments["updateTaggingHelpCover"]>): ReturnType<Comments["updateTaggingHelpCover"]> => currentComments().updateTaggingHelpCover(...args);
export const captureCommentComposer = (...args: Parameters<Comments["captureCommentComposer"]>): ReturnType<Comments["captureCommentComposer"]> => currentComments().captureCommentComposer(...args);
export const resetCommentBindings = (...args: Parameters<Comments["resetCommentBindings"]>): ReturnType<Comments["resetCommentBindings"]> => currentComments().resetCommentBindings(...args);
export const limitAuthorNameField = (...args: Parameters<Comments["limitAuthorNameField"]>): ReturnType<Comments["limitAuthorNameField"]> => currentComments().limitAuthorNameField(...args);
export const getSavedAuthorName = (...args: Parameters<Comments["getSavedAuthorName"]>): ReturnType<Comments["getSavedAuthorName"]> => currentComments().getSavedAuthorName(...args);
export const saveAuthorName = (...args: Parameters<Comments["saveAuthorName"]>): ReturnType<Comments["saveAuthorName"]> => currentComments().saveAuthorName(...args);
export const setCommentSortMode = (...args: Parameters<Comments["setCommentSortMode"]>): ReturnType<Comments["setCommentSortMode"]> => currentComments().setCommentSortMode(...args);
export const setCommentFilterMode = (...args: Parameters<Comments["setCommentFilterMode"]>): ReturnType<Comments["setCommentFilterMode"]> => currentComments().setCommentFilterMode(...args);
export const setCommentAssigneeFilter = (...args: Parameters<Comments["setCommentAssigneeFilter"]>): ReturnType<Comments["setCommentAssigneeFilter"]> => currentComments().setCommentAssigneeFilter(...args);
export const setCommentAssignee = (...args: Parameters<Comments["setCommentAssignee"]>): ReturnType<Comments["setCommentAssignee"]> => currentComments().setCommentAssignee(...args);
export const formatTimestamp = (...args: Parameters<Comments["formatTimestamp"]>): ReturnType<Comments["formatTimestamp"]> => currentComments().formatTimestamp(...args);
export const syncAnchorResolvedClasses = (...args: Parameters<Comments["syncAnchorResolvedClasses"]>): ReturnType<Comments["syncAnchorResolvedClasses"]> => currentComments().syncAnchorResolvedClasses(...args);
export const commentsChanged = (...args: Parameters<Comments["commentsChanged"]>): ReturnType<Comments["commentsChanged"]> => currentComments().commentsChanged(...args);
export const openCommentComposer = (...args: Parameters<Comments["openCommentComposer"]>): ReturnType<Comments["openCommentComposer"]> => currentComments().openCommentComposer(...args);
export const closeCommentComposer = (...args: Parameters<Comments["closeCommentComposer"]>): ReturnType<Comments["closeCommentComposer"]> => currentComments().closeCommentComposer(...args);
export const postComment = (...args: Parameters<Comments["postComment"]>): ReturnType<Comments["postComment"]> => currentComments().postComment(...args);
export const openCommentsPanel = (...args: Parameters<Comments["openCommentsPanel"]>): ReturnType<Comments["openCommentsPanel"]> => currentComments().openCommentsPanel(...args);
export const toggleResolve = (...args: Parameters<Comments["toggleResolve"]>): ReturnType<Comments["toggleResolve"]> => currentComments().toggleResolve(...args);
export const armDeleteComment = (...args: Parameters<Comments["armDeleteComment"]>): ReturnType<Comments["armDeleteComment"]> => currentComments().armDeleteComment(...args);
export const toggleReplyComposer = (...args: Parameters<Comments["toggleReplyComposer"]>): ReturnType<Comments["toggleReplyComposer"]> => currentComments().toggleReplyComposer(...args);
export const postReply = (...args: Parameters<Comments["postReply"]>): ReturnType<Comments["postReply"]> => currentComments().postReply(...args);
export const jumpToAnchor = (...args: Parameters<Comments["jumpToAnchor"]>): ReturnType<Comments["jumpToAnchor"]> => currentComments().jumpToAnchor(...args);
export const jumpToComment = (...args: Parameters<Comments["jumpToComment"]>): ReturnType<Comments["jumpToComment"]> => currentComments().jumpToComment(...args);
export const toggleCommentMenu = (...args: Parameters<Comments["toggleCommentMenu"]>): ReturnType<Comments["toggleCommentMenu"]> => currentComments().toggleCommentMenu(...args);
export const restoreConflictValue = (...args: Parameters<Comments["restoreConflictValue"]>): ReturnType<Comments["restoreConflictValue"]> => currentComments().restoreConflictValue(...args);
export const captureReplyDrafts = (...args: Parameters<Comments["captureReplyDrafts"]>): ReturnType<Comments["captureReplyDrafts"]> => currentComments().captureReplyDrafts(...args);
export const renderComments = (...args: Parameters<Comments["renderComments"]>): ReturnType<Comments["renderComments"]> => currentComments().renderComments(...args);
export function mountCommentsState(ports: CommentsViewPorts): void {
  viewPorts = ports;
  currentComments().__init();
}
export const revealRow = (rowId: string): void => { shotHiding().reveal(rowId); };
export const closeCommentsPanel = (): void => { sidePanels().close("comments-panel"); };

export function registerCommentsAction(registry: ActionRegistry, slot: CommentActionSlot): () => void {
  return registerCommentAction(registry, slot, {
    screen: screenNow, openPanel: openCommentsPanel, closePanel: closeCommentsPanel,
    showTaggingHelp, openComposer: openCommentComposer
  });
}
