import { bootApp, closeApp } from "./_app-boot.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { currentDocument } from "../bootstrap/wiring/session-owner.ts";

window.Element.prototype.scrollIntoView = function () {};
await bootApp();
const { openBrollPanel, openBrollPage } = await import("../features/broll/panel.ts");
const { mountBrollEventsFeature: mountBrollFeature } = await import("../bootstrap/wiring/production.ts");
const { documentTransitions } = await import("../bootstrap/wiring/transition-owners.ts");
const { render } = await import("../features/rows/render.ts");
const { writerControls } = await import("../bootstrap/wiring/writer.ts");
const { scriptCellOf, storedHtmlFromDom } = await import("../bootstrap/richtext.ts");
const { domToPos } = await import("../features/common/cell-dom.ts");
const { editableTextHtml, setEditableTextHtml } = await import("../features/common/dom.ts");
after(closeApp);

function open(visualText = "Scene") {
  documentTransitions().open({
    from: { raw: {
      schema: 2, docId: "dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", title: "B-roll lifetime",
      rows: [{ id: "r1", status: "todo", visualText, audioText: "One" }],
      brollShots: [{ id: "b_one", name: "First shot", origin: "list", status: "unshot", notes: "", props: [] }]
    } },
    reason: "broll-lifetime"
  });
  render();
  openBrollPanel();
}

test("only the standard B-roll marker prefix is decorated in the editor", () => {
  const html = '<span class="broll-key" data-broll-id="bs_standard" contenteditable="false">B-roll: and words</span>' +
    '<br><span class="broll-key" data-broll-id="bs_variant" contenteditable="false">broll:</span> harbour';
  open(html);
  const cell = document.querySelector('#rows .cell-editable[data-field="visualText"]');
  const [standard, variant] = cell.querySelectorAll(".broll-key");
  const prefix = standard.querySelector(".broll-marker-prefix");
  assert.equal(prefix?.textContent, "B-roll:");
  assert.equal(standard.lastChild.textContent, " and words");
  assert.equal(variant.childElementCount, 0);
  assert.equal(domToPos(cell, prefix.firstChild, 0), 0);
  assert.equal(domToPos(cell, prefix.firstChild, prefix.textContent.length), 1);
  assert.equal(storedHtmlFromDom(editableTextHtml(cell)), html);
  assert.equal(currentDocument().rows[0].visualText, html);
});

test("the script cell reader reuses the stored HTML key for decorated marker text", () => {
  const markup = '<span class="broll-key" data-broll-id="bs_readback" contenteditable="false">';
  const stored = markup + 'B-roll:</span> ';
  const cell = document.createElement("div");
  const parser = window.DOMParser.prototype;
  const parse = parser.parseFromString;
  let decoratedParses = 0;
  parser.parseFromString = function (source, type) {
    if (source.includes('class="broll-marker-prefix"')) decoratedParses++;
    return parse.call(this, source, type);
  };
  try {
    const reads = Array.from({ length: 10 }, (_, i) => {
      const suffix = "0123456789".slice(0, i + 1);
      setEditableTextHtml(cell, stored + suffix);
      const runs = scriptCellOf(stored + suffix);
      const html = editableTextHtml(cell);
      return [runs, scriptCellOf(html), storedHtmlFromDom(html), stored + suffix];
    });
    assert.equal(decoratedParses, 0);
    for (const [runs, read, html, expected] of reads) {
      assert.equal(read, runs);
      assert.equal(html, expected);
    }
  } finally {
    parser.parseFromString = parse;
  }
});

test("literal marker markup in pasted text is kept distinct from editor decoration", () => {
  const marker = '<span class="broll-marker-prefix">b-roll:</span>';
  const paste = '<textarea>' + marker + '</textarea>';
  const cell = document.createElement("div");
  cell.innerHTML = marker;
  assert.equal(editableTextHtml(cell), marker);
  assert.equal(scriptCellOf(paste).map(run => run.text).join(""), marker);
  assert.notEqual(scriptCellOf(paste), scriptCellOf("<textarea>b-roll:</textarea>"));
});

test("Split drag and Writer Visual copy send the original B-roll markup", () => {
  const marker = '<span class="broll-key" data-broll-id="bs_transfer" contenteditable="false">b-roll:</span>';
  open(marker + " harbour");
  const writer = writerControls();
  try {
    for (const [selector, type, transfer] of [
      ["#rows .broll-key", "dragstart", "dataTransfer"],
      [".wr-flow-visual-text .broll-key", "copy", "clipboardData"]
    ]) {
      if (type === "copy") {
        writer.openWriter();
        writer.writerFlowControl().openVisual("r1");
      }
      const tag = document.querySelector(selector);
      const range = document.createRange();
      range.selectNode(tag);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new Map();
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, transfer, { value: { setData: (format, value) => data.set(format, value) } });
      tag.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
      assert.equal(data.get("text/html"), marker);
      assert.equal(data.get("text/plain"), "b-roll:");
    }
  } finally {
    writer.closeWriter();
  }
});

function fire(target, type, props = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

for (const scenario of ["dispose and reopen", "same-ID document replacement", "stale callback after remount", "normal callback"]) {
  test("b-roll app: retained handler, " + scenario, async () => {
    open();
    mountBrollFeature().dispose();
    const button = document.getElementById("broll-add-save");
    const previous = button.addEventListener;
    let held;
    button.addEventListener = function (type, fn, options) {
      if (type === "click") held = fn;
      return previous.call(this, type, fn, options);
    };
    const owner = mountBrollFeature();
    button.addEventListener = previous;
    openBrollPanel();
    assert.equal(typeof held, "function");
    let replacement;
    try {
      if (scenario !== "normal callback") owner.dispose();
      if (scenario === "dispose and reopen" || scenario === "same-ID document replacement") {
        const before = currentDocument();
        open();
        assert.notEqual(currentDocument(), before);
        assert.equal(currentDocument().docId, before.docId);
      }
      if (scenario === "stale callback after remount" || scenario === "dispose and reopen") {
        replacement = mountBrollFeature();
        openBrollPanel();
      }
      document.getElementById("broll-add-input").value = "Held shot";
      const before = JSON.stringify(currentDocument());
      const panel = document.getElementById("broll-panel");
      const html = panel.innerHTML;
      held(new window.Event("click"));
      await Promise.resolve();
      if (scenario === "normal callback") assert.equal(currentDocument().brollShots.filter((shot) => shot.name === "Held shot").length, 1);
      else {
        assert.equal(JSON.stringify(currentDocument()), before);
        assert.equal(panel.innerHTML, html);
        assert.equal(document.getElementById("broll-add-input").value, "Held shot");
      }
    } finally {
      owner.dispose();
      replacement?.dispose();
    }
  });
}

test("b-roll app: remount adds once, and disposal clears menus, selection and page focus resources", () => {
  open();
  const owner = mountBrollFeature();
  openBrollPanel();
  fire(document.querySelector('.broll-row-main[data-id="b_one"]'), "click", { ctrlKey: true });
  assert.deepEqual(window.__brollTest.selected(), ["b_one"]);
  fire(document.querySelector('[data-action="broll-group-menu"]'), "click");
  assert.ok(document.querySelector(".broll-group-menu"));
  openBrollPage();
  assert.equal(document.body.classList.contains("broll-page-open"), true);
  owner.dispose();
  assert.deepEqual(window.__brollTest.selected(), []);
  assert.equal(document.getElementById("broll-page").hidden, true);
  assert.equal(document.getElementById("broll-panel").hidden, true);
  assert.equal(document.body.classList.contains("broll-page-open"), false);
  const replacement = mountBrollFeature();
  try {
    openBrollPanel();
    assert.equal(document.querySelector(".broll-group-menu"), null);
    assert.equal(document.querySelector(".broll-card"), null);
    document.getElementById("broll-add-input").value = "Once after remount";
    fire(document.getElementById("broll-add-save"), "click");
    assert.equal(currentDocument().brollShots.filter((shot) => shot.name === "Once after remount").length, 1);
  } finally {
    replacement.dispose();
  }
});

test("export capture keeps the owner's live scope with the panel stopped", async () => {
  const { brollView } = await import("../bootstrap/wiring/ports/preferences.ts");
  const { localFileMenuControls } = await import("../bootstrap/wiring/local-files.ts");
  const { stopBrollPanelStateFeature, mountBrollPanelStateFeature } = await import("../bootstrap/wiring/broll.ts");
  const saved = brollView.current();
  open();
  try {
    brollView.setFilter("flagged");
    brollView.setPageGroup("person");
    stopBrollPanelStateFeature();
    assert.ok(currentDocument());
    const captured = localFileMenuControls().exportRequest("b-roll csv");
    assert.deepEqual(captured.options.brollView, { filter: "flagged", group: "person" });
    brollView.setFilter("shot");
    assert.deepEqual(captured.options.brollView, { filter: "flagged", group: "person" });
    assert.deepEqual(localFileMenuControls().exportRequest("b-roll csv").options.brollView, { filter: "shot", group: "person" });
    assert.deepEqual(localFileMenuControls().exportRequest("b-roll csv", { brollView: { filter: "all", group: "scene" } }).options.brollView, { filter: "all", group: "scene" });
  } finally {
    brollView.setFilter(saved.filter);
    brollView.setGroup(saved.group);
    brollView.setPageGroup(saved.pageGroup);
    mountBrollPanelStateFeature();
  }
});

test("records lookup follows the booted instance, replacement and stop", async () => {
  const { currentBrollRecords, mountBrollFeature: mountRecords, stopBrollFeature: stopRecords } = await import("../bootstrap/wiring/broll.ts");
  const first = currentBrollRecords();
  assert.ok(first);
  try {
    const second = mountRecords();
    assert.notEqual(first, second);
    assert.equal(currentBrollRecords(), second);
    stopRecords();
    assert.equal(currentBrollRecords(), null);
  } finally {
    const replacement = mountRecords();
    assert.equal(currentBrollRecords(), replacement);
    assert.notEqual(currentBrollRecords(), first);
  }
});
