import type { WrittenMarks } from "../application/recovery/pristine.ts";
import { takeDesktopDraft, type DesktopDraftPorts } from "./startup/desktop-draft.ts";
import { openInitialDocument, type InitialDocumentPorts } from "./startup/initial-document.ts";
import { guardUnload, registerServiceWorker, watchHistoryMigration } from "./startup/page-lifetime.ts";

export interface PageLifetimePorts {
  readonly window: Window;
  readonly snapshotKey: string;
  readonly unsaved: () => boolean;
}

export interface StartupPorts<Draft, Loaded extends WrittenMarks, Doc, Report> {
  readonly desktop: boolean;
  readonly draft: DesktopDraftPorts<Draft>;
  readonly document: InitialDocumentPorts<Loaded, Doc, Report>;
  readonly page: PageLifetimePorts;
  readonly startDesktop: () => void;
}

export interface Startup {
  readonly openDocument: () => Promise<unknown>;
  readonly ready: () => Promise<unknown> | null;
  readonly finish: () => void;
  readonly dispose: () => void;
}

let running: Startup | null = null;

export function beginStartup<Draft, Loaded extends WrittenMarks, Doc, Report>(
  ports: StartupPorts<Draft, Loaded, Doc, Report>
): Startup {
  if (running) throw new Error("startup has already begun; dispose it first");
  let disposed = false;
  let opened = false;
  let finished = false;
  let opening: Promise<unknown> | null = null;
  const disposers: (() => void)[] = [];
  const current = (): boolean => !disposed;
  const draft = takeDesktopDraft(ports.draft);

  const startup: Startup = {
    openDocument: () => {
      if (opened) throw new Error("the initial document is already opening");
      opened = true;
      opening = openInitialDocument(ports.document, ports.desktop, current).then(() => {
        if (disposed) return undefined;
        return draft.resume(current);
      });
      return opening;
    },
    ready: () => opening,
    finish: () => {
      if (finished) throw new Error("startup has already finished");
      finished = true;
      const page = ports.page;
      disposers.push(watchHistoryMigration(page.window, page.snapshotKey, ports.document.startHistoryMigration));
      disposers.push(guardUnload(page.window, page.unsaved));
      disposers.push(registerServiceWorker(page.window, ports.desktop));
      if (ports.desktop) ports.startDesktop();
    },
    dispose: () => {
      disposed = true;
      while (disposers.length) disposers.pop()?.();
      if (running === startup) running = null;
    }
  };
  running = startup;
  return startup;
}
