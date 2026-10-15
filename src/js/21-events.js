import { S } from "./_state.js";
import { captureOperation, documentTransitions, stillOwns } from "../legacy/transition-bridge.ts";
import { neverWrittenOut } from "../application/recovery/pristine.ts";
import { mountComposition } from "../features/editing/composition.ts";
import { editorBlur, mountEditorFocus } from "../features/editing/focus.ts";
import { conn, importHome } from "./_home.js";
import { suppressUnloadWarning } from "./00-prelude.js";
import { mountMediaRoutes } from "../features/media/routes.ts";
import { mountMergeBanner } from "../features/merge/banner.ts";
import { mountRowRoutes } from "../features/rows/routes.ts";
import { mountUndoRoutes, undoGesture } from "../features/undo/routes.ts";
import { mountVideoPopover } from "../features/video/popover.ts";
import { cycleRowStatus } from "./01-scene-status.js";
import {
  expandHiddenShotStrip,
  revealRow,
  updateHideShotMenu
} from "./01b-hide-shot.js";
import { initDocIdentityChannel, loadInitialState, syncDocIdentity } from "./02b-doc-id.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import {
  SNAPSHOT_KEY,
  cloneState,
  closeHistoryPanel,
  getEditorName,
  installMergeBanner,
  promptForName,
  promptForWpm,
  reportMerge,
  restoreMergeSnapshot,
  restoreSnapshotFromCard,
  updateIdentityChip
} from "./03-sync.js";
import { startHistoryMigration } from "./03a-history-store.js";
import { initSidePanelResizeHandles } from "./03b-side-panels.js";
import { cssAttr, safeId, sanitizeHtml, storedHtmlFromDom, storedImageHtml } from "./04-richtext.js";
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
  paintingScreen,
  render,
  renderFirstDraw,
  renderRow,
  screenIsStale,
  syncFieldFromDom,
  syncPageTitle,
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
  capturePastePlace,
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
  restorePastePlace,
  setDropMarkerForRow,
  showPictureNotAdded,
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
  findQueryChanged,
  leaveFindAtMatch,
  pickBulkTagCat,
  replaceAll,
  replaceCurrent,
  runBulkTag,
  stepFind,
  toggleBulkTag
} from "./09-find-replace.js";
import {
  AUTHOR_NAME_FIELDS,
  armDeleteComment,
  captureReplyDrafts,
  closeCommentComposer,
  closeCommentsPanel,
  jumpToAnchor,
  jumpToComment,
  limitAuthorNameField,
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
import {
  caretAfterStep,
  compositionUndoMark,
  configureUndo,
  dropEmptyStepsSince,
  lastUndoEntry,
  redo,
  settleAfterApply,
  undo
} from "./12a-undo.js";
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
  fileConflictCtx,
  handleFileMenuAction,
  hideResumeBanner,
  openProjectFile,
  pendingResumeHandle,
  reloadFileFromDisk,
  reloadProjectFromDisk,
  resumeFromHandle,
  runExport,
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
  placeCaretAtTextOffset,
  renderWriter,
  scheduleWriterStats,
  updateWriterFormatState,
  writerOpen,
  writerUndoStep
} from "./19-writer.js";
import {
  acquireWakeLock,
  applyPrompterSize,
  buildPrompterContent,
  closePrompter,
  cueSceneForCurrentPosition,
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
import { appActions } from "../legacy/app-actions.ts";
import { editAllowed, liveSession } from "../legacy/session-bridge.ts";

var REVIEW_SAFE_ACTIONS = {
  "toggle-reply": 1, "reply-post": 1, "reply-cancel": 1,
  "link-confirm": 1, "link-cancel": 1, "video-confirm": 1, "video-cancel": 1,
  "jump-tag": 1, "jump-row": 1, "writer-jump": 1,
  "gallery-open": 1, "gallery-open-videos": 1,
  "tag-expand": 1, "bulk-clear": 1,
  "export-breakdown": 1, "export-packing-gear": 1
};

export function toastLastEditor(loaded) {
  if (loaded.lastEditedBy && loaded.lastEditedBy !== getEditorName()) {
    showToast("Opened the latest version — last edited by " + loaded.lastEditedBy, "ok");
  }
}

export function onRootClick(e) {
  if (reviewMode()) {
    var tbReview = e.target.closest(".mini-toolbar button[data-cmd]");
    var actionEl = e.target.closest("[data-action]");
    if (tbReview ? tbReview.getAttribute("data-cmd") !== "comment"
                 : (actionEl && !REVIEW_SAFE_ACTIONS[actionEl.getAttribute("data-action")])) {
      reviewBlocked();
      return;
    }
  }

  if (rowRoutes && rowRoutes.addClick(e)) return;

  var tbBtn = e.target.closest(".mini-toolbar button[data-cmd]");
  if (tbBtn) { handleToolbarCmd(tbBtn); return; }

  var linkConfirm = e.target.closest('[data-action="link-confirm"]');
  if (linkConfirm) { confirmLink(linkConfirm.closest(".field-wrap")); return; }

  var linkCancel = e.target.closest('[data-action="link-cancel"]');
  if (linkCancel) { cancelLink(linkCancel.closest(".field-wrap")); return; }

  if (videoPopover && videoPopover.click(e)) return;

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

  var commentMenuBtn = e.target.closest('[data-action="comment-menu"]');
  if (commentMenuBtn) { toggleCommentMenu(commentMenuBtn.getAttribute("data-id")); return; }
  if (e.target.closest(".comment-menu")) return;

  var jumpTagBtn = e.target.closest('[data-action="jump-tag"]');
  if (jumpTagBtn) {
    jumpToTag(jumpTagBtn.getAttribute("data-row"), jumpTagBtn.getAttribute("data-key"));
    return;
  }

  var jumpCard = e.target.closest(".comment-card.is-jumpable");
  if (jumpCard && !e.target.closest(".reply-composer") && !e.target.closest("a") &&
      window.getSelection().isCollapsed) {
    jumpToAnchor(jumpCard.getAttribute("data-id"));
    return;
  }

  var selCard = (e.ctrlKey || e.metaKey || e.shiftKey)
    ? e.target.closest("#production-list .tag-entity") : null;
  if (selCard && handleSelectionClick(e, selCard)) { e.preventDefault(); return; }

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
    if (S.productionGroupBy !== "cat" && S.productionGroupBy !== "person") clearProductionSelection();
    renderProduction();
    return;
  }

  var breakdownBtn = e.target.closest('[data-action="export-breakdown"]');
  if (breakdownBtn) { exportAs("breakdown"); return; }

  var packingGearBtn = e.target.closest('[data-action="export-packing-gear"]');
  if (packingGearBtn) { runExport("export-packing-gear"); return; }

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

  var statusLamp = e.target.closest("#rows .row .status-btn.is-static");
  if (statusLamp) { cycleRowStatus(statusLamp.closest(".row").getAttribute("data-id")); return; }

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

  if (rowRoutes && rowRoutes.menuClick(e)) return;

  if (mediaRoutes && mediaRoutes.pickerClick(e)) return;

  var tile = e.target.closest('[data-action="gallery-open"], [data-action="gallery-open-videos"]');
  if (tile) {
    openGalleryOverlay(tile.getAttribute("data-id"), Number(tile.getAttribute("data-slot")) || 0,
      tile.getAttribute("data-action") === "gallery-open-videos");
    return;
  }

  if (mediaRoutes && mediaRoutes.linkClick(e)) return;
}

function refocusRowMenu(rowId) {
  closeRowMenus();
  var a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !(a.closest && a.closest(".row-menu"))) return;
  var btn = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"] .row-more');
  if (btn) btn.focus({ preventScroll: true });
}



function onRootMouseDown(e) {
  hideTagGhost();
  var grip = e.target.closest('[data-action="drag-grip"]');
  if (grip) {
    var gripRow = grip.closest(".row");
    if (gripRow) gripRow.setAttribute("draggable", "true");
  }
  if (e.target.closest(".mini-toolbar button")) e.preventDefault();
  var anchor = e.target.closest(".cmt-anchor");
  if (anchor) jumpToComment(anchor.getAttribute("data-cmt"));

  var tagEl = e.target.closest(".tag-anchor");
  if (tagEl) {
    var key = tagKey(tagEl.getAttribute("data-tag-cat"), tagEl.getAttribute("data-tag-name"));
    if (S.productionGroupBy === "scene") S.productionGroupBy = "cat";
    S.tagExpanded = key;
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

function nearestScrollAncestor(el) {
  var node = el.parentElement;
  while (node && node !== document.body) {
    var cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function keepCaretInView(cellEl) {
  var sel = window.getSelection();
  if (!sel.rangeCount) return;
  var rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) rect = cellEl.getBoundingClientRect();
  var margin = 32;
  if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
  var delta = (rect.top + rect.bottom) / 2 - window.innerHeight / 2;
  nearestScrollAncestor(cellEl).scrollBy({ top: delta, behavior: "smooth" });
}

function onDraftUndoKey(e, box) {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
  var dir = undoGesture(e);
  if (!dir) return false;
  if (!isDraftBox(box)) return false;
  e.preventDefault();
  if (dir === "redo") draftRedo(box); else draftUndo(box);
  return true;
}

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

function refreshFormatState(cellEl) {
  if (cellEl.classList.contains("wr-para")) updateWriterFormatState();
  else updateToolbarState(cellEl);
}

var FORMAT_KEYS = { b: "bold", i: "italic", u: "underline" };

var undoRoutes = null;

var mediaRoutes = null;

var mediaRoutePorts = {
  pendingRow: function () { return S.pendingImageRowId; },
  setPendingRow: function (rowId) { S.pendingImageRowId = rowId; },
  choose: function () { document.getElementById("file-input").click(); },
  addPicture: handleImageFile,
  removePicture: removeImage,
  removeLink: removeImageLink,
  openLink: openGalleryLink
};

function mountMedia(fileInput) {
  if (mediaRoutes) mediaRoutes.dispose();
  mediaRoutes = mountMediaRoutes({ window: window, fileInput: fileInput, ports: mediaRoutePorts });
}

var rowRoutes = null;

var rowRoutePorts = {
  dragging: function () { return S.dragRowId; },
  setDragging: function (rowId) { S.dragRowId = rowId; },
  clearMarkers: clearDropMarkers,
  markDrop: setDropMarkerForRow,
  scroll: updateDragScroll,
  stopScroll: stopDragScroll,
  move: moveRowTo,
  add: addRow,
  moveBy: function (rowId, dir) { moveRow(rowId, dir); refocusRowMenu(rowId); },
  toggleMenu: toggleRowMenu,
  armDelete: armDelete
};

function mountRows(rowsEl) {
  if (rowRoutes) rowRoutes.dispose();
  rowRoutes = mountRowRoutes({ window: window, rows: rowsEl, ports: rowRoutePorts });
}

function afterUndoApplied(steps) {
  var cellStep = null;
  steps.forEach(function (st) {
    if (st.op !== "rowField" || !S.state.rows.some(function (r) { return r.id === st.rowId; })) return;
    if (!cellStep && (st.key === "visualText" || st.key === "audioText")) cellStep = st;
  });
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

function onRootInput(e) {
  var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
  if (!cellEl) return;
  if (!isScriptCell(cellEl)) { noteDraftInput(cellEl); return; }
  maybeAutoTagShortcut(e, cellEl);
  maybeDirectionShortcut(e, cellEl);
  maybeCueShortcut(e, cellEl);
  maybeCaptureBroll(e, cellEl);
  maybeOpenPlainTag(e, cellEl);
  syncFieldFromDom(cellEl);
  settleEndedComposition(e);
  afterScriptCellChange(cellEl);
}

function afterScriptCellChange(cellEl) {
  keepCaretInView(cellEl);
  scheduleProductionRefresh();
  scheduleBrollRefresh();
  scheduleWriterStats();
  S.untaggedMutedFor = null;
  scheduleUntaggedScan();
  updateTagGhost(cellEl);
  refreshPlainTag();
}

var composition = null;

function scriptCellOf(target) {
  var cellEl = target && target.closest && target.closest(".cell-editable");
  return cellEl && isScriptCell(cellEl) ? { rowId: cellEl.getAttribute("data-id"), field: cellEl.getAttribute("data-field") } : null;
}

function mountScriptComposition(roots) {
  if (composition) composition.dispose();
  composition = mountComposition({
    roots: roots,
    ports: {
      cellOf: scriptCellOf,
      epoch: function () { return liveSession().epoch(); },
      mark: function (cell) { return compositionUndoMark(cell.rowId, cell.field); },
      dropEmptySince: dropEmptyStepsSince
    }
  });
  return composition;
}

function settleEndedComposition(e) {
  if (composition) composition.settle(e);
}

function takeTitle(input) {
  if (!S.state) return false;
  if (!editAllowed()) {
    input.value = S.state.title || "";
    return false;
  }
  S.state.title = input.value;
  return true;
}

var editorFocusPorts = {
  isScriptCell: isScriptCell,
  blurSuppressed: function () { return !!S.undoApplying || paintingScreen(); },
  leftEditable: function () {
    hideTagGhost();
    cancelPlainTag();
    hideUntaggedPrompt();
    S.untaggedMutedFor = null;
  },
  blurredCell: function (cellEl) {
    var clean = sanitizeHtml(cellEl.innerHTML);
    if (clean !== storedHtmlFromDom(cellEl.innerHTML)) cellEl.innerHTML = clean;
    syncFieldFromDom(cellEl);
    if (!S.undoApplying) anchorBrollInLeftCell(cellEl);
  },
  typeAtMarks: function (cellEl, data) { return typePendingMarks(cellEl, data) || typeAtDirectionEdge(cellEl, data); },
  typed: function (cellEl, data) { onRootInput({ target: cellEl, inputType: "insertText", data: data }); },
  focusedRow: function (rowId) { S.lastFocusedRowId = rowId; },
  focusedParagraph: function (paraEl) {
    S.writerLastCell = paraEl;
    updateWriterFormatState();
  },
  selectionChanged: function (active) {
    forgetStalePendingMarks();
    if (active && active.classList && active.classList.contains("cell-editable")) {
      if (active.classList.contains("wr-para")) updateWriterFormatState();
      else updateToolbarState(active);
    }
    refreshPlainTag();
    updateUntaggedPrompt();
  }
};

var onRootFocusOut = editorBlur(editorFocusPorts);

var editorFocus = null;

function mountFocusAndSelection(rowsEl, writerDocEl) {
  if (editorFocus) editorFocus();
  editorFocus = mountEditorFocus({ rows: rowsEl, writer: writerDocEl, doc: document, ports: editorFocusPorts });
  return editorFocus;
}

function insertIntoScriptCell(cellEl, html, text, files) {
  if (hasMediaFiles(files)) {
    var rowId = cellEl.getAttribute("data-id");
    var field = cellEl.getAttribute("data-field");
    var ctx = captureOperation();
    var began = capturePastePlace(cellEl);
    readClipboardFiles(files, compressImageFile, { frame: videoFirstFrame, grant: grantVideoFile }).then(function (extra) {
      if (!stillOwns(ctx)) { showPictureNotAdded(); return; }
      var live = cellEl.isConnected ? cellEl
        : document.querySelector('#rows .cell-editable[data-id="' + cssAttr(rowId) + '"][data-field="' + field + '"]');
      if (!live) return;
      if (html || text) restorePastePlace(live, began);
      insertIntoScriptCellNow(live, html, text, extra);
    });
    return;
  }
  insertIntoScriptCellNow(cellEl, html, text, null);
}

function insertIntoScriptCellNow(cellEl, html, text, extra) {
  if (screenIsStale()) {
    showToast("Could not paste — press Redraw first.", "error");
    return;
  }
  var before = lastUndoEntry();
  var res = pasteIntoCell(cellEl, html, text, extra);
  if (!res.done) return;
  var lost = res.lost + (extra ? extra.lost : 0);
  if (lost) showToast((lost === 1 ? "A picture" : lost + " pictures") + " couldn't be added — only a link to it was copied. Save it, then paste or drop the file.", "warn");
  if (res.attached) {
    var attachedRowId = cellEl.getAttribute("data-id");
    renderRow(attachedRowId);
    announceAttached(res, before);
    if (res.attached.links && res.attached.links.length) {
      var entry = lastUndoEntry();
      thumbnailsAfterPaste(attachedRowId, res.attached.links, entry === before ? null : entry);
    }
  }
  if (res.movedComments) {
    syncAnchorResolvedClasses();
    captureReplyDrafts();
    renderComments();
  }
  afterScriptCellChange(res.cellEl);
}

function announceAttached(res, before) {
  var pics = res.attached.pictures, vids = res.attached.videos;
  function n(count, one) { return count === 1 ? one : count + " " + one + "s"; }
  var what = pics && vids ? n(pics, "picture") + " and " + n(vids, "video")
    : pics ? n(pics, "picture") : n(vids, "video");
  var msg = what.charAt(0).toUpperCase() + what.slice(1) + " added to scene " + (res.rowIndex + 1);
  var entry = lastUndoEntry();
  if (!entry || entry === before) { showToast(msg, "ok"); return; }
  showActionToast(msg, "ok", "Undo", function () { undoRoutes.undoIfLatest(entry); });
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
    if (pasteScenesAt(cd, cellEl)) return;
    if (reviewMode()) return;
    insertIntoScriptCell(cellEl, cd.getData("text/html"), cd.getData("text/plain"), cd.files);
    return;
  }
  pasteIntoDraft(cellEl, cd.getData("text/html"), cd.getData("text/plain"));
}

var videoPopover = null;

function mountVideo() {
  if (videoPopover) videoPopover.dispose();
  videoPopover = mountVideoPopover({ window: window, ports: { confirm: confirmVideo, cancel: cancelVideo } });
}

function onRootKeydown(e) {
  if (rowMenuKeydown(e)) return;
  if (e.target.matches && e.target.matches(".link-popover input")) {
    if (e.key === "Enter") { e.preventDefault(); confirmLink(e.target.closest(".field-wrap")); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelLink(e.target.closest(".field-wrap")); }
    return;
  }
  if (videoPopover && videoPopover.keydown(e)) return;
  var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
  if (!cellEl) return;
  if (reviewMode() && isScriptCell(cellEl)) return;
  if (!isScriptCell(cellEl) && onDraftUndoKey(e, cellEl)) return;
  if (undoRoutes.key(e)) return;
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
  if (e.key === "Escape" && untaggedSuggestion) {
    S.untaggedMutedFor = cellEl;
    hideUntaggedPrompt();
  }
  var mod = e.ctrlKey || e.metaKey;
  if (e.key === "Enter" && e.altKey && !mod && isScriptCell(cellEl)) {
    e.preventDefault();
    hideTagGhost();
    syncFieldFromDom(cellEl);
    splitCellField(cellEl);
    return;
  }
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
  if (e.key === "Enter" && mod && isScriptCell(cellEl)) {
    e.preventDefault();
    hideTagGhost();
    syncFieldFromDom(cellEl);
    addRowAndFocus(cellEl.getAttribute("data-id"), cellEl.getAttribute("data-field"));
    return;
  }
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

function isFileDrag(e) {
  var types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  for (var i = 0; i < types.length; i++) if (types[i] === "Files") return true;
  return false;
}

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
  if (rowRoutes && rowRoutes.dragOver(e)) return;
  if (e.target.closest && e.target.closest(".cell-editable")) {
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "copy"; } catch (err) {}
  }
}

function onRootDragLeave(e) {
  var cell = e.target.closest && e.target.closest(".visual-cell");
  if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove("drag-over");
}

function onRootDrop(e) {
  var drop = imageDropTarget(e);
  var dropFiles = e.dataTransfer && e.dataTransfer.files;
  var mediaDrop = drop && hasMediaFiles(dropFiles);
  if (drop) drop.closest(".visual-cell").classList.remove("drag-over");
  if (drop && !mediaDrop) {
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
  if (rowRoutes && rowRoutes.drop(e)) return;
  var cellEl = e.target.closest && e.target.closest(".cell-editable");
  if (cellEl) {
    e.preventDefault();
    var dt = e.dataTransfer;
    var html = dt ? dt.getData("text/html") : "";
    var text = dt ? dt.getData("text/plain") : "";
    var files = dt ? dt.files : null;
    if (!html && !text && !hasMediaFiles(files)) return;
    if (isScriptCell(cellEl) && reviewMode()) return;
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

  var draftTaken = null;
  if (S.DESKTOP && draftRestorePending && typeof S.DESKTOP.takeDraft === "function") {
    draftTaken = Promise.resolve().then(function () {
      return S.DESKTOP.takeDraft();
    }).catch(function () { return null; });
  } else {
    detectServer();
  }
  loadUpdateStatus();
  var updateDismiss = document.getElementById("update-bar-dismiss");
  if (updateDismiss) updateDismiss.addEventListener("click", dismissUpdateNotice);

  renderDesktopAppNotice();
  var desktopAppDismiss = document.getElementById("desktop-app-bar-dismiss");
  if (desktopAppDismiss) desktopAppDismiss.addEventListener("click", dismissDesktopAppNotice);
  wireTouchSelection();

  var ghostEl = document.getElementById("tag-ghost");
  if (ghostEl) ghostEl.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    acceptTagGhost();
  });
  var openHintEl = document.getElementById("tag-open-hint");
  if (openHintEl) openHintEl.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    if (plainTagOpen()) closePlainTag();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && S.prompterOpen) acquireWakeLock();
  });

  S.state = null;
  S.initialStateReady = loadInitialState().then(function (loaded) {
    var applied = applyStashedWork(loaded, null, {
      recovery: true,
      newBase: function () { return cloneState(loaded); },
      report: false
    });
    if (S.state !== applied.state) {
      documentTransitions().open({ from: { document: applied.state }, reason: "boot: the version this page loaded, nothing to merge" });
      renderFirstDraw();
    }
    updateIdentityChip();
    updateAutoSaveMenu();
    updateHideShotMenu();
    updateSaveStatus();

    if (applied.report) {
      reportMerge(applied.report, { kind: "recovery" });
    } else {
      toastLastEditor(loaded);
    }

    if (!applied.report && neverWrittenOut(loaded)) {
      if (!S.DESKTOP) tryResumeLastProject();
    }
    if (typeof syncDocIdentity === "function") syncDocIdentity();
    if (!S.DESKTOP) initDocIdentityChannel();
    if (S.DESKTOP && typeof notifyDesktopDocumentState === "function") notifyDesktopDocumentState();
    startHistoryMigration();
  }).then(function () {
    if (!draftTaken) return;
    return draftTaken.then(function (t) {
      armServerDraftResume(t);
      detectServer();
      return applyTakenDraft(t);
    });
  });

  document.addEventListener("input", function (e) {
    if (e.isComposing) return;
    if (e.target && e.target.matches && e.target.matches(AUTHOR_NAME_FIELDS)) limitAuthorNameField(e.target);
  });
  document.addEventListener("compositionend", function (e) {
    if (e.target && e.target.matches && e.target.matches(AUTHOR_NAME_FIELDS)) limitAuthorNameField(e.target);
  });

  mountVideo();
  var rowsEl = document.getElementById("rows");
  rowsEl.addEventListener("click", onRootClick);
  rowsEl.addEventListener("mousedown", onRootMouseDown);
  rowsEl.addEventListener("input", onRootInput);
  rowsEl.addEventListener("paste", onRootPaste);
  rowsEl.addEventListener("copy", onRootCopy);
  rowsEl.addEventListener("cut", onRootCut);
  rowsEl.addEventListener("keydown", onRootKeydown);
  document.addEventListener("mousedown", function (e) {
    if (!(e.target.closest && e.target.closest(".row-menu-wrap"))) closeRowMenus();
  }, true);
  mountRows(rowsEl);
  rowsEl.addEventListener("dragover", onRootDragOver);
  rowsEl.addEventListener("dragleave", onRootDragLeave);
  rowsEl.addEventListener("drop", onRootDrop);
  document.querySelector(".add-row-bar").addEventListener("click", onRootClick);
  window.addEventListener("scroll", hideTagGhost, true);
  window.addEventListener("resize", hideTagGhost);
  window.addEventListener("scroll", hideUntaggedPrompt, true);
  window.addEventListener("resize", hideUntaggedPrompt);
  window.addEventListener("scroll", refreshPlainTag, true);
  window.addEventListener("resize", refreshPlainTag);

  var suggestEl = document.getElementById("tag-suggest");
  suggestEl.addEventListener("mousedown", function (e) { e.preventDefault(); });
  suggestEl.addEventListener("click", function () { acceptUntaggedMention(); });

  document.getElementById("identity-chip").addEventListener("click", promptForName);

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
      if (bulkTagOpen()) { closeBulkTag(); document.getElementById("find-tag").focus(); return; }
      leaveFindAtMatch();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.target.tagName === "BUTTON") return;
    e.preventDefault();
    if (e.target.id === "replace-input") { replaceCurrent(); return; }
    stepFind(e.shiftKey ? -1 : 1);
  });

  document.getElementById("runtime-chip").addEventListener("click", promptForWpm);
  var lengthStatus = document.getElementById("length-status");
  if (lengthStatus) lengthStatus.addEventListener("click", promptForWpm);

  document.getElementById("history-close").addEventListener("click", closeHistoryPanel);
  document.getElementById("history-panel").addEventListener("click", onRootClick);

  document.querySelector(".toolbar").addEventListener("mousedown", function (e) {
    if (e.target.closest(".btn")) e.preventDefault();
  });

  document.getElementById("btn-production").addEventListener("click", function () { runFromButton("panel-production"); });
  document.getElementById("production-close").addEventListener("click", closeProductionPanel);
  wireTagEntityContainer("production-panel");
  document.getElementById("production-panel").addEventListener("keydown", function (e) {
    if (!e.target.classList) return;
    if (e.target.id === "bulk-person-input") {
      if (e.key === "Enter" && reviewMode()) { e.preventDefault(); reviewBlocked(); renderProduction(); }
      else if (e.key === "Enter") { e.preventDefault(); bulkAddPerson(); }
      else if (e.key === "Escape") { e.preventDefault(); S.tagAddingPersonFor = null; renderProduction(); }
      return;
    }
    if (e.target.classList.contains("tag-rename-input") || e.target.classList.contains("tag-person-input")) return;
    if (e.key === "Escape" && selectedKeys().length) {
      e.preventDefault();
      clearProductionSelection();
      renderProduction();
    }
  });
  document.getElementById("production-panel").addEventListener("change", function (e) {
    if (reviewMode()) {
      if (e.target.id === "bulk-owner" || e.target.id === "bulk-status") { reviewBlocked(); renderProduction(); }
      return;
    }
    if (e.target.id === "bulk-owner") {
      if (e.target.value !== "__none__") bulkSetOwner(e.target.value);
      return;
    }
    if (e.target.id === "bulk-status") {
      if (e.target.value !== "__none__") bulkSetStatus(e.target.value);
    }
  });

  document.getElementById("btn-gear").addEventListener("click", function () { runFromButton("panel-gear"); });
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
      if (S.DESKTOP) {
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
      var perm = await handle.requestPermission({ mode: "readwrite" });
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

  mountMergeBanner({
    window: window,
    ports: {
      lastUndo: function () { return S.lastMergeUndo; },
      sameDocument: function (docId) { return !!S.state && docId === S.state.docId; },
      restore: restoreMergeSnapshot,
      warn: function (message) { showToast(message, "warn"); },
      openComments: openCommentsPanel,
      rowElement: function (rowId) { return document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") + '"]'); },
      logError: function (e) { if (window.console) console.error(e); },
      install: installMergeBanner
    }
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
  document.getElementById("file-conflict-merge").addEventListener("click", openMergeReview);
  document.getElementById("merge-review-close").addEventListener("click", cancelMergeReview);
  document.getElementById("merge-review-cancel").addEventListener("click", cancelMergeReview);
  document.getElementById("merge-review-confirm").addEventListener("click", confirmFileMerge);
  window.addEventListener("keydown", function (e) {
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
    el.addEventListener("focusin", onDraftFocusIn);
    el.addEventListener("beforeinput", onDraftBeforeInput);
    el.addEventListener("compositionstart", onDraftComposition);
    el.addEventListener("compositionend", onDraftComposition);
    el.addEventListener("dragstart", onDraftDragStart);
    el.addEventListener("dragend", onDraftDragEnd);
    el.addEventListener("drop", onDraftDrop);
  });

  document.getElementById("btn-comments").addEventListener("click", function () { runFromButton("panel-comments"); });
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
    compressImageFile(file, 700, 0.72).then(function (dataUrl) {
      var rec = internDataUrl(dataUrl);
      if (!rec) throw new Error("not a picture the registry takes");
      persist([rec.sha256]);
      appendDraftMedia(document.getElementById("comment-body-editable"), storedImageHtml(rec));
    }).catch(function () { showToast("Could not use that image.", "error"); });
  });
  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (selectedKeys().length && !document.getElementById("production-panel").hidden) {
      e.preventDefault();
      clearProductionSelection();
      renderProduction();
      return;
    }
    if (!document.getElementById("comment-modal").hidden) closeCommentComposer(true);
    else if (!document.getElementById("comments-panel").hidden) closeCommentsPanel();
  });

  mountMedia(document.getElementById("file-input"));

  document.getElementById("doc-title").addEventListener("input", function (e) {
    if (!takeTitle(e.target)) return;
    syncPageTitle();
    markDirty();
  });

  document.getElementById("btn-save").addEventListener("click", saveFromButton);
  document.getElementById("btn-save").addEventListener("mouseenter", updateSaveStatus);
  document.getElementById("btn-save").addEventListener("focus", updateSaveStatus);
  document.getElementById("wr-save-status").addEventListener("mouseenter", updateSaveStatus);
  document.getElementById("btn-present").addEventListener("click", function () { runFromButton("present"); });

  document.getElementById("btn-file").addEventListener("click", function (e) {
    e.stopPropagation();
    toggleFileMenu(undefined, { focusFirst: e.detail === 0 });
  });
  document.getElementById("file-menu").addEventListener("click", function (e) {
    var parent = e.target.closest(".mi-parent");
    if (parent) { toggleSubmenu(parent.getAttribute("data-submenu"), undefined, e.detail === 0); return; }
    var item = e.target.closest("[data-file-action]");
    if (item && !item.disabled) handleFileMenuAction(item.getAttribute("data-file-action"));
  });
  document.getElementById("file-menu-close").addEventListener("click", function (e) {
    e.stopPropagation();
    toggleFileMenu(false);
  });
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
    if (e.key === "Escape" && !document.getElementById("md-rows-modal").hidden) {
      finishMarkdownRowChoice("keep");
    }
  });

  document.getElementById("import-close").addEventListener("click", closeImportModal);
  document.getElementById("import-cancel").addEventListener("click", closeImportModal);
  document.getElementById("import-confirm").addEventListener("click", confirmImport);
  var importPreviewDebounce = null;
  document.getElementById("import-textarea").addEventListener("input", function (e) {
    var value = e.target.value;
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
  document.getElementById("pp-speed-down").addEventListener("click", function () { stepPrompterSpeed(-1); });
  document.getElementById("pp-speed-up").addEventListener("click", function () { stepPrompterSpeed(1); });
  document.getElementById("pp-size-down").addEventListener("click", function () { stepPrompterSize(-1); });
  document.getElementById("pp-size-up").addEventListener("click", function () { stepPrompterSize(1); });
  document.getElementById("prompter-scroll").addEventListener("scroll", updatePrompterStatus, { passive: true });
  window.addEventListener("resize", updatePrompterStatus);
  document.getElementById("pp-skip-shot").addEventListener("click", function (e) {
    S.prompterSkipShot = !S.prompterSkipShot;
    e.currentTarget.classList.toggle("is-active", S.prompterSkipShot);
    stopVoiceFollow();
    setPrompterPlaying(false);
    buildPrompterContent();
    applyPrompterSize();
    document.getElementById("prompter-scroll").scrollTop = 0;
    updateVoiceAvailability();
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
    var target = e.target;
    if (target && target.closest && !target.closest("#rows") && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    var chord = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === "Escape") { closePrompter(); }
    else if (e.key === " ") { if (!chord) { e.preventDefault(); setPrompterPlaying(!S.prompterPlaying); } }
    else if (e.key === "ArrowUp") { if (!chord) e.preventDefault(); stepPrompterSpeed(1); }
    else if (e.key === "ArrowDown") { if (!chord) e.preventDefault(); stepPrompterSpeed(-1); }
    else if (!chord && (e.key === "m" || e.key === "M")) { e.preventDefault(); setPrompterMirror(!prompterMirror); }
    else if (!chord && (e.key === "f" || e.key === "F")) { e.preventDefault(); setPrompterFlip(!prompterFlip); }
    else if (e.key === "ArrowLeft") { if (!chord) e.preventDefault(); stepScene(-1); }
    else if (e.key === "ArrowRight") { if (!chord) e.preventDefault(); stepScene(1); }
  });

  document.getElementById("btn-write").addEventListener("click", function () { runFromButton("write"); });

  var writerDocEl = document.getElementById("writer-doc");
  undoRoutes = mountUndoRoutes({
    window: window,
    roots: [rowsEl, writerDocEl],
    ports: {
      replay: function (dir) { if (dir === "redo") redo(); else undo(); },
      writerStep: writerUndoStep,
      stale: screenIsStale,
      reviewOnly: reviewMode,
      scriptCell: isScriptCell,
      latest: lastUndoEntry,
      warn: function (message) { showToast(message, "warn"); },
      commentsAreSent: onServerDoc,
      afterReplay: afterUndoApplied,
      install: configureUndo
    }
  });
  writerDocEl.addEventListener("input", onRootInput);
  writerDocEl.addEventListener("paste", onRootPaste);
  writerDocEl.addEventListener("copy", onRootCopy);
  writerDocEl.addEventListener("cut", onRootCut);
  writerDocEl.addEventListener("keydown", onRootKeydown);
  mountFocusAndSelection(rowsEl, writerDocEl);
  mountScriptComposition([rowsEl, writerDocEl]);
  writerDocEl.addEventListener("keydown", onWriterKeydown, true);
  writerDocEl.addEventListener("click", function (e) {
    var gutter = e.target.closest('[data-action="writer-jump"]');
    if (gutter) { jumpFromWriterToRow(gutter.getAttribute("data-row")); return; }
    var expandShotBtn = e.target.closest('[data-action="expand-hidden-shot"]');
    if (expandShotBtn) expandHiddenShotStrip(expandShotBtn.getAttribute("data-ids"));
  });

  document.getElementById("wr-save").addEventListener("click", saveFromButton);

  document.getElementById("wr-size").addEventListener("input", function (e) {
    applyWriterSize(parseInt(e.target.value, 10), true);
  });

  document.getElementById("writer-title").addEventListener("input", function (e) {
    if (!takeTitle(e.target)) return;
    document.getElementById("doc-title").value = e.target.value;
    markDirty();
  });

  document.querySelector(".writer-bar").addEventListener("mousedown", function (e) {
    if (e.target.closest(".wr-fmt")) e.preventDefault();
  });
  document.querySelector(".writer-bar").addEventListener("click", function (e) {
    var fmt = e.target.closest(".wr-fmt");
    if (fmt) { onWriterFormat(fmt); return; }
    if (e.target.closest("#wr-gutter-mode")) { cycleWriterGutter(); return; }
    if (e.target.closest("#wr-export")) { runExport("export-narration-docx"); return; }
  });
  document.getElementById("wr-close").addEventListener("click", function () { closeWriter(); });

  document.addEventListener("focusin", function (e) {
    if (!writerOpen || paintingScreen()) return;
    var el = e.target;
    if (!el || !el.closest) return;
    if (el.closest("#writer")) return;
    if (el.closest(".modal-backdrop:not([hidden]), .toast")) return;
    var back = document.querySelector("#writer-doc .wr-para") || document.getElementById("wr-close");
    if (back) back.focus();
  });

  window.addEventListener("keydown", function (e) {
    if (!writerOpen || e.key !== "Escape") return;
    if (tagGhost) { hideTagGhost(); return; }
    closeWriter();
  });

  window.addEventListener("storage", function (e) {
    if (e.key === SNAPSHOT_KEY && e.newValue) startHistoryMigration();
  });

  window.addEventListener("beforeunload", function (e) {
    if (S.dirty && !suppressUnloadWarning) { e.preventDefault(); e.returnValue = ""; }
  });

  if (!S.DESKTOP && "serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  if (S.DESKTOP && typeof initDesktop === "function") initDesktop();
}

function runFromButton(id) {
  appActions.invoke(id, "button");
}

function saveFromButton() { runFromButton("save"); }

export function __init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}
