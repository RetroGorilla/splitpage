import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("standalone Split full and row repaint add no shared caret mapping, paint normalization or selection reads", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { pathToFileURL } from "node:url";
    const url = path => pathToFileURL(path).href;
    const mapping = await import("./src/application/editing/painted-selection.ts");
    const cells = await import("./src/features/common/cell-dom.ts");
    const reading = await import("./src/adapters/collab/paint-base.ts");
    const counts = { mapping: 0, paint: 0, reading: 0 };
    mock.module(url("src/application/editing/painted-selection.ts"), { namedExports: { ...mapping, followPaintedCaret: (...args) => { counts.mapping++; return mapping.followPaintedCaret(...args); } } });
    mock.module(url("src/features/common/cell-dom.ts"), { namedExports: { ...cells, paintTrailingCellSpaces: (...args) => { counts.paint++; return cells.paintTrailingCellSpaces(...args); } } });
    mock.module(url("src/adapters/collab/paint-base.ts"), { namedExports: { ...reading, readSharedPaintedSelectionText: (...args) => { counts.reading++; return reading.readSharedPaintedSelectionText(...args); } } });
    const { bootApp, closeApp } = await import("./src/test/_app-boot.mjs");
    window.Element.prototype.scrollBy = () => {};
    window.Element.prototype.scrollIntoView = () => {};
    await bootApp();
    const { migrateRows } = await import("./src/bootstrap/document-ports.ts");
    const { exportDocumentOf } = await import("./src/bootstrap/wiring/export-capture.ts");
    const { buildSplitpageFile } = await import("./src/adapters/formats/project-file.ts");
    const { openDocument } = await import("./src/bootstrap/wiring/transition-owners.ts");
    const { render, renderRow } = await import("./src/features/rows/render.ts");
    for (const size of [2, 50]) {
      const rows = Array.from({ length: size }, (_, index) => ({ id: "r" + index, audioText: "Word ", visualText: "Wide " }));
      const file = new File([buildSplitpageFile(exportDocumentOf(migrateRows({ schema: 2, paragraphsDecided: true, title: "Paint cost", rows })))], "paint.splitpage");
      await openDocument({ kind: "file", file, handle: null, options: { skipSnapshot: true } });
      assert.equal(document.querySelector('#rows .cell-editable[data-id="r0"][data-field="audioText"]').textContent, "Word ");
      render(); renderRow("r0");
      assert.deepEqual(counts, { mapping: 0, paint: 0, reading: 0 });
    }
    const { splitSpaceSwitch } = await import("./src/test/_shared-split-space.mjs");
    const { enterSharedSession, leaveSharedSession } = await import("./src/bootstrap/wiring/shared-session.ts");
    const { ports } = splitSpaceSwitch();
    assert.deepEqual(await enterSharedSession(ports), { ok: true });
    assert.ok(document.querySelector("[data-shared-cell-space]"));
    counts.paint = 0;
    render(); renderRow("r0");
    assert.equal(counts.paint, 0);
    assert.deepEqual(leaveSharedSession(ports), { ok: true });
    assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
    Object.assign(counts, { mapping: 0, paint: 0, reading: 0 });
    render(); renderRow("r0");
    assert.deepEqual(counts, { mapping: 0, paint: 0, reading: 0 });
    assert.equal(document.querySelector("[data-shared-cell-space-form], [data-shared-cell-space]"), null);
    await closeApp();
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
