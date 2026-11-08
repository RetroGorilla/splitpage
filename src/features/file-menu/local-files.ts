import type { BusyBarArguments } from "../../application/effects/ports.ts";
import type { LocalFileMenuPorts, LocalFileMenuControls } from "./local-files-ports.ts";
import { formatTimestamp } from "../common/comment-time.ts";
import { exportToggleOptions } from "../../application/export/registry.ts";
import { unshownCharactersText } from "../../application/export/diagnostics.ts";
import { slugify } from "../../../shared/text.ts";

let mounted: LocalFileMenuControls | null = null;

function mountLocalFileMenu(next: LocalFileMenuPorts) {
let ports: LocalFileMenuPorts | null = next;
let active = true;
const conflictTimers = new Set<ReturnType<typeof setTimeout>>();

function running() {
  if (!active) throw new Error("The local file menu is not started yet");
  return ports as LocalFileMenuPorts;
}

function currentDocument(...args: Parameters<LocalFileMenuPorts["document"]["current"]>) { return running().document.current(...args); }
function preferences() { return running().preferences; }
function importHome(...args: Parameters<LocalFileMenuPorts["place"]["importHome"]>) { return running().place.importHome(...args); }
function fileHome(...args: Parameters<LocalFileMenuPorts["place"]["fileHome"]>) { return running().place.fileHome(...args); }
function captureExportDocument(...args: Parameters<LocalFileMenuPorts["exports"]["captureExportDocument"]>) { return running().exports.captureExportDocument(...args); }
function loadExportAssets(...args: Parameters<LocalFileMenuPorts["exports"]["loadExportAssets"]>) { return running().exports.loadExportAssets(...args); }
function exportAssetsRequest(...args: Parameters<LocalFileMenuPorts["assets"]["request"]>) { return running().assets.request(...args); }
function standaloneHtmlFor(...args: Parameters<LocalFileMenuPorts["standaloneHtml"]>) { return running().standaloneHtml(...args); }
function warnImagesLeftOut(...args: Parameters<LocalFileMenuPorts["imagesLeftOut"]>) { return running().imagesLeftOut(...args); }
function withBusyBar<T>(...args: BusyBarArguments<T>) { return running().notices.busy.withBar(...args); }
function deliverFile(...args: Parameters<LocalFileMenuPorts["delivery"]["deliver"]>) { return running().delivery.deliver(...args); }
function showToast(...args: Parameters<LocalFileMenuPorts["notices"]["show"]>) { return running().notices.show(...args); }
function offerFileMerge(...args: Parameters<LocalFileMenuPorts["merge"]["offer"]>) { return running().merge.offer(...args); }
function resetMergeOffer(...args: Parameters<LocalFileMenuPorts["merge"]["reset"]>) { return running().merge.reset(...args); }
function isExportAction(...args: Parameters<LocalFileMenuPorts["exportControls"]["isExportAction"]>) { return running().exportControls.isExportAction(...args); }
function rememberExport(...args: Parameters<LocalFileMenuPorts["exportControls"]["rememberExport"]>) { return running().exportControls.rememberExport(...args); }

function updateFileChip() {
  updateHeaderFileChip();
}

function fileChipListeners(refresh: () => void): ReturnType<LocalFileMenuControls["fileChipListeners"]> {
  return {
    session: function (change) {
      if (!active) return;
      if (change.kind === "adopt" || change.kind === "disk" || change.kind === "recovery" || change.kind === "reload") refresh();
    },
    location: function (change) {
      if (!active) return;
      if (change !== "writtenOut") refresh();
    },
    save: function (change) {
      if (!active) return;
      if (change === "clean" || change === "halt") refresh();
    }
  };
}

function updateHeaderFileChip() {
  const chip = document.getElementById("file-chip");
  const imported = importHome();
  if (!imported) {
    (chip as HTMLElement).hidden = true;
    return;
  }
  (chip as HTMLElement).hidden = false;
  (document.getElementById("file-chip-name") as HTMLElement).textContent = imported.name;
  const stateEl = document.getElementById("file-chip-state");
  (stateEl as HTMLElement).textContent = imported.dirty ? "· unsaved changes" : "· up to date";
  (stateEl as HTMLElement).classList.toggle("unsaved", !!imported.dirty);
}

function exportFileName(kind: string, baseName: string, opts?: Parameters<LocalFileMenuControls["exportFileName"]>[2]) {
  const exporter = running().formats.byId(kind);
  return exporter ? exporter.fileName(baseName, opts || {}) : baseName + "." + kind;
}

function exportBaseName() {
  return importHome() ? (importHome() as NonNullable<ReturnType<typeof importHome>>).name.replace(/\.[^.]+$/, "") : slugify((currentDocument() as NonNullable<ReturnType<typeof currentDocument>>).title);
}

function exportRequest(kind: string, opts?: Readonly<Record<string, unknown>>) {
  opts = opts || {};
  const exporter = running().formats.byId(kind) || running().formats.byId("md");
  const doc = captureExportDocument();
  return Object.freeze({
    kind: kind,
    doc: doc,
    options: Object.freeze(Object.assign(exportToggleOptions(running().formats, exporter, opts), {
      allowImageBundle: !!opts.allowImageBundle,
      brollView: Object.freeze(running().brollView.printView(opts.brollView))
    })),
    assets: exportAssetsRequest(doc)
  });
}

async function buildFileData(kind: string, baseName: string, opts?: Readonly<Record<string, unknown>>) {
  const request = exportRequest(kind, opts);
  const registered = running().formats.byId(kind);
  const exporter = registered || running().formats.byId("md");
  if (!(exporter as NonNullable<typeof exporter>).build) throw new Error("The " + kind + " export prints a page and builds no file");
  const home = fileHome();
  const script = home ? home.handle || null : null;
  const assets = await loadExportAssets(request.assets);
  if (!active) throw new Error("The local file menu is not started yet");
  const made = await ((exporter as NonNullable<typeof exporter>).build as NonNullable<NonNullable<typeof exporter>["build"]>)({
    doc: request.doc,
    options: request.options,
    assets: assets,
    ports: { standaloneHtml: standaloneHtmlFor }
  }, baseName);
  if (!active) throw new Error("The local file menu is not started yet");
  const filename = registered
    ? (exporter as NonNullable<typeof exporter>).fileName(baseName, { imageBundle: !!made.imageBundle })
    : baseName + "." + kind;
  if (made.diagnostics) {
    warnImagesLeftOut(made.diagnostics.imagesLeftOut, filename);
    if (made.diagnostics.unshownCharacters) showToast(unshownCharactersText(made.diagnostics.unshownCharacters), "warn");
  }
  return { data: made.data, filename: filename, withFiles: made.withFiles ? { scriptName: made.withFiles.scriptName, script } : null };
}

let pendingResumeHandle: ReturnType<LocalFileMenuControls["pendingHandle"]> = null;

function showResumeBanner(handle: NonNullable<ReturnType<LocalFileMenuControls["pendingHandle"]>>) {
  pendingResumeHandle = handle;
  const banner = document.getElementById("resume-banner");
  (document.getElementById("resume-banner-text") as HTMLElement).textContent =
    " " + (handle.name || "your last project") + " needs a click to reopen.";
  (banner as HTMLElement).hidden = false;
}

function hideResumeBanner() {
  pendingResumeHandle = null;
  (document.getElementById("resume-banner") as HTMLElement).hidden = true;
}

let fileConflictShowToken = 0;

function fileConflictHome(conflict: NonNullable<Parameters<LocalFileMenuControls["showFileConflictView"]>[0]>) {
  return conflict.kind === "project" ? fileHome() : importHome();
}

function showFileConflictView(conflict: Parameters<LocalFileMenuControls["showFileConflictView"]>[0]) {
  if (!conflict) {
    hideFileConflictView();
    return;
  }
  const fileName = conflict.fileName;
  const currentFile = conflict.current;
  if (!currentFile) {
    (document.getElementById("file-conflict-detail") as HTMLElement).textContent =
      "Could not check whether " + fileName + " is still there — it may have been moved, " +
      "deleted, or is on a drive that isn't connected right now. Saving now would recreate it.";
    resetMergeOffer();
    (document.getElementById("file-conflict-modal") as HTMLElement).hidden = false;
    return;
  }
  const when = currentFile.lastModified
    ? formatTimestamp(new Date(currentFile.lastModified).toISOString(), preferences().clock())
    : "recently";
  (document.getElementById("file-conflict-detail") as HTMLElement).textContent =
    fileName + " changed on disk at " + when +
    ", after you opened it here. Saving now would overwrite that version.";
  const token = ++fileConflictShowToken;
  const show = function () {
    if (!active || token !== fileConflictShowToken) return;
    (document.getElementById("file-conflict-modal") as HTMLElement).hidden = false;
  };
  const probe = offerFileMerge(currentFile, fileConflictHome(conflict));
  const timer = setTimeout(show, 1500);
  conflictTimers.add(timer);
  probe.then(function () { clearTimeout(timer); conflictTimers.delete(timer); show(); },
             function () { clearTimeout(timer); conflictTimers.delete(timer); show(); });
}

function hideFileConflictView() {
  fileConflictShowToken++;
  (document.getElementById("file-conflict-modal") as HTMLElement).hidden = true;
  resetMergeOffer();
}

async function exportAs(kind: string, more?: Readonly<Record<string, unknown>>) {
  const printing = running().pdfPrint.export(kind, more, function () { return active; });
  if (printing) return printing;
  const base = exportBaseName();
  let built;
  try {
    built = await withBusyBar("Building the " + kind.toUpperCase() + " file…", function () {
      return buildFileData(kind, base, Object.assign({ allowImageBundle: true }, more));
    });
  } catch (e) {
    if (!active) return;
    showToast("Could not build the " + kind.toUpperCase() + " file.", "error");
    return;
  }
  if (!active) return;
  if (built.withFiles && typeof built.data === "string") {
    await running().scriptFiles.export(built.filename, built.withFiles.scriptName, built.data, built.withFiles.script);
    return;
  }
  await deliverFile(built.filename, built.data, { savedMsg: "Exported " + built.filename });
}

async function runExport(action: string | null) {
  const exporter = running().formats.byAction(action);
  if (!exporter) return false;
  const why = exporter.reason ? exporter.reason(captureExportDocument()) : "";
  if (!active) return false;
  if (why) {
    showToast(exporter.refusal || why + ".", "warn");
    return false;
  }
  await exportAs(exporter.id, exporter.defaults);
  return active;
}

let fileMenuChoiceListeners: ((action: string | null) => void)[] = [];

function onFileMenuChoice(listener: (action: string | null) => void) {
  fileMenuChoiceListeners.push(listener);
  return function () {
    const index = fileMenuChoiceListeners.indexOf(listener);
    if (index !== -1) fileMenuChoiceListeners.splice(index, 1);
  };
}

function noteFileMenuChoice(action: string | null) {
  fileMenuChoiceListeners.forEach(function (listener) { listener(action); });
}

function runExportAction(action: string | null) {
  if (!running().formats.isAction(action)) return false;
  handleFileMenuAction(action, "command-menu");
  return true;
}

function handleFileMenuAction(action: string | null, source?: Parameters<LocalFileMenuPorts["actions"]["invoke"]>[1]) {
  noteFileMenuChoice(action);
  if (action !== "autosave" && action !== "toggle-hide-shot" && action !== "toggle-rundown-min") running().actions.invoke("close-file-menu", "button");
  if (isExportAction(action)) rememberExport(action);
  if (running().actions.has(action)) {
    running().actions.invoke(action, source || "menu");
    return;
  }
  if (!currentDocument()) {
    showToast("Still loading…", "warn"); return;
  }
  if (running().formats.isAction(action)) runExport(action);
}


  const controls: LocalFileMenuControls = { updateFileChip, fileChipListeners, exportFileName, exportBaseName, exportRequest, buildFileData, showResumeBanner, hideResumeBanner, showFileConflictView, exportAs, runExport, onFileMenuChoice, noteFileMenuChoice, runExportAction, handleFileMenuAction, pendingHandle: function () { return pendingResumeHandle; }, dispose: function () {
    if (!active) return;
    active = false;
    fileConflictShowToken++;
    conflictTimers.forEach(clearTimeout);
    conflictTimers.clear();
    fileMenuChoiceListeners = [];
    pendingResumeHandle = null;
    ports = null;
    if (mounted === controls) mounted = null;
  } };
  Object.keys(controls).forEach(function (key) {
    if (key === "dispose") return;
    const call = (controls as unknown as Record<string, (...args: never[]) => unknown>)[key] as (...args: never[]) => unknown;
    (controls as unknown as Record<string, (...args: never[]) => unknown>)[key] = function (...args: never[]) {
      if (!active) throw new Error("The local file menu is not started yet");
      return call(...args);
    };
  });
  return controls;
}

export function startLocalFileMenu(next: LocalFileMenuPorts) {
  if (mounted) throw new Error("The local file menu is already started; stop it first");
  const mine = mountLocalFileMenu(next);
  mounted = mine;
  return mine;
}
