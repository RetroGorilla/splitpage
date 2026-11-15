import { test } from "node:test";
import assert from "node:assert/strict";
import { markParts } from "./mark-parts.mjs";

const at = (name, startTime) => ({ name: "measure:" + name, startTime });

test("mark parts: each seam counts its span minus the spans nested in it, and the parts add up to the outermost spans", () => {
  const parts = markParts([
    at("trial:start", 0), at("trial:end", 4),
    at("live-apply:start", 5), at("mirror-apply:start", 6), at("mirror-apply:end", 8), at("assembly:start", 8), at("assembly:end", 11),
    at("projection-listeners:start", 11), at("session-receive:start", 12), at("document-entry:start", 12), at("document-entry:end", 14),
    at("render:start", 15), at("render:end", 20), at("session-receive:end", 21), at("projection-listeners:end", 22), at("live-apply:end", 23),
    { name: "unrelated", startTime: 30 }
  ]);
  assert.deepEqual(parts.exclusive, { trial: 4, "mirror-apply": 2, assembly: 3, "document-entry": 2, render: 5, "session-receive": 2,
    "projection-listeners": 2, "live-apply": 2 });
  assert.deepEqual([parts.validation, parts.apply, parts.projection, parts.rendering, parts.input, parts.outer], [4, 2, 11, 5, 0, 22]);
});

test("mark parts: typing counts the handler, command and write without their nested projection and render", () => {
  const parts = markParts([
    at("input-handler:start", 0), at("input-command:start", 1), at("input-write:start", 3), at("mirror-apply:start", 4), at("mirror-apply:end", 5),
    at("render:start", 6), at("render:end", 9), at("input-write:end", 10), at("input-command:end", 12), at("input-handler:end", 13)
  ]);
  assert.deepEqual([parts.validation, parts.apply, parts.projection, parts.rendering, parts.input, parts.outer], [0, 0, 1, 3, 9, 13]);
});

test("mark parts: an unpaired, crossed, unclosed or unknown mark is refused", () => {
  assert.throws(() => markParts([at("trial:end", 1)]), /Unpaired timing mark: measure:trial:end/);
  assert.throws(() => markParts([at("trial:start", 0), at("live-apply:start", 1), at("trial:end", 2), at("live-apply:end", 3)]), /Unpaired/);
  assert.throws(() => markParts([at("render:start", 0)]), /Unclosed timing mark: render/);
  assert.throws(() => markParts([at("paint:start", 0), at("paint:end", 1)]), /outside every part: paint/);
});
