import type { FileSaveCheck } from "../../src/application/files/local-file-access.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountFileSaving, obsoleteSaveText } from "../../src/application/save/file-saving.ts";
import type { FileSaveHandle, FileSaveTarget, FileSavingMount, FileSavingPorts } from "../../src/application/save/file-saving-ports.ts";
import type { Home } from "../../src/application/location/document-location.ts";
import { buildExportDocument } from "../../src/core/document/export-document.ts";
import type { ExportDocument, ExportReadModels } from "../../src/core/document/export-document.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import type { OperationContext } from "../../src/application/session/operation.ts";
import type { SaveJob, WriterResult } from "../../src/application/save/coordinator.ts";
import type { FileSaveRequest } from "../../src/application/save/file-saving-ports.ts";

interface Setup {
  readonly home?: Home;
  readonly writtenOut?: boolean;
  readonly pick?: FileSaveTarget | { readonly kind: "cancelled" };
  readonly check?: FileSaveCheck;
  readonly writeFails?: Error;
  readonly delivered?: boolean;
  readonly autosave?: boolean;
  readonly onDesktop?: boolean;
}

const NO_MODELS: ExportReadModels = { production: [], commentNumbers: {}, broll: [] };
const OLD_ID = "d0123456789abcdef0123456789abcdef";
const NEW_ID = "dfedcba9876543210fedcba9876543210";

function fileHandle(name: string): FileSaveHandle {
  return { name };
}

function harness(setup: Setup = {}) {
  const log: string[] = [];
  const toasts: string[] = [];
  const built: ExportDocument[] = [];
  const state = { home: setup.home ?? ({ kind: "none" } as Home), writtenOut: setup.writtenOut ?? false, changes: 4, menuOn: true };
  const doc = migrateRows({ title: "Pilot Script", docId: OLD_ID, rev: 2, rows: [] }, fakeMigration().ports);
  const menu = {
    attributes: {} as Record<string, string>,
    classes: new Set<string>(),
    setAttribute: (name: string, value: string) => { menu.attributes[name] = value; },
    classList: { toggle: (token: string, force?: boolean) => { if (force) menu.classes.add(token); else menu.classes.delete(token); return !!force; } }
  };
  const ports: FileSavingPorts = {
    edits: { edit: (command) => {
      const plan = command.plan(doc, { edit: () => ({ allowed: true }) });
      if (!plan || "refused" in plan) return false;
      plan.apply(doc);
      state.changes++;
      return true;
    } },
    deferred: {
      copyHistory: (fromId, toId) => { log.push("copyHistory:" + fromId + ">" + toId); },
      syncIdentity: () => { log.push("syncIdentity"); },
      setBaseline: (published, reason) => { log.push("setBaseline:" + (published as { rev: number }).rev + ":" + reason); }
    },
    ids: { docId: () => { log.push("mintDocId"); return NEW_ID; } },
    clock: { nowIso: () => "2026-10-26T00:00:00.000Z" },
    document: {
      current: () => doc,
      stamp: (stamp) => { log.push("stamp:" + stamp.name); return null; }
    },
    location: {
      home: () => state.home,
      fileHome: () => (state.home.kind === "file" ? state.home : null),
      setHome: (kind, fields) => { state.home = { kind, ...fields } as Home; log.push("setHome:" + kind); return state.home; },
      amendHome: (record, fields) => { log.push("amendHome:" + Object.keys(fields).join(",")); Object.assign(record, fields); return record; },
      restoreHome: (record) => { log.push("restoreHome:" + record.kind); state.home = record; return record; },
      writtenOut: () => state.writtenOut,
      markWrittenOut: (on) => { state.writtenOut = on; log.push("markWrittenOut:" + on); }
    },
    lastFile: { remember: (handle) => { log.push("remember:" + handle.name); return Promise.resolve(); } },
    pictures: { ensureBytes: (shas) => { log.push("ensureBytes:" + shas.length); return Promise.resolve([]); } },
    exports: {
      captureExportDocument: (opts) => {
        log.push("capture:" + String(opts && opts.docId) + ":" + String(opts && opts.stamp && opts.stamp.rev) + ":" + String(opts && opts.stamp && opts.stamp.lastEditedBy));
        return buildExportDocument(doc, "2026-10-26T00:00:00.000Z", NO_MODELS, opts);
      }
    },
    formats: {
      buildSplitpage: () => { log.push("build:splitpage"); return "{}"; },
      buildMarkdown: (captured) => { built.push(captured); log.push("build:md"); return "# Pilot"; },
      imagesMissing: () => []
    },
    files: {
      dialogs: (slug) => { log.push("dialogs:" + slug); return { desktop: null, browser: null }; },
      pick: () => { log.push("pick"); return Promise.resolve(setup.pick ?? { kind: "download" }); },
      existing: (handle) => { log.push("existing:" + handle.name); return { kind: "handle", handle, picked: false }; },
      checkConflict: (handle, lastModified) => { log.push("checkConflict:" + handle.name + ":" + String(lastModified)); return Promise.resolve(setup.check ?? { ok: true }); },
      write: (handle, body) => {
        log.push("write:" + handle.name + ":" + body);
        return setup.writeFails ? Promise.reject(setup.writeFails) : Promise.resolve({ lastModified: 77 });
      },
      isAbort: (error) => !!error && (error as { name?: string }).name === "AbortError"
    },
    delivery: { deliver: (filename, _data, options) => { log.push("deliver:" + filename + ":" + String(options && options.savedMsg)); return Promise.resolve(setup.delivered ?? true); } },
    saves: {
      policy: () => ({ enabled: () => state.menuOn }),
      confirmSavedNow: () => { log.push("confirmSavedNow"); },
      halt: (reason) => { log.push("halt:" + reason); },
      resume: () => { log.push("resume"); },
      changes: () => state.changes
    },
    notices: {
      show: (message) => { toasts.push(message); return { isConnected: true, dismiss: () => {}, removeEventListener: () => {} }; },
      imagesLeftOut: (count, name) => { log.push("imagesLeftOut:" + count + ":" + name); }
    },
    preferences: { editorName: () => "Adam", autosave: () => setup.autosave ?? true },
    page: { getElementById: (id) => (id === "menu-autosave" ? menu : null) },
    bundles: { carry: (from, to, names) => { log.push("carry:" + from.name + ">" + to.name + ":" + names.join("|")); } }
  };
  const mounted = mountFileSaving(ports) as FileSavingMount;
  return { log, toasts, state, menu, mounted, ports, doc, built };
}

function job(kind: string, owns = true) {
  const moves: string[] = [];
  const value: SaveJob<FileSaveRequest> = {
    request: { kind },
    generation: 1,
    operation: () => ({}) as OperationContext,
    owns: () => owns,
    alive: () => true,
    moved: () => { moves.push("moved"); },
    landed: (steps) => { if (owns) steps.current(); else steps.obsolete(); }
  };
  return { value, moves };
}

function write(h: ReturnType<typeof harness>, kind: string, owns = true): Promise<WriterResult> {
  return h.mounted.destination().write(job(kind, owns).value);
}

const FILE_HOME = { kind: "file", handle: fileHandle("pilot.md"), format: "md", name: "pilot.md", lastModified: 50 } as unknown as Home;

test("paragraph metadata is captured before asset loading, survives reload, and a failed save leaves live edits intact", async () => {
  for (const fails of [false, true]) {
    const h = harness({ home: { ...FILE_HOME }, writtenOut: true, ...(fails ? { writeFails: new Error("disk full") } : {}) });
    h.doc.rows.push({ id: "paragraph", audioText: "Captured", paragraphStart: true });
    h.doc.paragraphsDecided = true;
    let release = () => {};
    let loading = () => {};
    const reached = new Promise<void>(resolve => { loading = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const ports: FileSavingPorts = { ...h.ports, pictures: { ensureBytes: async () => { loading(); await held; return []; } } };
    h.mounted.dispose();
    const mounted = mountFileSaving(ports) as FileSavingMount;
    try {
      const pending = mounted.destination().write(job("save").value);
      await reached;
      const row = h.doc.rows[0];
      assert.ok(row);
      delete row.paragraphStart;
      row.audioText = "Edited while loading";
      release();
      assert.equal((await pending).kind, fails ? "failed" : "saved");
      const captured = h.built[0]?.document;
      assert.ok(captured);
      const reopened = migrateRows(JSON.parse(JSON.stringify(captured)), fakeMigration().ports);
      assert.equal(reopened.rows[0]?.paragraphStart, true);
      assert.equal(reopened.rows[0]?.audioText, "Captured");
      assert.equal(reopened.paragraphsDecided, true);
      assert.equal(h.doc.rows[0]?.paragraphStart, undefined);
      assert.equal(h.doc.rows[0]?.audioText, "Edited while loading");
      if (fails) assert.equal(h.log.some(line => line.startsWith("setBaseline:")), false);
    } finally { release(); mounted.dispose(); }
  }
});

test("first picked save writes the filename title and trailing version into the captured document", async () => {
  const h = harness({ pick: { kind: "handle", handle: fileHandle("Headset ad v3.md"), picked: true } });
  h.doc.title = "Untitled Script";
  try {
    assert.equal((await write(h, "save")).kind, "saved");
    assert.equal(h.built[0]?.document.title, "Headset ad");
    assert.equal(h.built[0]?.title, "Headset ad");
    assert.equal(h.built[0]?.document.titleVersion, "v3");
    assert.equal(h.built[0]?.document.titleOrigin, "file");
    assert.equal(h.doc.title, "Headset ad");
    assert.equal(h.doc.titleVersion, "v3");
    assert.equal(h.doc.titleOrigin, "file");
  } finally { h.mounted.dispose(); }
});

test("download-only browsers leave the default title and tag unchanged", async () => {
  const h = harness();
  h.doc.title = "Untitled Script";
  h.doc.titleVersion = "v7";
  try {
    assert.equal((await write(h, "save")).kind, "saved");
    assert.equal(h.doc.title, "Untitled Script");
    assert.equal(h.doc.titleVersion, "v7");
    assert.equal(h.doc.titleOrigin, undefined);
    assert.equal(h.built[0]?.document.title, "Untitled Script");
    assert.equal(h.built[0]?.document.titleVersion, "v7");
  } finally { h.mounted.dispose(); }
});

test("cancelled, failed and obsolete first saves never apply file naming to the live document", async () => {
  for (const kind of ["cancelled", "failed", "obsolete"]) {
    const h = harness({
      pick: kind === "cancelled" ? { kind: "cancelled" } : { kind: "handle", handle: fileHandle("Headset v3.md"), picked: true },
      ...(kind === "failed" ? { writeFails: new Error("disk full") } : {})
    });
    h.doc.title = "Untitled Script";
    try {
      await write(h, "save", kind !== "obsolete");
      assert.equal(h.doc.title, "Untitled Script");
      assert.equal(h.doc.titleVersion, undefined);
      assert.equal(h.doc.titleOrigin, undefined);
      assert.equal(h.state.changes, 4);
      assert.equal(h.state.writtenOut, false);
      assert.equal(h.state.home.kind, "none");
    } finally { h.mounted.dispose(); }
  }
});

test("a save to the open file checks the disk, writes, then confirms the document in order", async () => {
  const h = harness({ home: FILE_HOME, writtenOut: true });
  const result = await write(h, "save");
  assert.deepEqual(result, { kind: "saved" });
  assert.deepEqual(h.log, [
    "resume",
    "capture:null:3:Adam",
    "existing:pilot.md",
    "checkConflict:pilot.md:50",
    "ensureBytes:0",
    "build:md",
    "write:pilot.md:# Pilot",
    "stamp:stamp-edit",
    "setBaseline:3:saveDoc: the bytes just written",
    "amendHome:diskBase,lastModified",
    "markWrittenOut:true",
    "syncIdentity",
    "confirmSavedNow",
    "imagesLeftOut:0:pilot.md"
  ]);
  assert.deepEqual(h.toasts, ["Saved to pilot.md"]);
});

test("a file changed on disk refuses a manual save with the conflict and halts an automatic one", async () => {
  const changed: FileSaveCheck = { ok: false, current: { lastModified: 99 } };
  const manual = harness({ home: FILE_HOME, check: changed });
  assert.deepEqual(await write(manual, "save"), {
    kind: "refused",
    reason: "The file changed on disk since it was opened",
    conflict: { fileName: "pilot.md", current: { lastModified: 99 }, kind: "project" }
  });
  assert.ok(!manual.log.some((line) => line.startsWith("write:")));
  const auto = harness({ home: FILE_HOME, check: changed });
  assert.deepEqual(await write(auto, "autosave"), { kind: "refused", reason: "The file changed on disk since it was opened" });
  assert.ok(!auto.log.includes("resume"));
  assert.ok(auto.log.includes("halt:Autosave is paused — pilot.md changed on disk since it was opened. Press Save to sort it out."));
  assert.ok(!auto.log.some((line) => line.startsWith("write:") || line.startsWith("stamp:")));
});

test("a file whose permission was withdrawn fails the save with an error, not a conflict, and halts an automatic one", async () => {
  const denied: FileSaveCheck = { ok: false, current: null, denied: true };
  const manual = harness({ home: FILE_HOME, check: denied });
  const result = await write(manual, "save");
  assert.equal(result.kind, "failed");
  assert.deepEqual(manual.toasts, ["Could not save — permission to change pilot.md was withdrawn, so use Save a copy or open the file again."]);
  assert.ok(!manual.log.some((line) => line.startsWith("write:") || line.startsWith("stamp:") || line === "confirmSavedNow"));
  assert.ok(!manual.log.some((line) => line.startsWith("halt:")), "a manual save does not halt autosave");
  const auto = harness({ home: FILE_HOME, check: denied });
  assert.equal((await write(auto, "autosave")).kind, "failed");
  assert.ok(!auto.log.some((line) => line.startsWith("write:") || line.startsWith("stamp:")), "nothing was written");
  assert.ok(auto.log.includes("halt:Autosave is paused — the last save failed (permission to change pilot.md was withdrawn, so use Save a copy or open the file again). Press Save to try again."));
});

test("a forced save skips the disk check", async () => {
  const h = harness({ home: FILE_HOME, check: { ok: false, current: null } });
  assert.deepEqual(await write(h, "force"), { kind: "saved" });
  assert.ok(!h.log.some((line) => line.startsWith("checkConflict:")));
});

test("Save As of a written-out script forks its id, retargets to the picked file and remembers it", async () => {
  const picked = fileHandle("copy.splitpage");
  const h = harness({ home: FILE_HOME, writtenOut: true, pick: { kind: "handle", handle: picked, picked: true } });
  const saveAs = job("saveAs");
  assert.deepEqual(await h.mounted.destination().write(saveAs.value), { kind: "saved" });
  assert.deepEqual(h.log, [
    "resume",
    "mintDocId",
    "capture:" + NEW_ID + ":3:Adam",
    "dialogs:pilot-script",
    "pick",
    "setHome:file",
    "ensureBytes:0",
    "build:splitpage",
    "write:copy.splitpage:{}",
    "stamp:stamp-edit",
    "setBaseline:3:saveDoc: the bytes just written",
    "amendHome:diskBase,lastModified",
    "copyHistory:" + OLD_ID + ">" + NEW_ID,
    "stamp:stamp-document-id",
    "markWrittenOut:true",
    "syncIdentity",
    "confirmSavedNow",
    "remember:copy.splitpage",
    "imagesLeftOut:0:copy.splitpage"
  ]);
  assert.deepEqual(saveAs.moves, ["moved", "moved"]);
  assert.deepEqual(h.toasts, ["Saved a new copy: copy.splitpage"]);
});

test("a write that lands after the job lost the document only copies the history", async () => {
  const picked = fileHandle("copy.md");
  const h = harness({ home: FILE_HOME, writtenOut: true, pick: { kind: "handle", handle: picked, picked: true } });
  assert.deepEqual(await write(h, "saveAs", false), { kind: "saved" });
  assert.ok(h.log.includes("copyHistory:" + OLD_ID + ">" + NEW_ID));
  assert.ok(!h.log.some((line) => line.startsWith("stamp:") || line.startsWith("setBaseline:") || line.startsWith("setHome:") || line === "confirmSavedNow"));
});

test("with no file picker the save downloads the file", async () => {
  const h = harness();
  assert.deepEqual(await write(h, "save"), { kind: "saved" });
  assert.ok(h.log.includes("deliver:pilot-script.md:Downloaded pilot-script.md"));
  assert.ok(h.log.includes("confirmSavedNow"));
  const refused = harness({ delivered: false });
  assert.deepEqual(await write(refused, "save"), { kind: "cancelled" });
  assert.ok(!refused.log.some((line) => line.startsWith("stamp:")));
});

test("a cancelled dialog changes nothing", async () => {
  const h = harness({ pick: { kind: "cancelled" } });
  assert.deepEqual(await write(h, "saveAs"), { kind: "cancelled" });
  assert.ok(!h.log.some((line) => line.startsWith("write:") || line.startsWith("stamp:") || line.startsWith("setHome:")));
});

test("a failed write reports it, halts autosave on an automatic save and undoes the retarget", async () => {
  const picked = fileHandle("new.md");
  const h = harness({ pick: { kind: "handle", handle: picked, picked: true }, writeFails: new Error("disk full") });
  const result = await write(h, "saveAs");
  assert.equal(result.kind, "failed");
  assert.deepEqual(h.toasts, ["Could not save — disk full."]);
  assert.ok(h.log.includes("restoreHome:none"));
  const auto = harness({ home: FILE_HOME, writeFails: new Error("disk full") });
  await write(auto, "auto");
  assert.ok(auto.log.includes("halt:Autosave is paused — the last save failed (disk full). Press Save to try again."));
  const aborted = harness({ home: FILE_HOME, writeFails: Object.assign(new Error("no"), { name: "AbortError" }) });
  assert.deepEqual(await write(aborted, "save"), { kind: "cancelled" });
  assert.deepEqual(aborted.toasts, []);
});

test("the file destination takes Save As and the other file saves wherever the document is", () => {
  const destination = harness().mounted.destination();
  assert.equal(destination.id, "file");
  for (const kind of ["saveAs", "save", "auto", "autosave", "force"]) {
    assert.equal(destination.takes({ kind }, { kind: "file" }), true);
    assert.equal(destination.takes({ kind }, { kind: "none" }), true);
  }
  assert.equal(destination.takes({ kind: "writeback" }, { kind: "none" }), false);
  assert.equal(harness({ home: FILE_HOME }).mounted.destination().autoSaveTarget({ kind: "file" }), "file");
  assert.equal(harness().mounted.destination().autoSaveTarget({ kind: "none" }), null);
});

test("the save ports key destinations, report late saves, pass ownership through and drive the autosave menu", () => {
  const h = harness({ home: FILE_HOME, autosave: false });
  let owns = true;
  const ownership = {
    capture: () => ({ epoch: 1, docId: OLD_ID, destination: h.state.home, destinationGeneration: 0, generation: 0 }) as OperationContext,
    stillOwns: () => owns
  };
  const ports = h.mounted.savePorts(ownership);
  assert.equal(ports.destination(), h.state.home);
  assert.deepEqual(ports.keyOf({ kind: "none" }), ports.keyOf(null));
  assert.deepEqual(ports.keyOf({ kind: "file", handle: { _desktopId: 7 } }), { owner: "desktop:7", name: "handle" });
  const handle = {};
  assert.equal(ports.keyOf({ kind: "file", handle }).owner, handle);
  ports.obsolete({ kind: "save" }, true);
  ports.obsolete({ kind: "save" }, false);
  assert.deepEqual(h.toasts, [obsoleteSaveText("Pilot Script")]);
  const ctx = ownership.capture();
  assert.equal(ports.ownership.capture, ownership.capture);
  assert.equal(ports.ownership.stillOwns(ctx), true);
  owns = false;
  assert.equal(ports.ownership.stillOwns(ctx), false);
  assert.equal(ports.autosave.enabledAtStart(), false);
  ports.autosave.changed("enabled");
  assert.equal(h.menu.attributes["aria-checked"], "true");
  assert.ok(h.menu.classes.has("is-on"));
  h.state.menuOn = false;
  ports.autosave.changed("halt");
  assert.equal(h.menu.attributes["aria-checked"], "true");
  h.mounted.updateAutoSaveMenu();
  assert.equal(h.menu.attributes["aria-checked"], "false");
  assert.ok(!h.menu.classes.has("is-on"));
});

test("an older .html project is saved as Markdown through Save As", async () => {
  const html = { kind: "file", handle: fileHandle("old.html"), format: "html", name: "old.html" } as unknown as Home;
  const h = harness({ home: html, pick: { kind: "cancelled" } });
  assert.deepEqual(await write(h, "save"), { kind: "cancelled" });
  assert.equal(h.toasts[0], "Older .html projects are saved as Markdown from now on — choose where to keep it.");
  assert.ok(h.log.includes("pick"));
  assert.ok(!h.log.includes("mintDocId"));
});

test("disposing the mount releases its ports only while it is the live one", () => {
  const first = harness();
  const second = harness();
  first.mounted.dispose();
  second.mounted.updateAutoSaveMenu();
  assert.equal(second.menu.attributes["aria-checked"], "true");
  second.mounted.dispose();
  assert.throws(() => second.mounted.updateAutoSaveMenu());
});

test("Save As from a script on disk carries the script's bundled videos to the new file; other saves do not", async () => {
  const withVideos = [{ id: "r1", imageLinks: [
    { name: "a.mp4", size: 3, location: { kind: "bundled", name: "a.mp4" }, poster: true },
    { name: "p.mp4", size: 3, location: { kind: "path", path: "C:\\v\\p.mp4" } }],
  moreImages: [{ links: [{ name: "b.mov", location: { kind: "bundled", name: "b (2).mov" }, poster: true }] }] }];
  const carries = (h: ReturnType<typeof harness>) => h.log.filter((line) => line.startsWith("carry:"));
  const saveAs = harness({ home: FILE_HOME, writtenOut: true, pick: { kind: "handle", handle: fileHandle("copy.splitpage"), picked: true } });
  saveAs.doc.rows.push(...(migrateRows({ rows: withVideos }, fakeMigration().ports).rows));
  assert.deepEqual(await write(saveAs, "saveAs"), { kind: "saved" });
  assert.deepEqual(carries(saveAs), ["carry:pilot.md>copy.splitpage:a.mp4|b (2).mov"]);
  const plain = harness({ home: { ...FILE_HOME }, writtenOut: true });
  plain.doc.rows.push(...(migrateRows({ rows: withVideos }, fakeMigration().ports).rows));
  assert.deepEqual(await write(plain, "save"), { kind: "saved" });
  assert.deepEqual(carries(plain), [], "saving in place carries nothing");
  const none = harness({ home: FILE_HOME, writtenOut: true, pick: { kind: "handle", handle: fileHandle("copy.splitpage"), picked: true } });
  assert.deepEqual(await write(none, "saveAs"), { kind: "saved" });
  assert.deepEqual(carries(none), [], "no bundled videos, nothing to carry");
  const first = harness({ pick: { kind: "handle", handle: fileHandle("first.splitpage"), picked: true } });
  first.doc.rows.push(...(migrateRows({ rows: withVideos }, fakeMigration().ports).rows));
  assert.deepEqual(await write(first, "save"), { kind: "saved" });
  assert.deepEqual(carries(first), [], "a script never saved has no folder to carry from");
});
