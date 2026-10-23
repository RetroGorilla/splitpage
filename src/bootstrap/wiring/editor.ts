import type { ActionDefinition } from "../../application/actions.ts";
import { rowActions } from "../../features/rows/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { ROOT_CLICK_ORDER, ROOT_MOUSEDOWN_ORDER, createRootRouter } from "../../features/routing/root-router.ts";
import type { RootClickSlot, RootMouseDownSlot, RootRoute } from "../../features/routing/root-router.ts";
import { createReviewClickGate } from "../../features/review/click-gate.ts";
import { createCellEditing } from "../../application/editing/cell-editing.ts";
import { caretTextOffset, placeCaretAtTextOffset } from "../../features/editing/caret.ts";
import { createCellPage, isDraftBox, isScriptCell } from "../../features/editing/cell-page.ts";
import { mountComposition } from "../../features/editing/composition.ts";
import type { CompositionCell } from "../../features/editing/composition.ts";
import { editorBlur, mountEditorFocus } from "../../features/editing/focus.ts";
import type { EditorFocusPorts } from "../../features/editing/focus.ts";
import { mountEditorToolbar } from "../../features/editing/toolbar.ts";
import type { EditorToolbarPorts } from "../../features/editing/toolbar.ts";
import { mountClipboardRoutes } from "../../features/clipboard/routes.ts";
import { mountMediaRoutes } from "../../features/media/routes.ts";
import type { MediaRoutePorts } from "../../features/media/routes.ts";
import { mountMergeBanner } from "../../features/merge/banner.ts";
import type { MergeReport } from "../../features/merge/banner.ts";
import { mountRowsEditor } from "../../features/rows/editor.ts";
import type { RowsEditorPorts } from "../../features/rows/editor.ts";
import { mountRowRoutes } from "../../features/rows/routes.ts";
import type { RowRoutePorts } from "../../features/rows/routes.ts";
import { mountTitleRoutes } from "../../features/title/routes.ts";
import { mountUndoRoutes, undoGesture } from "../../features/undo/routes.ts";
import { mountVideoPopover } from "../../features/video/popover.ts";
import { mountWriterRoutes } from "../../features/writer/routes.ts";
import type { WriterRoutePorts } from "../../features/writer/routes.ts";
import type { LiveDocumentPort } from "../../application/transitions/ports.ts";
import { captureOperation, stillOwns } from "../../legacy/transition-bridge.ts";
import { cellEditing, focusMemory, installCellEditing, installPicturePicker, mergeUndo, paintGuard, rowDrag, undoGuard } from "../../legacy/editor-bridge.ts";
import { REVIEW_ONLY, liveDocumentPort, liveSession, runCommand, sessionTextPorts } from "../../legacy/session-bridge.ts";
import { fromHtml } from "../../legacy/richtext.ts";
import { VIEWING_ONLY } from "../../application/collaboration/review.ts";
import { cycleRowStatus } from "../../js/01-scene-status.js";
import { expandHiddenShotStrip } from "../../js/01b-hide-shot.js";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";
import { restoreMergeSnapshot } from "../../js/03-sync.js";
import { installMergeBanner } from "../../legacy/merge-bridge.ts";
import { ensureTrailingCaretSpot, safeId, sanitizeHtml, storedHtmlFromDom } from "../../js/04-richtext.js";
import { cssAttr } from "../../features/common/dom.ts";
import { announceGalleryEdit } from "../../features/gallery/overlay.js";
import {
  cancelLink,
  cancelVideo,
  confirmLink,
  confirmVideo,
  forgetStalePendingMarks,
  handleToolbarCmd,
  insertLineBreak,
  maybeCueShortcut,
  maybeDirectionShortcut,
  noteFieldPainted,
  paintingScreen,
  screenIsStale,
  syncPageTitle,
  toggleCellFormat,
  typeAtDirectionEdge,
  typePendingMarks,
  updateToolbarState
} from "../../js/05-render.js";
import { copyFromCell, hasMediaFiles, pasteIntoCell, readClipboardFiles } from "../../js/05c-clipboard.js";
import { pasteScenesAt } from "../../js/05h-scene-select.js";
import { thumbnailsAfterPaste } from "../../js/05v-video.js";
import {
  draftRedo,
  draftUndo,
  noteDraftInput,
  pasteIntoDraft
} from "../../js/05d-draft-edit.js";
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
} from "../../js/06-rows.js";
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
} from "../../js/07-production-tags.js";
import {
  cancelPlainTag,
  closePlainTag,
  maybeOpenPlainTag,
  plainTagEmptyAtCaret,
  plainTagOpen,
  refreshPlainTag
} from "../../js/07b-plain-tags.js";
import { renderProduction } from "../../js/08-production-panels.js";
import { anchorBrollInLeftCell, maybeCaptureBroll, scheduleBrollRefresh } from "../../js/08c-broll.js";
import {
  captureReplyDrafts,
  jumpToComment,
  openCommentsPanel,
  renderComments,
  syncAnchorResolvedClasses
} from "../../js/10-comments.js";
import { showActionToast, showToast } from "../../legacy/effects-bridge.ts";
import { viewFlags } from "../../legacy/preferences-bridge.ts";
import {
  breakUndoCoalescing,
  caretAfterStep,
  compositionUndoMark,
  configureUndo,
  dropEmptyStepsSince,
  flushEdits,
  lastUndoEntry,
  redo,
  settleAfterApply,
  undo
} from "../../js/12a-undo.js";
import { onServerDoc } from "../../js/13-hosted.js";
import { runExport } from "../../js/18-local-files.js";
import {
  cycleWriterGutter,
  onWriterFormat,
  onWriterKeydown,
  scheduleWriterStats,
  updateWriterFormatState,
  writerUndoStep
} from "../../js/19-writer.js";
import { reviewBlocked, reviewMode } from "../../legacy/location-bridge.ts";

type RootInput = Pick<Event, "target">;

interface UndoCellStep {
  readonly op: string;
  readonly rowId: string;
  readonly key: string;
}

interface PasteAttached {
  readonly pictures: number;
  readonly videos: number;
  readonly links?: readonly unknown[];
}

interface PasteOutcome {
  readonly done: boolean;
  readonly lost: number;
  readonly attached: PasteAttached | null;
  readonly rowIndex: number;
  readonly cellEl: Element;
  readonly movedComments: boolean;
}

interface CellSuggestion {
  readonly cellEl: Element;
}

function shownTagGhost(): CellSuggestion | null {
  return tagGhost;
}

function shownUntaggedSuggestion(): CellSuggestion | null {
  return untaggedSuggestion;
}

const liveDocument: LiveDocumentPort = liveDocumentPort;

const reviewClickGate = createReviewClickGate({
  reviewMode: function () { return reviewMode(); },
  refuse: function () { reviewBlocked(); }
});

const rootClicks = createRootRouter<RootClickSlot, MouseEvent>(ROOT_CLICK_ORDER, function (e) { return reviewClickGate(e.target as Element); });

const rootMouseDowns = createRootRouter<RootMouseDownSlot, MouseEvent>(ROOT_MOUSEDOWN_ORDER);

export function onRootClick(e: MouseEvent): void {
  rootClicks.handle(e);
}

export function routeRootClick(slot: RootClickSlot, handler: RootRoute<MouseEvent>): () => void {
  return rootClicks.route(slot, handler);
}

export function routeRootMouseDown(slot: RootMouseDownSlot, handler: RootRoute<MouseEvent>): () => void {
  return rootMouseDowns.route(slot, handler);
}

export function rootRoutesTaken(): { click: readonly RootClickSlot[]; mousedown: readonly RootMouseDownSlot[] } {
  return { click: rootClicks.routed(), mousedown: rootMouseDowns.routed() };
}

function refocusRowMenu(rowId: string): void {
  closeRowMenus();
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !(a.closest && a.closest(".row-menu"))) return;
  const btn = document.querySelector<HTMLElement>('#rows .row[data-id="' + cssAttr(rowId) + '"] .row-more');
  if (btn) btn.focus({ preventScroll: true });
}

export function onRootMouseDown(e: MouseEvent): void {
  hideTagGhost();
  const target = e.target as Element;
  const grip = target.closest('[data-action="drag-grip"]');
  if (grip) {
    const gripRow = grip.closest(".row");
    if (gripRow) gripRow.setAttribute("draggable", "true");
  }
  if (target.closest(".mini-toolbar button")) e.preventDefault();
  const anchor = target.closest(".cmt-anchor");
  if (anchor) jumpToComment(anchor.getAttribute("data-cmt"));

  rootMouseDowns.handle(e);
}

function nearestScrollAncestor(el: Element): Element {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function keepCaretInView(cellEl: Element): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  let rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) rect = cellEl.getBoundingClientRect();
  const margin = 32;
  if (rect.top >= margin && rect.bottom <= window.innerHeight - margin) return;
  const delta = (rect.top + rect.bottom) / 2 - window.innerHeight / 2;
  nearestScrollAncestor(cellEl).scrollBy({ top: delta, behavior: "smooth" });
}

function onDraftUndoKey(e: KeyboardEvent, box: Element): boolean {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
  const dir = undoGesture(e);
  if (!dir) return false;
  if (!isDraftBox(box)) return false;
  e.preventDefault();
  if (dir === "redo") draftRedo(box); else draftUndo(box);
  return true;
}

function refreshFormatState(cellEl: Element): void {
  if (cellEl.classList.contains("wr-para")) updateWriterFormatState();
  else updateToolbarState(cellEl);
}

const editorToolbar = owned<ReturnType<typeof mountEditorToolbar>>();

const editorToolbarPorts: EditorToolbarPorts = {
  command: handleToolbarCmd,
  confirmLink: confirmLink,
  cancelLink: cancelLink,
  format: function (cellEl, cmd) {
    const toggled: Element | null = toggleCellFormat(cellEl, cmd);
    refreshFormatState(toggled || cellEl);
  }
};

export function mountToolbarFeature(): ReturnType<typeof mountEditorToolbar> {
  return editorToolbar.replace(function () {
    return mountEditorToolbar({ window: window, ports: editorToolbarPorts });
  }, function (owner) {
    return [function () { return routeRootClick("toolbar", function (e) { return owner.click(e); }); }];
  });
}

export const stopToolbarFeature = editorToolbar.stop;

const cellEditingMount = owned<{ readonly dispose: () => void }>();

const MEDIA_CELL = Object.freeze({ media: true });

export function mountCellEditingFeature(): { readonly dispose: () => void } {
  return cellEditingMount.replace(function () {
    const editing = createCellEditing<Element>({
      page: createCellPage({ storedHtml: function (html) { return storedHtmlFromDom(html); }, caretSpot: ensureTrailingCaretSpot }),
      document: liveDocument.current,
      run: runCommand,
      text: sessionTextPorts,
      decode: {
        text: function (html) { return fromHtml(html); },
        withMedia: function (html) { return fromHtml(html, MEDIA_CELL); }
      },
      undo: {
        applying: function () { return undoGuard().applying(); },
        breakCoalescing: breakUndoCoalescing,
        flush: flushEdits,
        latest: lastUndoEntry
      },
      stale: screenIsStale,
      painted: noteFieldPainted,
      shown: function <T>(edit: () => T): T { return paintGuard().whileShown(edit); },
      announce: announceGalleryEdit,
      refused: function (reason) { if (reason === REVIEW_ONLY) showToast(VIEWING_ONLY, "warn"); }
    });
    return { dispose: installCellEditing(editing) };
  });
}

export const stopCellEditingFeature = cellEditingMount.stop;

function editorRoots(): Element[] {
  return [document.getElementById("rows") as Element, document.getElementById("writer-doc") as Element];
}

const undoRoutes = owned<ReturnType<typeof mountUndoRoutes>>();

export function mountUndoFeature(): ReturnType<typeof mountUndoRoutes> {
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

export const stopUndoFeature = undoRoutes.stop;

const mergeBanner = owned<ReturnType<typeof mountMergeBanner>>();

export function mountMergeBannerFeature(): ReturnType<typeof mountMergeBanner> {
  return mergeBanner.replace(function () {
    return mountMergeBanner({
      window: window,
      ports: {
        lastUndo: function () { return mergeUndo().last(); },
        sameDocument: function (docId) {
          const doc = liveDocument.current();
          return !!doc && docId === doc.docId;
        },
        restore: restoreMergeSnapshot,
        warn: function (message) { showToast(message, "warn"); },
        openComments: openCommentsPanel,
        rowElement: function (rowId) { return document.querySelector('#rows .row[data-id="' + safeId(rowId, "r") + '"]'); },
        logError: function (e) { if (window.console) console.error(e); },
        install: function (banner) {
          return installMergeBanner({ show: function (result, opts) { return banner.show(result as MergeReport, opts); } });
        }
      }
    });
  });
}

export const stopMergeBannerFeature = mergeBanner.stop;

const mediaRoutes = owned<ReturnType<typeof mountMediaRoutes>>();

const mediaRoutePorts: MediaRoutePorts = {
  choose: function () { (document.getElementById("file-input") as HTMLElement).click(); },
  addPicture: handleImageFile,
  removePicture: removeImage,
  removeLink: removeImageLink,
  openLink: openGalleryLink
};

export function mountMediaFeature(): ReturnType<typeof mountMediaRoutes> {
  return mediaRoutes.replace(function () {
    return mountMediaRoutes({ window: window, fileInput: document.getElementById("file-input") as HTMLInputElement, ports: mediaRoutePorts });
  }, function (owner) {
    return [
      function () { return routeRootClick("media-picker", function (e) { return owner.pickerClick(e); }); },
      function () { return routeRootClick("media-link", function (e) { return owner.linkClick(e); }); },
      function () { return installPicturePicker(function (rowId) { owner.pick(rowId); }); }
    ];
  });
}

export const stopMediaFeature = mediaRoutes.stop;

const rowRoutes = owned<ReturnType<typeof mountRowRoutes>>();

const rowRoutePorts: RowRoutePorts = {
  dragging: function () { return rowDrag().dragging(); },
  setDragging: function (rowId) { if (rowId) rowDrag().start(rowId); else rowDrag().end(); },
  clearMarkers: clearDropMarkers,
  markDrop: setDropMarkerForRow,
  scroll: updateDragScroll,
  stopScroll: stopDragScroll,
  move: function (rowId, targetId, after) { cellEditing().moveRow(rowId, targetId, after); },
  add: addRow,
  moveBy: function (rowId, dir) { moveRow(rowId, dir); refocusRowMenu(rowId); },
  toggleMenu: toggleRowMenu,
  armDelete: armDelete,
  cycleStatus: cycleRowStatus,
  expandHidden: expandHiddenShotStrip,
  reveal: function (rowId) { shotHiding().reveal(rowId); },
  gone: function () { showToast("That scene is no longer here.", "warn"); }
};

export function mountRowsFeature(): ReturnType<typeof mountRowRoutes> {
  return rowRoutes.replace(function () {
    return mountRowRoutes({ window: window, rows: document.getElementById("rows") as Element, ports: rowRoutePorts });
  }, function (owner) {
    return [
      function () { return routeRootClick("rows-add", function (e) { return owner.addClick(e); }); },
      function () { return routeRootClick("rows-scene", function (e) { return owner.sceneClick(e); }); },
      function () { return routeRootClick("rows-menu", function (e) { return owner.menuClick(e); }); },
      function () { return rowDrag().onEnd(clearDropMarkers); }
    ];
  });
}

export const stopRowsFeature = rowRoutes.stop;

export function rowsActions(): ActionDefinition[] {
  return rowActions({ reveal: (rowId) => { shotHiding().reveal(rowId); } });
}

const rowsEditor = owned<ReturnType<typeof mountRowsEditor>>();

const rowsEditorPorts: RowsEditorPorts = {
  click: onRootClick,
  mousedown: onRootMouseDown,
  input: onRootInput,
  keydown: onRootKeydown,
  rowDragging: function () { return !!rowDrag().dragging(); },
  rowDragOver: function (e) { const routes = rowRoutes.owner(); return !!routes && routes.dragOver(e); },
  rowDrop: function (e) { const routes = rowRoutes.owner(); return !!routes && routes.drop(e); },
  scriptCell: isScriptCell,
  reviewOnly: reviewMode,
  hasMedia: hasMediaFiles,
  insert: insertIntoScriptCell,
  notMedia: function () { showToast("Only pictures and video files go in a scene's Image section.", "warn"); }
};

export function mountRowsEditingFeature(): ReturnType<typeof mountRowsEditor> {
  return rowsEditor.replace(function () {
    return mountRowsEditor({ window: window, rows: document.getElementById("rows") as Element, addBar: document.querySelector(".add-row-bar"), ports: rowsEditorPorts });
  });
}

export const stopRowsEditingFeature = rowsEditor.stop;

function afterUndoApplied(steps: readonly unknown[]): void {
  let cellStep: UndoCellStep | null = null;
  const doc = liveDocument.current();
  for (const st of steps as readonly UndoCellStep[]) {
    if (st.op !== "rowField") continue;
    if (!doc) throw new TypeError("An undo step was applied without a document");
    if (!doc.rows.some(function (r) { return r.id === st.rowId; })) continue;
    if (!cellStep && (st.key === "visualText" || st.key === "audioText")) cellStep = st;
  }
  undoGuard().whileApplying(renderProduction);
  settleAfterApply();
  if (cellStep) {
    const sel = '.cell-editable[data-id="' + cssAttr(cellStep.rowId) + '"][data-field="' + cellStep.key + '"]';
    const cell = document.querySelector<HTMLElement>((viewFlags().writerOpen() ? "#writer-doc " : "#rows ") + sel) || document.querySelector<HTMLElement>(sel);
    if (cell) {
      cell.focus();
      placeCaretAtTextOffset(cell, caretAfterStep(cellStep));
    }
  }
}

export function onRootInput(e: RootInput): void {
  const target = e.target as Element | null;
  const cellEl = target && target.classList && target.classList.contains("cell-editable") ? target : null;
  if (!cellEl) return;
  if (!isScriptCell(cellEl)) { noteDraftInput(cellEl); return; }
  maybeAutoTagShortcut(e, cellEl);
  maybeDirectionShortcut(e, cellEl);
  maybeCueShortcut(e, cellEl);
  maybeCaptureBroll(e, cellEl);
  maybeOpenPlainTag(e, cellEl);
  cellEditing().sync(cellEl);
  settleEndedComposition(e);
  afterScriptCellChange(cellEl);
}

function afterScriptCellChange(cellEl: Element): void {
  keepCaretInView(cellEl);
  scheduleProductionRefresh();
  scheduleBrollRefresh();
  scheduleWriterStats();
  focusMemory().unmutePrompt();
  scheduleUntaggedScan();
  updateTagGhost(cellEl);
  refreshPlainTag();
}

const composition = owned<ReturnType<typeof mountComposition>>();

function scriptCellOf(target: EventTarget | null): CompositionCell | null {
  const cellEl = target && (target as Element).closest && (target as Element).closest(".cell-editable");
  return cellEl && isScriptCell(cellEl) ? { rowId: cellEl.getAttribute("data-id") as string, field: cellEl.getAttribute("data-field") as string } : null;
}

export function mountCompositionFeature(): ReturnType<typeof mountComposition> {
  return composition.replace(function () {
    return mountComposition({
      roots: editorRoots(),
      ports: {
        cellOf: scriptCellOf,
        epoch: function () { return liveSession().epoch(); },
        mark: function (cell): unknown { return compositionUndoMark(cell.rowId, cell.field); },
        dropEmptySince: dropEmptyStepsSince
      }
    });
  });
}

export const stopCompositionFeature = composition.stop;

function settleEndedComposition(e: RootInput): void {
  const owner = composition.owner();
  if (owner) owner.settle(e as Event);
}

const titleRoutes = owned<ReturnType<typeof mountTitleRoutes>>();

export function mountTitlesFeature(): ReturnType<typeof mountTitleRoutes> {
  return titleRoutes.replace(function () {
    return mountTitleRoutes({
      main: document.getElementById("doc-title") as HTMLInputElement,
      writer: document.getElementById("writer-title") as HTMLInputElement,
      ports: {
        run: function (command) { return paintGuard().whileShown(function () { return runCommand(command); }); },
        current: function () {
          const doc = liveDocument.current();
          return doc ? doc.title || "" : null;
        },
        pageTitle: syncPageTitle
      }
    });
  });
}

export const stopTitlesFeature = titleRoutes.stop;

const writerRoutes = owned<ReturnType<typeof mountWriterRoutes>>();

const writerRoutePorts: WriterRoutePorts = {
  input: onRootInput,
  keydown: function (e) { onRootKeydown(e as KeyboardEvent); },
  editKeydown: onWriterKeydown,
  format: onWriterFormat,
  gutter: cycleWriterGutter,
  exportNarration: function () { runExport("export-narration-docx"); }
};

export function mountWriterFeature(): ReturnType<typeof mountWriterRoutes> {
  return writerRoutes.replace(function () {
    return mountWriterRoutes({ window: window, doc: document.getElementById("writer-doc") as HTMLElement, bar: document.querySelector(".writer-bar") as HTMLElement, ports: writerRoutePorts });
  });
}

export const stopWriterFeature = writerRoutes.stop;

const editorFocusPorts: EditorFocusPorts = {
  isScriptCell: isScriptCell,
  blurSuppressed: function () { return undoGuard().applying() || paintingScreen(); },
  leftEditable: function () {
    hideTagGhost();
    cancelPlainTag();
    hideUntaggedPrompt();
    focusMemory().unmutePrompt();
  },
  blurredCell: function (cellEl) {
    const clean = sanitizeHtml(cellEl.innerHTML);
    if (clean !== storedHtmlFromDom(cellEl.innerHTML)) cellEl.innerHTML = clean;
    cellEditing().sync(cellEl);
    if (!undoGuard().applying()) anchorBrollInLeftCell(cellEl);
  },
  typeAtMarks: function (cellEl, data) {
    const marked: Element | null = typePendingMarks(cellEl, data);
    if (marked) return marked;
    const edge: Element | null = typeAtDirectionEdge(cellEl, data);
    return edge;
  },
  typed: function (cellEl, data) { onRootInput({ target: cellEl, inputType: "insertText", data: data } as RootInput); },
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

export const onRootFocusOut = editorBlur(editorFocusPorts);

const editorFocus = owned<{ readonly dispose: () => void }>();

export function mountFocusFeature(): { readonly dispose: () => void } {
  return editorFocus.replace(function () {
    const roots = editorRoots();
    return { dispose: mountEditorFocus({ rows: roots[0] as Element, writer: roots[1] as Element, doc: document, ports: editorFocusPorts }) };
  });
}

export const stopFocusFeature = editorFocus.stop;

const clipboardRoutes = owned<ReturnType<typeof mountClipboardRoutes>>();

const clipboardRoutePorts = {
  scriptCell: isScriptCell,
  reviewOnly: reviewMode,
  copy: copyFromCell,
  afterCut: afterScriptCellChange,
  pasteScenes: pasteScenesAt,
  pasteDraft: pasteIntoDraft,
  hasMedia: hasMediaFiles,
  readMedia: function (files: FileList | readonly File[]) {
    return readClipboardFiles(files, compressImageFile, { frame: videoFirstFrame, grant: grantVideoFile });
  },
  capture: captureOperation,
  stillOwns: stillOwns,
  notAdded: showPictureNotAdded,
  placeOf: capturePastePlace,
  restorePlace: restorePastePlace,
  findCell: function (rowId: string, field: string) {
    return document.querySelector('#rows .cell-editable[data-id="' + cssAttr(rowId) + '"][data-field="' + field + '"]');
  },
  insertNow: function (cellEl: Element, html: string, text: string, extra: unknown) { insertIntoScriptCellNow(cellEl, html, text, extra); }
};

export function mountClipboardFeature(): ReturnType<typeof mountClipboardRoutes> {
  return clipboardRoutes.replace(function () {
    return mountClipboardRoutes({ window: window, roots: editorRoots(), ports: clipboardRoutePorts });
  });
}

export const stopClipboardFeature = clipboardRoutes.stop;

function insertIntoScriptCell(cellEl: Element, html: string, text: string, files: FileList | readonly File[] | null | undefined): void {
  const clipboard = clipboardRoutes.owner();
  if (clipboard) clipboard.insert(cellEl, html, text, files);
}

function insertIntoScriptCellNow(cellEl: Element, html: string, text: string, extra: unknown): void {
  if (screenIsStale()) {
    showToast("Could not paste — press Redraw first.", "error");
    return;
  }
  const before = lastUndoEntry();
  const res: PasteOutcome = pasteIntoCell(cellEl, html, text, extra);
  if (!res.done) return;
  const lost = res.lost + (extra ? (extra as { lost: number }).lost : 0);
  if (lost) showToast((lost === 1 ? "A picture" : lost + " pictures") + " couldn't be added — only a link to it was copied. Save it, then paste or drop the file.", "warn");
  if (res.attached) {
    const attachedRowId = cellEl.getAttribute("data-id");
    announceAttached(res.attached, res.rowIndex, before);
    if (res.attached.links && res.attached.links.length) {
      const entry = lastUndoEntry();
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

function announceAttached(attached: PasteAttached, rowIndex: number, before: unknown): void {
  const pics = attached.pictures, vids = attached.videos;
  function n(count: number, one: string): string { return count === 1 ? one : count + " " + one + "s"; }
  const what = pics && vids ? n(pics, "picture") + " and " + n(vids, "video")
    : pics ? n(pics, "picture") : n(vids, "video");
  const msg = what.charAt(0).toUpperCase() + what.slice(1) + " added to scene " + (rowIndex + 1);
  const entry = lastUndoEntry();
  if (!entry || entry === before) { showToast(msg, "ok"); return; }
  showActionToast(msg, "ok", "Undo", function () {
    const undoOwner = undoRoutes.owner();
    if (undoOwner) undoOwner.undoIfLatest(entry);
  });
}

export function onRootPaste(e: ClipboardEvent): void {
  const clipboard = clipboardRoutes.owner();
  if (clipboard) clipboard.paste(e);
}

const videoPopover = owned<ReturnType<typeof mountVideoPopover>>();

export function mountVideoFeature(): ReturnType<typeof mountVideoPopover> {
  return videoPopover.replace(function () {
    return mountVideoPopover({ window: window, ports: { confirm: confirmVideo, cancel: cancelVideo } });
  }, function (owner) {
    return [function () { return routeRootClick("video", function (e) { return owner.click(e); }); }];
  });
}

export const stopVideoFeature = videoPopover.stop;

export function onRootKeydown(e: KeyboardEvent): void {
  if (rowMenuKeydown(e)) return;
  const toolbar = editorToolbar.owner();
  if (toolbar && toolbar.keydown(e)) return;
  const video = videoPopover.owner();
  if (video && video.keydown(e)) return;
  const target = e.target as Element | null;
  const cellEl = target && target.classList && target.classList.contains("cell-editable") ? target : null;
  if (!cellEl) return;
  if (reviewMode() && isScriptCell(cellEl)) return;
  if (!isScriptCell(cellEl) && onDraftUndoKey(e, cellEl)) return;
  const undoOwner = undoRoutes.owner();
  if (undoOwner && undoOwner.key(e)) return;
  if (plainTagOpen(cellEl)) {
    if (e.key === "Tab") { e.preventDefault(); closePlainTag(); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideTagGhost(); cancelPlainTag(); return; }
    if (e.key === "Backspace" && plainTagEmptyAtCaret()) cancelPlainTag();
  }
  const ghost = shownTagGhost();
  if (e.key === "Tab" && ghost && ghost.cellEl === cellEl) {
    if (acceptTagGhost()) { e.preventDefault(); return; }
  }
  const suggestion = shownUntaggedSuggestion();
  if (e.key === "Tab" && !shownTagGhost() && suggestion && suggestion.cellEl === cellEl) {
    if (acceptUntaggedMention()) { e.preventDefault(); return; }
  }
  if (e.key === "Escape" || e.key === "ArrowLeft" || e.key === "ArrowRight" ||
      e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
    hideTagGhost();
  }
  if (e.key === "Escape" && shownUntaggedSuggestion()) {
    focusMemory().mutePrompt(cellEl);
    hideUntaggedPrompt();
  }
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Enter" && e.altKey && !mod && isScriptCell(cellEl)) {
    e.preventDefault();
    hideTagGhost();
    cellEditing().sync(cellEl);
    splitCellField(cellEl);
    return;
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && e.altKey && !mod && isScriptCell(cellEl)) {
    e.preventDefault();
    cellEditing().sync(cellEl);
    const mvId = cellEl.getAttribute("data-id");
    const mvField = cellEl.getAttribute("data-field");
    const mvOffset = caretTextOffset(cellEl);
    if (swapAdjacentRows(mvId, e.key === "ArrowUp" ? -1 : 1)) {
      if (!viewFlags().writerOpen()) focusRowField(mvId, mvField, mvOffset);
      renderProduction();
    }
    return;
  }
  if (e.key === "Enter" && mod && isScriptCell(cellEl)) {
    e.preventDefault();
    hideTagGhost();
    cellEditing().sync(cellEl);
    addRowAndFocus(cellEl.getAttribute("data-id"), cellEl.getAttribute("data-field"));
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const broken: Element = insertLineBreak(cellEl);
    cellEditing().sync(broken);
    return;
  }
  if (toolbar) toolbar.formatKey(e, cellEl);
}
