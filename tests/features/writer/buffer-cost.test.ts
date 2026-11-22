import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("standalone keystroke work: production input dispatch adds no buffer work or row walk", context => {
  const script = String.raw`
    import assert from "node:assert/strict";
    const { writerFor, typeInto } = await import("./tests/features/writer/painted-base-support.ts");
    const counts = [];
    for (const size of [2, 200]) {
      const page = writerFor(size);
      page.writer.repaint(); page.writer.caret("a", 5);
      const beat = page.root.querySelector('.wr-beat[data-id="a"]'); assert.ok(beat);
      let reads = 0;
      page.doc.rows = new Proxy(page.doc.rows, { get: (rows, key, receiver) => {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) reads++;
        return Reflect.get(rows, key, receiver);
      } });
      const before = new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "s" });
      assert.equal(page.root.dispatchEvent(before), true);
      typeInto(page.root, beat, "s");
      counts.push([size, reads]);
      assert.equal(page.doc.rows[0].audioText, "Alphas");
      assert.equal(page.writer.settle, undefined);
      page.writer.dispose();
    }
    assert.deepEqual(counts, [[2, 17], [200, 17]]);
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  context.diagnostic("2 and 200 rows: 17 production row reads per native key");
});

test("standalone heading keystroke: the rename runs as before, with no buffer, painted record or field key", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    const { writerFor } = await import("./tests/features/writer/painted-base-support.ts");
    for (const size of [2, 200]) {
      const page = writerFor(size, [{ id: "H1", name: "Scene", firstSceneId: "a" }]);
      page.writer.repaint();
      const heading = page.root.querySelector('.wr-heading[data-scene="H1"]'); assert.ok(heading);
      const node = heading.firstChild; assert.ok(node);
      window.getSelection().setBaseAndExtent(node, 5, node, 5);
      assert.equal(page.root.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "s" })), true);
      node.appendData("s"); window.getSelection().setBaseAndExtent(node, 6, node, 6);
      page.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "s" }));
      assert.deepEqual(page.doc.sections.map(scene => scene.name), ["Scenes"]);
      assert.equal(page.writer.settle, undefined);
      page.writer.dispose();
    }
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "--eval", script],
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
