import test from "node:test";
import assert from "node:assert/strict";
import { createMonitoredSharedDocument, validatedFixture } from "./helpers.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { destroySharedDocument, transactSharedDocument } from "../../../src/adapters/collab/document.ts";
import { collabProjectedTextTarget } from "../../../src/adapters/collab/text-target.ts";
import { createSharedNameCutWatch } from "../../../src/adapters/collab/name-cut-watch.ts";
import { readSharedOwnClock, readSharedPaintedText } from "../../../src/adapters/collab/paint-base.ts";
import { sharedBufferedTarget } from "../../../src/adapters/collab/buffer.ts";
import { headingFieldKey, TITLE_FIELD_KEY } from "../../../src/application/editing/buffered-field-key.ts";
import type { SharedTextAddress } from "../../../src/core/collab/operations.ts";

test("the cut watch reads no scene name for unrelated typing and only the changed underlying name, including its hidden text", () => {
  const handle = createMonitoredSharedDocument();
  hydrateSharedDocument(handle, validatedFixture({ title: "Title", rows: Array.from({ length: 80 }, (_, i) => ({ id: "r" + i, audioText: "Audio" })),
    sections: Array.from({ length: 80 }, (_, i) => ({ id: "h" + i, name: "n".repeat(199), firstSceneId: "r" + i })) }));
  const names = [TITLE_FIELD_KEY, ...Array.from({ length: 80 }, (_, i) => headingFieldKey("h" + i))].map(key => sharedBufferedTarget(handle, key));
  const reads: SharedTextAddress[] = [];
  let enumerations = 0;
  const watch = createSharedNameCutWatch(handle, () => { enumerations++; return names; }, readSharedOwnClock(handle), address => { reads.push(address); });
  function insert(address: SharedTextAddress, at: number, value: string): void {
    const found = collabProjectedTextTarget(handle, address); assert.ok(found);
    transactSharedDocument(handle, "local-command", () => { found.text.insert(at, value); });
  }
  try {
    assert.equal(watch.check().length, 81); reads.length = 0;
    const audio = sharedBufferedTarget(handle, "r0");
    insert(audio, 0, "X");
    assert.deepEqual(watch.check(), []);
    assert.deepEqual(reads, []);
    assert.equal(enumerations, 1);
    const name = names[38]; assert.ok(name);
    insert(name, 199, "AB");
    const first = watch.check();
    assert.deepEqual(reads, [name]);
    assert.equal(first.length, 1); assert.equal(first[0]?.units.length, 1);
    const shown = readSharedPaintedText(handle, name)?.text;
    reads.length = 0;
    insert(name, 201, "C");
    const hidden = watch.check();
    assert.deepEqual(reads, [name]);
    assert.equal(hidden[0]?.units.length, 2);
    assert.equal(readSharedPaintedText(handle, name)?.text, shown);
    assert.equal(enumerations, 1);
    reads.length = 0;
    insert(audio, 0, "Y");
    assert.deepEqual(watch.check(), []); assert.deepEqual(reads, []);
  } finally { watch.dispose(); destroySharedDocument(handle); }
});
