import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecord, setRecord, deleteRecord } from "./record-support.ts";
import { recordProjectionReplicas, submitRecords, rawGalleryJoin, checkRecordProjection, plainRow } from "./projection-record-support.ts";
import { literalMergedDocument, readPureMergedProjection } from "./projection-merged-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";

const firstHalf = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29];
const secondHalf = [30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59];
const singleVisible = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60];
const joinedVisible = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,60,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59];
function picture(index: number) { return { sha256: index.toString(16).padStart(64, "0"), width: 1, height: 1, mime: "image/png" }; }
function slot(index: number) { return { imageRef: picture(index), name: "Picture " + index }; }
function source(joined: boolean) {
  return { rows: joined ? [{ ...plainRow("R1", "a"), imageRef: picture(0), imageName: "Picture 0", moreImages: firstHalf.slice(1).map(slot) },
    { ...plainRow("R2", "b"), imageRef: picture(30), imageName: "Picture 30", moreImages: secondHalf.slice(1).map(slot) }]
    : [{ ...plainRow("R1", "a"), imageRef: picture(0), imageName: "Picture 0", moreImages: [...firstHalf.slice(1), ...secondHalf].map(slot) }] };
}
function expected(copies: number, joined: boolean, removed = false) {
  const row = { ...plainRow("R1", joined ? "a b" : "a"), imageRef: picture(0), imageName: "Picture 0", moreImages: (joined ? joinedVisible : singleVisible).map(slot) };
  const overflow = (copies === 3 ? [61, 62] : [61]).map(index => ({ kind: "gallery-overflow", rowId: "R1", itemId: "w" + (index - 60), beat: joined ? "R2" : "R1", slot: slot(index) }));
  return { document: { ...literalMergedDocument(""), rows: removed ? [] : [row] }, recovery: removed ? [...overflow, { kind: "removed-beat", row, members: ["R1", "R2"] }] : overflow };
}
function add(handle: Parameters<typeof submitRecords>[0], writer: number, joined: boolean, generated = false, duplicate = false) {
  const index = duplicate && writer ? 0 : 60 + writer;
  const beat = joined && writer ? "R2" : "R1", fields = { beat, rank: "z", picture: slot(index), links: [] };
  const commands = generated ? [createRecord("gallery", "tmp" + writer, { ...fields, rank: "0" }), setRecord("gallery", "tmp" + writer, "rank", "x"),
    deleteRecord("gallery", "tmp" + writer), createRecord("gallery", "w" + writer, { ...fields, rank: "~", picture: { imageRef: picture(index) } }),
    setRecord("gallery", "w" + writer, "picture", slot(index)), setRecord("gallery", "w" + writer, "rank", "z"),
    ...(duplicate && writer ? [setRecord("gallery", "w" + writer, "links", [{ href: "https://example.test/" + writer }])] : [])] : [createRecord("gallery", "w" + writer, fields)];
  submitRecords(handle, commands); return commands;
}
for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) for (const joined of [false, true]) for (const removed of joined ? [false, true] : [false])
  test(`gallery overflow shows the literal first 61 and recovers every later item: ${copies} ${order} joined=${joined} removed=${removed}`, () => {
    const run = recordProjectionReplicas(copies, source(joined));
    try {
      run.handles.forEach((handle, writer) => add(handle, writer, joined)); if (joined) rawGalleryJoin(run.a, removed);
      const result = expected(copies, joined, removed); assert.equal(result.document.rows[0]?.moreImages?.length ?? (removed ? 60 : 0), 60);
      checkRecordProjection(run, order, result.document, result.recovery);
    } finally { run.close(); }
  });

test("seeded gallery creation, update, deletion and ranking retains every overflow item across writers and reloads", t => {
  let checkpoints = 0, commands = 0;
  const seedChoices = [3,3,2,3,1,2,0,0,1,3,0,0,0,3,0,3,3,3,1,2,3,3,3,0];
  const kinds = new Set<string>(), declaredLimits: readonly { history: string; reason: string }[] = [], violations: { history: string; reason: string }[] = [];
  for (let seed = 0; seed < 24; seed++) for (const copies of [2, 3]) for (const joined of [false, true]) for (const duplicate of [false, true]) for (const order of ["D1", "rev", "dup"] as const) {
    let random = (Math.imul(seed + 1, 2654435761) ^ 0x6b61) >>> 0;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
    const reversed = next() < 0.5, remove = next() < 0.5;
    assert.equal(Number(reversed) * 2 + Number(remove), seedChoices[seed]);
    const run = recordProjectionReplicas(copies, source(joined));
    try {
      const writers = reversed ? [...run.handles.keys()].reverse() : [...run.handles.keys()];
      for (const writer of writers) {
        const handle = run.handles[writer]; assert.ok(handle);
        const list = add(handle, writer, joined, true, duplicate); commands += list.length;
        list.forEach(command => { assert.ok(command && typeof command === "object" && "kind" in command); kinds.add(String(command.kind)); });
      }
      const removed = joined && remove; if (joined) rawGalleryJoin(run.a, removed);
      let result = expected(copies, joined, removed);
      if (duplicate) {
        const row = { ...plainRow("R1", joined ? "a b" : "a"), imageRef: picture(0),
          imageLinks: copies === 3 ? [{ href: "https://example.test/1" }, { href: "https://example.test/2" }] : [{ href: "https://example.test/1" }],
          imageName: "Picture 0", moreImages: (joined ? joinedVisible : singleVisible).map(slot) };
        result = { document: { ...literalMergedDocument(""), rows: removed ? [] : [row] },
          recovery: removed ? [{ kind: "removed-beat", row, members: ["R1", "R2"] }] : [] };
      }
      try { checkRecordProjection(run, order, result.document, result.recovery); }
      catch (error) { violations.push({ history: `${seed}/${copies}/${joined}/${duplicate}/${order}`, reason: String(error) }); }
      checkpoints++;
    } finally { run.close(); }
  }
  assert.deepEqual([...kinds].sort(), ["record-create", "record-delete", "record-set"]);
  assert.equal(checkpoints, 576); assert.equal(commands, 9072); assert.deepEqual(violations, declaredLimits);
  t.diagnostic(JSON.stringify({ seeds: 24, checkpoints, commands, kinds: [...kinds].sort(), violations, declaredLimits }));
});

for (const order of ["D1", "rev", "dup"] as const) test(`61 concurrent pictures on a blank row survive the save and load boundary: ${order}`, () => {
  const run = recordProjectionReplicas(3, { rows: [{ id: "R1", audioText: "" }] });
  try {
    for (let index = 0; index < 61; index++) {
      const handle = run.handles[index % 3]; assert.ok(handle);
      submitRecords(handle, [createRecord("gallery", "p" + index, { beat: "R1", rank: String(index).padStart(2, "0"), picture: slot(index), links: [] })]);
    }
    checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: [{ ...plainRow("R1", ""), imageRef: picture(0), imageName: "Picture 0", moreImages: singleVisible.map(slot) }] });
    const actual = readPureMergedProjection(run.a), loaded = createFlowLoadRuntime().load(JSON.parse(actual.save) as unknown);
    assert.deepEqual(loaded.rows[0]?.imageRef, picture(0));
    assert.deepEqual(loaded.rows[0]?.moreImages, singleVisible.map(slot));
    assert.deepEqual(actual.view.recovery, []);
  } finally { run.close(); }
});

for (const copies of [2, 3]) for (const order of ["D1", "rev", "dup"] as const) test(`gallery folds before counting the 61-item limit: ${copies} ${order}`, () => {
  const run = recordProjectionReplicas(copies, source(false));
  try {
    add(run.a, 0, false);
    for (const [index, handle] of run.handles.entries()) if (index) submitRecords(handle, [createRecord("gallery", "w" + index,
      { beat: "R1", rank: "z", picture: { imageRef: picture(0), name: "Later name" }, links: [{ href: "https://example.test/" + index }] })]);
    const imageLinks = copies === 3 ? [{ href: "https://example.test/1" }, { href: "https://example.test/2" }] : [{ href: "https://example.test/1" }];
    checkRecordProjection(run, order, { ...literalMergedDocument(""), rows: [{ ...plainRow("R1", "a"), imageRef: picture(0),
      imageLinks, imageName: "Picture 0", moreImages: singleVisible.map(slot) }] });
  } finally { run.close(); }
});
