import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { EffectPorts } from "../../application/effects/ports.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { EditorSelectionPort } from "../../application/editing/selection.ts";
import type { UndoControl } from "../../application/editing/undo-control.ts";
import type { ExportRegistry } from "../../application/export/registry.ts";
import type { LastFile } from "../../application/files/last-file.ts";
import type { RecentFiles } from "../../application/files/recent-files.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { PictureStore } from "../../application/media/picture-store.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { ViewFlags } from "../../application/preferences/view-flags.ts";
import type { SaveOwnershipPort } from "../../application/save/coordinator.ts";
import type { SaveState } from "../../application/save/save-state.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { DocumentDestination } from "../../application/transitions/ports.ts";
import type { Transitions } from "../../application/transitions/transitions.ts";
import { normalizeTagName } from "../../core/document/tags.ts";
import { loadLastFileHandle } from "../../js/00-prelude.js";
import { breakUndoCoalescing, flushEdits, lastUndoEntry, redo, undo } from "../../js/12a-undo.js";
import type { ProductionIndexOwner } from "../../core/production/index.ts";
import { blobImgHtml, bytesForSync, dataUrlForSync, ensureBytes, intern, internDataUrl, isDurableSync, persist, queuePersist, recordFor, urlForSync } from "../../adapters/storage/02c-blobs.js";
import { arrivingOnLink } from "../../js/13-hosted.js";
import { appActions } from "../../legacy/app-actions.ts";
import { copyShareText, setMenuItemLabel, setMenuItemReason, showActionToast, showToast } from "../../legacy/effects-bridge.ts";
import { cacheSeal } from "../../legacy/cache-freeze.ts";
import { productionReaders } from "../../legacy/document-ports.ts";
import { editorSelection } from "../../legacy/editor-bridge.ts";
import { exportFormats } from "../../legacy/export-formats.ts";
import {
  currentConn, currentHome, documentLocation, fileHome, homeConn, importHome, reviewBlocked, reviewMode,
  serverHomeId, serverStatus, stillOnServer
} from "../../legacy/location-bridge.ts";
import { htmlToPlainText } from "../../legacy/plain-text.ts";
import { PREF_EVENT, preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { autoSavePolicy, onSaveChange, resumeAutoSave, saveBusy, setAutoSaveEnabled, unsavedChanges } from "../../legacy/save-bridge.ts";
import { productionIndex } from "../../legacy/production-index-bridge.ts";
import { cellOf, fromHtml, htmlToMarkdown, inertBody, sanitizeHtml, storedHtmlFromDom } from "../../legacy/richtext.ts";
import { screenNow } from "../../legacy/screen-state.ts";
import { currentDocument, editAllowed, onDocumentReplaced, onRefresh, onSessionChange, readSession, runCommand, runDocumentEdit, sessionStamps, sessionTextPorts } from "../../legacy/session-bridge.ts";
import { captureOperation, documentTransitions, stillOwns } from "../../legacy/transition-bridge.ts";

const actions: Pick<ActionRegistry, "invoke" | "view"> = {
  invoke: (id, source, input) => appActions.invoke(id, source, input),
  view: (id, source) => appActions.view(id, source)
};

const changes: PreferenceChanges = {
  onChange(listener, hearing) {
    const onPreference = (event: Event): void => {
      const change = (event as CustomEvent<PreferenceChange | undefined>).detail;
      if (!change) return;
      const name = preferences().nameOf(change.key);
      if (name) listener({ name, value: change.value, elsewhere: false });
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null) return;
      const name = preferences().nameOf(event.key);
      if (name) listener({ name, value: event.newValue, elsewhere: true });
    };
    const elsewhere = hearing?.elsewhere !== false;
    document.addEventListener(PREF_EVENT, onPreference);
    if (elsewhere) window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener(PREF_EVENT, onPreference);
      if (elsewhere) window.removeEventListener("storage", onStorage);
    };
  }
};

const documentReader: DocumentReader = {
  current: currentDocument,
  read: readSession,
  onChange: onSessionChange,
  onReplaced: onDocumentReplaced,
  onRefresh: onRefresh
};

const edits: DocumentEdits = {
  run: runCommand,
  edit: runDocumentEdit,
  allowed: editAllowed,
  stamps: sessionStamps,
  text: sessionTextPorts
};

const review: ReviewFacts = { reviewing: reviewMode, refuseInReview: reviewBlocked };

const flags: Pick<ViewFlags, "findOpen" | "setFindOpen"> = {
  findOpen: () => viewFlags().findOpen(),
  setFindOpen: (open) => viewFlags().setFindOpen(open)
};

const place: DocumentPlace = {
  home: () => currentHome(),
  connection: () => currentConn(),
  fileHome: () => fileHome(),
  importHome: () => importHome(),
  homeConn: () => homeConn(),
  serverHomeId: () => serverHomeId(),
  serverHomeRev: () => documentLocation().serverHomeRev(),
  serverOf: (connection) => documentLocation().serverOf(connection),
  stillOnServer: (connection) => stillOnServer(connection),
  writtenOut: () => documentLocation().writtenOut(),
  onChange: (listener) => documentLocation().onChange(listener),
  arrivingOnLink: () => arrivingOnLink(),
  serverMode: () => serverStatus().mode(),
  linkTurnedOff: () => serverStatus().linkTurnedOff(),
  sessionExpired: () => serverStatus().sessionExpired(),
  bookmarks: () => serverStatus().bookmarks(),
  bookmarkById: (id) => serverStatus().bookmarkById(id),
  onServerStatusChange: (listener) => serverStatus().onChange(listener)
};

const text: TextServices<HTMLElement> = {
  cellOf, inertBody, fromHtml, sanitizeHtml, storedHtmlFromDom, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal,
  retagBody(body, cat, target, toName) {
    body.querySelectorAll(".tag-anchor").forEach(function (el) {
      if (el.getAttribute("data-tag-cat") !== cat) return;
      if (normalizeTagName(el.getAttribute("data-tag-name")) !== target) return;
      if (toName !== null) { el.setAttribute("data-tag-name", toName); return; }
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    return body.innerHTML;
  }
};

const undoControl: UndoControl = {
  breakCoalescing: breakUndoCoalescing,
  flush: flushEdits,
  undo,
  redo,
  last: lastUndoEntry
};

const effects: EffectPorts<Element> = {
  notices: { show: showToast, showAction: showActionToast },
  menuItems: { setLabel: setMenuItemLabel, setReason: setMenuItemReason },
  clipboard: { copyText: copyShareText }
};

const ownership: SaveOwnershipPort = { capture: captureOperation, stillOwns };

const pictures: PictureStore = {
  intern,
  internDataUrl,
  recordFor,
  bytesFor: bytesForSync,
  urlFor: urlForSync,
  dataUrlFor: dataUrlForSync,
  isDurable: isDurableSync,
  queuePersist,
  persist,
  ensureBytes: (shas) => ensureBytes(shas),
  imgHtml: blobImgHtml
};

const saves: SaveState = {
  unsaved: () => unsavedChanges(),
  busy: () => saveBusy(),
  onChange: (listener) => onSaveChange(listener),
  dueNow: () => { autoSavePolicy().dueNow(); },
  resume: () => { resumeAutoSave(); },
  setAutoSaveEnabled: (on) => { setAutoSaveEnabled(on); }
};

const production: ProductionIndexOwner = {
  entries: (doc) => productionIndex().entries(doc),
  current: (doc) => productionIndex().current(doc),
  derived: () => productionIndex().derived(),
  resetDerived: () => { productionIndex().resetDerived(); },
  recordsPlan: (doc, viewed) => productionIndex().recordsPlan(doc, viewed)
};

const selection: EditorSelectionPort = {
  dropLink: () => { editorSelection().dropLink(); }
};

const exports: Pick<ExportRegistry, "card" | "cards" | "exporters" | "byAction" | "isAction" | "onChange"> = {
  card: (id) => exportFormats.card(id),
  cards: () => exportFormats.cards(),
  exporters: () => exportFormats.exporters(),
  byAction: (action) => exportFormats.byAction(action),
  isAction: (action) => exportFormats.isAction(action),
  onChange: (listener) => exportFormats.onChange(listener)
};

const lastFile: LastFile = { load: loadLastFileHandle };

const recents: RecentFiles = {
  list: () => desktopPort()?.listRecents(),
  remove: (fileId) => desktopPort()?.removeRecent(fileId),
  clear: () => desktopPort()?.clearRecents(),
  read: (id) => desktopPort()?.readFile(id),
  routeOpen: (request) => desktopPort()?.routeOpen(request)
};

const transitions: Transitions<DocumentDestination> = {
  open: (opening) => documentTransitions().open(opening),
  startNew: (arrival) => documentTransitions().startNew(arrival),
  restore: (restoration) => documentTransitions().restore(restoration),
  recover: (recovery) => documentTransitions().recover(recovery),
  publish: (ctx, publication) => documentTransitions().publish(ctx, publication),
  copyId: () => documentTransitions().copyId()
};

const shared = {
  ...effects,
  actions,
  changes,
  screen: (): ScreenState => screenNow(),
  document: documentReader,
  edits,
  place,
  review,
  flags,
  text,
  saves,
  production,
  selection,
  exports,
  ownership,
  pictures,
  lastFile,
  recents,
  undo: undoControl,
  transitions
};

export function sharedPorts(): typeof shared {
  return shared;
}
