import { mountNotices } from "../features/notices/mount.ts";
import { mountPrompterVisibility, mountPrompterOpen, mountPrompter } from "../features/prompter/mount.ts";
import { mountIdentity, mountServer, mountDrive } from "../features/settings/mount.ts";
import { mountHistory } from "../features/history/mount.ts";
import { mountSaveRecovery, mountConflicts, mountSave, mountFileMenu } from "../features/file-menu/mount.ts";
import { mountImports, mountGdoc } from "../features/imports/mount.ts";
import { mountWriterOpen, mountWriterNavigation, mountWriterClose } from "../features/writer/mount.ts";
import { mountHistoryGallery } from "../features/gallery/mount.ts";
import { mountTags } from "../features/tags/mount.ts";
import { createReviewClickGate } from "../features/review/click-gate.ts";
import { mountComposition } from "../features/editing/composition.ts";
import { editorBlur, mountEditorFocus } from "../features/editing/focus.ts";
import { mountEditorToolbar } from "../features/editing/toolbar.ts";
import { mountClipboardRoutes } from "../features/clipboard/routes.ts";
import { mountMediaRoutes } from "../features/media/routes.ts";
import { mountMergeBanner } from "../features/merge/banner.ts";
import { mountRowsEditor } from "../features/rows/editor.ts";
import { mountRowRoutes } from "../features/rows/routes.ts";
import { mountTitleRoutes } from "../features/title/routes.ts";
import { mountUndoRoutes, undoGesture } from "../features/undo/routes.ts";
import { mountVideoPopover } from "../features/video/popover.ts";
import { mountWriterRoutes } from "../features/writer/routes.ts";
import { S } from "./_state.js";
import { captureOperation, documentTransitions, stillOwns } from "../legacy/transition-bridge.ts";
import { beginStartup } from "../bootstrap/startup.ts";
import { whenDocumentReady } from "../bootstrap/startup/dom-ready.ts";
import { conn, importHome } from "./_home.js";
import { suppressUnloadWarning } from "./00-prelude.js";
import { cycleRowStatus } from "./01-scene-status.js";
import {
  expandHiddenShotStrip,
  revealRow,
  updateHideShotMenu
} from "./01b-hide-shot.js";
import { initDocIdentityChannel, loadInitialDocument, syncDocIdentity } from "./02b-doc-id.js";
import { internDataUrl, persist } from "./02c-blobs.js";
import {
  SNAPSHOT_KEY,
  cloneState,
  closeHistoryPanel,
  installMergeBanner,
  promptForName,
  promptForWpm,
  reportMerge,
  restoreMergeSnapshot,
  restoreSnapshotFromCard,
  toastLastEditor,
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
  setTagOwner,
  setTagNotes
} from "./08-production-panels.js";
import {
  anchorBrollInLeftCell,
  maybeCaptureBroll,
  scheduleBrollRefresh
} from "./08c-broll.js";
import { mountBrollFeature } from "./08d-broll-panel.js";
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
  captureImportPreview,
  closeGdocModal,
  closeImportModal,
  confirmGdocImport,
  confirmImport,
  handleImportFile,
  maybeAutoDetectTwoColumn,
  updateImportPreview
} from "./11-import.js";
import { showActionToast, showToast, updateSaveStatus } from "./12-dirty-toast.js";
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
  captureServerPicker,
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
import { applyStashedWork, queueAutoSave, saveDoc, updateAutoSaveMenu } from "./14-export.js";
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
  disposePrompterView,
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
  desktopDraftTaker
} from "./20g-drafts.js";
import { appActions } from "../legacy/app-actions.ts";
import { liveSession, runCommand } from "../legacy/session-bridge.ts";

var viewMounts = new Map();

function replaceViewMount(key, mount) {
  var previous = viewMounts.get(key);
  if (previous) previous.dispose();
  var owner = mount();
  viewMounts.set(key, owner);
  return owner;
}

function captureViewDocument() {
  var context = captureOperation();
  return function () { return stillOwns(context); };
}

export function mountNoticesFeature() {
  return replaceViewMount("mountNotices", function () {
    return mountNotices({ window: window, ports: {
      loadUpdateStatus: loadUpdateStatus,
      dismissUpdateNotice: dismissUpdateNotice,
      renderDesktopAppNotice: renderDesktopAppNotice,
      dismissDesktopAppNotice: dismissDesktopAppNotice
    } });
  });
}

export function mountPrompterVisibilityFeature() {
  return replaceViewMount("mountPrompterVisibility", function () {
    return mountPrompterVisibility({ window: window, ports: {
      acquireWakeLock: function (active) {
        var ownsDocument = captureViewDocument();
        acquireWakeLock(function () { return active() && ownsDocument(); });
      },
      isOpen: function () { return S.prompterOpen; }
    } });
  });
}

export function mountIdentityFeature() {
  return replaceViewMount("mountIdentity", function () {
    return mountIdentity({ window: window, ports: {
      promptForName: promptForName
    } });
  });
}

export function mountHistoryFeature() {
  return replaceViewMount("mountHistory", function () {
    return mountHistory({ window: window, ports: {
      promptForWpm: promptForWpm,
      closeHistoryPanel: closeHistoryPanel,
      onRootClick: onRootClick
    } });
  });
}

export function mountServerFeature() {
  return replaceViewMount("mountServer", function () {
    return mountServer({ window: window, ports: {
      closeServerPicker: closeServerPicker,
      openServerDoc: openServerDoc,
      armServerDelete: armServerDelete,
      routeOpen: function (id) { return S.DESKTOP ? S.DESKTOP.routeOpen({ kind: "server", serverDocId: id, serverUrl: conn.serverUrl, token: conn.token, tunnel: conn.tunnel }).then(function (result) { return !!result && result.where === "this-tab"; }) : null; },
      capture: function () {
        var ownsDocument = captureViewDocument();
        var ownsModal = captureServerPicker();
        return function () { return ownsDocument() && ownsModal(); };
      }
    } });
  });
}

export function mountDriveFeature() {
  return replaceViewMount("mountDrive", function () {
    return mountDrive({ window: window, ports: {
      closeDriveModal: closeDriveModal,
      driveSaveCredsFromForm: driveSaveCredsFromForm,
      driveShowCredsForm: driveShowCredsForm,
      driveConnect: driveConnect,
      driveCrumbTo: driveCrumbTo,
      driveOpenItem: driveOpenItem,
      driveListCurrent: driveListCurrent,
      toggleDriveNewFolder: toggleDriveNewFolder,
      driveCreateFolder: driveCreateFolder,
      driveSignIn: driveSignIn,
      driveSignOut: driveSignOut,
      driveStartRename: driveStartRename,
      driveSaveRename: driveSaveRename,
      driveCancelRename: driveCancelRename,
      driveItemById: driveItemById,
      armDriveDelete: armDriveDelete,
      driveUploadFiles: driveUploadFiles
    } });
  });
}

export function mountSaveRecoveryFeature() {
  return replaceViewMount("mountSaveRecovery", function () {
    return mountSaveRecovery({ window: window, ports: {
      hideResumeBanner: hideResumeBanner,
      resumeFromHandle: resumeFromHandle,
      showToast: showToast,
      saveDoc: saveDoc,
      exportAs: exportAs,
      pendingHandle: function () { return pendingResumeHandle; },
      capture: captureViewDocument
    } });
  });
}

export function mountConflictsFeature() {
  return replaceViewMount("mountConflicts", function () {
    return mountConflicts({ window: window, ports: {
      closeFileConflict: closeFileConflict,
      reloadProjectFromDisk: reloadProjectFromDisk,
      reloadFileFromDisk: reloadFileFromDisk,
      saveDoc: saveDoc,
      saveBackToFile: saveBackToFile,
      openMergeReview: openMergeReview,
      cancelMergeReview: cancelMergeReview,
      confirmFileMerge: confirmFileMerge,
      importHome: importHome,
      buildFileData: buildFileData,
      deliverFile: deliverFile,
      conflict: function () { return fileConflictCtx; },
      capture: captureViewDocument
    } });
  });
}

export function mountPanelsFeature() {
  return replaceViewMount("mountPanels", function () {
    return { dispose: initSidePanelResizeHandles() };
  });
}

export function mountSaveFeature() {
  return replaceViewMount("mountSave", function () {
    return mountSave({ window: window, ports: {
      saveFromButton: saveFromButton,
      updateSaveStatus: updateSaveStatus
    } });
  });
}

export function mountPrompterOpenFeature() {
  return replaceViewMount("mountPrompterOpen", function () {
    return mountPrompterOpen({ window: window, ports: {
      runFromButton: runFromButton
    } });
  });
}

export function mountFileMenuFeature() {
  return replaceViewMount("mountFileMenu", function () {
    return mountFileMenu({ window: window, ports: {
      toggleFileMenu: toggleFileMenu,
      toggleSubmenu: toggleSubmenu,
      handleFileMenuAction: handleFileMenuAction,
      openProjectFile: openProjectFile
    } });
  });
}

export function mountImportsFeature() {
  return replaceViewMount("mountImports", function () {
    return mountImports({ window: window, ports: {
      finishMarkdownRowChoice: finishMarkdownRowChoice,
      closeImportModal: closeImportModal,
      confirmImport: confirmImport,
      clearPendingFileRows: clearPendingFileRows,
      maybeAutoDetectTwoColumn: maybeAutoDetectTwoColumn,
      updateImportPreview: updateImportPreview,
      handleImportFile: handleImportFile,
      touchMode: function () { S.importModeTouched = true; },
      capture: function () {
        var ownsDocument = captureViewDocument();
        var ownsModal = captureImportPreview();
        return function () { return ownsDocument() && ownsModal(); };
      }
    } });
  });
}

export function mountGdocFeature() {
  return replaceViewMount("mountGdoc", function () {
    return mountGdoc({ window: window, ports: {
      closeGdocModal: closeGdocModal,
      confirmGdocImport: confirmGdocImport
    } });
  });
}

export function mountPrompterFeature() {
  return replaceViewMount("mountPrompter", function () {
    return mountPrompter({ window: window, ports: {
      disposeRuntime: disposePrompterView,
      closePrompter: closePrompter,
      stopVoiceFollow: stopVoiceFollow,
      startVoiceFollow: startVoiceFollow,
      setPrompterPlaying: setPrompterPlaying,
      setPrompterSpeed: setPrompterSpeed,
      applyPrompterSize: applyPrompterSize,
      stepPrompterSpeed: stepPrompterSpeed,
      stepPrompterSize: stepPrompterSize,
      updatePrompterStatus: updatePrompterStatus,
      buildPrompterContent: buildPrompterContent,
      updateVoiceAvailability: updateVoiceAvailability,
      cueSceneForCurrentPosition: cueSceneForCurrentPosition,
      updateSceneReadout: updateSceneReadout,
      setPrompterMirror: setPrompterMirror,
      setPrompterFlip: setPrompterFlip,
      setPrompterSceneMode: setPrompterSceneMode,
      stepScene: stepScene,
      voiceActive: function () { return S.voiceFollowActive; },
      playing: function () { return S.prompterPlaying; },
      isOpen: function () { return S.prompterOpen; },
      skipShot: function () { return S.prompterSkipShot; },
      setSkipShot: function (value) { S.prompterSkipShot = value; },
      mirror: function () { return prompterMirror; },
      flip: function () { return prompterFlip; },
      sceneMode: function () { return promptSceneMode; }
    } });
  });
}

export function mountWriterOpenFeature() {
  return replaceViewMount("mountWriterOpen", function () {
    return mountWriterOpen({ window: window, ports: {
      runFromButton: runFromButton
    } });
  });
}

export function mountWriterNavigationFeature() {
  return replaceViewMount("mountWriterNavigation", function () {
    return mountWriterNavigation({ window: window, ports: {
      jumpFromWriterToRow: jumpFromWriterToRow,
      expandHiddenShotStrip: expandHiddenShotStrip,
      saveFromButton: saveFromButton,
      applyWriterSize: applyWriterSize
    } });
  });
}

export function mountWriterCloseFeature() {
  return replaceViewMount("mountWriterClose", function () {
    return mountWriterClose({ window: window, ports: {
      closeWriter: closeWriter
    } });
  });
}

var historyGallery = null;

export function mountHistoryGalleryFeature() {
  historyGallery = replaceViewMount("mountHistoryGallery", function () {
    return mountHistoryGallery({ restore: restoreSnapshotFromCard, open: openGalleryOverlay });
  });
  return historyGallery;
}

var tags = null;

export function mountTagsFeature() {
  if (tags) tags.dispose();
  tags = mountTags({
    window: window,
    ports: {
      acceptTagGhost: acceptTagGhost,
      acceptUntaggedMention: acceptUntaggedMention,
      applyTag: applyTag,
      armBulkDelete: armBulkDelete,
      clearProductionSelection: clearProductionSelection,
      closeTagComposer: closeTagComposer,
      disarmBulkDelete: disarmBulkDelete,
      hideTagGhost: hideTagGhost,
      hideUntaggedPrompt: hideUntaggedPrompt,
      renderProduction: renderProduction,
      bulkDeleteSelected: bulkDeleteSelected,
      bulkAddPerson: bulkAddPerson,
      closeGearPanel: closeGearPanel,
      closeProductionPanel: closeProductionPanel,
      openProductionPanel: openProductionPanel,
      renderGearList: renderGearList,
      applyGearQuickAdd: applyGearQuickAdd,
      closePlainTag: closePlainTag,
      refreshPlainTag: refreshPlainTag,
      reviewBlocked: reviewBlocked,
      queueAutoSave: queueAutoSave,
      selectedKeys: selectedKeys,
      plainTagOpen: plainTagOpen,
      reviewMode: reviewMode,
      addPersonForTag: addPersonForTag,
      saveTagRename: saveTagRename,
      tagAllMentions: tagAllMentions,
      renderTagCategories: renderTagCategories,
      armPersonDelete: armPersonDelete,
      armRemoveTag: armRemoveTag,
      armDeleteTag: armDeleteTag,
      setTagStatus: setTagStatus,
      bulkSetOwner: bulkSetOwner,
      bulkSetStatus: bulkSetStatus,
      handleSelectionClick: handleSelectionClick,
      jumpToTag: jumpToTag,
      toggleCardSelection: toggleCardSelection,
      tagKey: tagKey,
      cssAttr: cssAttr,
      exportAs: exportAs,
      runExport: runExport,
      rootClick: onRootClick,
      runFromButton: runFromButton,
      setTagOwner: setTagOwner,
      setTagNotes: setTagNotes,
      bulkDeleteArmed: function () { return bulkDeleteArmed; },
      isTouch: function () { return IS_TOUCH; },
      addingPerson: function () { return S.tagAddingPersonFor; },
      expanded: function () { return S.tagExpanded; },
      productionGroup: function () { return S.productionGroupBy; },
      setAddingPerson: function (value) { S.tagAddingPersonFor = value; },
      setRenaming: function (value) { S.tagRenaming = value; },
      setExpanded: function (value) { S.tagExpanded = value; },
      setProductionGroup: function (value) { S.productionGroupBy = value; },
      setGearGroup: function (value) { S.gearGroupBy = value; },
      capture: function () { var context = captureOperation(); return function () { return stillOwns(context); }; },
      installEntity: wireTagEntityContainer
    }
  });
  return tags;
}

var reviewClickGate = createReviewClickGate({
  reviewMode: function () { return reviewMode(); },
  refuse: function () { reviewBlocked(); }
});

export function onRootClick(e) {
  if (reviewClickGate(e.target)) return;

  if (rowRoutes && rowRoutes.addClick(e)) return;

  if (editorToolbar && editorToolbar.click(e)) return;

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

  if (tags && tags.jumpClick(e)) return;

  var jumpCard = e.target.closest(".comment-card.is-jumpable");
  if (jumpCard && !e.target.closest(".reply-composer") && !e.target.closest("a") &&
      window.getSelection().isCollapsed) {
    jumpToAnchor(jumpCard.getAttribute("data-id"));
    return;
  }

  if (tags && tags.click(e)) return;

  if (historyGallery && historyGallery.restoreClick(e)) return;

  if (rowRoutes && rowRoutes.sceneClick(e)) return;

  if (rowRoutes && rowRoutes.menuClick(e)) return;

  if (mediaRoutes && mediaRoutes.pickerClick(e)) return;

  if (historyGallery && historyGallery.galleryClick(e)) return;

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

  if (tags) tags.anchorMouseDown(e);
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

var editorToolbar = null;

var editorToolbarPorts = {
  command: handleToolbarCmd,
  confirmLink: confirmLink,
  cancelLink: cancelLink,
  format: function (cellEl, cmd) { refreshFormatState(toggleCellFormat(cellEl, cmd) || cellEl); }
};

function mountToolbar() {
  if (editorToolbar) editorToolbar.dispose();
  editorToolbar = mountEditorToolbar({ window: window, ports: editorToolbarPorts });
}

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
  armDelete: armDelete,
  cycleStatus: cycleRowStatus,
  expandHidden: expandHiddenShotStrip,
  reveal: revealRow,
  gone: function () { showToast("That scene is no longer here.", "warn"); }
};

function mountRows(rowsEl) {
  if (rowRoutes) rowRoutes.dispose();
  rowRoutes = mountRowRoutes({ window: window, rows: rowsEl, ports: rowRoutePorts });
}

var rowsEditor = null;

var rowsEditorPorts = {
  click: onRootClick,
  mousedown: onRootMouseDown,
  input: onRootInput,
  keydown: onRootKeydown,
  rowDragging: function () { return !!S.dragRowId; },
  rowDragOver: function (e) { return !!rowRoutes && rowRoutes.dragOver(e); },
  rowDrop: function (e) { return !!rowRoutes && rowRoutes.drop(e); },
  scriptCell: isScriptCell,
  reviewOnly: reviewMode,
  hasMedia: hasMediaFiles,
  insert: insertIntoScriptCell,
  notMedia: function () { showToast("Only pictures and video files go in a scene's Image section.", "warn"); }
};

function mountRowsEditing(rowsEl) {
  if (rowsEditor) rowsEditor.dispose();
  rowsEditor = mountRowsEditor({ window: window, rows: rowsEl, addBar: document.querySelector(".add-row-bar"), ports: rowsEditorPorts });
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

var titleRoutes = null;

function mountTitles() {
  if (titleRoutes) titleRoutes.dispose();
  titleRoutes = mountTitleRoutes({
    main: document.getElementById("doc-title"),
    writer: document.getElementById("writer-title"),
    ports: {
      run: runCommand,
      current: function () { return S.state ? S.state.title || "" : null; },
      pageTitle: syncPageTitle
    }
  });
}

var writerRoutes = null;

var writerRoutePorts = {
  input: onRootInput,
  keydown: onRootKeydown,
  editKeydown: onWriterKeydown,
  format: onWriterFormat,
  gutter: cycleWriterGutter,
  exportNarration: function () { runExport("export-narration-docx"); }
};

function mountWriter(writerDocEl) {
  if (writerRoutes) writerRoutes.dispose();
  writerRoutes = mountWriterRoutes({ window: window, doc: writerDocEl, bar: document.querySelector(".writer-bar"), ports: writerRoutePorts });
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

var clipboardRoutes = null;

var clipboardRoutePorts = {
  scriptCell: isScriptCell,
  reviewOnly: reviewMode,
  copy: copyFromCell,
  afterCut: afterScriptCellChange,
  pasteScenes: pasteScenesAt,
  pasteDraft: pasteIntoDraft,
  hasMedia: hasMediaFiles,
  readMedia: function (files) {
    return readClipboardFiles(files, compressImageFile, { frame: videoFirstFrame, grant: grantVideoFile });
  },
  capture: captureOperation,
  stillOwns: stillOwns,
  notAdded: showPictureNotAdded,
  placeOf: capturePastePlace,
  restorePlace: restorePastePlace,
  findCell: function (rowId, field) {
    return document.querySelector('#rows .cell-editable[data-id="' + cssAttr(rowId) + '"][data-field="' + field + '"]');
  },
  insertNow: function (cellEl, html, text, extra) { insertIntoScriptCellNow(cellEl, html, text, extra); }
};

function mountClipboard(rowsEl, writerDocEl) {
  if (clipboardRoutes) clipboardRoutes.dispose();
  clipboardRoutes = mountClipboardRoutes({ window: window, roots: [rowsEl, writerDocEl], ports: clipboardRoutePorts });
  return clipboardRoutes;
}

function insertIntoScriptCell(cellEl, html, text, files) {
  clipboardRoutes.insert(cellEl, html, text, files);
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

function onRootPaste(e) {
  clipboardRoutes.paste(e);
}

var videoPopover = null;

function mountVideo() {
  if (videoPopover) videoPopover.dispose();
  videoPopover = mountVideoPopover({ window: window, ports: { confirm: confirmVideo, cancel: cancelVideo } });
}

function onRootKeydown(e) {
  if (rowMenuKeydown(e)) return;
  if (editorToolbar && editorToolbar.keydown(e)) return;
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
  if (editorToolbar) editorToolbar.formatKey(e, cellEl);
}

var startup = null;

function startupPorts() {
  return {
    desktop: !!S.DESKTOP,
    draft: {
      taker: desktopDraftTaker(),
      detectServer: detectServer,
      armServerResume: armServerDraftResume,
      applyDraft: applyTakenDraft
    },
    document: {
      load: function () { return loadInitialDocument(); },
      clone: cloneState,
      applyStash: function (loaded, options) { return applyStashedWork(loaded, null, options); },
      liveDocument: function () { return S.state; },
      open: function (doc, reason) { documentTransitions().open({ from: { document: doc }, reason: reason }); },
      firstDraw: renderFirstDraw,
      refreshChrome: [updateIdentityChip, updateAutoSaveMenu, updateHideShotMenu, updateSaveStatus],
      reportRecovery: function (report) { reportMerge(report, { kind: "recovery" }); },
      toastLastEditor: toastLastEditor,
      resumeLastProject: tryResumeLastProject,
      syncIdentity: syncDocIdentity,
      openIdentityChannel: function () { initDocIdentityChannel(); },
      notifyDesktop: notifyDesktopDocumentState,
      startHistoryMigration: startHistoryMigration
    },
    page: {
      window: window,
      snapshotKey: SNAPSHOT_KEY,
      unsaved: function () { return !!S.dirty && !suppressUnloadWarning; }
    },
    startDesktop: initDesktop
  };
}

function init() {
  startup = beginStartup(startupPorts());
  mountNoticesFeature();
  mountTagsFeature();

  mountPrompterVisibilityFeature();

  S.initialStateReady = startup.openDocument();

  document.addEventListener("input", function (e) {
    if (e.isComposing) return;
    if (e.target && e.target.matches && e.target.matches(AUTHOR_NAME_FIELDS)) limitAuthorNameField(e.target);
  });
  document.addEventListener("compositionend", function (e) {
    if (e.target && e.target.matches && e.target.matches(AUTHOR_NAME_FIELDS)) limitAuthorNameField(e.target);
  });

  mountVideo();
  mountToolbar();
  var rowsEl = document.getElementById("rows");
  document.addEventListener("mousedown", function (e) {
    if (!(e.target.closest && e.target.closest(".row-menu-wrap"))) closeRowMenus();
  }, true);
  mountRows(rowsEl);
  mountRowsEditing(rowsEl);
  mountIdentityFeature();

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

  mountHistoryGalleryFeature();
  mountHistoryFeature();

  document.querySelector(".toolbar").addEventListener("mousedown", function (e) {
    if (e.target.closest(".btn")) e.preventDefault();
  });

  mountBrollFeature();

  mountServerFeature();

  mountDriveFeature();

  mountSaveRecoveryFeature();

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

  mountConflictsFeature();

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
  mountPanelsFeature();
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

  mountTitles();

  mountSaveFeature();
  mountPrompterOpenFeature();

  mountFileMenuFeature();

  mountImportsFeature();

  mountGdocFeature();

  mountPrompterFeature();

  mountWriterOpenFeature();

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
  mountClipboard(rowsEl, writerDocEl);
  mountFocusAndSelection(rowsEl, writerDocEl);
  mountScriptComposition([rowsEl, writerDocEl]);
  mountWriter(writerDocEl);
  mountWriterNavigationFeature();

  document.querySelector(".writer-bar").addEventListener("mousedown", function (e) {
    if (e.target.closest(".wr-fmt")) e.preventDefault();
  });
  mountWriterCloseFeature();

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

  startup.finish();
}

function runFromButton(id) {
  appActions.invoke(id, "button");
}

function saveFromButton() { runFromButton("save"); }

export function __init() {
  whenDocumentReady(document, init);
}
