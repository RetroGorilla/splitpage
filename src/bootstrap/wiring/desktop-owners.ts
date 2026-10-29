import { createDesktopDocumentState } from "../../application/desktop/document-state.ts";
import type { DesktopDocumentListeners, DesktopDocumentState, DesktopDocumentStateOwner, DesktopDocumentStatePorts } from "../../application/desktop/document-state.ts";
import type { DesktopHandOff, PrompterElsewhere } from "../../application/desktop/shell.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import type { HistoryOwner } from "../../application/recovery/history-ports.ts";
import { draftResume, recoveryStarted } from "./recovery-owners.ts";
import { unsavedChanges } from "../../legacy/save-bridge.ts";
import { currentDocument } from "../../legacy/session-bridge.ts";
import { currentHome } from "../../legacy/location-bridge.ts";

let started: DesktopDocumentStateOwner | null = null;
let handOff: DesktopHandOff | null = null;

export function legacyDesktopDocumentPorts(history: Pick<HistoryOwner, "isPristineSeedDocument">): DesktopDocumentStatePorts {
  return Object.freeze({
    facts: Object.freeze({
      running: runningOnDesktop,
      document: function () { return currentDocument(); },
      restoring: function () { return recoveryStarted() && draftResume().restorePending(); },
      unsaved: function () { return unsavedChanges(); },
      pristine: function () { return history.isPristineSeedDocument(); },
      fileId: function (): string | null {
        const home = currentHome();
        const handle = home.handle as { readonly _desktopId?: string } | null | undefined;
        return (home.kind === "file" && handle && handle._desktopId) || null;
      }
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

export function handDesktopTo(next: DesktopHandOff | null): void {
  handOff = next;
}

export function openPrompterInBrowser(): Promise<PrompterElsewhere> {
  return handOff ? handOff.openPrompterInBrowser() : Promise.resolve({ ok: false, message: "" });
}
