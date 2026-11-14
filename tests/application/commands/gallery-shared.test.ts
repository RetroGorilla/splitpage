import { test } from "node:test";
import assert from "node:assert/strict";
import { galleryCommand } from "../../../src/application/commands/gallery.ts";
import type { GalleryEdit } from "../../../src/application/commands/gallery.ts";
import { sharedGalleryPorts } from "../../../src/bootstrap/wiring/ports/shared-gallery.ts";
import { sharedAuthorPort } from "../../../src/bootstrap/wiring/ports/shared-author.ts";
import { registerSharedOperationFamilies } from "../../../src/adapters/collab/operation-families.ts";
import { createSharedDocument, applySharedUpdate, destroySharedDocument, encodeSharedState, readSharedRevision } from "../../../src/adapters/collab/document.ts";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { executeSharedCommand, reverseSharedUndoRecord } from "../../../src/adapters/collab/undo-executor.ts";
import { projectSharedDocumentWithRecovery } from "../../../src/adapters/collab/project.ts";
import type { SharedDocumentHandle } from "../../../src/adapters/collab/types.ts";
import { createSessionCapabilities } from "../../../src/application/session/capabilities.ts";
import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import type { SharedOperation } from "../../../src/core/collab/operations.ts";
import { flowBaseReference } from "../../../src/core/collab/base-reference.ts";
import { sharedRankBetween } from "../../../src/core/collab/gallery-operations.ts";
import {
  addGalleryPicture, addGalleryVideo, annotateGallerySlot, moveGallerySlot, removeGalleryLink, removeGallerySlot, replaceGalleryPicture, setVideoThumbnail
} from "../../../src/core/document/gallery.ts";
import { replicas, operation } from "../../adapters/collab/executor-support.ts";
import { sharedHarness, adapterReplica } from "../session/shared-session-support.ts";
import { createFlowLoadRuntime } from "../../core/flow/load.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";

type Fields = Record<string, unknown>;
const STAMP = "2026-11-13T12:00:00.000Z", LATER = "2026-11-13T12:00:01.000Z";
const alice = { clock: { nowIso: () => STAMP }, editor: { name: () => "Alice" } };
const bob = { clock: { nowIso: () => LATER }, editor: { name: () => "Bob" } };
const ref = (letter: string) => ({ sha256: letter.repeat(64), width: 10, height: 10, mime: "image/png" });
const pen = { kind: "pen", color: "#e5383b", width: 0.02, points: [0.1, 0.2, 0.3, 0.4] };
const V1 = "https://youtu.be/one", V2 = "https://youtu.be/two", V3 = "https://youtu.be/new";
const ORDERS = ["D1", "rev", "dup"] as const;
const IDS = ["R1", "R2", "R3", "R4"] as const;
const SOURCE = { rows: [
  { id: "R1", audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }] },
  { id: "R2", audioText: "cd", imageRef: null },
  { id: "R3", audioText: "ef", imageRef: ref("d"), imageName: "Four", imageAnnotation: { imageRef: ref("f"), marks: [pen] } },
  { id: "R4", audioText: "gh", imageRef: null, imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7"), links: [{ href: V1, poster: true }] }] }
] };
const ROWS: Readonly<Record<string, Fields>> = {
  R1: { audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }] },
  R2: { audioText: "cd", imageRef: null },
  R3: { audioText: "ef", imageRef: ref("d"), imageName: "Four", imageAnnotation: { imageRef: ref("f"), marks: [pen] } },
  R4: { audioText: "gh", imageRef: null, imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7"), links: [{ href: V1, poster: true }] }] }
};

function row(id: string, fields: Fields, by: "Alice" | "Bob" | null): Fields {
  return { id, status: "todo", visualText: "", ...fields, updatedAt: by === "Alice" ? STAMP : by === "Bob" ? LATER : "", updatedBy: by };
}
function documentWith(changed: Readonly<Record<string, Fields>>, stamped: Readonly<Record<string, "Alice" | "Bob">> = {}, gone: readonly string[] = []): Fields {
  return { schema: 2, title: "", docId: "d00000000000000000000000000000000",
    rows: IDS.filter(id => !gone.includes(id)).map(id => row(id, changed[id] ?? ROWS[id] as Fields, stamped[id] ?? null)),
    comments: [], people: [], productionTags: [], brollShots: [], wordsPerMinute: 150, rev: 0 };
}

const stamp = (record: string, id = "w1_1", by = "Alice", at = STAMP) => ({ kind: "scalar", id: id + "_stamp_0:stamp", by, target: { scope: "beat", record }, field: "stamp", value: { at, by } });
const create = (record: string, beat: string, picture: Fields, links: readonly Fields[] = []) => ({ kind: "record-create", id: "w1_1:0", by: "Alice",
  target: { collection: "gallery", record }, fields: { beat, rank: "5", picture, links, extra: "{}" } });
const set = (index: number, record: string, field: string, value: unknown) => ({ kind: "record-set", id: "w1_1:" + index, by: "Alice",
  target: { collection: "gallery", record }, field, value });
const remove = (index: number, record: string) => ({ kind: "record-delete", id: "w1_1:" + index, by: "Alice", target: { collection: "gallery", record } });

interface GalleryLiteral {
  readonly name: string;
  readonly beat: string;
  readonly edit: GalleryEdit;
  readonly operations: readonly unknown[];
  readonly after: Fields;
  readonly typed: Fields;
  readonly twice: { readonly fields: Fields; readonly by: "Alice" | "Bob" };
}

const cases: readonly GalleryLiteral[] = [
  { name: "add a picture to a beat without pictures", beat: "R2", edit: r => addGalleryPicture(r, ref("c"), "Three") !== -1,
    operations: [create("w1_1_picture_0", "R2", { imageRef: ref("c"), name: "Three" }), stamp("R2")],
    after: { audioText: "cd", imageRef: ref("c"), imageName: "Three" },
    typed: { audioText: "cdX", imageRef: ref("c"), imageName: "Three" },
    twice: { fields: { audioText: "cd", imageRef: ref("c"), imageName: "Three" }, by: "Bob" } },
  { name: "add a picture after the others", beat: "R1", edit: r => addGalleryPicture(r, ref("c"), "Three") !== -1,
    operations: [create("w1_1_picture_2", "R1", { imageRef: ref("c"), name: "Three" }), stamp("R1")],
    after: { audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three" }] },
    typed: { audioText: "abX", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three" }] },
    twice: { fields: { audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three" }] }, by: "Bob" } },
  { name: "replace a picture", beat: "R1", edit: r => replaceGalleryPicture(r, 1, ref("c"), "Three"),
    operations: [set(0, "R1:slot:1", "picture", { imageRef: ref("c"), name: "Three" }), stamp("R1")],
    after: { audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("c"), name: "Three" }] },
    typed: { audioText: "abX", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("c"), name: "Three" }] },
    twice: { fields: { audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("c"), name: "Three" }] }, by: "Bob" } },
  { name: "replace a picture with one the gallery shows", beat: "R1", edit: r => replaceGalleryPicture(r, 1, ref("a"), "Again"),
    operations: [remove(0, "R1:slot:1"), stamp("R1")],
    after: { audioText: "ab", imageRef: ref("a"), imageName: "One" },
    typed: { audioText: "abX", imageRef: ref("a"), imageName: "One" },
    twice: { fields: { audioText: "ab", imageRef: ref("a"), imageName: "One" }, by: "Bob" } },
  { name: "remove the first picture", beat: "R1", edit: r => removeGallerySlot(r, 0),
    operations: [remove(0, "R1:slot:0"), stamp("R1")],
    after: { audioText: "ab", imageRef: ref("b"), imageName: "Two" },
    typed: { audioText: "abX", imageRef: ref("b"), imageName: "Two" },
    twice: { fields: { audioText: "ab", imageRef: ref("b"), imageName: "Two" }, by: "Bob" } },
  { name: "remove the only picture", beat: "R3", edit: r => removeGallerySlot(r, 0),
    operations: [remove(0, "R3:slot:0"), { kind: "record-create", id: "w1_1:1", by: "Alice", target: { collection: "gallery", record: "w1_1_picture_empty" },
      fields: { beat: "R3", rank: "0", picture: { imageRef: null }, links: [], extra: "{}" } }, stamp("R3")],
    after: { audioText: "ef", imageRef: null },
    typed: { audioText: "efX", imageRef: null },
    twice: { fields: { audioText: "ef", imageRef: null }, by: "Bob" } },
  { name: "make the cover", beat: "R1", edit: r => moveGallerySlot(r, 1, 0),
    operations: [set(0, "R1:slot:0", "rank", "5"), stamp("R1")],
    after: { audioText: "ab", imageRef: ref("b"), imageName: "Two", moreImages: [{ imageRef: ref("a"), name: "One" }] },
    typed: { audioText: "abX", imageRef: ref("b"), imageName: "Two", moreImages: [{ imageRef: ref("a"), name: "One" }] },
    twice: { fields: { audioText: "ab", imageRef: ref("b"), imageName: "Two", moreImages: [{ imageRef: ref("a"), name: "One" }] }, by: "Bob" } },
  { name: "annotate a picture", beat: "R1", edit: r => annotateGallerySlot(r, 0, ref("e"), ref("a"), [pen]),
    operations: [set(0, "R1:slot:0", "picture", { imageRef: ref("e"), name: "One", annotation: { imageRef: ref("a"), marks: [pen] } }), stamp("R1")],
    after: { audioText: "ab", imageRef: ref("e"), imageName: "One", imageAnnotation: { imageRef: ref("a"), marks: [pen] }, moreImages: [{ imageRef: ref("b"), name: "Two" }] },
    typed: { audioText: "abX", imageRef: ref("e"), imageName: "One", imageAnnotation: { imageRef: ref("a"), marks: [pen] }, moreImages: [{ imageRef: ref("b"), name: "Two" }] },
    twice: { fields: { audioText: "ab", imageRef: ref("e"), imageName: "One", imageAnnotation: { imageRef: ref("a"), marks: [pen] }, moreImages: [{ imageRef: ref("b"), name: "Two" }] }, by: "Bob" } },
  { name: "remove annotations", beat: "R3", edit: r => annotateGallerySlot(r, 0, null, ref("f"), []),
    operations: [set(0, "R3:slot:0", "picture", { imageRef: ref("f"), name: "Four" }), stamp("R3")],
    after: { audioText: "ef", imageRef: ref("f"), imageName: "Four" },
    typed: { audioText: "efX", imageRef: ref("f"), imageName: "Four" },
    twice: { fields: { audioText: "ef", imageRef: ref("f"), imageName: "Four" }, by: "Bob" } },
  { name: "add a web video", beat: "R2", edit: r => addGalleryVideo(r, { href: V3 }) !== -1,
    operations: [create("w1_1_picture_0", "R2", {}, [{ href: V3, poster: true }]), stamp("R2")],
    after: { audioText: "cd", imageRef: null, imageLinks: [{ href: V3, poster: true }] },
    typed: { audioText: "cdX", imageRef: null, imageLinks: [{ href: V3, poster: true }] },
    twice: { fields: { audioText: "cd", imageRef: null, imageLinks: [{ href: V3, poster: true }], moreImages: [{ links: [{ href: V3, poster: true }] }] }, by: "Bob" } },
  { name: "remove a video link", beat: "R4", edit: r => removeGalleryLink(r, 1, "u:" + V1),
    operations: [set(0, "R4:slot:1", "links", []), stamp("R4")],
    after: { audioText: "gh", imageRef: null, imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7") }] },
    typed: { audioText: "ghX", imageRef: null, imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7") }] },
    twice: { fields: { audioText: "gh", imageRef: null, imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7") }] }, by: "Bob" } },
  { name: "add a video thumbnail", beat: "R4", edit: r => setVideoThumbnail(r, "u:" + V2, ref("8")),
    operations: [set(0, "R4:slot:0", "picture", { imageRef: ref("8") }), stamp("R4")],
    after: { audioText: "gh", imageRef: ref("8"), imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7"), links: [{ href: V1, poster: true }] }] },
    typed: { audioText: "ghX", imageRef: ref("8"), imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7"), links: [{ href: V1, poster: true }] }] },
    twice: { fields: { audioText: "gh", imageRef: ref("8"), imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7"), links: [{ href: V1, poster: true }] }] }, by: "Bob" } }
];

function setup(count: 2 | 3 = 2) {
  const set = replicas(count, SOURCE);
  for (const handle of [set.a, set.b, set.c]) registerSharedOperationFamilies(handle, { cells: createFlowLoadRuntime().cells });
  return set;
}
function ports(handle: SharedDocumentHandle, name: string, stamps: typeof alice) {
  return sharedGalleryPorts({ handle: () => handle, author: sharedAuthorPort({ handle: () => handle, name: () => name }), stamps });
}
function project(handle: SharedDocumentHandle) {
  const { document, recovery } = projectSharedDocumentWithRecovery(handle);
  return { document, recovery: recovery.flatMap(entry => entry.kind === "removed-beat" ? [entry.row] : []) };
}
function late(handle: SharedDocumentHandle) {
  const joiner = createSharedDocument();
  try { assert.equal(applySharedUpdate(joiner, encodeSharedState(handle)).ok, true); return project(joiner); } finally { destroySharedDocument(joiner); }
}
function agreeing(label: string, handles: readonly SharedDocumentHandle[], order: typeof ORDERS[number] | "D1" = "D1") {
  const readings = handles.map((handle, index) => ({ order, replica: index ? "B" as const : "A" as const, output: project(handle) }));
  assertReplicasAgree(label, [...readings, { order: "late-C", replica: "C", output: late(handles[0] as SharedDocumentHandle) }]);
  return readings[0]?.output;
}
function flush(queue: ReturnType<typeof replicas>["queue"], order: typeof ORDERS[number]) {
  for (let round = 0; round < 100 && queue.pending.length; round++) {
    const messages = [...queue.pending];
    if (order === "rev") messages.reverse();
    for (const message of messages) queue.deliver(message.id, order === "dup" ? 2 : 1);
  }
  assert.equal(queue.pending.length, 0);
}
function send(handle: SharedDocumentHandle, ...values: unknown[]) {
  assert.deepEqual(executeSharedOperations(handle, values.map(operation), { base: readSharedRevision(handle) }), { ok: true });
}
function typing(beat: string) {
  return { kind: "text-insert", id: "typed", by: "Bob", target: { owner: beat, segment: beat, field: "audioText" },
    at: { left: null, right: flowBaseReference(beat, "audioText", 2), affinity: "before" }, content: [{ value: "X", marks: [] }] };
}
function removal(beat: string) {
  return { kind: "remove", id: "removed", by: "Bob", removalKind: "beat", targets: [beat], observed: [flowBaseReference(beat, "audioText", 0, 2)],
    boundaries: [beat], components: [], gallery: [], at: IDS.indexOf(beat as typeof IDS[number]) };
}
function standalone(before: Fields, literal: GalleryLiteral): Fields {
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(before) };
  const plan = galleryCommand(literal.beat, literal.edit, alice).plan(live, createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) }));
  assert.ok(plan && !("refused" in plan) && plan.shared === undefined);
  plan.apply(live);
  return live as unknown as Fields;
}

for (const literal of cases) test(`shared gallery command literal: ${literal.name}`, () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
  try {
    const before = project(h.a).document;
    assert.deepEqual(before, documentWith({}));
    assert.deepEqual(a.session.run(galleryCommand(literal.beat, literal.edit, alice, ports(h.a, "Alice", alice))).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [literal.operations]);
    flush(h.queue, "D1");
    const expected = documentWith({ [literal.beat]: literal.after }, { [literal.beat]: "Alice" });
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: expected, recovery: [] });
    assert.deepEqual(a.session.read(doc => doc), expected);
    assert.deepEqual(b.session.read(doc => doc), expected);
    assert.deepEqual(standalone(before, literal), expected);
  } finally { a.session.dispose(); b.session.dispose(); h.close(); }
});

for (const literal of cases) for (const order of ORDERS) {
  test(`shared gallery command races typing in its beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(galleryCommand(literal.beat, literal.edit, alice, ports(h.a, "Alice", alice))).kind, "applied");
      send(h.b, typing(literal.beat));
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order), { document: documentWith({ [literal.beat]: literal.typed }, { [literal.beat]: "Alice" }), recovery: [] });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared gallery command races removal of its beat: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a));
    try {
      assert.equal(a.session.run(galleryCommand(literal.beat, literal.edit, alice, ports(h.a, "Alice", alice))).kind, "applied");
      send(h.b, removal(literal.beat));
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order),
        { document: documentWith({}, {}, [literal.beat]), recovery: [row(literal.beat, literal.after, "Alice")] });
    } finally { a.session.dispose(); h.close(); }
  });
  test(`shared gallery command races the same command from the other copy: ${literal.name}, ${order}`, () => {
    const h = setup(), a = sharedHarness(adapterReplica(h.a)), b = sharedHarness(adapterReplica(h.b));
    try {
      assert.equal(a.session.run(galleryCommand(literal.beat, literal.edit, alice, ports(h.a, "Alice", alice))).kind, "applied");
      assert.equal(b.session.run(galleryCommand(literal.beat, literal.edit, bob, ports(h.b, "Bob", bob))).kind, "applied");
      flush(h.queue, order);
      assert.deepEqual(agreeing(literal.name, [h.a, h.b], order),
        { document: documentWith({ [literal.beat]: literal.twice.fields }, { [literal.beat]: literal.twice.by }), recovery: [] });
    } finally { a.session.dispose(); b.session.dispose(); h.close(); }
  });
}

for (const literal of cases) test(`shared gallery command as one list equals separate lists: ${literal.name}`, () => {
  const together = setup(), apart = setup();
  try {
    send(together.a, ...literal.operations);
    for (const value of literal.operations) send(apart.a, value);
    const expected = { document: documentWith({ [literal.beat]: literal.after }, { [literal.beat]: "Alice" }), recovery: [] };
    assert.deepEqual(project(together.a), expected);
    assert.deepEqual(project(apart.a), expected);
  } finally { together.close(); apart.close(); }
});

for (const literal of cases) test(`shared gallery command undo and redo: ${literal.name}`, () => {
  const h = setup();
  try {
    const execution = executeSharedCommand(h.a, literal.operations.map(operation) as SharedOperation[], { label: literal.name, selection: null, typing: null }, { base: readSharedRevision(h.a) });
    assert.deepEqual(execution.result, { ok: true });
    assert.ok(execution.record);
    let count = 0;
    const undone = reverseSharedUndoRecord(h.a, execution.record, { by: "Alice", nextId: () => "undo-" + ++count });
    assert.ok(undone.ok, JSON.stringify(undone));
    assert.equal(undone.effective, true);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: documentWith({}, { [literal.beat]: "Alice" }), recovery: [] });
    assert.ok(undone.inverse);
    const redone = reverseSharedUndoRecord(h.a, undone.inverse, { by: "Alice", nextId: () => "redo-" + ++count });
    assert.ok(redone.ok, JSON.stringify(redone));
    assert.equal(redone.effective, true);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing(literal.name, [h.a, h.b]), { document: documentWith({ [literal.beat]: literal.after }, { [literal.beat]: "Alice" }), recovery: [] });
  } finally { h.close(); }
});

const refusals: readonly { readonly name: string; readonly beat: string; readonly edit: GalleryEdit; readonly reason: string; readonly prepare?: (h: ReturnType<typeof setup>) => void }[] = [
  { name: "a video file from disk", beat: "R2", reason: "gallery-local-file",
    edit: r => addGalleryVideo(r, { name: "clip.mp4", size: 3, location: { kind: "bundled", name: "clip.mp4" } }) !== -1 },
  { name: "an old-style embedded image", beat: "R2", reason: "gallery-embedded-image",
    edit: r => { r.visualImage = "data:image/png;base64,iVBORw0KGgo="; return true; } },
  { name: "a picture without a content reference", beat: "R2", reason: "gallery-embedded-image",
    edit: r => addGalleryPicture(r, { sha256: "not-a-content-reference" }, "Odd") !== -1 },
  { name: "a beat joined with a beat that has pictures", beat: "R1", reason: "gallery-joined-beat",
    prepare: h => send(h.a, { kind: "join", id: "joined", by: "Bob", from: "R3", into: "R1", glue: " " }),
    edit: r => removeGallerySlot(r, 0) },
  { name: "a gallery past its first 61 entries", beat: "R2", reason: "gallery-overflow",
    prepare: h => send(h.a, ...Array.from({ length: 62 }, (_, index) => ({ kind: "record-create", id: "many:" + index, by: "Bob",
      target: { collection: "gallery", record: "many_" + String(index).padStart(2, "0") },
      fields: { beat: "R2", rank: "1" + String(index).padStart(2, "0"), picture: { imageRef: { sha256: index.toString(16).padStart(2, "0").repeat(32), width: 10, height: 10, mime: "image/png" } } } }))),
    edit: r => removeGallerySlot(r, 0) }
];

for (const refusal of refusals) test(`shared gallery command refuses by name: ${refusal.name}`, () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    refusal.prepare?.(h);
    const before = encodeSharedState(h.a);
    assert.deepEqual(a.session.run(galleryCommand(refusal.beat, refusal.edit, alice, ports(h.a, "Alice", alice))), { kind: "rejected", reason: refusal.reason });
    assert.deepEqual(a.executed, []);
    assert.deepEqual(encodeSharedState(h.a), before);
  } finally { a.session.dispose(); h.close(); }
});

test("shared gallery command serves a joined beat whose other beat has no pictures", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    send(h.a, { kind: "join", id: "joined", by: "Bob", from: "R2", into: "R1", glue: " " });
    assert.equal(a.session.run(galleryCommand("R1", r => addGalleryPicture(r, ref("c"), "Three") !== -1, alice, ports(h.a, "Alice", alice))).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [[create("w1_1_picture_2", "R1", { imageRef: ref("c"), name: "Three" }), stamp("R1")]]);
    flush(h.queue, "D1");
    const shown = agreeing("joined", [h.a, h.b])?.document.rows.find(found => found.id === "R1");
    assert.deepEqual([shown?.audioText, shown?.imageName, shown?.moreImages], ["ab cd", "One", [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three" }]]);
  } finally { a.session.dispose(); h.close(); }
});

test("shared gallery command removes the second record of a picture held twice when it edits the gallery", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    send(h.a, { kind: "record-create", id: "twin", by: "Bob", target: { collection: "gallery", record: "twin" },
      fields: { beat: "R1", rank: "5", picture: { imageRef: ref("a"), name: "Copy" } } });
    assert.deepEqual(project(h.a).document, documentWith({}));
    assert.equal(a.session.run(galleryCommand("R1", r => removeGallerySlot(r, 1), alice, ports(h.a, "Alice", alice))).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [[remove(0, "R1:slot:1"), remove(1, "twin"), stamp("R1")]]);
    flush(h.queue, "D1");
    assert.deepEqual(agreeing("twin", [h.a, h.b]), { document: documentWith({ R1: { audioText: "ab", imageRef: ref("a"), imageName: "One" } }, { R1: "Alice" }), recovery: [] });
  } finally { a.session.dispose(); h.close(); }
});

test("shared gallery command clears fields a picture's record holds that the gallery edit drops, as the standalone edit does", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    send(h.a, { kind: "record-create", id: "future", by: "Bob", target: { collection: "gallery", record: "future" },
      fields: { beat: "R1", rank: "5", picture: { imageRef: ref("c"), name: "Three" }, extra: JSON.stringify({ future: 1 }) } });
    const before = project(h.a).document;
    assert.deepEqual(before, documentWith({ R1: { audioText: "ab", imageRef: ref("a"), imageName: "One",
      moreImages: [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three", future: 1 }] } }));
    const edit: GalleryEdit = r => removeGallerySlot(r, 0);
    assert.equal(a.session.run(galleryCommand("R1", edit, alice, ports(h.a, "Alice", alice))).kind, "applied");
    assert.deepEqual(a.executed.map(entry => entry.operations), [[set(0, "future", "extra", "{}"), remove(1, "R1:slot:0"), stamp("R1")]]);
    flush(h.queue, "D1");
    const expected = documentWith({ R1: { audioText: "ab", imageRef: ref("b"), imageName: "Two", moreImages: [{ imageRef: ref("c"), name: "Three" }] } }, { R1: "Alice" });
    assert.deepEqual(agreeing("extra", [h.a, h.b]), { document: expected, recovery: [] });
    assert.deepEqual(standalone(before, { name: "extra", beat: "R1", edit, operations: [], after: {}, typed: {}, twice: { fields: {}, by: "Alice" } }), expected);
  } finally { a.session.dispose(); h.close(); }
});

test("shared gallery command writes no operation for an edit that changes nothing", () => {
  const h = setup(), a = sharedHarness(adapterReplica(h.a));
  try {
    assert.deepEqual(a.session.run(galleryCommand("R1", r => addGalleryPicture(r, ref("b"), "Two") !== -1, alice, ports(h.a, "Alice", alice))), { kind: "noop" });
    assert.deepEqual(a.executed, []);
  } finally { a.session.dispose(); h.close(); }
});

test("a gallery command without shared ports, or with no author, plans as before and allocates no operation list", () => {
  const before: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(project(setup().a).document) };
  const capability = createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
  const asked: string[] = [];
  const quiet = { author: () => { asked.push("author"); return null; }, pictures: () => { asked.push("pictures"); return []; },
    beatStamp: () => { asked.push("stamp"); return operation(stamp("R1")) as SharedOperation; } };
  for (const plan of [galleryCommand("R1", r => removeGallerySlot(r, 0), alice).plan(before, capability),
    galleryCommand("R1", r => removeGallerySlot(r, 0), alice, quiet).plan(before, capability)]) {
    assert.ok(plan && !("refused" in plan));
    assert.equal(plan.shared, undefined);
    assert.deepEqual(plan.changes.cells.map(cell => cell.field), ["imageName", "imageRef", "moreImages", "updatedAt", "updatedBy"]);
  }
  assert.deepEqual(asked, ["author"]);
});

test("ranks between two pictures sort between them", () => {
  assert.deepEqual([sharedRankBetween("", null), sharedRankBetween("0000000001", null), sharedRankBetween("", "0000000000"),
    sharedRankBetween("0000000000", "0000000001"), sharedRankBetween("5", "6"), sharedRankBetween("59", null), sharedRankBetween("1", "10")],
  ["5", "5", null, "00000000005", "55", "7", null]);
});
