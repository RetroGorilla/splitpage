import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedBrollIntroducedByText, sharedPeopleIntroducedByText, sharedTagsIntroducedByText } from "../../../src/core/collab/text-records.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import { bufferReaders } from "../../collab/buffer-readers.ts";

const author = { id: "typing", by: "Alice" };
const ids = { id: (prefix: string) => prefix + "_1", docId: () => "doc" };

test("the tag builder ignores a tag already present in the registry or in the old cell", () => {
  const html = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Chair" contenteditable="false">Chair</span>';
  const edit = { field: "audioText" as const, before: "", after: html, registry: [] };
  assert.deepEqual(sharedTagsIntroducedByText(edit, bufferReaders, author), [{
    kind: "record-create", id: "typing:tag:0", by: "Alice", target: { collection: "tags", record: "t_l9u69h7au1fw" },
    fields: { cat: "prop", name: "Chair", status: "needed" }
  }]);
  assert.deepEqual(sharedTagsIntroducedByText({ ...edit, before: html, after: html + " again" }, bufferReaders, author), []);
  assert.deepEqual(sharedTagsIntroducedByText({ ...edit, registry: [{
    id: "t_l9u69h7au1fw", cat: "prop", name: "Chair", status: "needed", owner: "", notes: ""
  }] }, bufferReaders, author), []);
});

test("the B-roll builder adds a key for a new line and keeps a held key without recreating its shot", () => {
  const key = '<span class="broll-key" data-broll-id="bs_1" contenteditable="false">B-roll:</span>';
  const plain = (html: unknown) => String(html ?? "").replace(/<[^>]*>/g, "");
  const introduced = (before: string, after: string) => sharedBrollIntroducedByText({
    rowId: "R1", before, after: bufferReaders.cellOf(after),
    state: { rows: [{ id: "R1", audioText: "Narration", visualText: before }], brollShots: [], productionTags: [] }
  }, bufferReaders, ids, plain, author);
  const created = introduced("", "B-roll: Close");
  assert.equal(toHtml(created.cell), key + " Close");
  assert.equal(created.keyed, 1);
  assert.deepEqual(created.records.map(entry => entry.target), [{ collection: "shots", record: "bs_1" }]);
  const edited = introduced(key + " Close", key + " Close up");
  assert.deepEqual([toHtml(edited.cell), edited.keyed, edited.records], [key + " Close up", 0, []]);
});

test("the people builder adds an introduced name and ignores an existing pairing", () => {
  const who = '<span class="who-anchor" data-who="Sam" contenteditable="false">@Sam</span>';
  const tag = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Chair" contenteditable="false">Chair</span>';
  const introduced = (elsewhere: string) => sharedPeopleIntroducedByText({
    rowId: "R1", before: "", after: tag + " for " + who,
    state: { rows: [{ id: "R1", visualText: "" }, { id: "R2", visualText: elsewhere }], productionTags: [], people: [] }
  }, bufferReaders, ids, author);
  assert.deepEqual(introduced(""), [{
    kind: "record-create", id: "typing:person:0", by: "Alice", target: { collection: "people", record: "p_1" }, fields: { name: "Sam" }
  }]);
  assert.deepEqual(introduced(who), []);
});
