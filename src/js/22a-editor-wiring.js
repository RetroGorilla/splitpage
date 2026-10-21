import { owned } from "../features/routing/owned.ts";
import { ROOT_CLICK_ORDER, ROOT_MOUSEDOWN_ORDER, createRootRouter } from "../features/routing/root-router.ts";
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
import { captureOperation, stillOwns } from "../legacy/transition-bridge.ts";
import { focusMemory, installPicturePicker, mergeUndo, rowDrag, undoGuard } from "../legacy/editor-bridge.ts";
import { cycleRowStatus } from "./01-scene-status.js";
import { expandHiddenShotStrip, revealRow } from "./01b-hide-shot.js";
import { installMergeBanner, restoreMergeSnapshot } from "./03-sync.js";
import { cssAttr, safeId, sanitizeHtml, storedHtmlFromDom } from "./04-richtext.js";
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
import { thumbnailsAfterPaste } from "./05v-video.js";
import {
  draftRedo,
  draftUndo,
  isDraftBox,
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
  hideTagGhost,
  hideUntaggedPrompt,
  maybeAutoTagShortcut,
  scheduleProductionRefresh,
  scheduleUntaggedScan,
  tagGhost,
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
import { renderProduction } from "./08-production-panels.js";
import { anchorBrollInLeftCell, maybeCaptureBroll, scheduleBrollRefresh } from "./08c-broll.js";
import {
  captureReplyDrafts,
  jumpToComment,
  openCommentsPanel,
  renderComments,
  syncAnchorResolvedClasses
} from "./10-comments.js";
import { showActionToast, showToast } from "./12-dirty-toast.js";
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
import { onServerDoc, reviewBlocked, reviewMode } from "./13-hosted.js";
import { runExport } from "./18-local-files.js";
import {
  caretTextOffset,
  cycleWriterGutter,
  onWriterFormat,
  onWriterKeydown,
  placeCaretAtTextOffset,
  renderWriter,
  scheduleWriterStats,
  updateWriterFormatState,
  writerOpen,
  writerUndoStep
} from "./19-writer.js";
import { liveSession, runCommand } from "../legacy/session-bridge.ts";

var reviewClickGate = createReviewClickGate({
  reviewMode: function () { return reviewMode(); },
  refuse: function () { reviewBlocked(); }
});

var rootClicks = createRootRouter(ROOT_CLICK_ORDER, function (e) { return reviewClickGate(e.target); });

var rootMouseDowns = createRootRouter(ROOT_MOUSEDOWN_ORDER);

export function onRootClick(e) {
  rootClicks.handle(e);
}

export function routeRootClick(slot, handler) {
  return rootClicks.route(slot, handler);
}

export function routeRootMouseDown(slot, handler) {
  return rootMouseDowns.route(slot, handler);
}

export function rootRoutesTaken() {
  return { click: rootClicks.routed(), mousedown: rootMouseDowns.routed() };
}

function refocusRowMenu(rowId) {
  closeRowMenus();
  var a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !(a.closest && a.closest(".row-menu"))) return;
  var btn = document.querySelector('#rows .row[data-id="' + cssAttr(rowId) + '"] .row-more');
  if (btn) btn.focus({ preventScroll: true });
}

export function onRootMouseDown(e) {
  hideTagGhost();
  var grip = e.target.closest('[data-action="drag-grip"]');
  if (grip) {
    var gripRow = grip.closest(".row");
    if (gripRow) gripRow.setAttribute("draggable", "true");
  }
  if (e.target.closest(".mini-toolbar button")) e.preventDefault();
  var anchor = e.target.closest(".cmt-anchor");
  if (anchor) jumpToComment(anchor.getAttribute("data-cmt"));

  rootMouseDowns.handle(e);
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

function refreshFormatState(cellEl) {
  if (cellEl.classList.contains("wr-para")) updateWriterFormatState();
  else updateToolbarState(cellEl);
}

var editorToolbar = owned();

var editorToolbarPorts = {
  command: handleToolbarCmd,
  confirmLink: confirmLink,
  cancelLink: cancelLink,
  format: function (cellEl, cmd) { refreshFormatState(toggleCellFormat(cellEl, cmd) || cellEl); }
};

export function mountToolbarFeature() {
  return editorToolbar.replace(function () {
    return mountEditorToolbar({ window: window, ports: editorToolbarPorts });
  }, function (owner) {
    return [function () { return routeRootClick("toolbar", function (e) { return owner.click(e); }); }];
  });
}

export var stopToolbarFeature = editorToolbar.stop;

function editorRoots() {
  return [document.getElementById("rows"), document.getElementById("writer-doc")];
}

var undoRoutes = owned();

export function mountUndoFeature() {
  return undoRoutes.replace(function () {
    return mountUndoRoutes({
      window: window,
      roots: editorRoots(),
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
  });
}

export var stopUndoFeature = undoRoutes.stop;

var mergeBanner = owned();

export function mountMergeBannerFeature() {
  return mergeBanner.replace(function () {
    return mountMergeBanner({
      window: window,
      ports: {
        lastUndo: function () { return mergeUndo().last(); },
        sameDocument: function (docId) { return !!S.state && docId === S.state.docId; },
        restore: restoreMergeSnapshot,
        warn: function (message) { showToast(message, "warn"); },
        openComments: openCommentsPanel,
        rowElement: function (rowId) { return document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") + '"]'); },
        logError: function (e) { if (window.console) console.error(e); },
        install: installMergeBanner
      }
    });
  });
}

export var stopMergeBannerFeature = mergeBanner.stop;

var mediaRoutes = owned();

var mediaRoutePorts = {
  choose: function () { document.getElementById("file-input").click(); },
  addPicture: handleImageFile,
  removePicture: removeImage,
  removeLink: removeImageLink,
  openLink: openGalleryLink
};

export function mountMediaFeature() {
  return mediaRoutes.replace(function () {
    return mountMediaRoutes({ window: window, fileInput: document.getElementById("file-input"), ports: mediaRoutePorts });
  }, function (owner) {
    return [
      function () { return routeRootClick("media-picker", function (e) { return owner.pickerClick(e); }); },
      function () { return routeRootClick("media-link", function (e) { return owner.linkClick(e); }); },
      function () { return installPicturePicker(function (rowId) { owner.pick(rowId); }); }
    ];
  });
}

export var stopMediaFeature = mediaRoutes.stop;

var rowRoutes = owned();

var rowRoutePorts = {
  dragging: function () { return rowDrag().dragging(); },
  setDragging: function (rowId) { if (rowId) rowDrag().start(rowId); else rowDrag().end(); },
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

export function mountRowsFeature() {
  return rowRoutes.replace(function () {
    return mountRowRoutes({ window: window, rows: document.getElementById("rows"), ports: rowRoutePorts });
  }, function (owner) {
    return [
      function () { return routeRootClick("rows-add", function (e) { return owner.addClick(e); }); },
      function () { return routeRootClick("rows-scene", function (e) { return owner.sceneClick(e); }); },
      function () { return routeRootClick("rows-menu", function (e) { return owner.menuClick(e); }); }
    ];
  });
}

export var stopRowsFeature = rowRoutes.stop;

var rowsEditor = owned();

var rowsEditorPorts = {
  click: onRootClick,
  mousedown: onRootMouseDown,
  input: onRootInput,
  keydown: onRootKeydown,
  rowDragging: function () { return !!rowDrag().dragging(); },
  rowDragOver: function (e) { var routes = rowRoutes.owner(); return !!routes && routes.dragOver(e); },
  rowDrop: function (e) { var routes = rowRoutes.owner(); return !!routes && routes.drop(e); },
  scriptCell: isScriptCell,
  reviewOnly: reviewMode,
  hasMedia: hasMediaFiles,
  insert: insertIntoScriptCell,
  notMedia: function () { showToast("Only pictures and video files go in a scene's Image section.", "warn"); }
};

export function mountRowsEditingFeature() {
  return rowsEditor.replace(function () {
    return mountRowsEditor({ window: window, rows: document.getElementById("rows"), addBar: document.querySelector(".add-row-bar"), ports: rowsEditorPorts });
  });
}

export var stopRowsEditingFeature = rowsEditor.stop;

function afterUndoApplied(steps) {
  var cellStep = null;
  steps.forEach(function (st) {
    if (st.op !== "rowField" || !S.state.rows.some(function (r) { return r.id === st.rowId; })) return;
    if (!cellStep && (st.key === "visualText" || st.key === "audioText")) cellStep = st;
  });
  undoGuard().whileApplying(function () {
    if (writerOpen) renderWriter(); else render();
    renderProduction();
  });
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

export function onRootInput(e) {
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
  focusMemory().unmutePrompt();
  scheduleUntaggedScan();
  updateTagGhost(cellEl);
  refreshPlainTag();
}

var composition = owned();

function scriptCellOf(target) {
  var cellEl = target && target.closest && target.closest(".cell-editable");
  return cellEl && isScriptCell(cellEl) ? { rowId: cellEl.getAttribute("data-id"), field: cellEl.getAttribute("data-field") } : null;
}

export function mountCompositionFeature() {
  return composition.replace(function () {
    return mountComposition({
    roots: editorRoots(),
    ports: {
      cellOf: scriptCellOf,
      epoch: function () { return liveSession().epoch(); },
      mark: function (cell) { return compositionUndoMark(cell.rowId, cell.field); },
      dropEmptySince: dropEmptyStepsSince
    }
    });
  });
}

export var stopCompositionFeature = composition.stop;

function settleEndedComposition(e) {
  var owner = composition.owner();
  if (owner) owner.settle(e);
}

var titleRoutes = owned();

export function mountTitlesFeature() {
  return titleRoutes.replace(function () {
    return mountTitleRoutes({
    main: document.getElementById("doc-title"),
    writer: document.getElementById("writer-title"),
    ports: {
      run: runCommand,
      current: function () { return S.state ? S.state.title || "" : null; },
      pageTitle: syncPageTitle
    }
    });
  });
}

export var stopTitlesFeature = titleRoutes.stop;

var writerRoutes = owned();

var writerRoutePorts = {
  input: onRootInput,
  keydown: onRootKeydown,
  editKeydown: onWriterKeydown,
  format: onWriterFormat,
  gutter: cycleWriterGutter,
  exportNarration: function () { runExport("export-narration-docx"); }
};

export function mountWriterFeature() {
  return writerRoutes.replace(function () {
    return mountWriterRoutes({ window: window, doc: document.getElementById("writer-doc"), bar: document.querySelector(".writer-bar"), ports: writerRoutePorts });
  });
}

export var stopWriterFeature = writerRoutes.stop;

var editorFocusPorts = {
  isScriptCell: isScriptCell,
  blurSuppressed: function () { return undoGuard().applying() || paintingScreen(); },
  leftEditable: function () {
    hideTagGhost();
    cancelPlainTag();
    hideUntaggedPrompt();
    focusMemory().unmutePrompt();
  },
  blurredCell: function (cellEl) {
    var clean = sanitizeHtml(cellEl.innerHTML);
    if (clean !== storedHtmlFromDom(cellEl.innerHTML)) cellEl.innerHTML = clean;
    syncFieldFromDom(cellEl);
    if (!undoGuard().applying()) anchorBrollInLeftCell(cellEl);
  },
  typeAtMarks: function (cellEl, data) { return typePendingMarks(cellEl, data) || typeAtDirectionEdge(cellEl, data); },
  typed: function (cellEl, data) { onRootInput({ target: cellEl, inputType: "insertText", data: data }); },
  focusedRow: function (rowId) { focusMemory().focusedRow(rowId); },
  focusedParagraph: function (paraEl) {
    focusMemory().focusedParagraph(paraEl);
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

export var onRootFocusOut = editorBlur(editorFocusPorts);

var editorFocus = owned();

export function mountFocusFeature() {
  return editorFocus.replace(function () {
    var roots = editorRoots();
    return { dispose: mountEditorFocus({ rows: roots[0], writer: roots[1], doc: document, ports: editorFocusPorts }) };
  });
}

export var stopFocusFeature = editorFocus.stop;

var clipboardRoutes = owned();

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

export function mountClipboardFeature() {
  return clipboardRoutes.replace(function () {
    return mountClipboardRoutes({ window: window, roots: editorRoots(), ports: clipboardRoutePorts });
  });
}

export var stopClipboardFeature = clipboardRoutes.stop;

function insertIntoScriptCell(cellEl, html, text, files) {
  var clipboard = clipboardRoutes.owner();
  if (clipboard) clipboard.insert(cellEl, html, text, files);
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
  showActionToast(msg, "ok", "Undo", function () {
    var undoOwner = undoRoutes.owner();
    if (undoOwner) undoOwner.undoIfLatest(entry);
  });
}

export function onRootPaste(e) {
  var clipboard = clipboardRoutes.owner();
  if (clipboard) clipboard.paste(e);
}

var videoPopover = owned();

export function mountVideoFeature() {
  return videoPopover.replace(function () {
    return mountVideoPopover({ window: window, ports: { confirm: confirmVideo, cancel: cancelVideo } });
  }, function (owner) {
    return [function () { return routeRootClick("video", function (e) { return owner.click(e); }); }];
  });
}

export var stopVideoFeature = videoPopover.stop;

export function onRootKeydown(e) {
  if (rowMenuKeydown(e)) return;
  var toolbar = editorToolbar.owner();
  if (toolbar && toolbar.keydown(e)) return;
  var video = videoPopover.owner();
  if (video && video.keydown(e)) return;
  var cellEl = e.target.classList && e.target.classList.contains("cell-editable") ? e.target : null;
  if (!cellEl) return;
  if (reviewMode() && isScriptCell(cellEl)) return;
  if (!isScriptCell(cellEl) && onDraftUndoKey(e, cellEl)) return;
  var undoOwner = undoRoutes.owner();
  if (undoOwner && undoOwner.key(e)) return;
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
    focusMemory().mutePrompt(cellEl);
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
  if (toolbar) toolbar.formatKey(e, cellEl);
}
