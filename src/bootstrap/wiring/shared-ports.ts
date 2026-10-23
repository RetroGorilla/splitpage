import type { ActionRegistry } from "../../application/actions.ts";
import type { LaunchFacts } from "../../application/desktop-presence.ts";
import type { FileDelivery } from "../../application/files/file-delivery.ts";
import type { LastFile } from "../../application/files/last-file.ts";
import type { SeedCheck } from "../../application/preferences/seed-check.ts";
import type { DraftResume } from "../../application/recovery/draft-resume.ts";
import type { SidePanels } from "../../application/side-panels.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { loadLastFileHandle } from "../../js/00-prelude.js";
import { deliverFile } from "../../legacy/file-delivery.ts";
import { sidePanels as currentSidePanels } from "../../legacy/panels-bridge.ts";
import { draftResume as currentDraftResume } from "../../legacy/recovery-bridge.ts";
import { seedCheckPasses } from "../../legacy/seed-check.ts";
import type { EffectPorts } from "../../application/effects/ports.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentEdits } from "../../application/session/document-edits.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import { arrivingOnLink } from "../../js/13-hosted.js";
import { appActions } from "../../legacy/app-actions.ts";
import { copyShareText, setMenuItemLabel, setMenuItemReason, showActionToast, showToast } from "../../legacy/effects-bridge.ts";
import { cacheSeal } from "../../legacy/cache-freeze.ts";
import { productionReaders } from "../../legacy/document-ports.ts";
import {
  currentConn, currentHome, documentLocation, fileHome, homeConn, importHome, reviewBlocked, reviewMode,
  serverHomeId, serverStatus, stillOnServer
} from "../../legacy/location-bridge.ts";
import { htmlToPlainText } from "../../legacy/plain-text.ts";
import { PREF_EVENT, preferences } from "../../legacy/preferences-bridge.ts";
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

const effects: EffectPorts<Element> = {
  notices: { show: showToast, showAction: showActionToast },
  menuItems: { setLabel: setMenuItemLabel, setReason: setMenuItemReason },
  clipboard: { copyText: copyShareText }
};

const sidePanels: Pick<SidePanels, "closeAll"> = {
  closeAll: () => currentSidePanels().closeAll()
};

const fileDelivery: FileDelivery = {
  deliver: (filename, data, options) => deliverFile(filename, data, options)
};

const draftResume: Pick<DraftResume, "restorePending"> = {
  restorePending: () => currentDraftResume().restorePending()
};

const seedCheck: SeedCheck = { passes: () => seedCheckPasses() };

const launchFacts: LaunchFacts = {
  firstTabOfLaunch: () => desktopPort()?.firstTabOfLaunch ?? false,
  hadPriorSession: () => desktopPort()?.hadPriorSession ?? false,
  launchIntent: () => desktopPort()?.launchIntent ?? null,
  hasDraftToRestore: () => desktopPort()?.hasDraftToRestore ?? false
};

const lastFile: LastFile = { load: () => loadLastFileHandle() };

const shared = {
  ...effects,
  actions,
  changes,
  sidePanels,
  fileDelivery,
  draftResume,
  seedCheck,
  launchFacts,
  lastFile,
  screen: (): ScreenState => screenNow(),
  document: documentReader,
  edits,
  place,
  review,
  text
};

export function sharedPorts(): typeof shared {
  return shared;
}
