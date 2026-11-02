import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { JSDOM } from "jsdom";
import { mountImportDialog } from "../../../src/features/imports/imports.ts";
import { parseImportRows, detectTwoColumnFormat } from "../../../src/adapters/formats/import-text.ts";

function harness(storageDisabled = false) {
  const realm = new JSDOM(readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8"), { url: "https://splitpage.test/" }).window;
  if (storageDisabled) Object.defineProperty(realm, "localStorage", { get() { throw new Error("storage disabled"); } });
  const calls = [];
  const doc = { rows: [{ id: "existing", audioText: "Original" }] };
  let owned = true, allowed = true, reject = false;
  let pending;
  const ports = {
    document: { read: (select) => select(doc) },
    edits: {
      allowed: () => allowed,
      stamps: { clock: { nowIso: () => "2026-10-26T12:00:00.000Z" }, editor: { name: () => "Adam" } },
      run: (command) => {
        calls.push(command.name);
        if (reject) return { kind: "rejected", reason: "refused" };
        const plan = command.plan(doc);
        plan.apply(doc);
        return { kind: "applied", generation: 1, changes: plan.changes };
      }
    },
    ownership: { capture: () => ({}), stillOwns: () => owned },
    history: { keep: (label) => calls.push(label) },
    text: { sanitizeHtml: (html) => html },
    notices: { show: (message) => calls.push(message) },
    formats: {
      parse: parseImportRows, detect: detectTwoColumnFormat,
      normalize: (rows) => rows.map((row, i) => ({ ...row, id: "new" + i })),
      csv: () => [{ id: "csv", audioText: "CSV" }],
      docx: () => new Promise((resolve) => { pending = resolve; }),
      anchorBroll: () => 0,
      declineBroll: () => calls.push("decline")
    },
    desktop: { running: () => true, openExternal: (url) => calls.push(url) },
    noteEdit: () => calls.push("noteEdit"),
    stampRow: (row) => { row.updatedBy = "Adam"; calls.push("stamp"); },
    mode: { touched: () => false, reset: () => {} }
  };
  const controls = mountImportDialog(ports, realm);
  const el = (id) => realm.document.getElementById(id);
  return { realm, calls, doc, controls, el, own: (value) => { owned = value; }, deny: () => { allowed = false; reject = true; }, decode: (rows) => pending({ rows }) };
}

test("import dialog mounts without the app and replaces through one command after its snapshot", () => {
  const h = harness();
  try {
    h.controls.openImportModal();
    h.el("import-textarea").value = "First\n\nSecond";
    h.el("import-replace").checked = true;
    h.controls.confirmImport();
    assert.deepEqual(h.doc.rows.map((row) => row.audioText), ["First", "Second"]);
    assert.deepEqual(h.calls.slice(0, 2), ["Before replacing rows on import", "import-replace-rows"]);
    assert.equal(h.el("import-modal").hidden, true);
    assert.equal(h.doc.rows[0].updatedBy, "Adam");
  } finally { h.controls.dispose(); h.realm.close(); }
});

test("stale ownership refuses confirmation before history and edits", () => {
  const h = harness();
  try {
    h.controls.openImportModal();
    h.el("import-textarea").value = "New";
    h.own(false);
    h.controls.confirmImport();
    assert.deepEqual(h.doc.rows.map((row) => row.audioText), ["Original"]);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0], /script changed/);
  } finally { h.controls.dispose(); h.realm.close(); }
});

test("a refused import neither snapshots nor changes rows", () => {
  const h = harness();
  try {
    h.controls.openImportModal();
    h.el("import-textarea").value = "New";
    h.el("import-replace").checked = true;
    h.deny();
    h.controls.confirmImport();
    assert.deepEqual(h.doc.rows.map((row) => row.audioText), ["Original"]);
    assert.deepEqual(h.calls, ["import-replace-rows"]);
  } finally { h.controls.dispose(); h.realm.close(); }
});

test("new-document import stamps before adoption and notes the edit afterwards", () => {
  const h = harness();
  try {
    let adopted;
    h.controls.openImportModal({ intoNewDocument: (rows, scan) => { h.calls.push("adopt"); adopted = { rows }; scan(adopted); } });
    h.el("import-textarea").value = "New";
    h.controls.confirmImport();
    assert.equal(adopted.rows[0].updatedBy, "Adam");
    assert.deepEqual(h.calls.slice(0, 3), ["stamp", "adopt", "noteEdit"]);
    assert.equal(h.doc.rows[0].audioText, "Original");
  } finally { h.controls.dispose(); h.realm.close(); }
});

test("a decode completing after dispose cannot change a remounted preview", async () => {
  const h = harness();
  let replacement;
  try {
    h.controls.openImportModal();
    const completion = h.controls.importDocumentSource().open({ file: { name: "old.docx" } });
    h.controls.dispose();
    const fresh = harness();
    replacement = fresh;
    fresh.controls.openImportModal();
    fresh.el("import-textarea").value = "Fresh";
    fresh.controls.updateImportPreview();
    h.decode([{ id: "late", audioText: "Late" }]);
    await completion;
    assert.match(fresh.el("import-preview").textContent, /Fresh/);
    assert.equal(fresh.el("import-textarea").value, "Fresh");
    assert.deepEqual(h.doc.rows.map((row) => row.audioText), ["Original"]);
  } finally { h.controls.dispose(); replacement?.controls.dispose(); h.realm.close(); replacement?.realm.close(); }
});

test("Google Docs uses the desktop download URL and closes its dialog", () => {
  const h = harness();
  try {
    h.controls.openGdocModal();
    h.el("gdoc-url-input").value = "https://docs.google.com/document/d/abcdefghijklmno/edit";
    h.controls.confirmGdocImport();
    assert.equal(h.calls[0], "https://docs.google.com/document/d/abcdefghijklmno/export?format=docx");
    assert.equal(h.el("gdoc-modal").hidden, true);
    assert.match(h.calls[1], /Opening the Doc/);
  } finally { h.controls.dispose(); h.realm.close(); }
});

test("unavailable scan-preference storage does not prevent mounting or importing", () => {
  const h = harness(true);
  try {
    h.controls.openImportModal();
    h.el("import-textarea").value = "New";
    h.controls.confirmImport();
    assert.equal(h.doc.rows[1].audioText, "New");
    assert.equal(h.el("import-modal").hidden, true);
  } finally { h.controls.dispose(); h.realm.close(); }
});
