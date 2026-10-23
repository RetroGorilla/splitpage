import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import type { ActionRegistry } from "../../application/actions.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { ExportRegistry } from "../../application/export/registry.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { DesktopVideo } from "../../application/media/desktop-video.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { SaveState } from "../../application/save/save-state.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { ProductionIndexOwner } from "../../core/production/index.ts";
import { arrivingOnLink } from "../../js/13-hosted.js";
import { appActions } from "../../legacy/app-actions.ts";
import { cacheSeal } from "../../legacy/cache-freeze.ts";
import { productionReaders } from "../../legacy/document-ports.ts";
import { exportFormats } from "../../legacy/export-formats.ts";
import {
  currentConn, currentHome, documentLocation, fileHome, homeConn, importHome, reviewBlocked, reviewMode,
  serverHomeId, serverStatus, stillOnServer
} from "../../legacy/location-bridge.ts";
import { htmlToPlainText } from "../../legacy/plain-text.ts";
import { PREF_EVENT, preferences } from "../../legacy/preferences-bridge.ts";
import { autoSavePolicy, onSaveChange, resumeAutoSave, saveBusy, unsavedChanges } from "../../legacy/save-bridge.ts";
import { productionIndex } from "../../legacy/production-index-bridge.ts";
import { cellOf, fromHtml, htmlToMarkdown, inertBody, sanitizeHtml, storedHtmlFromDom } from "../../legacy/richtext.ts";
import { screenNow } from "../../legacy/screen-state.ts";
import { currentDocument, editAllowed, onDocumentReplaced, onRefresh, onSessionChange, readSession, runCommand, runDocumentEdit, sessionStamps, sessionTextPorts } from "../../legacy/session-bridge.ts";

const actions: Pick<ActionRegistry, "invoke" | "view"> = {
  invoke: (id, source, input) => appActions.invoke(id, source, input),
  view: (id, source) => appActions.view(id, source)
};

const changes: PreferenceChanges = {
  onChange(listener) {
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
    document.addEventListener(PREF_EVENT, onPreference);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener(PREF_EVENT, onPreference);
      window.removeEventListener("storage", onStorage);
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
  cellOf, inertBody, fromHtml, sanitizeHtml, storedHtmlFromDom, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal
};

const saves: SaveState = {
  unsaved: () => unsavedChanges(),
  busy: () => saveBusy(),
  onChange: (listener) => onSaveChange(listener),
  dueNow: () => { autoSavePolicy().dueNow(); },
  resume: () => { resumeAutoSave(); }
};

const production: ProductionIndexOwner = {
  entries: (doc) => productionIndex().entries(doc),
  current: (doc) => productionIndex().current(doc),
  derived: () => productionIndex().derived(),
  resetDerived: () => { productionIndex().resetDerived(); },
  recordsPlan: (doc, viewed) => productionIndex().recordsPlan(doc, viewed)
};

const exports: Pick<ExportRegistry, "card" | "cards" | "exporters" | "byAction" | "isAction" | "onChange"> = {
  card: (id) => exportFormats.card(id),
  cards: () => exportFormats.cards(),
  exporters: () => exportFormats.exporters(),
  byAction: (action) => exportFormats.byAction(action),
  isAction: (action) => exportFormats.isAction(action),
  onChange: (listener) => exportFormats.onChange(listener)
};

const desktopVideo: DesktopVideo = {
  grant: (file) => desktopPort()?.grantVideoFile(file) ?? Promise.resolve(null),
  open: (token) => desktopPort()?.openVideoFile(token) ?? Promise.resolve(null),
  thumbnail: (host, ref) => desktopPort()?.videoThumbnail(host, ref) ?? Promise.resolve(null)
};

const shared = {
  actions,
  changes,
  screen: (): ScreenState => screenNow(),
  document: documentReader,
  edits,
  place,
  review,
  text,
  saves,
  production,
  exports,
  desktopVideo
};

export function sharedPorts(): typeof shared {
  return shared;
}
