import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("standalone Writer visual key builds no shared buffer and keeps the same work at 2 and 200 rows", context => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    import { pathToFileURL } from "node:url";
    const field = await import("./src/application/editing/buffered-field.ts");
    const painted = await import("./src/application/editing/painted-beats.ts");
    const cells = await import("./src/features/editing/cell-buffer.ts");
    const rich = await import("./src/bootstrap/richtext.ts");
    let built = 0, records = 0, mounts = 0, decodes = 0;
    mock.module(pathToFileURL("src/application/editing/buffered-field.ts").href, { namedExports: { createBufferedField: (...args) => { built++; return field.createBufferedField(...args); } } });
    mock.module(pathToFileURL("src/application/editing/painted-beats.ts").href, { namedExports: { createPaintedBeats: (...args) => { records++; return painted.createPaintedBeats(...args); } } });
    mock.module(pathToFileURL("src/features/editing/cell-buffer.ts").href, { namedExports: { mountCellBuffer: (...args) => { mounts++; return cells.mountCellBuffer(...args); } } });
    mock.module(pathToFileURL("src/bootstrap/richtext.ts").href, { namedExports: { ...rich, fromHtml: (...args) => { decodes++; return rich.fromHtml(...args); } } });
    const { writerFor } = await import("./tests/features/writer/painted-base-support.ts");
    const counts = [];
    for (const size of [2, 200]) {
      const page = writerFor(undefined, size);
      page.doc.rows[0].visualText = "Wide";
      page.writer.repaint(); page.writer.openVisual("a");
      const cell = document.querySelector(".wr-flow-visual-text"); assert.ok(cell);
      let reads = 0;
      page.doc.rows = new Proxy(page.doc.rows, { get: (rows, key, receiver) => {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) reads++;
        return Reflect.get(rows, key, receiver);
      } });
      const before = decodes;
      assert.equal(cell.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "s" })), true);
      cell.firstChild.appendData("s");
      window.getSelection().setBaseAndExtent(cell.firstChild, 5, cell.firstChild, 5);
      cell.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "s" }));
      counts.push([size, reads, decodes - before]);
      assert.equal(page.doc.rows[0].visualText, "Wides");
      assert.equal(page.writer.settle, undefined);
      page.writer.dispose();
    }
    assert.deepEqual({ built, records, mounts }, { built: 0, records: 0, mounts: 0 });
    console.log(JSON.stringify(counts));
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const counts: unknown = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  assert.deepEqual(counts, [[2, 12, 5], [200, 12, 5]]);
  context.diagnostic("2 and 200 rows: 12 row reads and five decodes per key; no shared field, painted record or cell buffer");
});
