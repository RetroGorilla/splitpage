import { createDesktopDocumentState } from "../../application/desktop/document-state.ts";
import type { DesktopDocumentListeners, DesktopDocumentState, DesktopDocumentStateOwner, DesktopDocumentStatePorts } from "../../application/desktop/document-state.ts";
import type { DesktopDraftFlushRequest, DesktopHandOff, PrompterElsewhere } from "../../application/desktop/shell.ts";
import { presence } from "./ports/desktop-presence.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import type { HistoryOwner } from "../../application/recovery/history-ports.ts";
import { draftResume, recoveryStarted } from "./recovery-owners.ts";
import { unsavedChanges } from "./save-owners.ts";
import { documentReader } from "./ports/document.ts";
import { currentHome } from "./location-owner.ts";
import type { DraftFlush } from "../../application/recovery/drafts-ports.ts";

let started: DesktopDocumentStateOwner | null = null;
let handOff: DesktopHandOff | null = null;
let sharedUnsaved: (() => boolean) | null = null;
let sharedFlush: ((mode?: DesktopDraftFlushRequest["fileCopyMode"]) => Promise<DraftFlush>) | null = null;
let pausePublication: object | null = null;

export function holdDesktopDocumentPublication(): () => void {
  const hold = {};
  pausePublication = hold;
  return () => {
    if (pausePublication !== hold) return;
    pausePublication = null;
    started?.notify();
  };
}

export function trackSharedDesktopUnsaved(read: () => boolean, flush: NonNullable<typeof sharedFlush>): () => void {
  sharedUnsaved = read;
  sharedFlush = flush;
  return () => {
    if (sharedUnsaved !== read) return;
    sharedUnsaved = null;
    sharedFlush = null;
  };
}

export function flushSharedDesktopCopy(mode?: DesktopDraftFlushRequest["fileCopyMode"]): Promise<DraftFlush> | undefined {
  return sharedFlush?.(mode);
}

export function legacyDesktopDocumentPorts(history: Pick<HistoryOwner, "isPristineSeedDocument">): DesktopDocumentStatePorts {
  return Object.freeze({
    facts: Object.freeze({
      running: presence.running,
      document: function () { return documentReader.current(); },
      restoring: function () { return recoveryStarted() && draftResume().restorePending(); },
      unsaved: function () { return sharedUnsaved?.() ?? unsavedChanges(); },
      pristine: function () { return history.isPristineSeedDocument(); },
      fileId: function (): string | null {
        const home = currentHome();
        const handle = home.handle as { readonly _desktopId?: string } | null | undefined;
        return (home.kind === "file" && handle && handle._desktopId) || null;
      }
    }),
    publish: function (state: DesktopDocumentState) {
      if (!pausePublication) desktopPort()?.setDocumentState(state);
    }
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
