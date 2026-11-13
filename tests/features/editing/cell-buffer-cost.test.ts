import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

test("standalone Split keystroke: no cell buffer, binding or painted record is built, and the work per key is pinned", context => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { pathToFileURL } from "node:url";
    const url = path => pathToFileURL(path).href;
    const field = await import("./src/application/editing/buffered-field.ts");
    const beats = await import("./src/application/editing/painted-beats.ts");
    const cells = await import("./src/features/editing/cell-buffer.ts");
    const rich = await import("./src/bootstrap/richtext.ts");
    let built = 0, records = 0, mounts = 0, decodes = 0;
    mock.module(url("src/application/editing/buffered-field.ts"), { namedExports: { createBufferedField: (...args) => { built++; return field.createBufferedField(...args); } } });
    mock.module(url("src/application/editing/painted-beats.ts"), { namedExports: { createPaintedBeats: (...args) => { records++; return beats.createPaintedBeats(...args); } } });
    mock.module(url("src/features/editing/cell-buffer.ts"), { namedExports: { mountCellBuffer: (...args) => { mounts++; return cells.mountCellBuffer(...args); } } });
    mock.module(url("src/bootstrap/richtext.ts"), { namedExports: { ...rich, fromHtml: (...args) => { decodes++; return rich.fromHtml(...args); } } });
    const { bootApp, closeApp } = await import("./src/test/_app-boot.mjs");
    window.Element.prototype.scrollBy = function () {};
    window.Element.prototype.scrollIntoView = function () {};
    await bootApp();
    const { migrateRows } = await import("./src/bootstrap/document-ports.ts");
    const { exportDocumentOf } = await import("./src/bootstrap/wiring/export-capture.ts");
    const { buildSplitpageFile } = await import("./src/adapters/formats/project-file.ts");
    const { openDocument } = await import("./src/bootstrap/wiring/transition-owners.ts");
    const { currentDocument, liveSession } = await import("./src/bootstrap/wiring/session-owner.ts");
    const { paintedFromRow } = await import("./src/features/rows/render.ts");
    const counts = [];
    for (const size of [2, 50]) {
      const rows = Array.from({ length: size }, (_, index) => ({ id: "r" + index, visualText: "Wide", audioText: "Alpha", status: "todo" }));
      const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows({ schema: 2, paragraphsDecided: true, title: "Cost", rows })))], "cost-" + size + ".splitpage", { lastModified: size });
      await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
      const cell = document.querySelector('#rows .cell-editable[data-id="r0"][data-field="audioText"]'); assert.ok(cell);
      assert.equal(paintedFromRow(cell, "audioText", currentDocument().rows[0]), true);
      assert.equal(paintedFromRow(cell, "audioText", { ...currentDocument().rows[0], audioText: "Other" }), false);
      cell.focus();
      const walker = document.createTreeWalker(cell, 4); let node = null;
      while (walker.nextNode()) node = walker.currentNode;
      const changes = [], stop = liveSession().subscribe(change => { changes.push(change.kind); });
      const before = { decodes, painted: window.__renderTest.counts() };
      assert.equal(cell.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "s" })), true);
      node.data += "s";
      const range = document.createRange(); range.setStart(node, node.data.length); range.collapse(true);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "s" }));
      const after = window.__renderTest.counts(); stop();
      assert.equal(currentDocument().rows[0].audioText, "Alphas");
      counts.push([size, changes, decodes - before.decodes, after.rowsPainted - before.painted.rowsPainted, after.cellsPainted - before.painted.cellsPainted]);
    }
    console.log(JSON.stringify({ counts, built, records, mounts }));
    await closeApp();
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: REPO, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  assert.deepEqual(JSON.parse(line), { counts: [[2, ["edit"], 1, 0, 0], [50, ["edit"], 1, 0, 0]], built: 0, records: 0, mounts: 0 });
  context.diagnostic("2 and 50 rows: one edit, one decode and no repaint per native key; no buffered field, painted record or cell buffer");
});

test("the shared Split wiring is not called by the running app", () => {
  const files = (dir: string): string[] => readdirSync(REPO + dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(dir + "/" + entry.name) : /\.ts$/.test(entry.name) ? [dir + "/" + entry.name] : []);
  const importers = files("src").filter(path => /split-buffer\.ts|mountSharedSplitBuffer|mountCellBuffer/.test(readFileSync(REPO + path, "utf8")));
  assert.deepEqual(importers.sort(), ["src/bootstrap/wiring/split-buffer.ts", "src/features/editing/cell-buffer.ts"]);
});
