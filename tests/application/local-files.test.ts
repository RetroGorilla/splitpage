import type { MalformedDesktopReply, DesktopPort } from "../../src/adapters/desktop/desktop-port.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalFilesOwner } from "../../src/application/transitions/local-files.ts";
import type { LocalFilesOwner, LocalFilesOwnerPorts } from "../../src/application/transitions/local-files-ports.ts";
import { createDocumentLocation } from "../../src/application/location/document-location.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import { fakeNotices } from "../features/fakes.ts";

function harness() {
  const log: string[] = [];
  const doc = migrateRows({ title: "A script", rows: [] }, fakeMigration().ports);
  const location = createDocumentLocation();
  const file = { name: "script.splitpage", lastModified: 20, size: 40, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
  const notices = fakeNotices();
  const state = { permission: "granted", dirty: false };
  const owner: LocalFilesOwner = createLocalFilesOwner();
  const ports: LocalFilesOwnerPorts = {
    document: { current: () => doc },
    session: { noteAbsorbedDirty: (kind) => { log.push("dirty:" + kind); }, noteReload: () => { log.push("reload"); } },
    transitions: { open: (opening) => {
      log.push("open:" + String(opening.keep) + ":" + String(opening.writtenOut));
      if (opening.destination) location.setHome(opening.destination.kind, opening.destination.fields);
      return { document: doc, forkedFrom: null, kept: false };
    } },
    history: { keep: (label) => { log.push(label); } },
    saving: { confirmSavedNow: () => { log.push("confirm"); } },
    saves: { unsaved: () => state.dirty },
    conflicts: { close: () => { log.push("closeConflict"); } },
    location,
    lastFile: { load: async () => { log.push("loadLast"); return file; }, remember: async () => { log.push("remember"); } },
    syncIdentity: () => { log.push("identity"); },
    stamps: { stampRow: () => { log.push("stamp"); } },
    notices: { ...notices.notices, busy: { begin: () => { log.push("beginBusy"); return 1; }, end: () => { log.push("endBusy"); } } },
    resetProductionPanel: () => { log.push("resetPanel"); },
    panels: { close: () => { log.push("closePanel"); } },
    undo: { flush: () => { log.push("flush"); } },
    imports: {
      parseProjectFileState: async () => { log.push("parse"); return { state: doc, kind: "splitpage", docIdEmbedded: true }; },
      docxToRows: async () => ({ title: null, rows: [], looseText: "" }), csvToRows: () => [], detectTwoColumnFormat: () => null,
      parseImportRows: () => [], normalizeImportedRows: () => []
    },
    text: { sanitizeHtml: (html) => String(html) },
    resumeNeeded: () => { log.push("banner"); },
    desktop: { running: () => false, openFileDialog: async () => null, routeOpen: async () => null as unknown as MalformedDesktopReply<Awaited<ReturnType<DesktopPort["routeOpen"]>>> },
    files: {
      read: async () => { log.push("read"); return file; }, text: (data) => data.text(),
      permission: async (_handle, options) => { assert.deepEqual(options, { mode: "readwrite" }); log.push("permission"); return state.permission; },
      openPicker: null, desktopHandle: () => { throw new Error("unused"); }, checkConflict: async () => ({ ok: true }),
      createWritable: async () => { throw new Error("unused"); }
    },
    chooseFallback: () => { log.push("fallback"); }
  };
  return { owner, ports, log, file, state, doc, location };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const stage of ["parse", "last handle", "permission", "read", "dialog", "route", "picker", "text", "docx", "reload import", "reload project"]) {
  test("opening stopped during " + stage + " cannot affect a replacement owner", async () => {
    const h = harness();
    const replacement = harness();
    const entered = deferred<undefined>();
    const gate = deferred<unknown>();
    const handleGate = deferred<Awaited<ReturnType<LocalFilesOwnerPorts["lastFile"]["load"]>>>();
    const hold = () => { entered.resolve(undefined); return gate.promise; };
    let ports = h.ports;
    let finish: unknown = h.file;
    let open = () => h.owner.resumeFromHandle({});
    if (stage === "parse") {
      ports = { ...ports, imports: { ...ports.imports, parseProjectFileState: async () => { await hold(); return { state: h.doc, kind: "splitpage", docIdEmbedded: true }; } } };
      finish = { state: h.doc, kind: "splitpage" };
      open = async () => { await h.owner.projectFileSource().open({ kind: "file", file: h.file, handle: {} }); };
    } else if (stage === "last handle" || stage === "permission") {
      ports = stage === "last handle"
        ? { ...ports, lastFile: { ...ports.lastFile, load: () => { entered.resolve(undefined); return handleGate.promise; } } }
        : { ...ports, files: { ...ports.files, permission: async () => String(await hold()) } };
      finish = stage === "permission" ? "prompt" : {};
      open = () => h.owner.tryResumeLastProject();
    } else if (stage === "dialog" || stage === "route") {
      ports = { ...ports, desktop: { running: () => true, openFileDialog: stage === "dialog" ? hold as () => Promise<MalformedDesktopReply<Awaited<ReturnType<DesktopPort["openFileDialog"]>>>> : async () => ({ id: 1 } as unknown as MalformedDesktopReply<Awaited<ReturnType<DesktopPort["openFileDialog"]>>>), routeOpen: stage === "route" ? hold as () => Promise<MalformedDesktopReply<Awaited<ReturnType<DesktopPort["routeOpen"]>>>> : async () => ({ where: "this-tab" }) } };
      finish = stage === "dialog" ? { id: 1 } : { where: "this-tab" };
      open = () => h.owner.openLocalFile();
    } else if (stage === "picker") {
      ports = { ...ports, files: { ...ports.files, openPicker: async () => { await hold(); return []; } } };
      open = () => h.owner.openLocalFile();
    } else if (stage === "text" || stage === "docx") {
      const file = { ...h.file, name: "import." + (stage === "text" ? "txt" : "docx") };
      ports = { ...ports, imports: { ...ports.imports, parseProjectFileState: async () => null, docxToRows: stage === "docx" ? async () => { await hold(); return { title: "late", rows: [], looseText: "" }; } : ports.imports.docxToRows }, files: { ...ports.files, text: async () => String(await hold()) } };
      finish = stage === "text" ? "late import" : { title: "late", rows: [] };
      open = async () => { await h.owner.projectFileSource().open({ kind: "file", file }); };
    } else {
      ports = { ...ports, files: { ...ports.files, read: async () => { await hold(); return h.file; } } };
      if (stage === "reload import") {
        h.location.setHome("import", { name: "import.txt", handle: {}, format: "txt" });
        open = () => h.owner.reloadFileFromDisk();
      } else if (stage === "reload project") {
        h.location.setHome("file", { name: h.file.name, handle: {}, format: "splitpage" });
        open = () => h.owner.reloadProjectFromDisk();
      }
    }
    const stop = h.owner.startLocalFiles(ports);
    const pending = open();
    await entered.promise;
    stop();
    const stopReplacement = h.owner.startLocalFiles(replacement.ports);
    const before = [...h.log];
    if (stage === "last handle") handleGate.resolve({});
    else gate.resolve(finish);
    await pending;
    assert.deepEqual(h.log, before);
    assert.deepEqual(replacement.log, []);
    stopReplacement();
  });
}

test("local files refuse before startup and after teardown, including retained sources", async () => {
  const h = harness();
  assert.throws(() => h.owner.openLocalFile(), /not started yet/);
  const stop = h.owner.startLocalFiles(h.ports);
  assert.throws(() => h.owner.startLocalFiles(h.ports), /already started/);
  const source = h.owner.projectFileSource();
  stop();
  assert.throws(() => h.owner.reloadFileFromDisk(), /not started yet/);
  assert.throws(() => source.open({ kind: "file", file: h.file }), /not started yet/);
});

test("resume loads and asks permission before reading, adopts before confirming and remembering", async () => {
  const h = harness();
  const stop = h.owner.startLocalFiles(h.ports);
  await h.owner.tryResumeLastProject();
  assert.deepEqual(h.log, ["loadLast", "permission", "read", "parse", "closePanel", "resetPanel", "open:undefined:true", "confirm", "remember"]);
  h.log.length = 0;
  h.state.permission = "prompt";
  await h.owner.tryResumeLastProject();
  assert.deepEqual(h.log, ["loadLast", "permission", "banner"]);
  stop();
});

test("a parsed project opens synchronously; reload closes the conflict before reading", async () => {
  const h = harness();
  const stop = h.owner.startLocalFiles(h.ports);
  const answer = h.owner.projectFileSource().open({ kind: "file", file: h.file, handle: {}, parsed: { state: h.doc, kind: "splitpage" } });
  assert.equal(answer, true);
  assert.deepEqual(h.log, ["closePanel", "resetPanel", "open:Before opening script.splitpage:true", "confirm", "remember"]);
  h.log.length = 0;
  await h.owner.reloadProjectFromDisk();
  assert.deepEqual(h.log, ["closeConflict", "read", "parse", "closePanel", "resetPanel", "open:Before opening script.splitpage:true", "confirm", "remember"]);
  stop();
});
