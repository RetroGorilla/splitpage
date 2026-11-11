import test from "node:test";
import assert from "node:assert/strict";
import { ScratchReplica } from "./designs.ts";
import { scratchExampleMark, scratchMarkKinds } from "./events.ts";
import { typingMarks } from "../../../../src/core/text/edits.ts";
import type { Marks } from "../../../../src/core/text/runs.ts";
import { ScratchModel } from "./model.ts";

for (const design of ["attributes", "records"] as const) test(`${design}: explicit typing and standalone inheritance at both edges and the interior`, () => {
  let checks = 0;
  for (const kind of scratchMarkKinds) for (const offset of [1, 2, 3]) for (const mode of ["plain", "marked", "inherit"] as const) {
    const replica = new ScratchReplica(design, 1, "abcd"), mark = scratchExampleMark(kind);
    try {
      replica.execute({ id: "initial", kind: "add", from: 1, to: 3, mark });
      const expectedOn = mode === "marked" || mode === "inherit" && !("id" in mark) && kind !== "cue" && (kind === "dir" ? offset === 2 : offset > 1);
      if (mode === "inherit") {
        const marks: Marks = "id" in mark ? {} : { [kind]: true };
        const standalone = typingMarks([{ text: "a", marks: {} }, { text: "bc", marks }, { text: "d", marks: {} }], offset);
        assert.equal(standalone[kind as "b"] === true, expectedOn);
      }
      replica.execute({ id: "typing", kind: "insert", from: offset, to: offset, text: "X", mode, marks: mode === "marked" ? [mark] : [] });
      assert.deepEqual(replica.read()[offset]?.marks, expectedOn ? [mark] : []);
      checks++;
    } finally { replica.destroy(); }
  }
  assert.equal(checks, 90);
});

test("records: inheritance keeps cue formatting on a valid cue line", () => {
  const replica = new ScratchReplica("records", 1, "SFX: wind");
  try {
    replica.execute({ id: "cue", kind: "add", from: 0, to: 9, mark: { kind: "cue", value: true } });
    replica.execute({ id: "typing", kind: "insert", from: 6, to: 6, text: "X", mode: "inherit" });
    assert.deepEqual(replica.read()[6]?.marks, [{ kind: "cue", value: true }]);
    const model = new ScratchModel("SFX: wind");
    model.add({ id: "cue", kind: "add", from: 0, to: 9, mark: { kind: "cue", value: true } }, new Set());
    model.add({ id: "typing", kind: "insert", from: 6, to: 6, text: "X", mode: "inherit" }, new Set(["cue"]));
    assert.deepEqual(model.read(new Set(["cue", "typing"])).find(char => char.id === "typing:0")?.marks, [{ kind: "cue", value: true }]);
  } finally { replica.destroy(); }
});
