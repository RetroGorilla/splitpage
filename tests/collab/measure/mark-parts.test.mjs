import { test } from "node:test";
import assert from "node:assert/strict";
import { markParts } from "./mark-parts.mjs";

const at = (name, startTime) => ({ name: "measure:" + name, startTime });
const figures = parts => [parts.validation, parts.apply, parts.projection, parts.rendering, parts.input, parts.unattributed, parts.outer];

test("mark parts: each seam counts its span minus the spans nested in it, and what the outer span holds outside every part is unattributed", () => {
  const parts = markParts([
    at("receive:start", 0), at("trial:start", 0), at("trial:end", 4),
    at("live-apply:start", 5), at("mirror-apply:start", 6), at("mirror-apply:end", 8), at("assembly:start", 8), at("assembly:end", 11),
    at("projection-listeners:start", 11), at("session-receive:start", 12), at("document-entry:start", 12), at("document-entry:end", 14),
    at("render:start", 15), at("render:end", 20), at("session-receive:end", 21), at("projection-listeners:end", 22), at("live-apply:end", 23),
    at("receive:end", 25), { name: "unrelated", startTime: 30 }
  ]);
  assert.deepEqual(parts.exclusive, { trial: 4, "mirror-apply": 2, assembly: 3, "document-entry": 2, render: 5, "session-receive": 2,
    "projection-listeners": 2, "live-apply": 2 });
  assert.deepEqual(figures(parts), [4, 2, 11, 5, 0, 3, 25]);
});

test("mark parts: typing counts the handler, command and write without their nested projection and render, and the cell refresh as rendering", () => {
  const parts = markParts([
    at("event:start", 0), at("input-handler:start", 0), at("input-command:start", 1), at("input-write:start", 3), at("mirror-apply:start", 4),
    at("mirror-apply:end", 5), at("render:start", 6), at("render:end", 9), at("input-write:end", 10), at("input-command:end", 12),
    at("input-handler:end", 13), at("input-handler:start", 13), at("cell-refresh:start", 14), at("cell-refresh:end", 17), at("input-handler:end", 17),
    at("event:end", 17)
  ]);
  assert.deepEqual(figures(parts), [0, 0, 1, 6, 10, 0, 17]);
});

test("mark parts: an outer span nested in a part is transparent, a held copy is apply, and only the outermost span counts as outer", () => {
  const parts = markParts([
    at("event:start", 0), at("input-handler:start", 1), at("receive:start", 2), at("trial:start", 2), at("trial:end", 5), at("queue:start", 5),
    at("queue:end", 6), at("receive:end", 6), at("input-command:start", 7), at("input-write:start", 8), at("drain:start", 9), at("live-apply:start", 9),
    at("live-apply:end", 12), at("drain:end", 13), at("input-write:end", 14), at("input-command:end", 15), at("input-handler:end", 16), at("event:end", 20)
  ]);
  assert.deepEqual(parts.exclusive, { trial: 3, queue: 1, "live-apply": 3, "input-write": 3, "input-command": 2, "input-handler": 3 });
  assert.deepEqual(figures(parts), [3, 4, 0, 0, 8, 5, 20]);
});

test("mark parts: a rebuild inside the trial counts in validation and is also published as its own figure", () => {
  const parts = markParts([
    at("receive:start", 0), at("trial:start", 0), at("rebuild:start", 1), at("rebuild:end", 4), at("trial:end", 6), at("live-apply:start", 6),
    at("live-apply:end", 8), at("receive:end", 8)
  ]);
  assert.deepEqual(parts.exclusive, { trial: 3, rebuild: 3, "live-apply": 2 });
  assert.deepEqual([parts.validation, parts.rebuild, parts.apply, parts.unattributed, parts.outer], [6, 3, 2, 0, 8]);
  assert.equal(markParts([at("receive:start", 0), at("trial:start", 0), at("trial:end", 2), at("receive:end", 2)]).rebuild, 0);
});

test("mark parts: an unpaired, crossed, unclosed or unknown mark, or a part outside every outer span, is refused", () => {
  const outer = marks => [at("event:start", 0), ...marks, at("event:end", 9)];
  assert.throws(() => markParts([at("trial:end", 1)]), /Unpaired timing mark: measure:trial:end/);
  assert.throws(() => markParts(outer([at("trial:start", 0), at("live-apply:start", 1), at("trial:end", 2), at("live-apply:end", 3)])), /Unpaired/);
  assert.throws(() => markParts([at("event:start", 0), at("render:start", 0)]), /Unclosed timing mark: render/);
  assert.throws(() => markParts(outer([at("paint:start", 0), at("paint:end", 1)])), /outside every part: paint/);
  assert.throws(() => markParts([at("trial:start", 0), at("trial:end", 1)]), /outside every outer span: measure:trial:start/);
  assert.throws(() => markParts([at("event:start", 0), at("event:end", 1), at("render:start", 2), at("render:end", 3)]), /outside every outer span/);
});
