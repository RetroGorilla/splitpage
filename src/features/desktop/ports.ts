import type { DesktopDocumentStateOwner } from "../../application/desktop/document-state.ts";
import type { DesktopHandOff, DesktopOpenedFile, DesktopShell, PrompterElsewhere } from "../../application/desktop/shell.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { SaveState } from "../../application/save/save-state.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { StartupSignal } from "../../application/startup-signal.ts";
import type { ScreenState } from "../../application/screen.ts";

export interface DesktopOpening {
  readonly kind: "file";
  readonly file: unknown;
  readonly handle: unknown;
}

export interface DesktopFileSource {
  readonly getFile: () => Promise<unknown>;
}

export interface DesktopMount extends DesktopHandOff {
  readonly openPrompterInChromium: () => Promise<PrompterElsewhere>;
  readonly initDesktop: () => void;
  readonly runMenuCommand: (command: string) => void;
  readonly wireReassignDocId: () => void;
  readonly dispose: () => void;
}

export interface DesktopPorts {
  readonly running: () => boolean;
  readonly shell: () => DesktopShell | null;
  readonly canOpenPrompter: { readonly browser: () => boolean; readonly chromium: () => boolean };
  readonly makeHandle: (entry: DesktopOpenedFile) => DesktopFileSource;
  readonly wireBlobs: () => void;
  readonly document: Pick<DocumentReader, "current">;
  readonly place: Pick<DocumentPlace, "fileHome">;
  readonly notices: Pick<NoticePort, "show">;
  readonly documents: { readonly open: (opening: DesktopOpening) => Promise<unknown> };
  readonly saves: Pick<SaveState, "unsaved"> & { readonly save: () => Promise<unknown> };
  readonly startup: StartupSignal;
  readonly flushDraft: (request: { readonly keep: boolean }) => unknown;
  readonly reassignDocId: (toId: string, message: unknown) => boolean;
  readonly documentState: Pick<DesktopDocumentStateOwner, "notify" | "settled" | "awaitHanded">;
  readonly menuCommands: { readonly run: (command: string) => boolean };
}

export interface DesktopActionPorts {
  readonly screen: () => ScreenState;
  readonly running: () => boolean;
  readonly canOpenPrompter: DesktopPorts["canOpenPrompter"];
}
