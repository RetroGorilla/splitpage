import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S } from "../js/_state.js";

await bootApp();
after(closeApp);

const { exportFormats } = await import("../legacy/export-formats.ts");
const { commandResults } = await import("../js/18d-command-menu.js");
const { exportBaseName } = await import("../js/18-local-files.js");
const {
  closeExportDialog, exportAgain, exportAgainItemState, exportActionReason, exportFileNameFor, exportSummary, lastExportAction,
  openExportDialog
} = await import("../js/18c-export-dialog.js");

const CARD = { id: "demo", group: "part", name: "Demo sheet", ext: ".demo", icon: "i-file", purpose: "A throwaway format for the test" };

function delivered() {
  const files = [];
  const make = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const click = window.HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => { files.push({ blob }); return "blob:registry/" + files.length; };
  URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { files[files.length - 1].name = this.download; };
  return {
    files,
    restore() {
      URL.createObjectURL = make;
      URL.revokeObjectURL = revoke;
      window.HTMLAnchorElement.prototype.click = click;
    }
  };
}

function demoExporter(extra = {}) {
  const built = [];
  return {
    built,
    decl: {
      id: "demo-sheet",
      action: "export-demo-sheet",
      card: "demo",
      name: "Demo sheet",
      menuLabel: "Demo sheet (.demo)",
      words: "zebra stripes",
      fileName: (base) => base + " - demo.demo",
      build: (ctx, base) => {
        built.push({ title: ctx.doc.title, frozen: Object.isFrozen(ctx.doc), base, allowImageBundle: ctx.options.allowImageBundle });
        return { data: "demo of " + ctx.doc.title };
      },
      ...extra
    }
  };
}

function exportItems(query) {
  return commandResults(query).filter((g) => g.group === "Export").flatMap((g) => g.items);
}

test("one provider and one registration put a new exporter in the menu, the palette, the dialog and Export Again", async () => {
  const demo = demoExporter();
  const docBefore = JSON.stringify(S.state);
  const dirtyBefore = S.dirty;
  const baseBefore = JSON.stringify(S.baseState);
  const seqBefore = S.editSeq;
  const idBefore = S.state.docId;
  const files = delivered();
  const dropCard = exportFormats.defineCard(CARD);
  const drop = exportFormats.register(demo.decl);
  try {
    const button = document.querySelector('#file-menu .menu-hidden-actions [data-file-action="export-demo-sheet"]');
    assert.ok(button, "a menu entry is drawn from the declaration");
    assert.equal(button.textContent, "Demo sheet (.demo)");
    assert.equal(document.querySelectorAll('#file-menu .menu-hidden-actions [data-file-action]').length, 17);

    const listed = exportItems("zebra");
    assert.deepEqual(listed.map((i) => i.cmd.id), ["export-demo-sheet"], "the palette finds it by its words");
    assert.equal(listed[0].view.label, "Export as Demo sheet");
    assert.equal(listed[0].view.disabled, false);

    assert.equal(openExportDialog({ action: "export-demo-sheet" }), true);
    assert.ok(document.querySelector('.export-card[data-format="demo"]'), "the dialog draws a card");
    assert.equal(document.querySelector('input[name="export-format"]:checked').value, "demo");
    assert.equal(document.getElementById("export-go").textContent, "Export Demo sheet");
    assert.equal(document.getElementById("export-filename").textContent, exportBaseName() + " - demo.demo");
    assert.equal(exportFileNameFor("export-demo-sheet"), exportBaseName() + " - demo.demo");
    assert.equal(typeof exportSummary("export-demo-sheet"), "string");

    document.getElementById("export-go").click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(files.files.map((f) => f.name), [exportBaseName() + " - demo.demo"], "the dialog ran the provider");
    assert.equal(await files.files[0].blob.text(), "demo of " + S.state.title);
    assert.deepEqual(demo.built.map((b) => [b.frozen, b.allowImageBundle]), [[true, true]], "the provider got the captured, frozen document");
    assert.equal(lastExportAction(), "export-demo-sheet", "the choice is remembered by its action id");
    assert.ok(document.getElementById("export-modal").hidden);

    assert.equal(exportAgainItemState().label, "Export again as Demo sheet");
    exportAgain();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(files.files.length, 2, "Export Again ran it");

    const [item] = exportItems("zebra");
    item.cmd.run();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(files.files.length, 3, "the palette ran it");

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(files.files.length, 4, "the menu entry ran it");

    assert.equal(JSON.stringify(S.state), docBefore, "exporting left the document as it was");
    assert.equal(S.dirty, dirtyBefore);
    assert.equal(JSON.stringify(S.baseState), baseBefore, "no baseline was confirmed");
    assert.equal(S.editSeq, seqBefore);
    assert.equal(S.state.docId, idBefore);
  } finally {
    closeExportDialog();
    files.restore();
    drop();
    dropCard();
  }
  assert.equal(document.querySelector('[data-file-action="export-demo-sheet"]'), null, "unregistering removes the menu entry");
  assert.deepEqual(exportItems("zebra"), []);
  assert.equal(lastExportAction(), null, "an action nobody registers is not offered again");
  assert.equal(exportAgainItemState().hidden, true);
  assert.equal(document.querySelectorAll('#file-menu .menu-hidden-actions [data-file-action]').length, 16);
});

test("an exporter's own availability reason greys it out everywhere", async () => {
  let reason = "Nothing to demo yet";
  const demo = demoExporter({ reason: () => reason });
  const files = delivered();
  const dropCard = exportFormats.defineCard(CARD);
  const drop = exportFormats.register(demo.decl);
  try {
    assert.equal(exportActionReason("export-demo-sheet"), reason);
    const [item] = exportItems("zebra");
    assert.equal(item.view.disabled, true);
    assert.equal(item.view.why, reason);
    openExportDialog({ action: "export-demo-sheet" });
    assert.equal(document.getElementById("export-go").disabled, true);
    assert.equal(document.getElementById("export-why").textContent, reason);
    assert.equal(document.querySelector('.export-card[data-format="demo"]').classList.contains("is-unavailable"), true);
    closeExportDialog();
    reason = "";
    assert.equal(exportActionReason("export-demo-sheet"), "");
    assert.equal(exportItems("zebra")[0].view.disabled, false);
  } finally {
    closeExportDialog();
    files.restore();
    drop();
    dropCard();
  }
  assert.equal(files.files.length, 0);
});

test("a second variant joins an existing card as one more choice", () => {
  const stacked = exportFormats.byAction("export-md");
  assert.ok(stacked);
  const drop = exportFormats.register({
    id: "md-demo", action: "export-md-demo", card: "md", choice: { value: "demo", label: "Demo shape" },
    name: "Markdown, demo", menuLabel: "Markdown, demo (.md)", fileName: (base) => base + " - demo.md",
    build: () => ({ data: "demo" })
  });
  try {
    assert.deepEqual(exportFormats.card("md")?.variants.map((v) => v.choice?.value), ["stacked", "table", "demo"]);
    openExportDialog({ action: "export-md-demo" });
    assert.deepEqual(
      Array.from(document.querySelectorAll('#export-options input[name="export-choice"]')).map((i) => i.value),
      ["stacked", "table", "demo"]);
    assert.equal(document.getElementById("export-go").textContent, "Export Markdown, demo");
  } finally {
    closeExportDialog();
    drop();
  }
  assert.deepEqual(exportFormats.card("md")?.variants.map((v) => v.choice?.value), ["stacked", "table"]);
});

test("the byte-capture matrix lists every registered exporter, so a new format cannot skip its cases", () => {
  const matrix = readFileSync(new URL("./m4-matrix-exports.test.mjs", import.meta.url), "utf8");
  const kinds = new Set((/const KINDS = \[([^\]]*)\]/.exec(matrix) || ["", ""])[1].match(/"[^"]+"/g)?.map((k) => k.slice(1, -1)));
  const registered = exportFormats.exporters().map((e) => e.id).concat(["txt"]);
  assert.deepEqual(registered.filter((id) => !kinds.has(id)), [], "add the new exporter to KINDS in m4-matrix-exports.test.mjs");
});
