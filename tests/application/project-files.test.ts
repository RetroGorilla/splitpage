import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectFiles } from "../../src/application/save/project-files.ts";
import type { ProjectFilesPorts } from "../../src/application/save/project-files.ts";
import { buildExportDocument } from "../../src/core/document/export-document.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import type { Home } from "../../src/application/location/document-location.ts";
import { deriveDocId } from "../../src/core/document/ids.ts";
import { migrateRows } from "../../src/bootstrap/document-ports.ts";

function fixture() {
  const calls: unknown[][] = [];
  const doc = migrateRows({ docId: "d" + "a".repeat(32), rows: [] });
  const captured = buildExportDocument(doc, "2026-10-26T00:00:00Z", { production: [], commentNumbers: {}, broll: [] });
  const supplied = buildExportDocument(doc, "2026-10-26T01:00:00Z", { production: [], commentNumbers: {}, broll: [] });
  let current: ValidatedDocument | null = doc;
  let home: Home | null = { kind: "file", handle: { name: "script.md" }, format: "md", lastModified: 42, diskBase: doc };
  const modal = { hidden: true, textContent: "" };
  const detail = { hidden: false, textContent: "" };
  let modalPresent = true;
  const saveResult = Promise.resolve();
  const openResult = Promise.resolve({ opened: true });
  const events = [{ type: "copy" }];
  const channel = {};
  const timing = { idle: 1, hostedIdle: 2, max: 3 };
  const ports: ProjectFilesPorts = {
    deferred: {
      prepareDocument: (raw, origin) => { calls.push(["prepare", raw, origin]); return doc; },
      restoreDocument: (raw) => { calls.push(["restore", raw]); return doc; },
      changeDocumentId: (to, options) => { calls.push(["identity", to, options]); return true; },
      identityEvents: () => events,
      connectIdentity: (factory) => { calls.push(["channel", factory]); return channel; },
      standaloneHtml: (value) => { calls.push(["standalone", value]); return "html"; },
      replaceSyncBase: (value, reason) => { calls.push(["base", value, reason]); },
      tagOccurrences: (...args) => { calls.push(["tag", ...args]); return { hits: 2, html: "tagged" }; }
    },
    document: { current: () => { calls.push(["current"]); return current; } },
    heldDocument: () => doc,
    location: {
      writtenOut: () => true,
      fileHome: () => { calls.push(["home"]); return home; },
      amendHome: (value, fields) => { calls.push(["amend", value, fields]); return value; }
    },
    entry: (raw) => { calls.push(["migrate", raw]); return doc; },
    text: {
      sanitizeHtml: (html) => { calls.push(["sanitize", html]); return "safe"; },
      inertBody: (html) => { calls.push(["inert", html]); return { ownerDocument: { getElementById: () => null } }; }
    },
    recovery: { stash: () => { calls.push(["stash"]); return true; } },
    exports: {
      captureExportDocument: () => { calls.push(["capture"]); return captured; },
      exportDocumentOf: (raw) => { calls.push(["exportOf", raw]); return supplied; }
    },
    saving: {
      save: (opts) => { calls.push(["save", opts]); return saveResult; },
      autoSave: () => { calls.push(["policy"]); return {
        timing,
        enabled: () => { calls.push(["enabled"]); return true; },
        halted: () => { calls.push(["halted"]); return "reason"; },
        pending: () => { calls.push(["pending"]); return false; }
      }; },
      target: () => { calls.push(["target"]); return "file"; },
      toggle: () => { calls.push(["toggle"]); },
      flush: () => { calls.push(["flush"]); }
    },
    opening: { open: (request) => { calls.push(["open", request]); return openResult; } },
    codecs: {
      buildSplitpage: (value) => { calls.push(["splitpage", value]); return "splitpage"; },
      buildMarkdown: (value) => { calls.push(["markdown", value]); return "markdown"; },
      parseMarkdown: (value) => { calls.push(["parse", value]); return doc; }
    },
    page: { getElementById: (id) => id === "md-rows-modal" ? modalPresent ? modal : null : detail }
  };
  return { ports, calls, doc, captured, supplied, modal, detail, saveResult, openResult, events, channel, timing,
    noModal: () => { modalPresent = false; }, noHome: () => { home = null; }, noDocument: () => { current = null; } };
}

test("project files: services preserve migration origin and all rich text arguments", () => {
  const f = fixture();
  const { services } = createProjectFiles(f.ports);
  const raw = { rows: [] };
  const origin = { kind: "file" } as const;
  assert.equal(services.migrateRows(raw), f.doc);
  assert.equal(services.migrateDocument(raw, origin), f.doc);
  assert.equal(services.sanitizeHtml("unsafe"), "safe");
  assert.deepEqual(services.tagFieldOccurrences("html", "phrase", "cat", "name", true), { hits: 2, html: "tagged" });
  assert.equal(services.inertBody("body").ownerDocument.getElementById("x"), null);
  assert.deepEqual(f.calls, [["migrate", raw], ["prepare", raw, origin], ["sanitize", "unsafe"], ["tag", "html", "phrase", "cat", "name", true], ["inert", "body"]]);
});

test("project files: serialize the supplied export or capture before each codec without extra migration", () => {
  const f = fixture();
  const { formats } = createProjectFiles(f.ports);
  const raw = { title: "supplied" };
  assert.equal(formats.buildSplitpage(), "splitpage");
  assert.equal(formats.buildSplitpage(raw), "splitpage");
  assert.equal(formats.buildMarkdown(null), "markdown");
  assert.equal(formats.buildMarkdown(raw), "markdown");
  assert.equal(formats.parseMarkdown("text"), f.doc);
  assert.equal(formats.buildStandaloneHtml(), "html");
  assert.deepEqual(f.calls, [["capture"], ["splitpage", f.captured], ["exportOf", raw], ["splitpage", f.supplied],
    ["capture"], ["markdown", f.captured], ["exportOf", raw], ["markdown", f.supplied], ["parse", "text"], ["capture"], ["standalone", f.captured]]);
});

test("project files: opening and importing keep their requests and saving preserves options and promises", () => {
  const f = fixture();
  const { formats } = createProjectFiles(f.ports);
  const file = new File([], "project.splitpage");
  const handle = { name: file.name };
  const options = { force: true, saveAs: true };
  assert.equal(formats.openFile(file, handle), f.openResult);
  assert.equal(formats.openFile(file), f.openResult);
  assert.equal(formats.importFile(file), f.openResult);
  assert.equal(formats.save(options), f.saveResult);
  assert.equal(formats.save(null), f.saveResult);
  assert.deepEqual(f.calls, [["open", { kind: "file", file, handle, options: { skipSnapshot: true } }],
    ["open", { kind: "file", file, handle: null, options: { skipSnapshot: true } }], ["open", { kind: "import", file }], ["save", options], ["save", {}]]);
  assert.equal(f.calls[3]?.[1], options);
});

test("project files: disk fallback amends the home before clearing the sync base, including without a file", () => {
  const f = fixture();
  const { formats } = createProjectFiles(f.ports);
  assert.deepEqual(formats.docFile(), { name: "script.md", kind: "md", lastModified: 42 });
  assert.equal(formats.hasDiskBase(), true);
  const home = f.ports.location.fileHome();
  f.calls.length = 0;
  assert.equal(formats.forgetDiskBase(), true);
  const reason = "formats.forgetDiskBase: test hook, drives the two-way fallback";
  assert.deepEqual(f.calls, [["home"], ["home"], ["amend", home, { diskBase: null }], ["base", null, reason]]);
  f.noHome();
  f.calls.length = 0;
  assert.equal(formats.forgetDiskBase(), true);
  assert.deepEqual(f.calls, [["home"], ["base", null, reason]]);
  assert.deepEqual(formats.docFile(), { name: null, kind: null, lastModified: null });
  assert.equal(formats.hasDiskBase(), false);
});

test("project files: identity, held state, recovery and autosave controls retain results and order", () => {
  const f = fixture();
  const { formats } = createProjectFiles(f.ports);
  assert.equal(formats.docId(), f.doc.docId);
  assert.deepEqual(f.calls.splice(0), [["current"], ["current"]]);
  f.noDocument();
  assert.equal(formats.docId(), null);
  assert.equal(formats.state(), f.doc);
  assert.equal(formats.writtenOut(), true);
  assert.equal(formats.deriveDocId("domain", "text"), deriveDocId("domain", "text"));
  assert.equal(formats.adoptRestoredState(f.doc), f.doc);
  const options = { fromId: "old", otherTitle: "other" };
  assert.equal(formats.reassignDocId("new", options), true);
  assert.equal(formats.docIdEvents(), f.events);
  const factory = () => f.channel;
  assert.equal(formats.initDocIdentityChannel(factory), f.channel);
  assert.equal(formats.migrate(f.doc), f.doc);
  assert.equal(formats.stash(), true);
  const clone = formats.clone(f.doc);
  assert.deepEqual(clone, f.doc);
  assert.notEqual(clone, f.doc);
  assert.equal(formats.autosave.timing(), f.timing);
  assert.equal(formats.autosave.enabled(), true);
  assert.equal(formats.autosave.halt(), "reason");
  assert.equal(formats.autosave.target(), "file");
  assert.equal(formats.autosave.pending(), false);
  formats.autosave.toggle();
  formats.autosave.flush();
  assert.deepEqual(f.calls, [["current"], ["restore", f.doc], ["identity", "new", options], ["channel", factory], ["migrate", f.doc], ["stash"],
    ["policy"], ["policy"], ["enabled"], ["policy"], ["halted"], ["target"], ["policy"], ["pending"], ["toggle"], ["flush"]]);
});

test("project files: Markdown mismatch resolves once, normalizes the answer, and keeps owners independent", async () => {
  const f = fixture();
  const owner = createProjectFiles(f.ports);
  const other = createProjectFiles(f.ports);
  const keep = owner.services.askMarkdownRows(1, 2);
  assert.equal(f.modal.hidden, false);
  assert.equal(f.detail.textContent, "This file's own record has 1 scene, but the table in it now has 2. Scenes were added or removed somewhere other than Splitpage, so the two can no longer be lined up scene by scene.");
  other.finishMarkdownRowChoice("table");
  owner.finishMarkdownRowChoice("unexpected");
  assert.equal(await keep, "keep");
  assert.equal(f.modal.hidden, true);
  const table = owner.services.askMarkdownRows(2, 1);
  assert.match(f.detail.textContent, /has 2 scenes, but the table in it now has 1\./);
  owner.finishMarkdownRowChoice("table");
  owner.finishMarkdownRowChoice("keep");
  assert.equal(await table, "table");
  f.noModal();
  assert.equal(await owner.services.askMarkdownRows(3, 4), "keep");
});
