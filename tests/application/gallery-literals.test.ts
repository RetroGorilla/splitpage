import { test } from "node:test";
import assert from "node:assert/strict";
import { galleryCommand } from "../../src/application/commands/gallery.ts";
import type { GalleryEdit } from "../../src/application/commands/gallery.ts";
import { createSessionCapabilities } from "../../src/application/session/capabilities.ts";
import type { ValidatedDocument } from "../../src/core/document/validated.ts";
import { migrateRows } from "../../src/core/migrate.ts";
import { fakeMigration } from "../core/migrate-ports.ts";
import {
  addGalleryPicture, addGalleryVideo, annotateGallerySlot, moveGallerySlot, removeGalleryLink, removeGallerySlot, replaceGalleryPicture, setVideoThumbnail
} from "../../src/core/document/gallery.ts";

type Fields = Record<string, unknown>;
const STAMP = "2026-11-13T12:00:00.000Z", LATER = "2026-11-13T12:00:01.000Z";
const alice = { clock: { nowIso: () => STAMP }, editor: { name: () => "Alice" } };
const ref = (letter: string) => ({ sha256: letter.repeat(64), width: 10, height: 10, mime: "image/png" });
const pen = { kind: "pen", color: "#e5383b", width: 0.02, points: [0.1, 0.2, 0.3, 0.4] };
const V1 = "https://youtu.be/one", V2 = "https://youtu.be/two", V3 = "https://youtu.be/new";
const IDS = ["R1", "R2", "R3", "R4"] as const;
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

function standalone(before: Fields, literal: GalleryLiteral): Fields {
  const live: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...structuredClone(before) };
  const plan = galleryCommand(literal.beat, literal.edit, alice).plan(live, createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) }));
  assert.ok(plan && !("refused" in plan) && plan.shared === undefined);
  plan.apply(live);
  return live as unknown as Fields;
}

type GalleryLiteral = { readonly name: string; readonly beat: string; readonly edit: GalleryEdit; readonly after: Fields };
const cases: readonly GalleryLiteral[] = [
  { name: "add a picture to a beat without pictures",
    beat: "R2",
    edit: r => addGalleryPicture(r, ref("c"), "Three") !== -1,
    after: { audioText: "cd", imageRef: ref("c"), imageName: "Three" } },
  { name: "add a picture after the others",
    beat: "R1",
    edit: r => addGalleryPicture(r, ref("c"), "Three") !== -1,
    after: { audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three" }] } },
  { name: "replace a picture",
    beat: "R1",
    edit: r => replaceGalleryPicture(r, 1, ref("c"), "Three"),
    after: { audioText: "ab", imageRef: ref("a"), imageName: "One", moreImages: [{ imageRef: ref("c"), name: "Three" }] } },
  { name: "replace a picture with one the gallery shows",
    beat: "R1",
    edit: r => replaceGalleryPicture(r, 1, ref("a"), "Again"),
    after: { audioText: "ab", imageRef: ref("a"), imageName: "One" } },
  { name: "remove the first picture",
    beat: "R1",
    edit: r => removeGallerySlot(r, 0),
    after: { audioText: "ab", imageRef: ref("b"), imageName: "Two" } },
  { name: "remove the only picture",
    beat: "R3",
    edit: r => removeGallerySlot(r, 0),
    after: { audioText: "ef", imageRef: null } },
  { name: "make the cover",
    beat: "R1",
    edit: r => moveGallerySlot(r, 1, 0),
    after: { audioText: "ab", imageRef: ref("b"), imageName: "Two", moreImages: [{ imageRef: ref("a"), name: "One" }] } },
  { name: "annotate a picture",
    beat: "R1",
    edit: r => annotateGallerySlot(r, 0, ref("e"), ref("a"), [pen]),
    after: { audioText: "ab", imageRef: ref("e"), imageName: "One", imageAnnotation: { imageRef: ref("a"), marks: [pen] }, moreImages: [{ imageRef: ref("b"), name: "Two" }] } },
  { name: "remove annotations",
    beat: "R3",
    edit: r => annotateGallerySlot(r, 0, null, ref("f"), []),
    after: { audioText: "ef", imageRef: ref("f"), imageName: "Four" } },
  { name: "add a web video",
    beat: "R2",
    edit: r => addGalleryVideo(r, { href: V3 }) !== -1,
    after: { audioText: "cd", imageRef: null, imageLinks: [{ href: V3, poster: true }] } },
  { name: "remove a video link",
    beat: "R4",
    edit: r => removeGalleryLink(r, 1, "u:" + V1),
    after: { audioText: "gh", imageRef: null, imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7") }] } },
  { name: "add a video thumbnail",
    beat: "R4",
    edit: r => setVideoThumbnail(r, "u:" + V2, ref("8")),
    after: { audioText: "gh", imageRef: ref("8"), imageLinks: [{ href: V2, poster: true }], moreImages: [{ imageRef: ref("7"), links: [{ href: V1, poster: true }] }] } }
];

for (const literal of cases) test(`standalone gallery command literal: ${literal.name}`, () => {
  assert.deepEqual(standalone(documentWith({}), literal), documentWith({ [literal.beat]: literal.after }, { [literal.beat]: "Alice" }));
});

test("standalone gallery promotion drops fields the gallery edit removes", () => {
  const before = documentWith({ R1: { audioText: "ab", imageRef: ref("a"), imageName: "One",
    moreImages: [{ imageRef: ref("b"), name: "Two" }, { imageRef: ref("c"), name: "Three", future: 1 }] } });
  const after = { audioText: "ab", imageRef: ref("b"), imageName: "Two", moreImages: [{ imageRef: ref("c"), name: "Three" }] };
  assert.deepEqual(standalone(before, { name: "extra", beat: "R1", edit: r => removeGallerySlot(r, 0), after }), documentWith({ R1: after }, { R1: "Alice" }));
});

const promotions: readonly Omit<GalleryLiteral, "beat">[] = [
  { name: "remove the picture before a video without a thumbnail",
    edit: r => removeGallerySlot(r, 0),
    after: { audioText: "ab", imageRef: null, imageLinks: [{ href: V3, poster: true }] } },
  { name: "make a video without a thumbnail the cover",
    edit: r => moveGallerySlot(r, 1, 0),
    after: { audioText: "ab", imageRef: null, imageLinks: [{ href: V3, poster: true }], moreImages: [{ imageRef: ref("c"), name: "Three" }] } }
];
function oneBeat(fields: Fields, by: "Alice" | null): Fields {
  return { ...documentWith({}), rows: [row("R1", fields, by)] };
}
for (const literal of promotions) test(`standalone gallery command keeps the empty imageRef: ${literal.name}`, () => {
  const before = oneBeat({ audioText: "ab", imageRef: ref("c"), imageName: "Three", moreImages: [{ links: [{ href: V3, poster: true }] }] }, null);
  assert.deepEqual(standalone(before, { ...literal, beat: "R1" }), oneBeat(literal.after, "Alice"));
});

test("the standalone gallery plan names only its changed fields and stamps", () => {
  const before: ValidatedDocument = { ...migrateRows({}, fakeMigration().ports), ...documentWith({}) };
  const capability = createSessionCapabilities("standalone", { edit: () => ({ allowed: true }), comment: () => ({ allowed: true }) });
  const plan = galleryCommand("R1", row => removeGallerySlot(row, 0), alice).plan(before, capability);
  assert.ok(plan && !("refused" in plan));
  assert.equal(plan.shared, undefined);
  assert.deepEqual(plan.changes.cells.map(cell => cell.field), ["imageName", "imageRef", "moreImages", "updatedAt", "updatedBy"]);
});
