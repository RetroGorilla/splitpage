import type { ValidatedDocument } from "../../core/document/validated.ts";
import { refsIn } from "../../../shared/blob-policy.ts";
import { autoSaveWhere } from "./autosave.ts";
import { createSaveCompletion } from "./save-completion.ts";
import { cloneState } from "../../core/document/clone.ts";
import { fileKindFromName } from "../../../shared/file-names.ts";
import { slugify } from "../../../shared/text.ts";
import { fileTitleChange } from "../../core/document/file-title.ts";
import type { FileTitleChange } from "../../core/document/file-title.ts";
import { deepFreeze } from "../../core/document/freeze.ts";
import type { ExportCaptureOptions, ExportDocument } from "../../core/document/export-document.ts";
import type { NoticeKind } from "../effects/ports.ts";
import type { DeliverOptions } from "../files/file-delivery.ts";
import type { Home, HomeFields } from "../location/document-location.ts";
import type { DocumentView } from "../session/document-session.ts";
import type { Operations } from "../session/operation.ts";
import type { AutoSaveChange } from "./autosave.ts";
import type { DestinationKey, SaveJob, SaveLanding, WriterResult } from "./coordinator.ts";
import type { SaveDestination } from "./destinations.ts";
import type { LandedWrite, SaveCompletion } from "./save-completion.ts";
import type { BundleHandover, FileSaveDialogs, FileSaveHandle, FileSavePorts, FileSaveRequest, FileSaveTarget, FileSavingMount, FileSavingPorts } from "./file-saving-ports.ts";
import type { AutoSaveTarget } from "./status.ts";

interface WriteOptions {
  readonly saveAs?: boolean;
  readonly auto?: boolean;
  readonly force?: boolean;
}

type FileSavingBaseline = NonNullable<Home["diskBase"]>;
type FileSavingCompletion = SaveCompletion<FileSavingBaseline, ValidatedDocument>;

let ports: FileSavingPorts | null = null;
let completion: FileSavingCompletion | null = null;

function mountedPorts(): FileSavingPorts {
  if (!ports) throw new Error("The file saving is not started yet");
  return ports;
}

function mountedCompletion(): FileSavingCompletion {
  if (!completion) throw new Error("The file saving is not started yet");
  return completion;
}

function mintDocId(): string { return mountedPorts().ids.docId(); }
function nowIso(): string { return mountedPorts().clock.nowIso(); }
function currentDocument(): DocumentView | null { return mountedPorts().document.current(); }
function documentLocation(): FileSavingPorts["location"] { return mountedPorts().location; }
function currentHome(): Home { return mountedPorts().location.home(); }
function fileHome(): Home | null { return mountedPorts().location.fileHome(); }
function setHome(kind: string, fields?: HomeFields | null): Home { return mountedPorts().location.setHome(kind, fields); }
function rememberLastFileHandle(handle: FileSaveHandle): Promise<void> { return mountedPorts().lastFile.remember(handle); }
function ensureBytes(shas: readonly string[]): Promise<unknown> { return mountedPorts().pictures.ensureBytes(shas); }
function captureExportDocument(opts?: ExportCaptureOptions | null): ExportDocument { return mountedPorts().exports.captureExportDocument(opts); }
function buildSplitpageFile(doc: ExportDocument): string { return mountedPorts().formats.buildSplitpage(doc); }
function buildMarkdownProject(doc: ExportDocument): string { return mountedPorts().formats.buildMarkdown(doc); }
function fileImagesMissing(doc: ExportDocument): readonly string[] { return mountedPorts().formats.imagesMissing(doc); }
function saveDialogs(slug: string): FileSaveDialogs { return mountedPorts().files.dialogs(slug); }
function pickTarget(dialogs: FileSaveDialogs): Promise<FileSaveTarget | { readonly kind: "cancelled" }> { return mountedPorts().files.pick(dialogs); }
function existingTarget(handle: FileSaveHandle): FileSaveTarget { return mountedPorts().files.existing(handle); }
function checkFileConflict(handle: FileSaveHandle, lastModified: number | null | undefined): ReturnType<FileSavingPorts["files"]["checkConflict"]> { return mountedPorts().files.checkConflict(handle, lastModified); }
function writeToHandle(handle: FileSaveHandle, body: string): Promise<{ readonly lastModified: number | null }> { return mountedPorts().files.write(handle, body); }
function isAbort(error: unknown): boolean { return mountedPorts().files.isAbort(error); }
function deliverFile(filename: string, data: unknown, opts?: DeliverOptions | null): Promise<boolean> { return mountedPorts().delivery.deliver(filename, data, opts); }
function autoSavePolicy(): ReturnType<FileSavingPorts["saves"]["policy"]> { return mountedPorts().saves.policy(); }
function haltAutoSave(reason: string): void { return mountedPorts().saves.halt(reason); }
function resumeAutoSave(): void { return mountedPorts().saves.resume(); }
function saveChanges(): number { return mountedPorts().saves.changes(); }
function showToast(message: string, kind?: NoticeKind, sticky?: boolean): unknown { return mountedPorts().notices.show(message, kind, sticky); }
function warnImagesLeftOut(count: number, name: string): void { return mountedPorts().notices.imagesLeftOut(count, name); }
function getEditorName(): string { return mountedPorts().preferences.editorName(); }
function preferences(): FileSavingPorts["preferences"] { return mountedPorts().preferences; }

const SAVED: WriterResult = Object.freeze({ kind: "saved" });
const CANCELLED: WriterResult = Object.freeze({ kind: "cancelled" });
const FAILED: WriterResult = Object.freeze({ kind: "failed" });
const FILE_CHANGED = "The file changed on disk since it was opened";
const CONFLICTED: WriterResult = Object.freeze({ kind: "refused", reason: "The file changed on disk since it was opened" });

function landedSave(job: SaveJob<FileSaveRequest>, captured: ExportDocument, published: ValidatedDocument, forkDocId: string | null, docIdAtSave: string, seqAtSave: number, landed: () => LandedWrite<FileSavingBaseline> | null, naming: FileTitleChange | null): SaveLanding {
  return {
    current: function () {
      mountedCompletion().confirmWrite({ captured, published, forkDocId, docIdAtSave, seqAtSave, landed: landed(), naming });
      if (forkDocId) job.moved();
    },
    obsolete: function () { adoptSavedCopyDocId(forkDocId, docIdAtSave, false); }
  };
}

async function writeDoc(opts: WriteOptions | null | undefined, job: SaveJob<FileSaveRequest>): Promise<WriterResult> {
  opts = opts || {};
  let saveAs = !!opts.saveAs;
  const auto = !!opts.auto;
  if (!auto) resumeAutoSave();

  const converting = !saveAs && currentHome().kind === "file" && currentHome().format === "html";
  if (converting) {
    saveAs = true;
    showToast("Older .html projects are saved as Markdown from now on — choose where to keep it.", "ok");
  }

  const forkDocId = (saveAs && opts.saveAs && documentLocation().writtenOut()) ? mintDocId() : null;
  const docIdAtSave = (currentDocument() as { readonly docId: string }).docId;
  const homeAtSave = currentHome();
  let captured = captureExportDocument({
    docId: forkDocId,
    stamp: { rev: ((currentDocument() as { readonly rev: number }).rev || 0) + 1, lastEditedBy: getEditorName(), lastEditedAt: nowIso() }
  });
  let published = cloneState(captured.document);
  const firstSave = !documentLocation().writtenOut();
  let naming: FileTitleChange | null = null;
  const seqAtSave = saveChanges();
  const slug = slugify(published.title);
  const reusing = !saveAs && fileHome() ? fileHome() : null;
  let kind = saveAs ? "md" : ((reusing && reusing.format as string | null) || "md");
  let prevHome: Home | null = null;
  let retarget: Home | null = null;
  let pickedFor: Home | null = null;
  let wrote = false;
  let move: BundleHandover | null = null;

  function retargetTo(handle: FileSaveHandle, k: string): void {
    if (!job.owns()) return;
    move = mountedPorts().bundles.beginMove();
    prevHome = currentHome();
    retarget = setHome("file", { handle: handle, format: k, name: handle.name });
    pickedFor = retarget;
    job.moved();
  }
  function undoRetarget(): void {
    if (retarget && !wrote && currentHome() === retarget) {
      documentLocation().restoreHome(prevHome as Home);
    }
    retarget = null;
  }

  let written: WriterResult;
  try {
    const target = reusing ? existingTarget(reusing.handle as FileSaveHandle) : await pickTarget(saveDialogs(slug));
    if (target.kind === "cancelled") return CANCELLED;
    if (target.kind === "handle" && target.picked) {
      kind = fileKindFromName(target.handle.name) === "splitpage" ? "splitpage" : "md";
      naming = fileTitleChange(captured.document, target.handle.name, firstSave);
      if (naming) {
        const named = Object.assign({}, captured.document, {
          title: naming.title, titleOrigin: naming.titleOrigin, titleVersion: naming.titleVersion
        });
        if (!naming.titleVersion) Reflect.deleteProperty(named, "titleVersion");
        captured = deepFreeze({ ...captured, document: named, title: naming.title });
        published = cloneState(captured.document);
      }
      retargetTo(target.handle, kind);
    }

    if (reusing && !opts.force) {
      const check = await checkFileConflict(reusing.handle as FileSaveHandle, homeAtSave.lastModified as number | null | undefined);
      if (!check.ok) {
        if ("denied" in check) throw new Error("permission to change " + (reusing.handle as FileSaveHandle).name + " was withdrawn, so use Save a copy or open the file again");
        if (!auto) return { kind: "refused", reason: FILE_CHANGED, conflict: { fileName: (reusing.handle as FileSaveHandle).name, current: check.current, kind: "project" } };
        haltAutoSave("Autosave is paused — " + (reusing.handle as FileSaveHandle).name +
                     " changed on disk since it was opened. Press Save to sort it out.");
        return CONFLICTED;
      }
    }

    await ensureBytes(refsIn(published));
    const imagesLeftOut = fileImagesMissing(captured).length;

    const filename = slug + (kind === "splitpage" ? ".splitpage" : ".md");
    let body: string;
    try {
      body = kind === "splitpage" ? buildSplitpageFile(captured) : buildMarkdownProject(captured);
    } catch (e) {
      showToast("Could not prepare the file to save.", "error");
      return FAILED;
    }

    if (target.kind === "handle") {
      const handle = target.handle;
      const landedOn = await writeToHandle(handle, body);
      wrote = true;
      job.landed(landedSave(job, captured, published, forkDocId, docIdAtSave, seqAtSave, function () {
        const landedHome = fileHome() && (fileHome() as Home).handle === handle ? currentHome() : null;
        return landedHome ? { home: landedHome, lastModified: landedOn.lastModified } : null;
      }, naming));
      if (pickedFor && currentHome() === pickedFor) rememberLastFileHandle(handle);
      const handover = move as BundleHandover | null;
      if (handover) {
        const landedHome = fileHome();
        move = null;
        if (job.owns() && landedHome && landedHome.handle === handle) handover.landed();
        else handover.abandoned();
      }
      if (!auto) showToast((saveAs ? "Saved a new copy: " : "Saved to ") + handle.name, "ok");
      warnImagesLeftOut(imagesLeftOut, handle.name);
      written = SAVED;
    } else {
      const ok = await deliverFile(filename, body, { savedMsg: "Downloaded " + filename });
      if (!ok) return CANCELLED;
      wrote = true;
      job.landed(landedSave(job, captured, published, forkDocId, docIdAtSave, seqAtSave, function () { return null; }, null));
      warnImagesLeftOut(imagesLeftOut, filename);
      written = SAVED;
    }
  } catch (err) {
    if (isAbort(err)) {
      written = CANCELLED;
    } else {
      const why = err && (err as Error).message ? (err as Error).message : "please try again";
      showToast("Could not save — " + why + ".", "error");
      if (auto) haltAutoSave("Autosave is paused — the last save failed (" + why + "). Press Save to try again.");
      written = { kind: "failed", error: err };
    }
  } finally {
    undoRetarget();
    const unsettled = move as BundleHandover | null;
    if (unsettled) unsettled.abandoned();
  }
  return written;
}

function adoptSavedCopyDocId(forkDocId: string | null, docIdAtSave: string, owned: boolean): void {
  mountedCompletion().adoptSavedCopyDocId(forkDocId, docIdAtSave, owned);
}

function readAutoSavePref(): boolean {
  return preferences().autosave();
}

function fileAutoSaveTarget(): AutoSaveTarget {
  const file = fileHome();
  return autoSaveWhere({
    file: file ? { handle: file.handle, format: (file.format as string | null) || null } : null
  });
}

function updateAutoSaveMenu(): void {
  const item = mountedPorts().page.getElementById("menu-autosave");
  if (!item) return;
  const on = autoSavePolicy().enabled();
  item.setAttribute("aria-checked", on ? "true" : "false");
  item.classList.toggle("is-on", on);
}

function autoSaveChanged(what: AutoSaveChange): void {
  if (what === "enabled") updateAutoSaveMenu();
}

const FILE_REQUESTS: readonly string[] = Object.freeze(["saveAs", "save", "auto", "autosave", "force"]);

function fileTakes(request: FileSaveRequest): boolean {
  return FILE_REQUESTS.indexOf(request.kind) !== -1;
}

function writeToFile(job: SaveJob<FileSaveRequest>): Promise<WriterResult> {
  const kind = job.request.kind;
  return writeDoc({ auto: kind === "auto" || kind === "autosave", force: kind === "force", saveAs: kind === "saveAs" }, job);
}

function fileDestination(): SaveDestination<FileSaveRequest, unknown> {
  return { id: "file", takes: fileTakes, autoSaveTarget: fileAutoSaveTarget, write: writeToFile };
}

const NO_DESTINATION_KEY = Object.freeze({});

function destinationKeyOf(h: unknown): DestinationKey {
  if (!h || (h as Home).kind === "none") return { owner: NO_DESTINATION_KEY, name: "none" };
  const handle = (h as Home).handle as { readonly _desktopId?: unknown } | null | undefined;
  if (handle && handle._desktopId) return { owner: "desktop:" + String(handle._desktopId), name: "handle" };
  if (handle) return { owner: handle, name: "handle" };
  return { owner: h, name: (h as Home).kind };
}

function reportObsoleteSave(request: FileSaveRequest, here: boolean): void {
  if (!here || !currentDocument()) return;
  showToast(obsoleteSaveText((currentDocument() as { readonly title: string }).title), "warn");
}

export function obsoleteSaveText(title: string | null | undefined): string {
  return "An earlier save of “" + (title || "Untitled Script") + "” finished after you reopened it. Your open copy is unchanged.";
}

function savePorts(ownership: Operations): FileSavePorts {
  return {
    destination: function () { return currentHome(); },
    keyOf: destinationKeyOf,
    obsolete: reportObsoleteSave,
    ownership: ownership,
    autosave: {
      enabledAtStart: readAutoSavePref,
      changed: autoSaveChanged
    }
  };
}

export function mountFileSaving(given: FileSavingPorts): FileSavingMount {
  ports = given;
  const mounted = given;
  const completed = createSaveCompletion(given);
  completion = completed;
  return {
    destination: fileDestination,
    savePorts: savePorts,
    updateAutoSaveMenu: updateAutoSaveMenu,
    dispose: function () {
      if (ports === mounted) ports = null;
      if (completion === completed) completion = null;
    }
  };
}
