import { createDesktopDocumentState } from "../application/desktop/document-state.ts";
import type { DesktopDocumentListeners, DesktopDocumentState, DesktopDocumentStateOwner, DesktopDocumentStatePorts } from "../application/desktop/document-state.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { isPristineSeedDocument } from "../js/03a-history-store.js";
import { draftResume, recoveryStarted } from "./recovery-bridge.ts";
import { unsavedChanges } from "./save-bridge.ts";
import { currentDocument } from "./session-bridge.ts";
import { currentHome, homeConn, serverHomeId } from "./location-bridge.ts";

let started: DesktopDocumentStateOwner | null = null;

export function legacyDesktopDocumentPorts(): DesktopDocumentStatePorts {
  return Object.freeze({
    facts: Object.freeze({
      running: runningOnDesktop,
      document: function () { return currentDocument(); },
      restoring: function () { return recoveryStarted() && draftResume().restorePending(); },
      connection: function () { return homeConn(); },
      unsaved: function () { return unsavedChanges(); },
      pristine: function () { return typeof isPristineSeedDocument === "function" && isPristineSeedDocument(); },
      fileId: function (): string | null {
        const home = currentHome();
        const handle = home.handle as { readonly _desktopId?: string } | null | undefined;
        return (home.kind === "file" && handle && handle._desktopId) || null;
      },
      serverKey: function () { return serverHomeId(); }
    }),
    publish: function (state: DesktopDocumentState) { desktopPort()?.setDocumentState(state); }
  });
}

export function startDesktopDocumentState(ports: DesktopDocumentStatePorts): () => void {
  if (started) throw new Error("The desktop document state is already started; stop it first");
  const mine = createDesktopDocumentState(ports);
  started = mine;
  return function () {
    if (started !== mine) return;
    started = null;
    mine.dispose();
  };
}

export function notifyDesktopDocumentState(): void {
  started?.notify();
}

export function handedDocumentSettled(): void {
  started?.settled();
}

export function awaitHandedDocument(intent: string | undefined): void {
  started?.awaitHanded(intent);
}

export function desktopDocumentListeners(): DesktopDocumentListeners {
  return {
    session: function () { started?.listeners().session(); },
    location: function () { started?.listeners().location(); },
    save: function (change) { started?.listeners().save(change); }
  };
}
