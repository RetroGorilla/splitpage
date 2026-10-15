import test from "node:test";
import assert from "node:assert/strict";
import { heldTimers } from "../view-harness.ts";
import { mountImports, mountGdoc } from "../../../src/features/imports/mount.ts";
import type { ImportsPorts, GdocPorts } from "../../../src/features/imports/mount.ts";
import { viewHarness } from "../view-harness.ts";
import type { Registration } from "../view-harness.ts";

const expected: readonly Registration[] = [
  [
    "md-rows-keep",
    "click"
  ],
  [
    "md-rows-table",
    "click"
  ],
  [
    "window",
    "keydown"
  ],
  [
    "import-close",
    "click"
  ],
  [
    "import-cancel",
    "click"
  ],
  [
    "import-confirm",
    "click"
  ],
  [
    "import-textarea",
    "input"
  ],
  [
    "import-split:paragraph",
    "change"
  ],
  [
    "import-split:line",
    "change"
  ],
  [
    "import-split:sentence",
    "change"
  ],
  [
    "import-split:twocolumn",
    "change"
  ],
  [
    "import-choose-file",
    "click"
  ],
  [
    "import-file-input",
    "change"
  ],
  [
    "import-modal",
    "click"
  ],
  [
    "window",
    "keydown"
  ],
  [
    "gdoc-close",
    "click"
  ],
  [
    "gdoc-cancel",
    "click"
  ],
  [
    "gdoc-confirm",
    "click"
  ],
  [
    "gdoc-url-input",
    "keydown"
  ],
  [
    "gdoc-modal",
    "click"
  ],
  [
    "window",
    "keydown"
  ]
];

export function setup() {
  const h = viewHarness();
  const p0: ImportsPorts = {
    finishMarkdownRowChoice: h.log("finishMarkdownRowChoice"),
    closeImportModal: h.log("closeImportModal"),
    confirmImport: h.log("confirmImport"),
    clearPendingFileRows: h.log("clearPendingFileRows"),
    maybeAutoDetectTwoColumn: h.log("maybeAutoDetectTwoColumn"),
    updateImportPreview: h.log("updateImportPreview"),
    handleImportFile: h.log("handleImportFile"),
    touchMode: h.log("touchMode"),
    capture: h.capture
  };
  const p1: GdocPorts = {
    closeGdocModal: h.log("closeGdocModal"),
    confirmGdocImport: h.log("confirmGdocImport")
  };
  const mount = () => [mountImports({ window: h.window, ports: p0 }), mountGdoc({ window: h.window, ports: p1 })];
  return { ...h, mount, p0, p1 };
}

test("imports: every target, event, phase and multiplicity across dispose and remount", () => {
  const h = setup();
  h.assertRemount(h.mount, expected);
  h.window.close();
});

for (const scenario of ["dispose and reopen", "same-ID replacement", "stale completion after remount", "normal completion"]) {
  test("imports: S31 held preview, " + scenario, () => {
    const h = setup();
    const timers = heldTimers(h.window, 150);
    const mount = () => mountImports({ window: h.window, ports: h.p0 });
    const owner = mount();
    let replacement: ReturnType<typeof mount> | undefined;
    try {
      h.el("import-textarea").value = "Visual: forest\nAudio: hello";
      h.fire(h.el("import-textarea"), "input");
      assert.equal(timers.pending.size, 1);
      assert.deepEqual(h.calls.map((call) => call.name), ["clearPendingFileRows"]);
      if (scenario === "dispose and reopen" || scenario === "stale completion after remount") {
        owner.dispose();
        assert.equal(timers.pending.size, 0);
        assert.equal(timers.cancelled.length, 1);
        h.replaceDocument();
        replacement = mount();
      } else if (scenario === "same-ID replacement") h.replaceDocument();
      h.calls.length = 0;
      timers.advance();
      if (scenario === "stale completion after remount") timers.held.forEach((run) => run());
      assert.deepEqual(h.calls, scenario === "normal completion" ? [
        { name: "maybeAutoDetectTwoColumn", args: ["Visual: forest\nAudio: hello"] }, { name: "updateImportPreview", args: [] }
      ] : []);
    } finally {
      owner.dispose();
      replacement?.dispose();
      timers.dispose();
      h.window.close();
    }
  });
}

test("imports: a newer input cancels the old timer and split changes stay immediate", () => {
  const h = setup();
  const timers = heldTimers(h.window, 150);
  const owners = h.mount();
  h.el("import-textarea").value = "first";
  h.fire(h.el("import-textarea"), "input");
  h.el("import-textarea").value = "second";
  h.fire(h.el("import-textarea"), "input");
  assert.equal(timers.pending.size, 1);
  assert.equal(timers.cancelled.length, 1);
  h.calls.length = 0;
  timers.held[0]?.();
  assert.deepEqual(h.calls, []);
  timers.advance();
  const split = h.document.querySelector('input[name="import-split"]');
  assert.ok(split);
  h.fire(split, "change");
  assert.deepEqual(h.calls.map((call) => call.name), ["maybeAutoDetectTwoColumn", "updateImportPreview", "touchMode", "updateImportPreview"]);
  owners.forEach((owner) => owner.dispose());
  timers.dispose();
  h.window.close();
});

test("imports: Markdown and Google Docs keyboard, backdrop and buttons keep their routes", () => {
  const h = setup();
  const owners = h.mount();
  h.el("md-rows-modal").hidden = false;
  h.el("import-modal").hidden = false;
  h.el("gdoc-modal").hidden = false;
  h.fire(h.el("md-rows-table"), "click");
  h.fire(h.el("gdoc-url-input"), "keydown", { key: "Enter" });
  h.fire(h.el("gdoc-modal"), "click");
  h.fire(h.el("import-modal"), "click");
  h.fire(h.window, "keydown", { key: "Escape" });
  assert.deepEqual(h.calls, [
    { name: "finishMarkdownRowChoice", args: ["table"] }, { name: "confirmGdocImport", args: [] },
    { name: "closeGdocModal", args: [] }, { name: "closeImportModal", args: [] },
    { name: "finishMarkdownRowChoice", args: ["keep"] }, { name: "closeImportModal", args: [] }, { name: "closeGdocModal", args: [] }
  ]);
  owners.forEach((owner) => owner.dispose());
  h.window.close();
});
