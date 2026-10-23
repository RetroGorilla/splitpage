import type { ActionRegistry } from "../../application/actions.ts";
import type { ReviewFacts } from "../../application/collaboration/review.ts";
import type { PreferenceChange, PreferenceChanges } from "../../application/preferences/preferences.ts";
import type { ScreenState } from "../../application/screen.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { TextServices } from "../../application/text/services.ts";
import { appActions } from "../../legacy/app-actions.ts";
import { cacheSeal } from "../../legacy/cache-freeze.ts";
import { productionReaders } from "../../legacy/document-ports.ts";
import { reviewBlocked, reviewMode } from "../../legacy/location-bridge.ts";
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

const review: ReviewFacts = { reviewing: reviewMode, refuseInReview: reviewBlocked };

const text: TextServices<HTMLElement> = {
  cellOf, inertBody, fromHtml, sanitizeHtml, storedHtmlFromDom, htmlToMarkdown, htmlToPlainText, productionReaders, cacheSeal
};

const shared = {
  actions,
  changes,
  screen: (): ScreenState => screenNow(),
  document: documentReader,
  review,
  text
};

export function sharedPorts(): typeof shared {
  return shared;
}
