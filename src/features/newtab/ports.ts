import type { ActionRegistry } from "../../application/actions.ts";
import type { LaunchFacts } from "../../application/desktop-presence.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { LastFile } from "../../application/files/last-file.ts";
import type { RecentFileData, RecentFiles } from "../../application/files/recent-files.ts";
import type { DocumentPlace } from "../../application/location/document-place.ts";
import type { Preferences } from "../../application/preferences/preferences.ts";
import type { SeedCheck } from "../../application/preferences/seed-check.ts";
import type { DraftResume } from "../../application/recovery/draft-resume.ts";
import type { SaveConfirmation } from "../../application/save/save-state.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";
import type { StartupSignal } from "../../application/startup-signal.ts";
import type { TextServices } from "../../application/text/services.ts";
import type { DocumentOpening } from "../../application/transitions/sources.ts";
import type { DocumentDestination } from "../../application/transitions/ports.ts";
import type { Transitions } from "../../application/transitions/transitions.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { IdSource } from "../../core/document/ports.ts";

export interface NewTabMount {
  readonly closeNewTabPage: () => void;
  readonly dispose: () => void;
}

export interface StarterChoice {
  readonly id: string;
  readonly name: string;
  readonly desc: string;
  readonly state: { readonly title: string; readonly rows: readonly unknown[] };
}

export interface NewTabPorts {
  readonly document: Pick<DocumentReader, "current">;
  readonly place: Pick<DocumentPlace, "home">;
  readonly desktop: () => boolean;
  readonly recents: RecentFiles;
  readonly launch: Pick<LaunchFacts, "launchIntent" | "hasDraftToRestore">;
  readonly lastFile: LastFile;
  readonly seedCheck: SeedCheck;
  readonly draftResume: Pick<DraftResume, "restorePending">;
  readonly startup: StartupSignal;
  readonly transitions: Pick<Transitions<DocumentDestination>, "startNew">;
  readonly opening: DocumentOpening;
  readonly text: { readonly productionReaders: Pick<TextServices<HTMLElement>["productionReaders"], "wordCount"> };
  readonly notices: Pick<NoticePort, "show">;
  readonly actions: Pick<ActionRegistry, "invoke">;
  readonly preferences: Pick<Preferences, "defaultWpm">;
  readonly saving: SaveConfirmation;
  readonly resetProductionPanel: () => void;
  readonly ids: Pick<IdSource, "id">;
  readonly prepareDocument: (raw: unknown) => ValidatedDocument;
  readonly syncIdentity: () => void;
  readonly importText: (options: { readonly intoNewDocument: (rows: unknown[], scan: (document: ValidatedDocument) => void) => void }) => void;
  readonly openFile: () => Promise<unknown>;
  readonly desktopDownload: { readonly url: () => string; readonly offered: () => boolean };
  readonly starters: readonly StarterChoice[];
  readonly findStarter: (id: string) => StarterChoice | null | undefined;
  readonly recentHandle: (entry: RecentFileData) => { readonly getFile: () => Promise<File> };
}
