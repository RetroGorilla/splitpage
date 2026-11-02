import { SCHEMA_VERSION } from "../../core/document/fields.ts";
import { cloneState } from "../../core/document/clone.ts";
import { fileKindFromName } from "../../../shared/file-names.ts";
import { createAdoptionCompletion } from "../save/save-completion.ts";
import { NO_DESTINATION } from "./ports.ts";
import type { LocalFileOpening, LocalFilesOwner, LocalFilesOwnerPorts } from "./local-files-ports.ts";
import type { LocalFileData, LocalFileHandle, LocalFileReference } from "../files/local-file-access.ts";
import type { ValidatedDocument } from "../../core/document/validated.ts";
import type { ImportedRow } from "../formats/import-formats.ts";

type FileOptions = NonNullable<LocalFileOpening["options"]>;
type CurrentFileDocument = Pick<NonNullable<ReturnType<LocalFilesOwnerPorts["document"]["current"]>>, "comments" | "title" | "rows">;

function startLocalFiles(ports: LocalFilesOwnerPorts) {
  let active = true;
  const busyReads = new Set<unknown>();
  function finishRead(token: unknown) { if (busyReads.delete(token)) endBusy(token); }
  const currentDocument = ports.document.current;
  const { noteAbsorbedDirty, noteReload } = ports.session;
  const documentTransitions = function () { return ports.transitions; };
  const keepSnapshot = ports.history.keep;
  const completion = createAdoptionCompletion(ports);
  const unsavedChanges = ports.saves.unsaved;
  const fileConflicts = function () { return ports.conflicts; };
  const { setHome, fileHome, importHome } = ports.location;
  const { load: loadLastFileHandle, remember: rememberLastFileHandle } = ports.lastFile;
  const syncDocIdentity = ports.syncIdentity;
  const stampRow = ports.stamps.stampRow;
  const { begin: beginBusy, end: endBusy } = ports.notices.busy;
  const showToast = ports.notices.show;
  const resetProductionPanelState = ports.resetProductionPanel;
  const sidePanels = function () { return ports.panels; };
  const flushEdits = ports.undo.flush;
  const { detectTwoColumnFormat, parseImportRows, docxToRows, csvToRows, normalizeImportedRows, parseProjectFileState } = ports.imports;
  const sanitizeHtml = ports.text.sanitizeHtml;
  const showResumeBanner = ports.resumeNeeded;
  const runningOnDesktop = ports.desktop.running;
  const desktopPort = function () { return ports.desktop; };
  const makeDesktopHandle = ports.files.desktopHandle;
function projectFileSource(): ReturnType<LocalFilesOwner["projectFileSource"]> {
  return {
    id: "project-file",
    takes: function (opening: LocalFileOpening) { return opening.kind === "file"; },
    open: function (opening: LocalFileOpening) {
      const parsed = opening.parsed;
      if (parsed) return adoptProjectState(parsed.state, opening.file, opening.handle || null, parsed.kind, opening.options);
      return openProjectFile(opening.file, opening.handle || null, opening.options);
    }
  };
}

async function openProjectFile(file: LocalFileData | null | undefined, handle: LocalFileReference | null | undefined, opts?: FileOptions | null) {
  opts = opts || {};
  const parsed = await parseProjectFileState(file);
  if (!active) return false;
  if (!parsed) return loadFileIntoEditor(file, handle);
  if (parsed.error === "richtext-depth") {
    showToast(parsed.message, "warn");
    return false;
  }
  if (parsed.error === "unreadable") {
    showToast("Could not read " + (file as LocalFileData).name + ".", "error");
    return false;
  }
  if (parsed.error === "not-splitpage") {
    showToast((file as LocalFileData).name + " doesn't look like a Splitpage file.", "error");
    return false;
  }
  return adoptProjectState(parsed.state, file, handle, parsed.kind, opts);
}

function adoptProjectState(newState: ValidatedDocument, file: LocalFileData | null | undefined, handle: LocalFileReference | null | undefined, kind: string, opts?: FileOptions | null) {
  if (!active) return false;
  opts = opts || {};
  sidePanels().close("newtab-page");

  resetProductionPanelState();
  documentTransitions().open({
    from: { document: newState },
    reason: "adoptProjectState: the project file as it was just read",
    keep: opts.skipSnapshot ? undefined : "Before opening " + (file as LocalFileData).name,
    destination: { kind: "file", fields: { handle: handle || null, format: kind, lastModified: (file as LocalFileData).lastModified || null,
                                           name: (file as LocalFileData).name, diskBase: cloneState(newState) } },
    writtenOut: true
  });

  if (!active) return false;
  completion.projectOpened();
  if (!active) return false;
  const commentNote = (currentDocument() as CurrentFileDocument).comments.length
    ? ", " + (currentDocument() as CurrentFileDocument).comments.length + " comment" + ((currentDocument() as CurrentFileDocument).comments.length === 1 ? "" : "s") : "";
  if (!opts.silent) showToast((opts.resumed ? "Resumed " : "Opened ") + ((currentDocument() as CurrentFileDocument).title || (file as LocalFileData).name) + " — " +
    (currentDocument() as CurrentFileDocument).rows.length + " row" + ((currentDocument() as CurrentFileDocument).rows.length === 1 ? "" : "s") + commentNote, "ok");

  if (active && handle) rememberLastFileHandle(handle);
  return true;
}

async function tryResumeLastProject() {
  const handle = await loadLastFileHandle();
  if (!active || !handle) return;
  let perm;
  try {
    perm = await ports.files.permission(handle, { mode: "readwrite" });
    if (!active) return;
  } catch (e) {
    return;
  }
  if (perm === "granted") {
    await resumeFromHandle(handle);
  } else if (perm === "prompt") {
    showResumeBanner(handle);
  }
}

async function resumeFromHandle(handle: LocalFileReference | null | undefined) {
  try {
    const file = await ports.files.read(handle);
    if (!active) return;
    await openProjectFile(file, handle, { skipSnapshot: !unsavedChanges(), resumed: true });
  } catch (e) {
  }
}

async function loadFileIntoEditor(file: LocalFileData | null | undefined, handle: LocalFileReference | null | undefined, opts?: FileOptions) {
  if (!active) return;
  opts = opts || {};
  let kind = fileKindFromName((file as LocalFileData).name);
  if (kind === "splitpage" || kind === "html") kind = null;
  if (!kind) { showToast("That file type isn't supported — try .docx, .md, .txt or .csv.", "warn"); return; }

  let newRows: ImportedRow[] | undefined, newTitle: string | null = null;
  const readBusy = beginBusy("Reading " + (file as LocalFileData).name + "…");
  busyReads.add(readBusy);
  try {
    if (kind === "docx") {
      const parsed = await docxToRows(file as LocalFileData);
      if (!active) return;
      newTitle = parsed.title;
      newRows = parsed.rows;
      if (!newRows.length && parsed.looseText) {
        const looseMode = detectTwoColumnFormat(parsed.looseText) ? "twocolumn" : "paragraph";
        newRows = normalizeImportedRows(parseImportRows(parsed.looseText, looseMode), sanitizeHtml);
      }
    } else if (kind === "csv") {
      const csvText = await ports.files.text(file as LocalFileData);
      if (!active) return;
      newRows = csvToRows(csvText);
    } else {
      const text = await ports.files.text(file as LocalFileData);
      if (!active) return;
      const mode = detectTwoColumnFormat(text) ? "twocolumn" : "paragraph";
      newRows = normalizeImportedRows(parseImportRows(text, mode), sanitizeHtml);
      const firstHeading = /^#\s+(.+)$/m.exec(text);
      if (firstHeading) newTitle = (firstHeading[1] as string).trim();
    }
  } catch (err) {
    if (!active) return;
    let msg = "Could not read that file.";
    if (err && (err as Error).message === "no-decompression-stream") msg = "This browser can't unzip .docx files — try Chrome or Edge.";
    else if (err && ((err as Error).message === "not-a-zip" || (err as Error).message === "no-document-xml")) msg = "That doesn't look like a Word document.";
    showToast(msg, "error");
    return;
  } finally {
    finishRead(readBusy);
  }

  if (!active) return;
  if (!newRows || !newRows.length) { showToast("No scenes found in that file.", "warn"); return; }


  newRows.forEach(stampRow);
  const openedTitle = newTitle || (file as LocalFileData).name.replace(/\.[^.]+$/, "");
  if (opts.reload) {
    flushEdits();
    noteReload({ title: openedTitle, rows: newRows });
  }
  const importFields = {
    name: (file as LocalFileData).name,
    handle: handle || null,
    format: kind,
    inPlace: !!(handle && (handle as LocalFileHandle).createWritable),
    dirty: false,
    lastModified: (file as LocalFileData).lastModified || null,
    size: (file as LocalFileData).size || null
  };
  if (opts.reload) {
    setHome("import", importFields);
  } else {
    resetProductionPanelState();
    documentTransitions().open({
      from: { raw: { schema: SCHEMA_VERSION, title: openedTitle, rows: newRows } },
      reason: "loadFileIntoEditor: the imported document as it was just read",
      keep: "Before opening " + (file as LocalFileData).name,
      destination: NO_DESTINATION,
      writtenOut: false
    });
  }
  if (!active) return;
  const imported = importHome();

  noteAbsorbedDirty(opts.reload ? "reload" : "adopt");
  if (!active) return;
  if (imported) completion.importOpened(imported);
  sidePanels().close("newtab-page");
  if (typeof syncDocIdentity === "function") syncDocIdentity();
  showToast(opts.reload
    ? "Reloaded " + (file as LocalFileData).name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s")
    : "Opened " + (file as LocalFileData).name + " — " + newRows.length + " row" + (newRows.length === 1 ? "" : "s") +
      " — as a new document", "ok");
}

async function openLocalFile() {
  if (runningOnDesktop()) {
    const entry = await desktopPort().openFileDialog();
    if (!active || !entry) return;
    const r = await desktopPort().routeOpen({ kind: "file", fileId: entry.id });
    if (!active || !r || r.where !== "this-tab") return;
    const desktopHandle = makeDesktopHandle(entry);
    const desktopFile = await ports.files.read(desktopHandle);
    if (!active) return;
    await openProjectFile(desktopFile, desktopHandle);
    return;
  }
  if (ports.files.openPicker) {
    try {
      const handles = await ports.files.openPicker({
        multiple: false,
        types: [{
          description: "Scripts and documents",
          accept: {
            "application/json": [".splitpage"],
            "text/html": [".html", ".htm"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
            "text/markdown": [".md"],
            "text/plain": [".txt"],
            "text/csv": [".csv"]
          }
        }]
      });
      if (!active) return;
      const handle = handles[0];
      const pickedFile = await ports.files.read(handle);
      if (!active) return;
      await openProjectFile(pickedFile, handle);
      return;
    } catch (err) {
      if (!active) return;
      if (err && (err as Error).name === "AbortError") return;
    }
  }
  if (active) ports.chooseFallback();
}

async function reloadFileFromDisk() {
  fileConflicts().close();
  const imported = importHome();
  if (!imported || !imported.handle) return;
  try {
    keepSnapshot("Before reloading " + imported.name + " from disk");
    const importedFile = await ports.files.read(imported.handle);
    if (!active) return;
    await loadFileIntoEditor(importedFile, imported.handle, { reload: true });
  } catch (e) {
    if (active) showToast("Could not re-read that file.", "error");
  }
}

async function reloadProjectFromDisk() {
  fileConflicts().close();
  const file = fileHome();
  if (!file || !file.handle) return;
  try {
    const projectFile = await ports.files.read(file.handle);
    if (!active) return;
    await openProjectFile(projectFile, file.handle);
  } catch (e) {
    if (active) showToast("Could not re-read that file.", "error");
  }
}


  return { projectFileSource, tryResumeLastProject, resumeFromHandle, openLocalFile, reloadFileFromDisk, reloadProjectFromDisk, dispose: function () { active = false; busyReads.forEach(endBusy); busyReads.clear(); } };
}

export function createLocalFilesOwner(): LocalFilesOwner {
  let started: ReturnType<typeof startLocalFiles> | null = null;
  function running() {
    if (!started) throw new Error("The local files is not started yet");
    return started;
  }
  return {
    startLocalFiles: function (ports) {
      if (started) throw new Error("The owner is already started; stop it first");
      const mine = startLocalFiles(ports);
      started = mine;
      return function () { if (started === mine) { started = null; mine.dispose(); } };
    },
    projectFileSource: function (...args) {
      const mine = running();
      const source = mine.projectFileSource(...args);
      return { id: source.id, takes: function (...args) { if (started !== mine) throw new Error("The local files is not started yet"); return source.takes(...args); }, open: function (...args) { if (started !== mine) throw new Error("The local files is not started yet"); return source.open(...args); } };
    },
    tryResumeLastProject: function (...args) { return running().tryResumeLastProject(...args); },
    resumeFromHandle: function (...args) { return running().resumeFromHandle(...args); },
    openLocalFile: function (...args) { return running().openLocalFile(...args); },
    reloadFileFromDisk: function (...args) { return running().reloadFileFromDisk(...args); },
    reloadProjectFromDisk: function (...args) { return running().reloadProjectFromDisk(...args); }
  };
}
