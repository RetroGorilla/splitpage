import { neverWrittenOut, type WrittenMarks } from "../../application/recovery/pristine.ts";

export const BOOT_OPEN_REASON = "boot: the version this page loaded, nothing to merge";

export interface StashOptions<Doc> {
  readonly recovery: true;
  readonly newBase: () => Doc;
  readonly report: false;
}

export interface StashResult<Doc, Report> {
  readonly state: Doc;
  readonly report?: Report | null;
}

export interface InitialDocumentPorts<Loaded extends WrittenMarks, Doc, Report> {
  readonly pristine: () => boolean;
  readonly load: (pristine: boolean) => PromiseLike<Loaded>;
  readonly clone: (loaded: Loaded) => Doc;
  readonly applyStash: (loaded: Loaded, options: StashOptions<Doc>) => StashResult<Doc, Report>;
  readonly liveDocument: () => unknown;
  readonly open: (document: Doc, reason: string) => void;
  readonly firstDraw: () => void;
  readonly refreshChrome: readonly (() => void)[];
  readonly reportRecovery: (report: Report) => void;
  readonly toastLastEditor: (loaded: Loaded) => void;
  readonly resumeLastProject: () => void;
  readonly syncIdentity: () => void;
  readonly openIdentityChannel: () => void;
  readonly notifyDesktop: () => void;
  readonly startHistoryMigration: () => void;
}

function adopt<Loaded extends WrittenMarks, Doc, Report>(ports: InitialDocumentPorts<Loaded, Doc, Report>, desktop: boolean, loaded: Loaded): void {
  const applied = ports.applyStash(loaded, {
    recovery: true,
    newBase: () => ports.clone(loaded),
    report: false
  });
  if (ports.liveDocument() !== applied.state) {
    ports.open(applied.state, BOOT_OPEN_REASON);
  }
  ports.firstDraw();
  for (const refresh of ports.refreshChrome) refresh();
  if (applied.report) ports.reportRecovery(applied.report);
  else ports.toastLastEditor(loaded);
  if (!applied.report && neverWrittenOut(loaded) && !desktop) ports.resumeLastProject();
}

function setUpIdentityAndHistory<Loaded extends WrittenMarks, Doc, Report>(ports: InitialDocumentPorts<Loaded, Doc, Report>, desktop: boolean): void {
  ports.syncIdentity();
  if (desktop) ports.notifyDesktop();
  else ports.openIdentityChannel();
  ports.startHistoryMigration();
}

export function openInitialDocument<Loaded extends WrittenMarks, Doc, Report>(
  ports: InitialDocumentPorts<Loaded, Doc, Report>,
  desktop: boolean,
  current: () => boolean
): Promise<void> {
  return Promise.resolve(ports.load(ports.pristine())).then((loaded) => {
    if (!current()) return;
    adopt(ports, desktop, loaded);
    setUpIdentityAndHistory(ports, desktop);
  });
}
