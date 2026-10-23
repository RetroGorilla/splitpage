import type { ActionRegistry } from "../../application/actions.ts";
import type { EffectPorts } from "../../application/effects/ports.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";
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
import { currentDocument, onDocumentReplaced, onRefresh, onSessionChange, readSession } from "../../legacy/session-bridge.ts";

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

const shared = {
  ...effects,
  actions,
  changes,
  screen: (): ScreenState => screenNow(),
  document: documentReader,
  place,
  review,
  text
};

export function sharedPorts(): typeof shared {
  return shared;
}
