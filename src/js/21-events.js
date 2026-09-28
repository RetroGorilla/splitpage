import { S } from "./_state.js";
import { conn, importHome } from "./_home.js";
import { suppressUnloadWarning } from "./00-prelude.js";
import { cycleRowStatus } from "./01-scene-status.js";
import {
  expandHiddenShotStrip,
  revealRow,
  toggleHideShotScenes,
  updateHideShotMenu
} from "./01b-hide-shot.js";
import { loadInitialState } from "./02-state.js";
import { initDocIdentityChannel, syncDocIdentity } from "./02b-doc-id.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import {
  SNAPSHOT_KEY,
  cloneState,
  closeHistoryPanel,
  getEditorName,
  promptForName,
  promptForWpm,
  reportMerge,
  restoreSnapshotFromCard,
  setBaseState,
  stampRow,
  undoMerge,
  updateIdentityChip
} from "./03-sync.js";
import { startHistoryMigration } from "./03a-history-store.js";
import { initSidePanelResizeHandles } from "./03b-side-panels.js";
import { cssAttr, sanitizeHtml, storedHtmlFromDom, storedImageHtml } from "./04-richtext.js";
import {
  cancelLink,
  cancelVideo,
  confirmLink,
  confirmVideo,
  forgetStalePendingMarks,
  handleToolbarCmd,
  insertLineBreak,
  isScriptCell,
  maybeCueShortcut,
  maybeDirectionShortcut,
  render,
  renderRow,
  syncFieldFromDom,
  toggleCellFormat,
  typeAtDirectionEdge,
  typePendingMarks,
  updateToolbarState
} from "./05-render.js";
import { copyFromCell, hasMediaFiles, pasteIntoCell, readClipboardFiles } from "./05c-clipboard.js";
import { pasteScenesAt } from "./05h-scene-select.js";
import { openGalleryOverlay } from "./05e-gallery-overlay.js";
import { thumbnailsAfterPaste } from "./05v-video.js";
import {
  appendDraftMedia,
  draftRedo,
  draftUndo,
  isDraftBox,
  noteDraftBeforeInput,
  noteDraftComposition,
  noteDraftFocus,
  noteDraftInput,
  pasteIntoDraft
} from "./05d-draft-edit.js";
import {
  addRow,
  addRowAndFocus,
  armDelete,
  clearDropMarkers,
  compressImageFile,
  grantVideoFile,
  focusRowField,
  handleImageFile,
  moveRow,
  moveRowTo,
  openGalleryLink,
  removeImage,
  removeImageLink,
  setDropMarkerForRow,
  splitCellField,
  stopDragScroll,
  swapAdjacentRows,
  closeRowMenus,
  rowMenuKeydown,
  toggleRowMenu,
  updateDragScroll,
  videoFirstFrame
} from "./06-rows.js";
import {
  acceptTagGhost,
  acceptUntaggedMention,
  applyTag,
  armBulkDelete,
  bulkDeleteArmed,
  clearProductionSelection,
  closeTagComposer,
  disarmBulkDelete,
  hideTagGhost,
  hideUntaggedPrompt,
  maybeAutoTagShortcut,
  renderTagCategories,
  scheduleProductionRefresh,
  scheduleUntaggedScan,
  selectedKeys,
  tagGhost,
  tagKey,
  untaggedSuggestion,
  updateTagGhost,
  updateUntaggedPrompt
} from "./07-production-tags.js";
import {
  cancelPlainTag,
  closePlainTag,
  maybeOpenPlainTag,
  plainTagEmptyAtCaret,
  plainTagOpen,
  refreshPlainTag
} from "./07b-plain-tags.js";
import {
  IS_TOUCH,
  addPersonForTag,
  applyGearQuickAdd,
  armDeleteTag,
  armPersonDelete,
  armRemoveTag,
  bulkAddPerson,
  bulkDeleteSelected,
  bulkSetOwner,
  bulkSetStatus,
  closeGearPanel,
  closeProductionPanel,
  handleSelectionClick,
  jumpToTag,
  openGearPanel,
  openProductionPanel,
  renderGearList,
  renderProduction,
  saveTagRename,
  setTagStatus,
  tagAllMentions,
  toggleCardSelection,
  wireTouchSelection
} from "./08-production-panels.js";
import {
  anchorBrollInLeftCell,
  maybeCaptureBroll,
  scheduleBrollRefresh
} from "./08c-broll.js";
import { wireBrollPanel } from "./08d-broll-panel.js";
import {
  bulkTagOpen,
  closeBulkTag,
  closeFindBar,
  findOpen,
  findQueryChanged,
  leaveFindAtMatch,
  openFindBar,
  pickBulkTagCat,
  replaceAll,
  replaceCurrent,
  runBulkTag,
  stepFind,
  toggleBulkTag
} from "./09-find-replace.js";
import {
  armDeleteComment,
  captureReplyDrafts,
  closeCommentComposer,
  closeCommentsPanel,
  jumpToAnchor,
  jumpToComment,
  openCommentsPanel,
  postComment,
  postReply,
  renderComments,
  restoreConflictValue,
  setCommentAssignee,
  setCommentAssigneeFilter,
  setCommentFilterMode,
  setCommentSortMode,
  syncAnchorResolvedClasses,
  toggleCommentMenu,
  toggleReplyComposer,
  toggleResolve
} from "./10-comments.js";
import {
  clearPendingFileRows,
  closeGdocModal,
  closeImportModal,
  confirmGdocImport,
  confirmImport,
  handleImportFile,
  maybeAutoDetectTwoColumn,
  updateImportPreview
} from "./11-import.js";
import { markDirty, showActionToast, showToast, updateSaveStatus } from "./12-dirty-toast.js";
import { caretAfterStep, configureUndo, lastUndoEntry, redo, settleAfterApply, undo } from "./12a-undo.js";
import {
  armDriveDelete,
  armServerDelete,
  closeDriveModal,
  closeServerPicker,
  detectServer,
  driveCancelRename,
  driveConnect,
  driveCreateFolder,
  driveCrumbTo,
  driveItemById,
  driveListCurrent,
  driveOpenItem,
  driveSaveCredsFromForm,
  driveSaveRename,
  driveShowCredsForm,
  driveSignIn,
  driveSignOut,
  driveStartRename,
  driveUploadFiles,
  onServerDoc,
  openServerDoc,
  reviewBlocked,
  reviewMode,
  toggleDriveNewFolder
} from "./13-hosted.js";
import { applyStashedWork, saveDoc, updateAutoSaveMenu } from "./14-export.js";
import {
  buildFileData,
  closeFileConflict,
  deliverFile,
  exportAs,
  exportNarration,
  exportPackingList,
  fileConflictCtx,
  handleFileMenuAction,
  hideResumeBanner,
  openProjectFile,
  pendingResumeHandle,
  reloadFileFromDisk,
  reloadProjectFromDisk,
  resumeFromHandle,
  saveBackToFile,
  tryResumeLastProject
} from "./18-local-files.js";
import { cancelMergeReview, confirmFileMerge, openMergeReview } from "./18a-local-merge.js";
import { toggleFileMenu, toggleSubmenu } from "./18b-file-menu.js";
import {
  applyWriterSize,
  caretTextOffset,
  closeWriter,
  cycleWriterGutter,
  jumpFromWriterToRow,
  onWriterFormat,
  onWriterKeydown,
  openWriter,
  placeCaretAtTextOffset,
  renderWriter,
  scheduleWriterStats,
  updateWriterFormatState,
  writerOpen
} from "./19-writer.js";
import {
  acquireWakeLock,
  applyPrompterSize,
  buildPrompterContent,
  closePrompter,
  cueSceneForCurrentPosition,
  openPrompter,
  promptSceneMode,
  prompterFlip,
  prompterMirror,
  setPrompterFlip,
  setPrompterMirror,
  setPrompterPlaying,
  setPrompterSceneMode,
  setPrompterSpeed,
  startVoiceFollow,
  stepPrompterSize,
  stepPrompterSpeed,
  stepScene,
  stopVoiceFollow,
  updatePrompterStatus,
  updateSceneReadout,
  updateVoiceAvailability,
  wireTagEntityContainer
} from "./20-teleprompter.js";
import {
  dismissDesktopAppNotice,
  dismissUpdateNotice,
  loadUpdateStatus,
  renderDesktopAppNotice
} from "./20a-update.js";
import { finishMarkdownRowChoice } from "./20d-formats.js";
import { initDesktop, notifyDesktopDocumentState } from "./20f-desktop.js";
import {
  applyTakenDraft,
  armServerDraftResume,
  draftRestorePending
} from "./20g-drafts.js";

/* ================= events ================= */

/* Everything a review session (13-hosted.js) may still do from the click
   delegation below. An ALLOW-list rather than a list of things to block,
   because this handler serves the script, the comments panel, the comment
   composer, the history panel and the Production and Gear panels: a new
   action added to any of them has to be considered here before a reviewer
   can reach it, which is the right way round for something the server is
   going to refuse anyway. Everything on it either navigates (jumping to a
   tag, a scene, a comment), is part of writing a comment or a reply,
   including the reply composer's own link popover, or builds a file from
   the document without writing to it (the Production panel's CSV, the
   Gear panel's packing list). The b-roll panel and
   its full page have their own delegation since #148, and their own list
   (08d-broll-panel.js BROLL_REVIEW_SAFE_ACTIONS). */
var REVIEW_SAFE_ACTIONS = {
  "toggle-reply": 1, "reply-post": 1, "reply-cancel": 1,
  "link-confirm": 1, "link-cancel": 1, "video-confirm": 1, "video-cancel": 1,
  "jump-tag": 1, "jump-row": 1, "writer-jump": 1,
  /* a scene's gallery dialog, to look at (and see a picture at full size,
     #216): it offers no edit in a review session (05e-gallery-overlay.js) */
  "gallery-open": 1, "gallery-open-videos": 1,
  "tag-expand": 1, "bulk-clear": 1,
  "export-breakdown": 1, "export-packing-gear": 1
};

export function onRootClick(e) {
  if (reviewMode()) {
    var tbReview = e.target.closest(".mini-toolbar button[data-cmd]");
    var actionEl = e.target.closest("[data-action]");
    /* A click on nothing in particular — the comment card's own "jump to
       this text", a selection gesture, plain padding — carries no action
       and changes nothing, so it is left alone. */
    if (tbReview ? tbReview.getAttribute("data-cmd") !== "comment"
                 : (actionEl && !REVIEW_SAFE_ACTIONS[actionEl.getAttribute("data-action")])) {
      reviewBlocked();
      return;
    }
  }

  var addBtn = e.target.closest('[data-action="add-row"]');
  if (addBtn) { addRow(null); return; }

  var tbBtn = e.target.closest(".mini-toolbar button[data-cmd]");
  if (tbBtn) { handleToolbarCmd(tbBtn); return; }

  var linkConfirm = e.target.closest('[data-action="link-confirm"]');
  if (linkConfirm) { confirmLink(linkConfirm.closest(".field-wrap")); return; }

  var linkCancel = e.target.closest('[data-action="link-cancel"]');
  if (linkCancel) { cancelLink(linkCancel.closest(".field-wrap")); return; }

  var videoConfirm = e.target.closest('[data-action="video-confirm"]');
  if (videoConfirm) { confirmVideo(videoConfirm.closest(".field-wrap")); return; }

  var videoCancel = e.target.closest('[data-action="video-cancel"]');
  if (videoCancel) { cancelVideo(videoCancel.closest(".field-wrap")); return; }

  var toggleResolveBtn = e.target.closest('[data-action="toggle-resolve"]');
  if (toggleResolveBtn) { toggleResolve(toggleResolveBtn.getAttribute("data-id")); return; }

  var commentFilterBtn = e.target.closest("#comments-filter-seg [data-filter]");
  if (commentFilterBtn) { setCommentFilterMode(commentFilterBtn.getAttribute("data-filter")); return; }

  var toggleReplyBtn = e.target.closest('[data-action="toggle-reply"]');
  if (toggleReplyBtn) { toggleReplyComposer(toggleReplyBtn.getAttribute("data-id")); return; }

  var replyCancelBtn = e.target.closest('[data-action="reply-cancel"]');
  if (replyCancelBtn) { toggleReplyComposer(replyCancelBtn.getAttribute("data-id")); return; }

  var replyPostBtn = e.target.closest('[data-action="reply-post"]');
  if (replyPostBtn) { postReply(replyPostBtn.getAttribute("data-id")); return; }

  var deleteCommentBtn = e.target.closest('[data-action="delete-comment"]');
  if (deleteCommentBtn) { armDeleteComment(deleteCommentBtn, deleteCommentBtn.getAttribute("data-id")); return; }

  var restoreConflictBtn = e.target.closest('[data-action="restore-conflict"]');
  if (restoreConflictBtn) { restoreConflictValue(restoreConflictBtn.getAttribute("data-id")); return; }

  /* A comment card's "⋯" and the menu it opens (#169, 10-comments.js)
     are not the card's jump below: the "⋯" toggles its menu, and a press
     on the menu's own padding does nothing. Delete in it returned above. */
  var commentMenuBtn = e.target.closest('[data-action="comment-menu"]');
  if (commentMenuBtn) { toggleCommentMenu(commentMenuBtn.getAttribute("data-id")); return; }
  if (e.target.closest(".comment-menu")) return;

  var jumpTagBtn = e.target.closest('[data-action="jump-tag"]');
  if (jumpTagBtn) {
    jumpToTag(jumpTagBtn.getAttribute("data-row"), jumpTagBtn.getAttribute("data-key"));
    return;
  }

  /* The comment card itself is the "jump to text" control — see
     .is-jumpable. Excluded: the reply composer (its own contenteditable,
     name input and link popover all need a plain click to focus, not a
     jump) and any <a> in the comment body (should follow the link, not
     jump away from it — everything else on the card already returned
     above, buttons included, so by this point a click on .comment-actions
     itself is just padding, not a hit). And a click that ends a text
     selection — finishing a drag to copy the quote or the body must never
     also fire a jump. */
  var jumpCard = e.target.closest(".comment-card.is-jumpable");
  if (jumpCard && !e.target.closest(".reply-composer") && !e.target.closest("a") &&
      window.getSelection().isCollapsed) {
    jumpToAnchor(jumpCard.getAttribute("data-id"));
    return;
  }

  /* Ctrl/Cmd or Shift on a card is the multi-select gesture, and it wins
     over everything else the card contains — Ctrl+clicking the status pill
     or the Rename button selects the card rather than firing that control,
     which is what makes "modifier-click anywhere on it" a reliable target.
     Checked first for that reason. */
  var selCard = (e.ctrlKey || e.metaKey || e.shiftKey)
    ? e.target.closest("#production-list .tag-entity") : null;
  if (selCard && handleSelectionClick(e, selCard)) { e.preventDefault(); return; }

  /* On touch, while a selection exists, taps on an item's row toggle
     membership (standard mobile selection-mode behaviour, and far kinder
     than long-pressing every card). The whole row line since #169 — name,
     status, owner; a tap on its status must not step the status on — but
     only the row: the open item's detail controls — owner, notes, status —
     keep working mid-selection, and a scene link (jump-tag, above) still
     jumps. */
  if (IS_TOUCH && selectedKeys().length) {
    var touchRow = e.target.closest("#production-list .tag-entity-row");
    if (touchRow) {
      toggleCardSelection(touchRow.closest(".tag-entity").getAttribute("data-key"));
      return;
    }
  }

  var bulkClear = e.target.closest('[data-action="bulk-clear"]');
  if (bulkClear) { clearProductionSelection(); renderProduction(); return; }

  var bulkDel = e.target.closest('[data-action="bulk-delete"]');
  if (bulkDel) {
    if (bulkDeleteArmed) { disarmBulkDelete(); bulkDeleteSelected(); }
    else { armBulkDelete(); renderProduction(); }
    return;
  }

  var bulkPersonNew = e.target.closest('[data-action="bulk-person-new"]');
  if (bulkPersonNew) {
    S.tagAddingPersonFor = "__bulk__";
    renderProduction();
    var bpi = document.getElementById("bulk-person-input");
    if (bpi) bpi.focus();
    return;
  }

  var bulkPersonSave = e.target.closest('[data-action="bulk-person-save"]');
  if (bulkPersonSave) { bulkAddPerson(); return; }

  var bulkPersonCancel = e.target.closest('[data-action="bulk-person-cancel"]');
  if (bulkPersonCancel) { S.tagAddingPersonFor = null; renderProduction(); return; }

  /* both of these are checked ahead of tag-expand: the pill lives inside
     the card head, which is itself the expander, so whichever branch runs
     first wins — and clicking the pill must not also open the card */
  var tagStatusCycle = e.target.closest('[data-action="tag-status-cycle"]');
  if (tagStatusCycle) { setTagStatus(tagStatusCycle.getAttribute("data-key"), null); return; }

  var tagStatusSet = e.target.closest('[data-action="tag-status-set"]');
  if (tagStatusSet) {
    setTagStatus(tagStatusSet.getAttribute("data-key"), tagStatusSet.getAttribute("data-status"));
    return;
  }

  var tagExpandBtn = e.target.closest('[data-action="tag-expand"]');
  if (tagExpandBtn) {
    var expandKey = tagExpandBtn.getAttribute("data-key");
    S.tagExpanded = S.tagExpanded === expandKey ? null : expandKey;
    S.tagRenaming = null;
    S.tagAddingPersonFor = null;
    renderProduction();
    return;
  }

  var personNewBtn = e.target.closest('[data-action="tag-person-new"]');
  if (personNewBtn) {
    S.tagAddingPersonFor = personNewBtn.getAttribute("data-key");
    renderProduction();
    var newInput = document.querySelector('.tag-person-input[data-key="' +
      cssAttr(S.tagAddingPersonFor) + '"]');
    if (newInput) newInput.focus();
    return;
  }

  var personSaveBtn = e.target.closest('[data-action="tag-person-save"]');
  if (personSaveBtn) { addPersonForTag(personSaveBtn.getAttribute("data-key")); return; }

  var personCancelBtn = e.target.closest('[data-action="tag-person-cancel"]');
  if (personCancelBtn) { S.tagAddingPersonFor = null; renderProduction(); return; }

  var personDeleteBtn = e.target.closest('[data-action="person-delete"]');
  if (personDeleteBtn) { armPersonDelete(personDeleteBtn, personDeleteBtn.getAttribute("data-person")); return; }

  var groupBtn = e.target.closest("#production-modes [data-group]");
  if (groupBtn) {
    S.productionGroupBy = groupBtn.getAttribute("data-group");
    /* Scene and Shoot draw no cards, so a selection would survive with
       nothing on screen showing it and no bar to act on it. Keeping it
       would break the rule that a selection is always visible. */
    if (S.productionGroupBy !== "cat" && S.productionGroupBy !== "person") clearProductionSelection();
    renderProduction();
    return;
  }

  var breakdownBtn = e.target.closest('[data-action="export-breakdown"]');
  if (breakdownBtn) { exportAs("breakdown"); return; }

  var packingGearBtn = e.target.closest('[data-action="export-packing-gear"]');
  if (packingGearBtn) { exportPackingList("gear"); return; }

  var tagRenameBtn = e.target.closest('[data-action="tag-rename"]');
  if (tagRenameBtn) { S.tagRenaming = tagRenameBtn.getAttribute("data-key"); renderProduction(); return; }

  var tagRenameSave = e.target.closest('[data-action="tag-rename-save"]');
  if (tagRenameSave) { saveTagRename(tagRenameSave.getAttribute("data-key")); return; }

  var tagRenameCancel = e.target.closest('[data-action="tag-rename-cancel"]');
  if (tagRenameCancel) { S.tagRenaming = null; renderProduction(); return; }

  var tagAllBtn = e.target.closest('[data-action="tag-all-mentions"]');
  if (tagAllBtn) { tagAllMentions(tagAllBtn.getAttribute("data-key")); return; }

  var tagRemoveBtn = e.target.closest('[data-action="tag-remove"]');
  if (tagRemoveBtn) { armRemoveTag(tagRemoveBtn, tagRemoveBtn.getAttribute("data-key")); return; }

  var tagDeleteBtn = e.target.closest('[data-action="tag-delete"]');
  if (tagDeleteBtn) { armDeleteTag(tagDeleteBtn, tagDeleteBtn.getAttribute("data-key")); return; }

  var catBtn = e.target.closest("#tag-cats .tag-cat-btn");
  if (catBtn) { renderTagCategories(catBtn.getAttribute("data-tag-cat")); return; }

  var restoreSnapBtn = e.target.closest('[data-action="restore-snapshot"]');
  if (restoreSnapBtn) { restoreSnapshotFromCard(restoreSnapBtn); return; }

  var statusBtn = e.target.closest('[data-action="cycle-status"]');
  if (statusBtn) { cycleRowStatus(statusBtn.getAttribute("data-id")); return; }

  var expandShotBtn = e.target.closest('[data-action="expand-hidden-shot"]');
  if (expandShotBtn) { expandHiddenShotStrip(expandShotBtn.getAttribute("data-ids")); return; }

  var jumpRowBtn = e.target.closest('[data-action="jump-row"]');
  if (jumpRowBtn) {
    revealRow(jumpRowBtn.getAttribute("data-row"));
    var target = document.querySelector('#rows .row[data-id="' + cssAttr(jumpRowBtn.getAttribute("data-row")) + '"]');
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("just-merged");
      void target.offsetWidth;
      target.classList.add("just-merged");
    } else {
      showToast("That scene is no longer here.", "warn");
    }
    return;
  }

  /* The scene's "⋯" menu (#169, 06-rows.js). detail 0 is a click the
     keyboard made — Enter or Space — so the first item takes focus. */
  var rowMenuBtn = e.target.closest('[data-action="row-menu"]');
  if (rowMenuBtn) { toggleRowMenu(rowMenuBtn, e.detail === 0); return; }

  var moveUp = e.target.closest('[data-action="move-up"]');
  if (moveUp) { moveRow(moveUp.getAttribute("data-id"), -1); refocusRowMenu(moveUp.getAttribute("data-id")); return; }

  var moveDown = e.target.closest('[data-action="move-down"]');
  if (moveDown) { moveRow(moveDown.getAttribute("data-id"), 1); refocusRowMenu(moveDown.getAttribute("data-id")); return; }

  var insertBelow = e.target.closest('[data-action="insert-below"]');
  if (insertBelow) { addRow(insertBelow.getAttribute("data-id")); return; }

  var del = e.target.closest('[data-action="delete-row"]');
  if (del) { armDelete(del, del.getAttribute("data-id")); return; }

  var imgAdd = e.target.closest('[data-action="image-add"], [data-action="image-add-more"], [data-action="image-replace"]');
  if (imgAdd) {
    S.pendingImageRowId = imgAdd.getAttribute("data-id");
    /* Replace names its slot (a single picture); the paperclip and Add add (#135) */
    pendingImageSlot = imgAdd.getAttribute("data-action") === "image-replace"
      ? Number(imgAdd.getAttribute("data-slot")) || 0 : undefined;
    document.getElementById("file-input").click();
    return;
  }

  var imgRemove = e.target.closest('[data-action="image-remove"]');
  if (imgRemove) { removeImage(imgRemove.getAttribute("data-id"), Number(imgRemove.getAttribute("data-slot")) || 0); return; }

  /* the scene's gallery (#135): a tile opens its dialog (05e-gallery-
     overlay.js) at that item, "+N more videos" at its videos; a caption
     line opens its video; × takes a link off */
  var tile = e.target.closest('[data-action="gallery-open"], [data-action="gallery-open-videos"]');
  if (tile) {
    openGalleryOverlay(tile.getAttribute("data-id"), Number(tile.getAttribute("data-slot")) || 0,
      tile.getAttribute("data-action") === "gallery-open-videos");
    return;
  }

  var linkOff = e.target.closest('[data-action="gallery-link-remove"]');
  if (linkOff) {
    removeImageLink(linkOff.getAttribute("data-id"), Number(linkOff.getAttribute("data-slot")) || 0, linkOff.getAttribute("data-key"));
    return;
  }

  var videoLinkEl = e.target.closest('[data-action="gallery-link"]');
  if (videoLinkEl) {
    e.preventDefault();
    openGalleryLink(videoLinkEl.getAttribute("data-id"), Number(videoLinkEl.getAttribute("data-slot")) || 0, videoLinkEl.getAttribute("data-key"));
    return;
  }
}

/* The slot the file picker's picture goes to: a number for Replace,
   undefined to add one (#135). */
var pendingImageSlot;

/* A move from the scene's menu repaints its gutter, and the menu item that
   had focus goes with it — leaving focus on <body>, where the next arrow
   key does nothing. It comes back to the moved scene's "⋯", so a second
   Move up is one Enter and one arrow away. Only when focus really was
   lost: a move made while a script cell has the caret (a test's jsclick,
   a merge landing) leaves the caret where it is. */
function refocusRowMenu(rowId) {
  closeRowMenus();
  var a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !(a.closest && a.closest(".row-menu"))) return;
  var btn = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"] .row-more');
  if (btn) btn.focus({ preventScroll: true });
}



function onRootMouseDown(e) {
  hideTagGhost();
  /* arm the row for dragging only while its grip is held — see the note on
     dragRowId for why the row isn't just permanently draggable */
  var grip = e.target.closest('[data-action="drag-grip"]');
  if (grip) {
    var gripRow = grip.closest(".row");
    if (gripRow) gripRow.setAttribute("draggable", "true");
  }
  if (e.target.closest(".mini-toolbar button")) e.preventDefault();
  /* Handle anchors here, not on click: focusing the cell reveals the mini
     toolbar, which shifts the text down, so mouseup lands elsewhere and the
     synthesized click retargets to an ancestor — the first click was lost. */
  var anchor = e.target.closest(".cmt-anchor");
  if (anchor) jumpToComment(anchor.getAttribute("data-cmt"));

  var tagEl = e.target.closest(".tag-anchor");
  if (tagEl) {
    var key = tagKey(tagEl.getAttribute("data-tag-cat"), tagEl.getAttribute("data-tag-name"));
    /* scene grouping has no per-item card to land on, so clicking a tag in
       the script always comes back to a view that does */
    if (S.productionGroupBy === "scene") S.productionGroupBy = "cat";
    S.tagExpanded = key; /* open straight onto its owner + notes */
    openProductionPanel();
    setTimeout(function () {
      var card = document.querySelector('.tag-entity[data-key="' + cssAttr(key) + '"]');
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.remove("flash");
        void card.offsetWidth;
        card.classList.add("flash");
      }
    }, 30);
  }
}

/* The comment composer and every reply box reuse .cell-editable, and their
   input events bubble to the same handler as the script's own cells. Only
   the script itself can carry tags, so everything tag-related below is
   gated on the cell actually being a row field (isScriptCell, 05-render.js,
   where the formatting commands need it too) — otherwise typing
   "[boom pole]" into a comment silently made a tag inside that comment and
   registered a production item that could never appear in the script.
   The writer's paragraphs are row fields too — same data-id/data-field,
   same row behind them — so they get the same treatment as the cells in
   the split view. That is the whole reason the writer needed no editing
   code of its own beyond splitting and joining scenes. */

/* The nearest ancestor that actually scrolls — document for a cell in
   #rows, the .writer-scroll pane for a paragraph in #writer-doc. Walked
   rather than hard-coded, so this keeps working wherever a script cell
   ends up living next. */
function nearestScrollAncestor(el) {
  var node = el.parentElement;
  while (node && node !== document.body) {
    var cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/* Typing near the edge of the viewport, the browser scrolls the caret
   into view on its own — this is only for what it doesn't reliably
   handle: pasting a large block, or backspacing/selecting-and-deleting a
   big chunk at once, either of which can leave the caret sitting off
   screen with no native scroll to follow it. Losing sight of the scene
   you were just in, right as you cut a paragraph down, is exactly the
   moment it's easiest to lose your place in the script.

   Checked on every input event but a no-op almost all of the time — it
   only acts once the caret has actually drifted out of a comfortable
   margin, so normal typing near the middle of the screen never triggers
   it and never fights the browser's own scroll-follow. */
function keepCaretInView(cellEl) {
  var sel = window.getSelection();
  if (!sel.rangeCount) return;
  var rect = sel.getRangeAt(0).getBoundingClientRect();
  /* a collapsed range at the tail of the text (or right after an atomic
     tag) can report a zero-sized rect — the cell's own edge is still
     close enough to answer "is this on screen right now" */
  if (!rect || (!rect.width && !rect.height)) rect = cellEl.getBoundingClientRect();
  var margin = 32;
  if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
  /* Scrolls to the CARET's own position, not the cell's. A cell that just
     grew to several times the viewport's height — a big paste, or a
     typing shortcut inserting a large block — is exactly the case this
     exists for, and scrollIntoView() on the cell centres the ELEMENT, not
     whatever point inside it the caret happens to be at. On a cell far
     taller than the viewport that can land the caret exactly as far out
     of view as it started. */
  var delta = (rect.top + rect.bottom) / 2 - window.innerHeight / 2;
  nearestScrollAncestor(cellEl).scrollBy({ top: delta, behavior: "smooth" });
}

/* ---- undo and redo (12a-undo.js) ---- */

function isUndoKey(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z");
}
function isRedoKey(e) {
  return (e.ctrlKey || e.metaKey) && !e.altKey &&
    (((e.key === "z" || e.key === "Z") && e.shiftKey) || ((e.key === "y" || e.key === "Y") && !e.shiftKey));
}

/* Where the document's undo does NOT answer Ctrl+Z: a text box of its own
   (the title, a search, a dialog's field, a comment being written) keeps
   the browser's, which is what undoes typing in it. */
function ownsItsUndo(el) {
  if (!el || el === document.body) return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.isContentEditable) {
    var cell = el.closest && el.closest(".cell-editable");
    return !(cell && isScriptCell(cell));
  }
  return false;
}

function onUndoKey(e) {
  if (e.defaultPrevented) return false;
  var redoing = isRedoKey(e);
  if (!redoing && !(isUndoKey(e) && !e.shiftKey)) return false;
  if (ownsItsUndo(document.activeElement)) return false;
  if (reviewMode()) return false;
  e.preventDefault();
  if (redoing) redo(); else undo();
  return true;
}

/* Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y in a comment's composer or
   a reply box: that box's own history (05d-draft-edit.js), never the
   browser's. Its edits are made through the model, which the browser's own
   undo stack never saw, so it must never run there — the key is taken even
   when there is nothing left to undo. Not during an IME composition, whose
   keys are the IME's. */
function onDraftUndoKey(e, box) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
  var redoing = isRedoKey(e);
  if (!redoing && !(isUndoKey(e) && !e.shiftKey)) return false;
  if (!isDraftBox(box)) return false;
  e.preventDefault();
  if (redoing) draftRedo(box); else draftUndo(box);
  return true;
}

/* beforeinput in a comment's composer or a reply box: the browser's own
   undo and redo (a menu's Undo) answered from the box's history; a
   character typed where B/I/U is pending goes in through the model, as in
   a script cell (onFormatBeforeInput); anything else is typing the browser
   is about to do, which the box's history notes (05d-draft-edit.js). */
function onDraftBeforeInput(e) {
  var box = e.target && e.target.closest && e.target.closest(".cell-editable");
  if (!box || !isDraftBox(box)) return;
  if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
    e.preventDefault();
    if (e.inputType === "historyRedo") draftRedo(box); else draftUndo(box);
    return;
  }
  if (e.inputType === "insertText" && !e.isComposing && e.data && typePendingMarks(box, e.data)) {
    e.preventDefault();
    return;
  }
  noteDraftBeforeInput(box, e);
}

function onDraftFocusIn(e) {
  var box = e.target && e.target.closest && e.target.closest(".cell-editable");
  if (box) noteDraftFocus(box);
}

function onDraftComposition(e) {
  var box = e.target && e.target.closest && e.target.closest(".cell-editable");
  if (box) noteDraftComposition(box, e.type === "compositionstart");
}

/* A drop into a comment's composer or a reply box from anywhere else goes
   in the way a paste does (pasteIntoDraft): through the sanitiser, as one
   edit of the draft. Words dragged within the same box are the browser's
   own move, recorded as typing. */
var draftDragSource = null;
function onDraftDragStart(e) {
  var box = e.target && e.target.closest && e.target.closest(".cell-editable");
  draftDragSource = box && isDraftBox(box) ? box : null;
}
function onDraftDragEnd() {
  draftDragSource = null;
}
function onDraftDrop(e) {
  var box = e.target && e.target.closest && e.target.closest(".cell-editable");
  if (!box || !isDraftBox(box) || draftDragSource === box) return;
  var dt = e.dataTransfer;
  var html = dt ? dt.getData("text/html") : "";
  var text = dt ? dt.getData("text/plain") : "";
  if (!html && !text) return;
  e.preventDefault();
  box.focus();
  try {
    var range = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
    if (range && box.contains(range.startContainer)) {
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch (err) {}
  pasteIntoDraft(box, html, text);
}

function onUndoBeforeInput(e) {
  if (e.inputType !== "historyUndo" && e.inputType !== "historyRedo") return;
  var cellEl = e.target && e.target.closest && e.target.closest(".cell-editable");
  if (!cellEl || !isScriptCell(cellEl)) return;
  e.preventDefault();
  if (e.inputType === "historyRedo") redo(); else undo();
}

/* A character typed where B/I/U was pressed with nothing selected goes in
   through the model carrying those marks (typePendingMarks, 05-render.js)
   rather than being typed by the browser — and then gets everything a
   typed character gets (the tag shortcuts, b-roll capture, the counters),
   since the input event the browser would have fired never comes. IME
   composition is left alone: it is the browser's (design §5). */
function onFormatBeforeInput(e) {
  if (e.inputType !== "insertText" || e.isComposing || !e.data) return;
  var cellEl = e.target && e.target.closest && e.target.closest(".cell-editable");
  if (!cellEl || !isScriptCell(cellEl)) return;
  /* the same for a character typed at the edge of a stage direction
     (#167), which is narration, not more of the direction */
  var fresh = typePendingMarks(cellEl, e.data) || typeAtDirectionEdge(cellEl, e.data);
  if (!fresh) return;
  e.preventDefault();
  onRootInput({ target: fresh, inputType: "insertText", data: e.data });
}

/* The bar that shows this cell's formatting: the writer's own, or the
   field's mini toolbar. */
function refreshFormatState(cellEl) {
  if (cellEl.classList.contains("wr-para")) updateWriterFormatState();
  else updateToolbarState(cellEl);
}

var FORMAT_KEYS = { b: "bold", i: "italic", u: "underline" };

/* What an undo or a redo leaves on screen: the document repainted, the
   rows it touched stamped as edited now (they are, and a collaborator's
   merge needs to know), and — when it was one cell's text — the caret back
   in that cell where the change was. */
function afterUndoApplied(steps) {
  var cellStep = null;
  steps.forEach(function (st) {
    if (st.op !== "rowField") return;
    var row = S.state.rows.find(function (r) { return r.id === st.rowId; });
    if (!row) return;
    stampRow(row);
    /* the caret goes to the first cell whose text this changed and that is
       still in the script — for a split undone, the scene it was split from */
    if (!cellStep && (st.key === "visualText" || st.key === "audioText")) cellStep = st;
  });
  markDirty();
  S.undoApplying = true;
  try {
    if (writerOpen) renderWriter(); else render();
    renderProduction();
  } finally {
    S.undoApplying = false;
  }
  settleAfterApply();
  if (cellStep) {
    var sel = '.cell-editable[data-id="' + cssAttr(cellStep.rowId) + '"][data-field="' + cellStep.key + '"]';
    var cell = document.querySelector((writerOpen ? "#writer-doc " : "#rows ") + sel) || document.querySelector(sel);
    if (cell) {
      cell.focus();
      placeCaretAtTextOffset(cell, caretAfterStep(cellStep));
    }
  }
}

function onUndoRefused(reason, dir) {
  showToast("Couldn't " + dir + " — " + (reason || "the document has changed since") + ".", "warn");
}

function onRootInput(e) {
  var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
  if (!cellEl) return;
  /* a comment's composer or a reply box: the browser typed, and the box's
     own history notes it (05d-draft-edit.js) */
  if (!isScriptCell(cellEl)) { noteDraftInput(cellEl); return; }
  maybeAutoTagShortcut(e, cellEl);
  maybeDirectionShortcut(e, cellEl);
  maybeCueShortcut(e, cellEl);
  maybeCaptureBroll(e, cellEl);
  maybeOpenPlainTag(e, cellEl);
  syncFieldFromDom(cellEl);
  afterScriptCellChange(cellEl);
}

/* Everything a change to a script cell's text sets going, whoever made
   it: typing (onRootInput) or a paste, a drop or a cut through the model
   (05c-clipboard.js), which change the cell without an input event. */
function afterScriptCellChange(cellEl) {
  keepCaretInView(cellEl);
  /* Keeps the production count/panel in sync with edits that change which
     tags exist in the script WITHOUT going through the tag composer or the
     typing shortcuts — most notably backspacing an atomic tag away
     entirely (see the .tag-anchor contenteditable="false" note), which is
     exactly the kind of edit that used to leave the panel showing stale
     data if it happened to already be open. Debounced because reading the
     tags back means parsing every field of every row: fine once, but not
     twice per keystroke on a long script. */
  scheduleProductionRefresh();
  /* Deleting a marker, or typing past one, changes what the b-roll list
     says as surely as the tag scan — and for the same reason it is
     debounced: reading the markers back means parsing every visual field
     in the script. */
  scheduleBrollRefresh();
  scheduleWriterStats();
  /* Any script edit can change this, not just an edit to a visual cell:
     typing "[boom pole]" into the audio column puts a new item in the
     registry, and every plain-text "boom pole" already sitting in the
     visual column becomes an untagged mention of it. */
  S.untaggedMutedFor = null;
  scheduleUntaggedScan();
  updateTagGhost(cellEl);
  /* an open "VFX:" tag grows with the typing, and ends if the edit took it
     away (07b-plain-tags.js) */
  refreshPlainTag();
}

function onRootFocusOut(e) {
  /* editCell (05b-cell-edit.js) replacing the focused cell with its
     repaint: the browser reports that as the old element losing focus, but
     nobody left the field — the caret goes straight back into the new one.
     Treating it as a leave anchored a pasted b-roll line under the caret
     and read the old element's words back over the edit. */
  if (S.cellRepainting) return;
  hideTagGhost();
  /* leaving the cell ends an open "VFX:" tag: its keyword back as typed */
  cancelPlainTag();
  hideUntaggedPrompt();
  S.untaggedMutedFor = null;
  var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
  if (!cellEl) return;
  /* A cell losing focus because a repaint from state is replacing it (an
     undo, an edit through the model) holds nothing state does not already
     have — and anything done to it here, a b-roll line anchored say, would
     land in a cell about to leave the page. */
  if (S.undoApplying) return;
  var wrap = cellEl.closest(".field-wrap");
  var related = e.relatedTarget;
  if (wrap && related && wrap.contains(related)) return; /* focus moved within the same field (e.g. the link popover) — defer sanitizing */
  var clean = sanitizeHtml(cellEl.innerHTML);
  /* compared without the src the hydrator gave each <img data-blob> — the
     sanitised form never has one, and repainting the cell for that alone
     would re-decode every picture in it on every blur */
  if (clean !== storedHtmlFromDom(cellEl.innerHTML)) cellEl.innerHTML = clean;
  syncFieldFromDom(cellEl);
  /* Leaving a field is the safe moment to anchor a B-roll marker that got
     into it without being typed — a paste, or the closing character
     arriving as part of one. Only this field, and in place: see
     anchorBrollInLeftCell(). Not while an undo or a redo is being put on
     screen: its repaint replaces the focused cell, Chrome fires focusout
     on it on the way out, and anchoring then would turn the "B-roll:" an
     undo of a typed key just gave back straight into a key again. */
  if (!S.undoApplying) anchorBrollInLeftCell(cellEl);
}

/* A paste or a drop into a script cell, through the model (05c-clipboard.js):
   the clipboard's HTML (else its text) read with fromHtml — a tag copied
   from another scene stays a live tag, anything foreign is sanitised away
   — and put in place of the selection as one undoable edit. A picture, a
   video card, a video link or a video file never goes in the cell (design
   D7): it goes into the scene's gallery, its Image section, in that same
   edit (#135; #124 made a comment of it). Files are read first — a
   picture is made small and hashed, a video file's first frame taken —
   so a paste carrying one goes in a moment later. */
function insertIntoScriptCell(cellEl, html, text, files) {
  if (hasMediaFiles(files)) {
    var rowId = cellEl.getAttribute("data-id");
    var field = cellEl.getAttribute("data-field");
    readClipboardFiles(files, compressImageFile, { frame: videoFirstFrame, grant: grantVideoFile }).then(function (extra) {
      /* the same cell, unless a repaint replaced it meanwhile */
      var live = cellEl.isConnected ? cellEl
        : document.querySelector('#rows .cell-editable[data-id="' + cssAttr(rowId) + '"][data-field="' + field + '"]');
      if (live) insertIntoScriptCellNow(live, html, text, extra);
    });
    return;
  }
  insertIntoScriptCellNow(cellEl, html, text, null);
}

function insertIntoScriptCellNow(cellEl, html, text, extra) {
  var before = lastUndoEntry();
  var res = pasteIntoCell(cellEl, html, text, extra);
  if (!res.done) return;
  var lost = res.lost + (extra ? extra.lost : 0);
  if (lost) showToast((lost === 1 ? "A picture" : lost + " pictures") + " couldn't be added — only a link to it was copied. Save it, then paste or drop the file.", "warn");
  if (res.attached) {
    /* the Image section shows what just went in */
    var attachedRowId = cellEl.getAttribute("data-id");
    renderRow(attachedRowId);
    announceAttached(res, before);
    /* a YouTube or Vimeo link's thumbnail, fetched now and folded into
       this paste's own undo entry when it comes (#141) */
    if (res.attached.links && res.attached.links.length) {
      var entry = lastUndoEntry();
      thumbnailsAfterPaste(attachedRowId, res.attached.links, entry === before ? null : entry);
    }
  }
  if (res.movedComments) {
    /* a cut comment's card follows its words to the new scene */
    syncAnchorResolvedClasses();
    captureReplyDrafts();
    renderComments();
  }
  afterScriptCellChange(res.cellEl);
}

/* Copy and cut inside one script cell go through the model too
   (05c-clipboard.js): a copy never carries a comment; a cut does, to the
   paste in this tab that moves it (design D6). A selection that is not
   inside one script cell is left to the browser. */
/* "Picture added to scene 4", with Undo: the paste's own undo entry —
   the words and what went into the gallery — taken back, so long as it is
   still the last thing done; after anything else, Ctrl+Z is the way back. */
function announceAttached(res, before) {
  var pics = res.attached.pictures, vids = res.attached.videos;
  function n(count, one) { return count === 1 ? one : count + " " + one + "s"; }
  var what = pics && vids ? n(pics, "picture") + " and " + n(vids, "video")
    : pics ? n(pics, "picture") : n(vids, "video");
  var msg = what.charAt(0).toUpperCase() + what.slice(1) + " added to scene " + (res.rowIndex + 1);
  var entry = lastUndoEntry();
  if (!entry || entry === before) { showToast(msg, "ok"); return; }
  showActionToast(msg, "ok", "Undo", function () {
    if (lastUndoEntry() === entry) undo();
    else showToast("Something else has changed since — Ctrl+Z undoes one step at a time.", "warn");
  });
}

function onRootCopy(e) {
  onRootCopyOrCut(e, false);
}
function onRootCut(e) {
  onRootCopyOrCut(e, true);
}
function onRootCopyOrCut(e, cut) {
  var cellEl = e.target.closest && e.target.closest(".cell-editable");
  if (!cellEl || !isScriptCell(cellEl)) return;
  var readOnly = reviewMode();
  if (copyFromCell(e, cellEl, cut, readOnly) && cut && !readOnly) {
    var fresh = document.activeElement && document.activeElement.closest && document.activeElement.closest(".cell-editable");
    afterScriptCellChange(fresh || cellEl);
  }
}

function onRootPaste(e) {
  var cellEl = e.target.closest && e.target.closest(".cell-editable");
  if (!cellEl) return;
  e.preventDefault();
  var cd = e.clipboardData || window.clipboardData;
  if (isScriptCell(cellEl)) {
    /* whole scenes on the clipboard (#204): new scenes after this one */
    if (pasteScenesAt(cd, cellEl)) return;
    /* a review session's script is read-only: nothing to paste into */
    if (reviewMode()) return;
    insertIntoScriptCell(cellEl, cd.getData("text/html"), cd.getData("text/plain"), cd.files);
    return;
  }
  /* A comment's composer or a reply box: not script text, and pictures
     and video cards are welcome there. Prefer the HTML flavor, but only
     once it has been through sanitizeHtml/walkSanitize — the same gate
     every other route into a body's markup goes through — so raw HTML
     pasted in from outside Splitpage (a foreign <script>, inline style,
     etc.) never gets in. One edit of the draft (05d-draft-edit.js), which
     the box's own Ctrl+Z takes back. */
  pasteIntoDraft(cellEl, cd.getData("text/html"), cd.getData("text/plain"));
}

function onRootKeydown(e) {
  if (rowMenuKeydown(e)) return;
  if (e.target.matches && e.target.matches(".link-popover input")) {
    if (e.key === "Enter") { e.preventDefault(); confirmLink(e.target.closest(".field-wrap")); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelLink(e.target.closest(".field-wrap")); }
    return;
  }
  if (e.target.matches && e.target.matches(".video-popover input")) {
    if (e.key === "Enter") { e.preventDefault(); confirmVideo(e.target.closest(".field-wrap")); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelVideo(e.target.closest(".field-wrap")); }
    return;
  }
  var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
  if (!cellEl) return;
  /* A review session's script cells are not editable, but they are still
     .cell-editable and still take focus — that is how a reader selects the
     words to comment on — so every shortcut below would otherwise still
     fire on them. A comment's own composer and a reply's are untouched:
     they are not script cells. */
  if (reviewMode() && isScriptCell(cellEl)) return;
  /* Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y are the document's undo
     and redo (12a-undo.js), never the browser's own contenteditable
     history: every repaint destroyed that, and it only ever knew about the
     one cell. onUndoKey handles it, the same way it does outside a cell. A
     comment's composer or a reply box has a history of its own. */
  if (!isScriptCell(cellEl) && onDraftUndoKey(e, cellEl)) return;
  if (onUndoKey(e)) return;
  /* Tab, in this order (#210, Adam's decision): an open plain-language tag
     ("VFX: lens flare", 07b-plain-tags.js) closes first — you typed its
     keyword, so it is the most explicit thing in flight. Then the ghost,
     which wins outright over the prompt: you typed a bracket, so you asked
     for it. The untagged-mention prompt only ever gets the key when nothing
     more explicit is in flight. Esc cancels an open tag and puts its
     keyword back, and nothing else (not the comments panel behind it);
     Backspace with nothing typed after the keyword does the same and then
     deletes the colon, as it would have. */
  if (plainTagOpen(cellEl)) {
    if (e.key === "Tab") { e.preventDefault(); closePlainTag(); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideTagGhost(); cancelPlainTag(); return; }
    if (e.key === "Backspace" && plainTagEmptyAtCaret()) cancelPlainTag();
  }
  if (e.key === "Tab" && tagGhost && tagGhost.cellEl === cellEl) {
    if (acceptTagGhost()) { e.preventDefault(); return; }
  }
  if (e.key === "Tab" && !tagGhost && untaggedSuggestion && untaggedSuggestion.cellEl === cellEl) {
    if (acceptUntaggedMention()) { e.preventDefault(); return; }
  }
  if (e.key === "Escape" || e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
    hideTagGhost();
  }
  /* Escape puts the prompt away for this cell until you type again or go
     somewhere else — an arrow key is just moving about, and having it
     reappear as you pass each mention is the point. */
  if (e.key === "Escape" && untaggedSuggestion) {
    S.untaggedMutedFor = cellEl;
    hideUntaggedPrompt();
  }
  var mod = e.ctrlKey || e.metaKey;
  /* Alt+Enter: split the field being written in — the split view's version
     of the writer's plain Enter (splitCellField/splitRowFieldCore). Its
     own gesture rather than folding into Ctrl+Enter just below, which
     already means something else here — a fresh, empty scene — and stays
     exactly that. Only the focused column moves; the row's other column
     is untouched, still whole, still on the original row.

     (In the writer this key never reaches here: its own capture-phase
     handler treats every Enter, Alt included, as a split and stops the
     event before it bubbles this far — see onWriterKeydown.) */
  if (e.key === "Enter" && e.altKey && !mod && isScriptCell(cellEl)) {
    e.preventDefault();
    hideTagGhost();
    syncFieldFromDom(cellEl);
    splitCellField(cellEl);
    return;
  }
  /* Alt+Up / Alt+Down: move the scene the caret is in one place earlier
     or later — the keyboard equivalent of dragging its grip, sharing the
     same swap the gutter's own ↑/↓ buttons use (swapAdjacentRows,
     06-rows.js) and syncing exactly the way a drag-reorder does (one
     markDirty(), one queueAutoSave() — see moveRowTo). isScriptCell()
     matches a cell in #rows or in #writer-doc alike and excludes a
     comment reply box, so this never fires there. No wrap: past either
     end swapAdjacentRows() declines and nothing happens.

     The two views finish the repaint differently. renderWriter() already
     re-finds and re-focuses whatever paragraph was active before it ran
     (writerCaretState(), 19-writer.js), which is this same row, so
     nothing further is needed there. The split view's render() only ever
     lands the caret at the end of the cell, not the exact offset it was
     at, so that is corrected explicitly with focusRowField() afterward.
     Calling the full render() from inside the writer instead would reach
     past it into #rows's own copy of this field and steal focus there —
     the same reason splitWriterRow/mergeWriterRows call renderWriter()
     only, never render(), while the writer is open. */
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey && !mod && isScriptCell(cellEl)) {
    e.preventDefault();
    syncFieldFromDom(cellEl);
    var mvId = cellEl.getAttribute("data-id");
    var mvField = cellEl.getAttribute("data-field");
    var mvOffset = caretTextOffset(cellEl);
    if (swapAdjacentRows(mvId, e.key === "ArrowUp" ? -1 : 1)) {
      if (writerOpen) {
        renderWriter();
      } else {
        render();
        focusRowField(mvId, mvField, mvOffset);
      }
      renderProduction();
    }
    return;
  }
  /* Only the script has scenes to add one to. In a comment or reply box
     this cell has no row behind it, and adding one anyway used to splice a
     new scene onto the top of the document and jump focus into it. */
  if (e.key === "Enter" && mod && isScriptCell(cellEl)) {
    e.preventDefault();
    hideTagGhost();
    syncFieldFromDom(cellEl);
    addRowAndFocus(cellEl.getAttribute("data-id"), cellEl.getAttribute("data-field"));
    return;
  }
  /* Enter and Shift+Enter, and Ctrl+B/I/U: edits through the model
     (05-render.js) — of the cell in a script cell, of the draft in a
     comment or reply box. */
  if (e.key === "Enter") {
    e.preventDefault();
    syncFieldFromDom(insertLineBreak(cellEl));
    return;
  }
  var fmtCmd = mod ? FORMAT_KEYS[String(e.key || "").toLowerCase()] : null;
  if (fmtCmd) {
    e.preventDefault();
    refreshFormatState(toggleCellFormat(cellEl, fmtCmd) || cellEl);
  }
}

function onRootDragStart(e) {
  var row = e.target.closest(".row");
  if (!row || !row.getAttribute("draggable")) return;
  S.dragRowId = row.getAttribute("data-id");
  row.classList.add("is-dragging");
  try {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", S.dragRowId); /* Firefox refuses to drag without payload */
  } catch (err) {}
}

function onRootDragEnd() {
  S.dragRowId = null;
  clearDropMarkers();
}

/* A file coming in from the desktop, as opposed to a row being dragged
   within the page. `types` is a DOMStringList in some browsers, so it is
   walked by index rather than with indexOf. */
function isFileDrag(e) {
  var types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  for (var i = 0; i < types.length; i++) if (types[i] === "Files") return true;
  return false;
}

/* The whole visual column of a scene accepts an image file — the small
   paperclip is only the affordance, not the target. Gated on it actually
   being a file drag and on no row being mid-reorder, so dragging a scene
   across another scene's visual column still reorders rather than being
   swallowed here. Returns the .visual-media div, which carries the row id. */
function imageDropTarget(e) {
  if (S.dragRowId || !isFileDrag(e)) return null;
  var cell = e.target.closest(".visual-cell");
  return cell ? cell.querySelector(".visual-media") : null;
}

function onRootDragOver(e) {
  var drop = imageDropTarget(e);
  if (drop) {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
    document.querySelectorAll("#rows .visual-cell.drag-over").forEach(function (c) {
      c.classList.remove("drag-over");
    });
    drop.closest(".visual-cell").classList.add("drag-over");
    return;
  }
  if (S.dragRowId) {
    var row = e.target.closest(".row");
    if (!row || row.getAttribute("data-id") === S.dragRowId) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (err) {}
    setDropMarkerForRow(row, e.clientY);
    return;
  }
  /* Foreign content being dragged in from outside the page (another tab,
     another app) onto a script cell. preventDefault here so 'drop' is
     guaranteed to fire and land in onRootDrop's model path below (the
     sanitiser, then fromHtml) instead of some engine's own native "accept
     the drop" default —
     Chromium's own default for a contenteditable region is to accept it
     and insert raw HTML regardless of what this handler does, which is
     exactly the paste bypass onRootPaste already exists to block. */
  if (e.target.closest && e.target.closest(".cell-editable")) {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
  }
}

function onRootDragLeave(e) {
  /* only clear when the pointer has actually left the column — dragging
     across the text inside it fires dragleave for every child element */
  var cell = e.target.closest && e.target.closest(".visual-cell");
  if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove("drag-over");
}

function onRootDrop(e) {
  var drop = imageDropTarget(e);
  /* Pictures and video files dropped anywhere on the visual column go into
     the scene's gallery (#135) the way a paste's do — added beside the
     pictures there, a video as its link — through the column's cell, so
     it is one undo entry with a toast. Dropped on the words, the words
     that came with them go in too; anywhere else in the column only the
     files count. */
  var dropFiles = e.dataTransfer && e.dataTransfer.files;
  var mediaDrop = drop && hasMediaFiles(dropFiles);
  if (drop) drop.closest(".visual-cell").classList.remove("drag-over");
  if (drop && !mediaDrop) {
    /* some other file: not a picture, and not for the browser to open */
    e.preventDefault();
    if (dropFiles && dropFiles.length) showToast("Only pictures and video files go in a scene's Image section.", "warn");
    return;
  }
  if (mediaDrop && !(e.target.closest && e.target.closest(".cell-editable"))) {
    e.preventDefault();
    if (reviewMode()) return;
    var visualCell = drop.closest(".visual-cell").querySelector(".cell-editable");
    if (visualCell) insertIntoScriptCell(visualCell, "", "", dropFiles);
    return;
  }
  if (S.dragRowId) {
    var row = e.target.closest(".row");
    if (!row) return;
    e.preventDefault();
    var after = row.classList.contains("drop-after");
    var targetId = row.getAttribute("data-id");
    var movingId = S.dragRowId;
    S.dragRowId = null;
    clearDropMarkers();
    moveRowTo(movingId, targetId, after);
    return;
  }
  /* Any other drop onto a script cell is foreign content — a page or app
     outside Splitpage dragging in its own text/HTML, or words dragged from
     another scene. It never gets the browser's own native HTML insertion,
     which passes through neither the sanitiser nor the model: it goes in
     the way a paste does (insertIntoScriptCell), at the drop point. A drag
     carries no cut nonce, so a comment on dragged words stays where it was
     (design D6). */
  var cellEl = e.target.closest && e.target.closest(".cell-editable");
  if (cellEl) {
    e.preventDefault();
    var dt = e.dataTransfer;
    var html = dt ? dt.getData("text/html") : "";
    var text = dt ? dt.getData("text/plain") : "";
    var files = dt ? dt.files : null;
    if (!html && !text && !hasMediaFiles(files)) return;
    if (isScriptCell(cellEl) && reviewMode()) return;
    /* Unlike paste, nothing has focused this cell or put a caret in it —
       the user was dragging, never clicked in. The insertion goes at the
       current selection, so without one first it has nowhere to land. */
    cellEl.focus();
    try {
      var range = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && cellEl.contains(range.startContainer)) {
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (err) {}
    if (isScriptCell(cellEl)) insertIntoScriptCell(cellEl, html, text, files);
  }
}

function init() {
  /* No page-wide styleWithCSS any more: a script cell's formatting is the
     model's (05-render.js), and the one command still wanting CSS mode —
     hiliteColor in a cell the model does not edit — switches it on for
     itself (applyHighlight). */

  /* Fire and forget: the menu items reveal themselves if a server answers,
     and everything below works identically either way. Deliberately not
     awaited — a slow or absent server must never delay the editor opening.

     Except in the one tab that is coming back from a crash with a draft to
     restore. A draft of a SERVER document is merged by resumeServerDoc(),
     which detectServer() leads to and which assigns `state` itself
     (13-hosted.js) — so detecting the server here would race the boot load
     below, and a fast answer with a slow load would let the seed document
     overwrite the resumed one. The draft itself is asked for now, since
     that is only IPC and the answer is wanted as early as possible; the
     detect and the restore both wait for the boot body to finish
     (20g-drafts.js). */
  var draftTaken = null;
  if (S.DESKTOP && draftRestorePending && typeof S.DESKTOP.takeDraft === "function") {
    draftTaken = Promise.resolve().then(function () {
      return S.DESKTOP.takeDraft();
    }).catch(function () { return null; });
  } else {
    detectServer();
  }
  /* Same reasoning as detectServer: fire and forget, and silent when there
     is no launcher to have written the file. */
  loadUpdateStatus();
  var updateDismiss = document.getElementById("update-bar-dismiss");
  if (updateDismiss) updateDismiss.addEventListener("click", dismissUpdateNotice);

  /* Not part of loadUpdateStatus()'s fetch chain on purpose: this must show
     on a plain file:// open and wherever update-status.json 404s, neither
     of which ever calls back into that promise. */
  renderDesktopAppNotice();
  var desktopAppDismiss = document.getElementById("desktop-app-bar-dismiss");
  if (desktopAppDismiss) desktopAppDismiss.addEventListener("click", dismissDesktopAppNotice);
  wireTouchSelection();

  /* On touch the ghost suggestion is a tap target (the Tab key it stands
     in for doesn't exist there). pointerdown, not click: it fires before
     the tap can move the caret out from under the suggestion, and
     preventDefault keeps focus in the cell so the insertion lands where
     the caret already is. */
  var ghostEl = document.getElementById("tag-ghost");
  if (ghostEl) ghostEl.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    acceptTagGhost();
  });
  /* The open "VFX:" tag's note is its Tab key on a phone (Adam, #210): a
     tap closes the tag exactly as Tab does. pointerdown with the default
     prevented, as the ghost above, so the cell keeps the focus and the
     caret the close reads; a click on desktop does the same. */
  var openHintEl = document.getElementById("tag-open-hint");
  if (openHintEl) openHintEl.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    if (plainTagOpen()) closePlainTag();
  });

  /* the OS silently revokes a wake lock when the app is backgrounded;
     take it back when the prompter is still up on return */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && S.prompterOpen) acquireWakeLock();
  });

  S.state = null;
  S.initialStateReady = loadInitialState().then(function (loaded) {
    /* A stash that survived the reload is merged into `loaded`, adopted and
       given its base by applyMerge (03-sync.js), the one writer of
       `baseState` on a merge path (#96). The base is what this page loaded,
       never the merge — and read only once the merge has begun, because
       applyStashedWork gives `loaded` the stash's id first. `report: false`
       keeps the banner below the chips and menus, where it always was, and
       keeps a stash that matched the page from marking it dirty. */
    var applied = applyStashedWork(loaded, null, {
      newBase: function () { return cloneState(loaded); },
      report: false
    });
    if (S.state !== applied.state) {
      /* No stash, or one that belongs to a server document: nothing went
         through applyMerge, so nothing has been adopted yet. */
      S.state = applied.state;
      setBaseState(cloneState(S.state), "boot: the version this page loaded, nothing to merge");
      render();
    }
    updateIdentityChip();
    /* Same reason as syncDocIdentity() below: a fresh load never goes
       through setSaveButtons(), the funnel these two hang off, so the
       File menu's autosave label and the save-state indicator get their
       first values here rather than waiting for the first keystroke. */
    updateAutoSaveMenu();
    updateHideShotMenu();
    updateSaveStatus();

    if (applied.report) {
      reportMerge(applied.report);
    } else if (loaded.lastEditedBy && loaded.lastEditedBy !== getEditorName()) {
      showToast("Opened the latest version — last edited by " + loaded.lastEditedBy, "ok");
    }

    /* Only offer to resume a remembered project into an untouched, never-
       saved copy of the page — rev/lastEditedBy only get set by a real
       Save (see saveDoc()). Double-clicking an already-saved project's own
       .html must always show exactly that file, never get swapped out from
       under you for some *other* file this browser remembers editing. */
    if (!applied.report && !loaded.rev && !loaded.lastEditedBy) {
      /* Desktop restores whole SESSIONS (every window, every tab) in the
         main process at launch (TAB-BOOT-SYNC / DESKTOP-STATE-V2) — this
         page's own launchIntent already says what it's for (blank,
         open-file, restore-draft, open-server), so there is nothing left
         for the renderer's own "resume the last project" guess to do on
         desktop. Only the plain browser build, which has no main process
         to ask, still resumes from its own remembered IndexedDB handle. */
      if (!S.DESKTOP) tryResumeLastProject();
    }
    /* Desktop's window title mirrors the document (20f-desktop.js) —
       push an initial value now rather than waiting for the first edit,
       since a fresh load never touches markDirty()/clearDirty() (the
       hook inside setSaveButtons()) until one of the resume paths above
       runs, or the reader types something. */
    /* For the same reason, the boot document's identity is adopted here:
       nothing on this path goes through setSaveButtons(), the funnel that
       notices identity changes afterwards. Then the browser's duplicate
       check opens its channel and announces this document (desktop has
       the main process's claim table instead, and must not run both). */
    if (typeof syncDocIdentity === "function") syncDocIdentity();
    if (!S.DESKTOP) initDocIdentityChannel();
    if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
    /* Move the old shared snapshot list into "Older history" once. Not
       awaited: it never rejects, the key is removed only after the copy is
       confirmed, and nothing at boot depends on it finishing. */
    startHistoryMigration();
  }).then(function () {
    /* The crash-draft restore is part of "the boot state is ready", not
       something that happens after it: until it settles, the document on
       screen is not the one the user left behind. Arm before detect, and
       detect before restoring, because a server draft is merged from inside
       resumeServerDoc() and the restore has to be able to wait for it. */
    if (!draftTaken) return;
    return draftTaken.then(function (t) {
      armServerDraftResume(t);
      detectServer();
      return applyTakenDraft(t);
    });
  });

  var rowsEl = document.getElementById("rows");
  rowsEl.addEventListener("click", onRootClick);
  rowsEl.addEventListener("mousedown", onRootMouseDown);
  rowsEl.addEventListener("input", onRootInput);
  rowsEl.addEventListener("focusout", onRootFocusOut);
  rowsEl.addEventListener("paste", onRootPaste);
  rowsEl.addEventListener("copy", onRootCopy);
  rowsEl.addEventListener("cut", onRootCut);
  rowsEl.addEventListener("keydown", onRootKeydown);
  /* An open scene menu closes on a press anywhere outside it (#169). */
  document.addEventListener("mousedown", function (e) {
    if (!(e.target.closest && e.target.closest(".row-menu-wrap"))) closeRowMenus();
  }, true);
  configureUndo({ commentsAreSent: onServerDoc, afterApply: afterUndoApplied, onRefused: onUndoRefused });
  /* Ctrl+Z with nothing focused, or a button — after deleting a scene from
     its menu, say — is the document's undo too. A focused script cell
     handles it in onRootKeydown first; a text box of its own keeps its own. */
  window.addEventListener("keydown", function (e) {
    if (e.target && e.target.closest && e.target.closest("#rows, #writer-doc")) return;
    onUndoKey(e);
  });
  /* The browser's own undo arrives as beforeinput too (Edit ▸ Undo, a
     right-click menu, the desktop app's Edit menu): the document's undo
     answers it instead, so there is only ever one history. */
  rowsEl.addEventListener("beforeinput", onUndoBeforeInput);
  rowsEl.addEventListener("beforeinput", onFormatBeforeInput);
  rowsEl.addEventListener("dragstart", onRootDragStart);
  rowsEl.addEventListener("dragend", onRootDragEnd);
  rowsEl.addEventListener("dragover", onRootDragOver);
  rowsEl.addEventListener("dragleave", onRootDragLeave);
  rowsEl.addEventListener("drop", onRootDrop);
  /* a drag that ends outside the list still has to clean up after itself */
  document.addEventListener("mouseup", function () {
    if (!S.dragRowId) clearDropMarkers();
  });
  /* Auto-scroll hot zone, listened for on window rather than #rows: the
     sticky header sits above #rows in the DOM (src/page.html), so a
     pointer resting over the header — squarely inside the top hot zone —
     never reaches a listener scoped to #rows. Gated on dragRowId so an
     image file being dragged in (the other thing dragover sees, handled by
     imageDropTarget above) never moves the page. */
  window.addEventListener("dragover", function (e) {
    if (!S.dragRowId) return;
    /* Over the rundown strip a scene is being aimed at a gap there (#185,
       05f-rundown.js), not carried to the edge: no scrolling. A minimized
       strip takes no drop, so it is the hot zone as before. */
    if (e.target && e.target.closest && e.target.closest("#rundown:not(.is-min)")) { stopDragScroll(); return; }
    updateDragScroll(e.clientX, e.clientY);
  });
  document.querySelector(".add-row-bar").addEventListener("click", onRootClick);
  window.addEventListener("scroll", hideTagGhost, true);
  window.addEventListener("resize", hideTagGhost);
  /* Both are positioned against a client rect, so both go away rather than
     hang in the wrong place. The prompt comes straight back when the caret
     next moves or a key is pressed. */
  window.addEventListener("scroll", hideUntaggedPrompt, true);
  window.addEventListener("resize", hideUntaggedPrompt);
  /* An open "VFX:" tag is still open after a scroll: its note moves with
     the cell rather than going away. */
  window.addEventListener("scroll", refreshPlainTag, true);
  window.addEventListener("resize", refreshPlainTag);

  var suggestEl = document.getElementById("tag-suggest");
  /* mousedown, not click, is where the default has to go: by the time click
     fires the cell has lost the caret this needs */
  suggestEl.addEventListener("mousedown", function (e) { e.preventDefault(); });
  suggestEl.addEventListener("click", function () { acceptUntaggedMention(); });

  document.getElementById("identity-chip").addEventListener("click", promptForName);

  /* The tagging reference no longer opens itself over the script on every
     visit until dismissed (#169, the brief's "the script starts
     immediately"). It is one click away — File ▸ Tagging reference, the
     command menu, Settings, and the tour's step that shows it — and a
     floating card since #205; its close, Esc and dismissal are wired with
     it in 10-comments.js (showTaggingHelp / hideTaggingHelp). */

  /* ---- find & replace ---- */
  document.getElementById("find-close").addEventListener("click", closeFindBar);
  document.getElementById("find-next").addEventListener("click", function () { stepFind(1); });
  document.getElementById("find-prev").addEventListener("click", function () { stepFind(-1); });
  document.getElementById("find-replace").addEventListener("click", replaceCurrent);
  document.getElementById("find-replace-all").addEventListener("click", replaceAll);
  document.getElementById("find-tag").addEventListener("click", toggleBulkTag);
  document.getElementById("find-tag-go").addEventListener("click", runBulkTag);
  document.getElementById("find-tag-cancel").addEventListener("click", function () {
    closeBulkTag();
    document.getElementById("find-tag").focus();
  });
  document.getElementById("find-tag-cats").addEventListener("click", function (e) {
    var btn = e.target.closest(".tag-cat-btn");
    if (btn) pickBulkTagCat(btn.getAttribute("data-tag-cat"));
  });
  document.getElementById("find-case").addEventListener("click", function (e) {
    S.findMatchCase = !S.findMatchCase;
    e.currentTarget.classList.toggle("is-active", S.findMatchCase);
    e.currentTarget.setAttribute("aria-pressed", S.findMatchCase ? "true" : "false");
    findQueryChanged();
  });
  document.getElementById("find-input").addEventListener("input", findQueryChanged);
  document.getElementById("findbar").addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      /* the Tag all row first, then the bar */
      if (bulkTagOpen()) { closeBulkTag(); document.getElementById("find-tag").focus(); return; }
      leaveFindAtMatch();
      return;
    }
    if (e.key !== "Enter") return;
    /* a button in the bar (Tag all's categories, Tag, Cancel) keeps its own Enter */
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();
    if (e.target.id === "replace-input") { replaceCurrent(); return; }
    stepFind(e.shiftKey ? -1 : 1);
  });
  window.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== "f" && e.key !== "F")) return;
    if (!S.state) return;
    /* the find bar edits the split view's cells, which are behind the
       writer — opening it there hands the keystroke to something the
       writer cannot see */
    if (writerOpen) return;
    /* Every modal dialog (.modal-backdrop — Import, Google Doc, Comment,
       file-conflict, Server, Drive, Tag) sits fixed above the find bar,
       which is a plain static-flow element with no z-index of its own.
       Without this check, Ctrl+F while typing inside any of them still
       focused the (now invisible, covered) find-input — every further
       keystroke meant for that modal's own field silently vanished into
       a search box the user couldn't even see. */
    if (document.querySelector(".modal-backdrop:not([hidden])")) return;
    /* the script lives across dozens of separate contenteditables, so the
       browser's own find is close to useless here — take the shortcut */
    e.preventDefault();
    if (findOpen) { document.getElementById("find-input").select(); }
    else openFindBar();
  });

  /* ---- hide shot scenes (issue #25) ----
     Ctrl/Cmd+Alt+H: doesn't collide with Ctrl+F (find), Ctrl+B/I/U
     (formatting), Ctrl/Alt+Enter (split/next scene) or Ctrl+Z (undo
     split) — see 01b-hide-shot.js for the toggle itself. Mirrored as a
     real Electron accelerator on the View menu (desktop/main.js), which
     Electron consumes before it ever reaches this listener there — this
     copy is what makes the shortcut work in the plain browser build. */
  window.addEventListener("keydown", function (e) {
    if (!(e.ctrlKey || e.metaKey) || !e.altKey) return;
    if (e.key !== "h" && e.key !== "H") return;
    if (!S.state) return;
    if (document.querySelector(".modal-backdrop:not([hidden])")) return;
    e.preventDefault();
    toggleHideShotScenes();
  });

  /* ---- "which scene was the caret in" (issue #26) ----
     Feeds the teleprompter's scene mode: opening the prompter (or turning
     scene mode on) cues whichever scene this last pointed at. Covers both
     the split view's cells and the writer's paragraphs — both carry the
     same data-id, so one listener does either. */
  document.addEventListener("focusin", function (e) {
    var cell = e.target.closest && e.target.closest(".cell-editable");
    var id = cell && cell.getAttribute("data-id");
    if (id) S.lastFocusedRowId = id;
  });

  /* ---- reading speed: the script's length, on the rundown or (phone) in
     the header's status line (#207) ---- */
  document.getElementById("runtime-chip").addEventListener("click", promptForWpm);
  var lengthStatus = document.getElementById("length-status");
  if (lengthStatus) lengthStatus.addEventListener("click", promptForWpm);

  document.getElementById("history-close").addEventListener("click", closeHistoryPanel);
  document.getElementById("history-panel").addEventListener("click", onRootClick);

  /* Mousedown, not click, is where the default has to be prevented (issue:
     Production wouldn't open after scrolling past #138's denser header).
     .topbar is `position: sticky`, and while scrolled it sits in its
     condensed, one-row state; a plain contenteditable cell was focused
     when the toolbar button was pressed. Letting the mousedown move focus
     to the button made the browser scroll the (un-stuck, static) header
     back into view to reveal it — snapping the topbar out of .is-condensed
     between the mousedown and the mouseup a real click delivers a few
     pixels apart, so the button was gone from under the pointer by the
     time the up-event landed and no click ever fired. The buttons never
     needed focus for their click handler to run, so simply not taking it
     leaves the header - and the pointer - exactly where they were. */
  document.querySelector(".toolbar").addEventListener("mousedown", function (e) {
    if (e.target.closest(".btn")) e.preventDefault();
  });

  document.getElementById("btn-production").addEventListener("click", function () {
    if (!S.state) { showToast("Still loading...", "warn"); return; }
    var panel = document.getElementById("production-panel");
    if (panel.hidden) openProductionPanel(); else closeProductionPanel();
  });
  document.getElementById("production-close").addEventListener("click", closeProductionPanel);
  wireTagEntityContainer("production-panel");
  /* production-only: bulk selection and its bar, layered on top of the
     shared wiring above rather than folded into it — the gear panel has
     no selection state and nothing here to select. */
  document.getElementById("production-panel").addEventListener("keydown", function (e) {
    if (!e.target.classList) return;
    if (e.target.id === "bulk-person-input") {
      if (e.key === "Enter" && reviewMode()) { e.preventDefault(); reviewBlocked(); renderProduction(); }
      else if (e.key === "Enter") { e.preventDefault(); bulkAddPerson(); }
      else if (e.key === "Escape") { e.preventDefault(); S.tagAddingPersonFor = null; renderProduction(); }
      return;
    }
    /* wireTagEntityContainer's own keydown listener (registered on this
       SAME element) already handles Escape for these two inputs —
       cancelling a per-card rename or add-person popup. Both listeners
       fire for one keydown since neither calls stopPropagation, so
       without this check, Escape here ALSO ran the "clear the bulk
       selection" branch below — silently wiping out an unrelated
       multi-select the user was still building, as a side effect of
       cancelling an unrelated popup. */
    if (e.target.classList.contains("tag-rename-input") || e.target.classList.contains("tag-person-input")) return;
    /* Escape drops the selection — the counterpart to the bar's ×, and the
       reason a plain click is allowed to leave a selection standing */
    if (e.key === "Escape" && selectedKeys().length) {
      e.preventDefault();
      clearProductionSelection();
      renderProduction();
    }
  });
  document.getElementById("production-panel").addEventListener("change", function (e) {
    /* a reviewer has no bulk bar (08-production-panels.js renderBulkBar);
       one forced back into the page is refused here, and redrawn away */
    if (reviewMode()) {
      if (e.target.id === "bulk-owner" || e.target.id === "bulk-status") { reviewBlocked(); renderProduction(); }
      return;
    }
    /* the bulk dropdowns are commands, not fields: "__none__" is the label
       sitting in the closed select ("Assign to…"), never a value to apply */
    if (e.target.id === "bulk-owner") {
      if (e.target.value !== "__none__") bulkSetOwner(e.target.value);
      return;
    }
    if (e.target.id === "bulk-status") {
      if (e.target.value !== "__none__") bulkSetStatus(e.target.value);
    }
  });

  document.getElementById("btn-gear").addEventListener("click", function () {
    if (!S.state) { showToast("Still loading...", "warn"); return; }
    var panel = document.getElementById("gear-panel");
    if (panel.hidden) openGearPanel(); else closeGearPanel();
  });
  document.getElementById("gear-close").addEventListener("click", closeGearPanel);
  wireTagEntityContainer("gear-panel");
  document.getElementById("gear-modes").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-group]");
    if (!btn) return;
    S.gearGroupBy = btn.getAttribute("data-group");
    renderGearList();
  });
  document.getElementById("gear-quickadd-save").addEventListener("click", applyGearQuickAdd);

  wireBrollPanel();

  document.getElementById("server-modal").addEventListener("click", function (e) {
    if (e.target.id === "server-modal") { closeServerPicker(); return; }
    var openBtn = e.target.closest('[data-action="server-open"]');
    if (openBtn) {
      var sid = openBtn.getAttribute("data-id");
      /* Desktop routes through main first — it may already have this
         server document open in another tab (or another window), in
         which case that tab is activated instead of a second copy
         opening here. this-tab means main confirmed this sender tab is
         the right place (pristine and ready), same as opening it always
         has. */
      if (S.DESKTOP) {
        /* Which server is part of which document (#11): the same id on
           another server is another document, and a new tab main makes for
           this one has to boot onto THIS tab's server. The token goes too,
           once, so that tab does not ask for a PIN this one already typed —
           main keeps it in memory for that tab and never writes it down. */
        S.DESKTOP.routeOpen({ kind: "server", serverDocId: sid, serverUrl: conn.serverUrl,
                              token: conn.token, tunnel: conn.tunnel }).then(function (r) {
          if (r && r.where === "this-tab") openServerDoc(sid); else closeServerPicker();
        });
      } else {
        openServerDoc(sid);
      }
      return;
    }
    var delBtn = e.target.closest('[data-action="server-delete"]');
    if (delBtn) { armServerDelete(delBtn, delBtn.getAttribute("data-id")); return; }
  });
  document.getElementById("server-close").addEventListener("click", closeServerPicker);
  document.getElementById("server-cancel").addEventListener("click", closeServerPicker);
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !document.getElementById("server-modal").hidden) closeServerPicker();
  });

  document.getElementById("drive-modal").addEventListener("click", function (e) {
    if (e.target.id === "drive-modal") { closeDriveModal(); return; }
    var t = e.target.closest("[data-action]");
    if (!t) return;
    var act = t.getAttribute("data-action");
    var id = t.getAttribute("data-id");
    if (act === "drive-save-creds") driveSaveCredsFromForm();
    else if (act === "drive-edit-creds") driveShowCredsForm();
    else if (act === "drive-connect") driveConnect(document.getElementById("drive-folder-input").value);
    else if (act === "drive-crumb") driveCrumbTo(Number(t.getAttribute("data-index")));
    else if (act === "drive-open-item") driveOpenItem(id);
    else if (act === "drive-refresh") driveListCurrent();
    else if (act === "drive-newfolder-toggle") toggleDriveNewFolder();
    else if (act === "drive-newfolder-create") driveCreateFolder();
    else if (act === "drive-newfolder-cancel") toggleDriveNewFolder(false);
    else if (act === "drive-upload") document.getElementById("drive-upload-input").click();
    else if (act === "drive-signin") driveSignIn();
    else if (act === "drive-signout") driveSignOut();
    else if (act === "drive-rename") driveStartRename(id);
    else if (act === "drive-rename-save") driveSaveRename(id);
    else if (act === "drive-rename-cancel") driveCancelRename();
    else if (act === "drive-delete") { var it = driveItemById(id); if (it) armDriveDelete(t, it); }
  });
  document.getElementById("drive-close").addEventListener("click", closeDriveModal);
  document.getElementById("drive-done").addEventListener("click", closeDriveModal);
  document.getElementById("drive-folder-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); driveConnect(e.target.value); }
  });
  document.getElementById("drive-newfolder-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); driveCreateFolder(); }
    else if (e.key === "Escape") { e.preventDefault(); toggleDriveNewFolder(false); }
  });
  ["drive-api-key", "drive-client-id"].forEach(function (id) {
    document.getElementById(id).addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); driveSaveCredsFromForm(); }
    });
  });
  document.getElementById("drive-upload-input").addEventListener("change", function (e) {
    driveUploadFiles(e.target.files);
    e.target.value = "";
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !document.getElementById("drive-modal").hidden) closeDriveModal();
  });

  document.getElementById("tag-modal").addEventListener("click", onRootClick);
  document.getElementById("tag-close").addEventListener("click", closeTagComposer);
  document.getElementById("tag-cancel").addEventListener("click", closeTagComposer);
  document.getElementById("tag-apply").addEventListener("click", applyTag);
  document.getElementById("tag-modal").addEventListener("click", function (e) {
    if (e.target.id === "tag-modal") closeTagComposer();
  });
  document.getElementById("tag-name").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); applyTag(); }
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !document.getElementById("tag-modal").hidden) closeTagComposer();
  });

  document.getElementById("resume-continue").addEventListener("click", async function () {
    var handle = pendingResumeHandle;
    if (!handle) { hideResumeBanner(); return; }
    try {
      var perm = await handle.requestPermission({ mode: "readwrite" }); /* the click this needed */
      if (perm !== "granted") { hideResumeBanner(); return; }
      await resumeFromHandle(handle);
    } catch (e) {
      showToast("Could not reopen that file.", "error");
    }
    hideResumeBanner();
  });
  document.getElementById("resume-dismiss").addEventListener("click", hideResumeBanner);

  document.getElementById("save-error-dismiss").addEventListener("click", function () {
    document.getElementById("save-error-banner").hidden = true;
  });
  document.getElementById("save-error-retry").addEventListener("click", function () {
    document.getElementById("save-error-banner").hidden = true;
    saveDoc();
  });
  document.getElementById("save-error-export").addEventListener("click", function () {
    exportAs("md");
  });

  document.getElementById("merge-dismiss").addEventListener("click", function () {
    document.getElementById("merge-banner").hidden = true;
  });
  document.getElementById("merge-undo").addEventListener("click", function (e) { undoMerge(e.currentTarget); });
  document.getElementById("merge-review").addEventListener("click", function () {
    document.getElementById("merge-banner").hidden = true;
    openCommentsPanel();
  });

  document.getElementById("file-conflict-close").addEventListener("click", closeFileConflict);
  document.getElementById("file-conflict-cancel").addEventListener("click", closeFileConflict);
  document.getElementById("file-conflict-reload").addEventListener("click", function () {
    if (fileConflictCtx && fileConflictCtx.kind === "project") reloadProjectFromDisk();
    else reloadFileFromDisk();
  });
  document.getElementById("file-conflict-overwrite").addEventListener("click", function () {
    var ctx = fileConflictCtx;
    closeFileConflict();
    if (ctx && ctx.kind === "project") saveDoc({ force: true });
    else saveBackToFile({ force: true });
  });
  /* The fifth outcome: show what differs first, merge only if the user
     says so (18a-local-merge.js). Nothing else about the modal changes —
     the candidate stays put, so Cancel in the review pane comes back to
     these same four choices. */
  document.getElementById("file-conflict-merge").addEventListener("click", openMergeReview);
  document.getElementById("merge-review-close").addEventListener("click", cancelMergeReview);
  document.getElementById("merge-review-cancel").addEventListener("click", cancelMergeReview);
  document.getElementById("merge-review-confirm").addEventListener("click", confirmFileMerge);
  window.addEventListener("keydown", function (e) {
    /* Esc backs out of the review, never through it: a merge is only ever
       made by pressing the button that says so. */
    if (e.key === "Escape" && !document.getElementById("merge-review-modal").hidden) {
      e.preventDefault();
      cancelMergeReview();
    }
  });

  document.getElementById("file-conflict-copy").addEventListener("click", function () {
    var ctx = fileConflictCtx;
    closeFileConflict();
    if (ctx && ctx.kind === "project") { saveDoc({ saveAs: true }); return; }
    var imported = importHome();
    if (!imported) return;
    var base = imported.name.replace(/\.[^.]+$/, "");
    var ext = (/\.([^.]+)$/.exec(imported.name) || ["", "md"])[1];
    buildFileData(imported.format, base + " (copy)").then(function (built) {
      deliverFile(base + " (copy)." + ext, built.data, { savedMsg: "Saved a separate copy" });
    });
  });

  var commentModalEl = document.getElementById("comment-modal");
  [commentModalEl, document.getElementById("comments-panel")].forEach(function (el) {
    el.addEventListener("click", onRootClick);
    el.addEventListener("mousedown", onRootMouseDown);
    el.addEventListener("input", onRootInput);
    el.addEventListener("focusout", onRootFocusOut);
    el.addEventListener("paste", onRootPaste);
    el.addEventListener("keydown", onRootKeydown);
    /* a draft's own undo history and its drops (05d-draft-edit.js) */
    el.addEventListener("focusin", onDraftFocusIn);
    el.addEventListener("beforeinput", onDraftBeforeInput);
    el.addEventListener("compositionstart", onDraftComposition);
    el.addEventListener("compositionend", onDraftComposition);
    el.addEventListener("dragstart", onDraftDragStart);
    el.addEventListener("dragend", onDraftDragEnd);
    el.addEventListener("drop", onDraftDrop);
  });

  document.getElementById("btn-comments").addEventListener("click", function () {
    if (!S.state) { showToast("Still loading…", "warn"); return; }
    var panel = document.getElementById("comments-panel");
    if (panel.hidden) openCommentsPanel(); else closeCommentsPanel();
  });
  document.getElementById("comments-panel-close").addEventListener("click", closeCommentsPanel);
  initSidePanelResizeHandles();
  document.getElementById("comments-panel").addEventListener("change", function (e) {
    if (e.target.id === "comments-assignee-filter") { setCommentAssigneeFilter(e.target.value); return; }
    if (e.target.classList.contains("comment-assignee-select")) {
      setCommentAssignee(e.target.getAttribute("data-id"), e.target.value);
    }
  });
  var commentsSortSelect = document.getElementById("comments-sort");
  commentsSortSelect.value = S.commentSortMode;
  commentsSortSelect.addEventListener("change", function (e) {
    captureReplyDrafts();
    setCommentSortMode(e.target.value);
  });

  document.getElementById("comment-close").addEventListener("click", function () { closeCommentComposer(true); });
  document.getElementById("comment-cancel").addEventListener("click", function () { closeCommentComposer(true); });
  document.getElementById("comment-post").addEventListener("click", postComment);
  commentModalEl.addEventListener("click", function (e) {
    if (e.target.id === "comment-modal") closeCommentComposer(true);
  });
  document.getElementById("comment-image-input").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    /* The picture goes into the image registry and is stored at once
       (#82): the comment body names it by its sha, and the hydrator gives
       the <img> its src on screen. */
    compressImageFile(file, 700, 0.72).then(function (dataUrl) {
      var rec = internDataUrl(dataUrl);
      if (!rec) throw new Error("not a picture the registry takes");
      persist([rec.sha256]);
      /* on a line of its own at the end, as one edit of the draft that its
         Ctrl+Z takes back (05d-draft-edit.js) */
      appendDraftMedia(document.getElementById("comment-body-editable"), storedImageHtml(rec));
    }).catch(function () { showToast("Could not use that image.", "error"); });
  });
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    /* Ctrl+clicking cards leaves focus on the body, so the panel's own
       keydown never sees Escape — clearing a selection has to be caught at
       the window. It takes precedence over closing the panel: Escape undoes
       the most recent thing you did, and that was selecting. */
    if (selectedKeys().length && !document.getElementById("production-panel").hidden) {
      e.preventDefault();
      clearProductionSelection();
      renderProduction();
      return;
    }
    if (!document.getElementById("comment-modal").hidden) closeCommentComposer(true);
    else if (!document.getElementById("comments-panel").hidden) closeCommentsPanel();
  });

  document.addEventListener("selectionchange", function () {
    /* a B/I/U pressed with nothing selected is for that caret position
       only — first, so the toolbars below no longer show it */
    forgetStalePendingMarks();
    var active = document.activeElement;
    if (active && active.classList && active.classList.contains("cell-editable")) {
      if (active.classList.contains("wr-para")) updateWriterFormatState();
      else updateToolbarState(active);
    }
    /* An open "VFX:" tag follows the caret too, and ends when the caret
       leaves it (07b-plain-tags.js) — first, so the prompt below knows. */
    refreshPlainTag();
    /* Follows the caret without re-scanning: the ranges are already in
       hand, this only picks which one to offer and where to put it. */
    updateUntaggedPrompt();
  });

  document.getElementById("file-input").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (file && S.pendingImageRowId) handleImageFile(S.pendingImageRowId, file, pendingImageSlot);
    e.target.value = "";
    S.pendingImageRowId = null;
    pendingImageSlot = undefined;
  });

  document.getElementById("doc-title").addEventListener("input", function (e) {
    if (!S.state) return;
    S.state.title = e.target.value;
    markDirty();
  });

  /* wrapped, not passed straight through — saveDoc's first argument is its
     options object, and handing it a MouseEvent works only by accident */
  document.getElementById("btn-save").addEventListener("click", function () { saveDoc(); });
  document.getElementById("btn-present").addEventListener("click", function () {
    if (!S.state) { showToast("Still loading…", "warn"); return; }
    openPrompter();
  });

  document.getElementById("btn-file").addEventListener("click", function (e) {
    e.stopPropagation();
    /* detail 0 is a click the keyboard made (Enter or Space on the
       button): the menu then opens on its first item (18b-file-menu.js). */
    toggleFileMenu(undefined, { focusFirst: e.detail === 0 });
  });
  document.getElementById("file-menu").addEventListener("click", function (e) {
    /* An item that opens a submenu (Open recent, Import) has no
       data-file-action, so it never reaches handleFileMenuAction() or the
       other modules' capture-phase listeners on this same element —
       opening one is not a File action. */
    var parent = e.target.closest(".mi-parent");
    if (parent) { toggleSubmenu(parent.getAttribute("data-submenu"), undefined, e.detail === 0); return; }
    var item = e.target.closest("[data-file-action]");
    if (item && !item.disabled) handleFileMenuAction(item.getAttribute("data-file-action"));
  });
  document.getElementById("file-menu-close").addEventListener("click", function (e) {
    e.stopPropagation();
    toggleFileMenu(false);
  });
  /* the backdrop lives inside .menu-wrap, so the outside-click rule below
     never sees it — clicking away is this listener's job */
  document.getElementById("file-menu-backdrop").addEventListener("click", function () {
    toggleFileMenu(false);
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".menu-wrap")) toggleFileMenu(false);
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !document.getElementById("file-menu").hidden) toggleFileMenu(false, { returnFocus: true });
  });
  document.getElementById("open-file-input").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (file) openProjectFile(file, null);
  });

  document.getElementById("md-rows-keep").addEventListener("click", function () {
    finishMarkdownRowChoice("keep");
  });
  document.getElementById("md-rows-table").addEventListener("click", function () {
    finishMarkdownRowChoice("table");
  });
  window.addEventListener("keydown", function (e) {
    /* Esc means "keep Splitpage's record" — the choice that changes
       nothing. Dismissing a question must never silently rebuild the
       script out of a table. */
    if (e.key === "Escape" && !document.getElementById("md-rows-modal").hidden) {
      finishMarkdownRowChoice("keep");
    }
  });

  document.getElementById("import-close").addEventListener("click", closeImportModal);
  document.getElementById("import-cancel").addEventListener("click", closeImportModal);
  document.getElementById("import-confirm").addEventListener("click", confirmImport);
  /* maybeAutoDetectTwoColumn + updateImportPreview together re-scan and
     re-parse the WHOLE textarea (detectTwoColumnFormat runs twice, once
     in each) with no memoization — on a large pasted script, that ran
     in full on every subsequent keystroke, not just the paste itself.
     Debounced so a run of edits (typing, or the flurry of "input"
     events a paste itself can fire) coalesces into one pass after
     things settle, rather than one per keystroke. */
  var importPreviewDebounce = null;
  document.getElementById("import-textarea").addEventListener("input", function (e) {
    var value = e.target.value;
    /* Not debounced: a picked .docx/.csv and typed text are alternative
       sources for one Import button, and the preview must stop offering
       the file the moment the first character lands. */
    if (value) clearPendingFileRows();
    clearTimeout(importPreviewDebounce);
    importPreviewDebounce = setTimeout(function () {
      maybeAutoDetectTwoColumn(value);
      updateImportPreview();
    }, 150);
  });
  document.querySelectorAll('input[name="import-split"]').forEach(function (r) {
    r.addEventListener("change", function () {
      S.importModeTouched = true;
      updateImportPreview();
    });
  });
  document.getElementById("import-choose-file").addEventListener("click", function () {
    document.getElementById("import-file-input").click();
  });
  document.getElementById("import-file-input").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    if (file) handleImportFile(file);
    e.target.value = "";
  });
  document.getElementById("import-modal").addEventListener("click", function (e) {
    if (e.target.id === "import-modal") closeImportModal();
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !document.getElementById("import-modal").hidden) closeImportModal();
  });

  document.getElementById("gdoc-close").addEventListener("click", closeGdocModal);
  document.getElementById("gdoc-cancel").addEventListener("click", closeGdocModal);
  document.getElementById("gdoc-confirm").addEventListener("click", confirmGdocImport);
  document.getElementById("gdoc-url-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") confirmGdocImport();
  });
  document.getElementById("gdoc-modal").addEventListener("click", function (e) {
    if (e.target.id === "gdoc-modal") closeGdocModal();
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !document.getElementById("gdoc-modal").hidden) closeGdocModal();
  });

  document.getElementById("pp-close").addEventListener("click", closePrompter);
  document.getElementById("pp-voice").addEventListener("click", function () {
    if (S.voiceFollowActive) stopVoiceFollow(); else startVoiceFollow();
  });
  document.getElementById("pp-play").addEventListener("click", function () { setPrompterPlaying(!S.prompterPlaying); });
  document.getElementById("pp-speed").addEventListener("input", function (e) { setPrompterSpeed(Number(e.target.value)); });
  document.getElementById("pp-size").addEventListener("input", applyPrompterSize);
  /* Speed and Size are steppers (#169); the range inputs behind them stay
     the values, hidden. */
  document.getElementById("pp-speed-down").addEventListener("click", function () { stepPrompterSpeed(-1); });
  document.getElementById("pp-speed-up").addEventListener("click", function () { stepPrompterSpeed(1); });
  document.getElementById("pp-size-down").addEventListener("click", function () { stepPrompterSize(-1); });
  document.getElementById("pp-size-up").addEventListener("click", function () { stepPrompterSize(1); });
  /* The top bar's scene and times and the foot's running order follow the
     reading position, which is the scroll in every mode. */
  document.getElementById("prompter-scroll").addEventListener("scroll", updatePrompterStatus, { passive: true });
  window.addEventListener("resize", updatePrompterStatus);
  document.getElementById("pp-skip-shot").addEventListener("click", function (e) {
    S.prompterSkipShot = !S.prompterSkipShot;
    e.currentTarget.classList.toggle("is-active", S.prompterSkipShot);
    /* rebuilding resets the read position, so never do it mid-follow */
    stopVoiceFollow();
    setPrompterPlaying(false);
    buildPrompterContent();
    applyPrompterSize();
    document.getElementById("prompter-scroll").scrollTop = 0;
    updateVoiceAvailability();
    /* buildPrompterContent() just reset the scene boundaries along with
       everything else — re-cue from scratch rather than leave scene mode
       pointed at a scene index that may no longer mean the same thing. */
    if (promptSceneMode) cueSceneForCurrentPosition(); else updateSceneReadout();
  });
  document.getElementById("pp-mirror").addEventListener("click", function () {
    setPrompterMirror(!prompterMirror);
  });
  document.getElementById("pp-flip").addEventListener("click", function () {
    setPrompterFlip(!prompterFlip);
  });
  document.getElementById("pp-scene-mode").addEventListener("click", function () {
    setPrompterSceneMode(!promptSceneMode);
  });
  document.getElementById("pp-scene-prev").addEventListener("click", function () { stepScene(-1); });
  document.getElementById("pp-scene-next").addEventListener("click", function () { stepScene(1); });
  document.getElementById("pp-fullscreen").addEventListener("click", function () {
    var el = document.getElementById("prompter");
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
    else if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
  });

  window.addEventListener("keydown", function (e) {
    if (!S.prompterOpen) return;
    if (e.key === "Escape") { closePrompter(); }
    else if (e.key === " ") { e.preventDefault(); setPrompterPlaying(!S.prompterPlaying); }
    else if (e.key === "ArrowUp") { stepPrompterSpeed(1); }
    else if (e.key === "ArrowDown") { stepPrompterSpeed(-1); }
    else if (e.key === "m" || e.key === "M") { setPrompterMirror(!prompterMirror); }
    else if (e.key === "f" || e.key === "F") { setPrompterFlip(!prompterFlip); }
    /* Scene mode's own step keys — ArrowUp/Down already own speed, so
       Left/Right (unused anywhere else in the prompter) step scenes. A
       no-op while scene mode is off, same as every other bar control it
       doesn't apply to yet. */
    else if (e.key === "ArrowLeft") { stepScene(-1); }
    else if (e.key === "ArrowRight") { stepScene(1); }
  });

  /* ---- the writer ---- */

  document.getElementById("btn-write").addEventListener("click", function () {
    if (!S.state) { showToast("Still loading…", "warn"); return; }
    /* The writer is a writing surface end to end — its paragraphs ARE the
       row fields — so a review session does not get one. */
    if (reviewBlocked()) return;
    openWriter();
  });

  var writerDocEl = document.getElementById("writer-doc");
  /* The paragraphs are row fields, so they run on the same handlers the
     split view's cells do — see isScriptCell(). onRootClick is
     deliberately NOT among them: its actions (open the production panel
     on this tag, jump to that scene) all reach for the split view's DOM,
     which is sitting stale behind this one until the writer closes. */
  writerDocEl.addEventListener("input", onRootInput);
  writerDocEl.addEventListener("focusout", onRootFocusOut);
  writerDocEl.addEventListener("paste", onRootPaste);
  writerDocEl.addEventListener("copy", onRootCopy);
  writerDocEl.addEventListener("cut", onRootCut);
  writerDocEl.addEventListener("keydown", onRootKeydown);
  writerDocEl.addEventListener("beforeinput", onUndoBeforeInput);
  writerDocEl.addEventListener("beforeinput", onFormatBeforeInput);
  /* capture, so Enter becomes a new scene before onRootKeydown can make
     it a line break */
  writerDocEl.addEventListener("keydown", onWriterKeydown, true);
  writerDocEl.addEventListener("focusin", function (e) {
    if (e.target.classList && e.target.classList.contains("wr-para")) {
      S.writerLastCell = e.target;
      updateWriterFormatState();
    }
  });
  writerDocEl.addEventListener("click", function (e) {
    var gutter = e.target.closest('[data-action="writer-jump"]');
    if (gutter) { jumpFromWriterToRow(gutter.getAttribute("data-row")); return; }
    var expandShotBtn = e.target.closest('[data-action="expand-hidden-shot"]');
    if (expandShotBtn) expandHiddenShotStrip(expandShotBtn.getAttribute("data-ids"));
  });

  document.getElementById("wr-save").addEventListener("click", function () { saveDoc(); });

  document.getElementById("wr-size").addEventListener("input", function (e) {
    applyWriterSize(parseInt(e.target.value, 10), true);
  });

  document.getElementById("writer-title").addEventListener("input", function (e) {
    if (!S.state) return;
    S.state.title = e.target.value;
    document.getElementById("doc-title").value = e.target.value;
    markDirty();
  });

  document.querySelector(".writer-bar").addEventListener("mousedown", function (e) {
    /* keep the selection the buttons are about to format */
    if (e.target.closest(".wr-fmt")) e.preventDefault();
  });
  document.querySelector(".writer-bar").addEventListener("click", function (e) {
    var fmt = e.target.closest(".wr-fmt");
    if (fmt) { onWriterFormat(fmt); return; }
    if (e.target.closest("#wr-gutter-mode")) { cycleWriterGutter(); return; }
    if (e.target.closest("#wr-export")) { exportNarration("narration-docx"); return; }
  });
  /* Close sits beside Save in the title row now (2026-09-28), not on the
     tools' bar */
  document.getElementById("wr-close").addEventListener("click", function () { closeWriter(); });

  /* The writer covers the whole screen, but Tab does not know that: from
     the last control on its bar, focus walks on into the header and the
     script cells sitting behind the overlay, where you can type into a
     document you cannot see. Pull it back. Modals and the toasts are
     allowed to take focus — they are drawn on top of the writer and are
     meant to. */
  document.addEventListener("focusin", function (e) {
    if (!writerOpen) return;
    var el = e.target;
    if (!el || !el.closest) return;
    if (el.closest("#writer")) return;
    if (el.closest(".modal-backdrop:not([hidden]), .toast")) return;
    var back = document.querySelector("#writer-doc .wr-para") || document.getElementById("wr-close");
    if (back) back.focus();
  });

  window.addEventListener("keydown", function (e) {
    if (!writerOpen || e.key !== "Escape") return;
    /* Escape belongs to the tag suggestion first, if one is showing */
    if (tagGhost) { hideTagGhost(); return; }
    closeWriter();
  });

  /* Another tab still running a build from before per-document history can
     write the old shared key at any time. Migrate what it wrote as soon as
     it lands, rather than leaving it until this page next loads. */
  window.addEventListener("storage", function (e) {
    if (e.key === SNAPSHOT_KEY && e.newValue) startHistoryMigration();
  });

  window.addEventListener("beforeunload", function (e) {
    /* never block the reload that carries a stashed merge home */
    if (S.dirty && !suppressUnloadWarning) { e.preventDefault(); e.returnValue = ""; }
  });

  /* The service worker is for offline http(s) use — splitpage://app is
     already served locally by the main process, with no network round
     trip to cache anything against, and registering one there would just
     be dead weight sitting on a scheme it was never meant for. */
  if (!S.DESKTOP && "serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  /* Desktop glue (20f-desktop.js): wires the native File-menu/header
     commands, file-open events and window-title updates into the exact
     same code paths the in-page UI already uses. A no-op — and every
     DESKTOP-gated branch throughout src/js along with it — whenever this
     page is not running inside the Electron shell. */
  if (S.DESKTOP && typeof initDesktop === "function") initDesktop();
}

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
