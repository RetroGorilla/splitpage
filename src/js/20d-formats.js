import { deriveDocId } from "../core/document/ids.ts";
import { amendHome, documentLocation, fileHome } from "../legacy/location-bridge.ts";
import { migrateRows } from "./02-state.js";
import {
  adoptRestoredState,
  docIdEvents,
  initDocIdentityChannel,
  migrateDocument,
  reassignDocId,
  standaloneHtmlFor
} from "./02b-doc-id.js";
import { setBaseState } from "./03-sync.js";
import { stashLocalWork } from "../legacy/recovery-bridge.ts";
import { tagFieldOccurrences } from "./07-production-tags.js";
import { captureExportDocument, exportDocumentOf } from "./14b-export-kit.js";
import { inertBody, sanitizeHtml } from "../legacy/richtext.ts";
import { autoSavePolicy, autoSaveTarget, flushAutoSave, saveDoc, toggleAutoSave } from "../legacy/save-bridge.ts";
import { currentDocument, heldDocument } from "../legacy/session-bridge.ts";
import { openDocument } from "../legacy/transition-bridge.ts";
import { cloneState } from "../core/document/clone.ts";
import { buildMarkdownProject, buildSplitpageFile, parseMarkdownProject } from "../adapters/formats/project-file.ts";

var pendingMdRowChoice = null;

function askMarkdownRowChoice(blockRows, tableRows) {
  return new Promise(function (resolve) {
    var modal = document.getElementById("md-rows-modal");
    if (!modal) { resolve("keep"); return; }
    document.getElementById("md-rows-detail").textContent =
      "This file's own record has " + blockRows + " scene" + (blockRows === 1 ? "" : "s") +
      ", but the table in it now has " + tableRows + ". Scenes were added or removed " +
      "somewhere other than Splitpage, so the two can no longer be lined up scene by scene.";
    pendingMdRowChoice = resolve;
    modal.hidden = false;
  });
}

export function finishMarkdownRowChoice(choice) {
  var modal = document.getElementById("md-rows-modal");
  if (modal) modal.hidden = true;
  var resolve = pendingMdRowChoice;
  pendingMdRowChoice = null;
  if (resolve) resolve(choice === "table" ? "table" : "keep");
}

export function legacyProjectFileServices() {
  return {
    migrateRows: migrateRows,
    migrateDocument: migrateDocument,
    sanitizeHtml: sanitizeHtml,
    tagFieldOccurrences: tagFieldOccurrences,
    inertBody: inertBody,
    askMarkdownRows: askMarkdownRowChoice
  };
}

export function __init() {
  window.__splitpageFormats = {
    buildSplitpage: function (s) { return buildSplitpageFile(s ? exportDocumentOf(s) : captureExportDocument()); },
    buildMarkdown: function (s) { return buildMarkdownProject(s ? exportDocumentOf(s) : captureExportDocument()); },
    parseMarkdown: function (text) { return parseMarkdownProject(text); },
    buildStandaloneHtml: function () { return standaloneHtmlFor(captureExportDocument()); },
    docId: function () { return currentDocument() ? currentDocument().docId : null; },
    writtenOut: function () { return documentLocation().writtenOut(); },
    deriveDocId: deriveDocId,
    adoptRestoredState: adoptRestoredState,
    reassignDocId: reassignDocId,
    docIdEvents: docIdEvents,
    initDocIdentityChannel: initDocIdentityChannel,
    openFile: function (file, handle) { return openDocument({ kind: "file", file: file, handle: handle || null, options: { skipSnapshot: true } }); },
    importFile: function (file) { return openDocument({ kind: "import", file: file }); },
    save: function (opts) { return saveDoc(opts || {}); },
    autosave: {
      timing: function () { return autoSavePolicy().timing; },
      enabled: function () { return autoSavePolicy().enabled(); },
      halt: function () { return autoSavePolicy().halted(); },
      target: function () { return autoSaveTarget(); },
      pending: function () { return autoSavePolicy().pending(); },
      toggle: toggleAutoSave,
      flush: flushAutoSave
    },
    migrate: migrateRows,
    stash: stashLocalWork,
    clone: cloneState,
    state: function () { return heldDocument(); },
    docFile: function () {
      var f = fileHome();
      return { name: f && f.handle ? f.handle.name : null, kind: f ? f.format : null,
               lastModified: f ? f.lastModified : null };
    },
    hasDiskBase: function () { return !!(fileHome() && fileHome().diskBase); },
    forgetDiskBase: function () { if (fileHome()) amendHome(fileHome(), { diskBase: null }); setBaseState(null, "__splitpageFormats.forgetDiskBase: test hook, drives the two-way fallback"); return true; }
  };
}
