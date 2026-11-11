import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fieldMappingSource, legacyMappingSource } from "./mapping-source.ts";
import { withProjectedFixture } from "./projection-support.ts";
import { withFullProjectedFixture } from "./projection-roundtrip-support.ts";

const firstRef = { sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", width: 11, height: 13, mime: "image/png" };
const pen = { kind: "pen", color: "#ffb703", width: 0.02, points: [0.1, 0.2, 0.3, 0.4] };
const text = { kind: "text", color: "#ffb703", size: 0.1, x: 0.2, y: 0.3, text: "Annotation text sentinel" };
const highlight = { kind: "highlight", color: "#ffb703", width: 0.03, points: [0.1, 0.2, 0.7, 0.8] };
const probes: readonly [string, Readonly<Record<string, unknown>>][] = [
  ["`titleOrigin`", { titleOrigin: "user" }],
  ["`titleVersion`", { titleVersion: "v37" }],
  ["`docId`", { docId: "d00000000000000000000000000000077" }],
  ["`rows`", { "rows.length": 1, "rows.0.id": "Rprobe" }],
  ["`comments`", { "comments.length": 3, "comments.0.id": "Cprobe" }],
  ["`people`", { "people.0.id": "Pprobe" }],
  ["`productionTags`", { "productionTags.0.id": "t_probe" }],
  ["`brollShots`", { "brollShots.0.id": "Sprobe" }],
  ["`wordsPerMinute`", { wordsPerMinute: 223 }],
  ["`rev`", { rev: 37 }],
  ["`lastEditedBy`", { lastEditedBy: "Legacy editor" }],
  ["`lastEditedAt`", { lastEditedAt: "2026-03-05T06:07:08Z" }],
  ["`personColors`", { "personColors.Person sentinel": "#80BDFB" }],
  ["`targetSeconds`", { targetSeconds: 4321 }],
  ["`paragraphsDecided`", { paragraphsDecided: true }],
  ["`schema`", { schema: 2 }],
  ["Unknown top-level keys (fixture `doc.unknownField.kept`)", { "futureTop.kept": "top extra sentinel" }],
  ["Unknown keys on rows, comments, replies and shots", { "rows.0.futureRow": "row extra sentinel", "comments.0.futureComment": "comment extra sentinel", "comments.0.replies.0.futureReply": "reply extra sentinel", "brollShots.0.futureShot": "shot extra sentinel" }],
  ["Unknown keys on people and tag records", { "people.0.futurePerson": "person extra sentinel", "productionTags.0.futureTag": "tag extra sentinel" }],
  ["`rows[].id`", { "rows.0.id": "Rprobe" }],
  ["`rows[].status`", { "rows.0.status": "shot" }],
  ["`rows[].lengthSeconds`", { "rows.0.lengthSeconds": 123 }],
  ["`rows[].paragraphStart`", { "rows.0.paragraphStart": true }],
  ["`rows[].updatedAt`", { "rows.0.updatedAt": "2026-04-05T06:07:08Z" }],
  ["`rows[].updatedBy`", { "rows.0.updatedBy": "Row editor sentinel" }],
  ["`rows[].imageRef`", { "rows.0.imageRef": firstRef }],
  ["`rows[].imageName`", { "rows.0.imageName": "First picture sentinel" }],
  ["`rows[].imageAnnotation`", { "rows.0.imageAnnotation.imageRef": { sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", width: 17, height: 19, mime: "image/png" }, "rows.0.imageAnnotation.marks": [pen, text] }],
  ["`rows[].imageLinks`", { "rows.0.imageLinks": [{ href: "https://example.test/inventory-video", duration: 91.2, poster: true }, { name: "inventory-clip.mp4", size: 12345 }] }],
  ["`rows[].moreImages`", { "rows.0.moreImages.length": 1 }],
  ["`rows[].visualImage`", { "rows.0.visualImage#absent": true }],
  ["`moreImages[].imageRef`", { "rows.0.moreImages.0.imageRef": { sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", width: 23, height: 29, mime: "image/png" } }],
  ["`moreImages[].name`", { "rows.0.moreImages.0.name": "Other picture sentinel" }],
  ["`moreImages[].annotation`", { "rows.0.moreImages.0.annotation.imageRef": { sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", width: 31, height: 37, mime: "image/png" }, "rows.0.moreImages.0.annotation.marks": [highlight] }],
  ["`moreImages[].links`", { "rows.0.moreImages.0.links": [{ href: "https://example.test/other-video", duration: 82.3, poster: true }] }],
  ["`…links[].href`", { "rows.0.imageLinks.0.href": "https://example.test/inventory-video" }],
  ["`…links[].name`, `…links[].size`", { "rows.0.imageLinks.1.name": "inventory-clip.mp4", "rows.0.imageLinks.1.size": 12345 }],
  ["`…links[].duration`", { "rows.0.imageLinks.0.duration": 91.2 }],
  ["`…links[].poster`", { "rows.0.imageLinks.0.poster": true }],
  ["`…links[].location`", { "rows.0.imageLinks.1.location#absent": true }],
  ["Image reference `{sha256, width, height, mime}`", { "rows.0.imageRef": firstRef, "comments.1.imageValue": { sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", width: 47, height: 53, mime: "image/png" } }],
  ["Hash-only inline image reference `{sha256}` (`StoredImageRef`)", { "comments.2.body": '<img class="comment-img" data-blob="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd">' }],
  ["Annotation mark, pen or highlight", { "rows.0.imageAnnotation.marks.0": pen, "rows.0.moreImages.0.annotation.marks.0": highlight }],
  ["Annotation mark, text", { "rows.0.imageAnnotation.marks.1": text }],
  ["`sections[].id`", { "sections.0.id": "Hprobe" }],
  ["`sections[].firstSceneId`", { "sections.0.firstSceneId": "Rprobe" }],
  ["`id`", { "comments.0.id": "Cprobe" }],
  ["`rowId`", { "comments.0.rowId": "Rprobe" }],
  ["`field`", { "comments.0.field": "audioText" }],
  ["`anchorId`", { "comments.0.anchorId": "Canchor" }],
  ["`quotedText`", { "comments.0.quotedText": "Quoted sentinel" }],
  ["`author`", { "comments.0.author": "Author sentinel" }],
  ["`body`", { "comments.0.body": "Comment body sentinel" }],
  ["`resolved`", { "comments.0.resolved": true }],
  ["`resolvedBy`, `resolvedAt`", { "comments.0.resolvedBy": "Resolver sentinel", "comments.0.resolvedAt": "2026-02-04T04:05:06Z" }],
  ["`assignee`", { "comments.0.assignee": "Assignee sentinel" }],
  ["`createdAt`", { "comments.0.createdAt": "2026-01-02T03:04:05Z" }],
  ["`updatedAt`", { "comments.0.updatedAt": "2026-02-03T04:05:06Z" }],
  ["`kind`", { "comments.0.kind": "conflict" }],
  ["`imageValue`", { "comments.1.imageValue.sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }],
  ["`conflictField`, `emptyValue`, `titleValue`", { "comments.0.conflictField": "audioText", "comments.0.emptyValue": true, "comments.0.titleValue": "Title conflict sentinel" }],
  ["`replies[]`", { "comments.0.replies.length": 1 }],
  ["`replies[].id`", { "comments.0.replies.0.id": "RPprobe" }],
  ["`replies[].author`, `.body`, `.createdAt`", { "comments.0.replies.0.author": "Reply author sentinel", "comments.0.replies.0.body": "Reply body sentinel", "comments.0.replies.0.createdAt": "2026-02-05T04:05:06Z" }],
  ["`people[].id`", { "people.0.id": "Pprobe" }],
  ["`people[].name`", { "people.0.name": "Person sentinel" }],
  ["`productionTags[].id`", { "productionTags.0.id": "t_probe" }],
  ["`productionTags[].cat`", { "productionTags.0.cat": "prop" }],
  ["`productionTags[].name`", { "productionTags.0.name": "Prop sentinel" }],
  ["`productionTags[].owner`", { "productionTags.0.owner": "Pprobe" }],
  ["`productionTags[].notes`", { "productionTags.0.notes": "Tag notes sentinel" }],
  ["`productionTags[].status`", { "productionTags.0.status": "have" }],
  ["`brollShots[].id`", { "brollShots.0.id": "Sprobe" }],
  ["`brollShots[].name`, `.desc`", { "brollShots.0.name": "Shot name sentinel", "brollShots.0.desc": "Shot description sentinel" }],
  ["`brollShots[].status`", { "brollShots.0.status": "shot" }],
  ["`brollShots[].reshoot`", { "brollShots.0.reshoot": true }],
  ["`brollShots[].notes`, `.audioRef`, `.location`", { "brollShots.0.notes": "Shot notes sentinel", "brollShots.0.audioRef": "Shot audio sentinel", "brollShots.0.location": "Shot location sentinel" }],
  ["`brollShots[].owner`", { "brollShots.0.owner": "Pprobe" }],
  ["`brollShots[].origin`", { "brollShots.0.origin": "list" }],
  ["`brollShots[].props[]`", { "brollShots.0.props": [{ id: "t_probe", name: "Prop sentinel" }] }],
  ["Image", { "comments.2.body": '<img class="comment-img" data-blob="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd">' }],
  ["Video card", { "comments.2.replies.0.body": '<a class="video-embed-card" href="https://example.test/media"><span class="vec-host">Media host sentinel</span></a>' }]
];
test("projection literal probes cover the 82 non-shared-text field rows", () => {
  const inventory = readFileSync(new URL("../../../docs/collaboration/stage-0/2-fields.md", import.meta.url), "utf8").split("## Marks with identity")[0]; assert.ok(inventory);
  const deferred = ["`title`", "`sections`", "`sections[].name`", "`rows[].audioText` (narration)", "`rows[].visualText` (visual)", "Characters and line breaks", "Bold, italic, underline, strike, highlight", "Link", "Comment mark", "Tag", "Stage direction", "Audio cue", "B-roll key", "`@Name`"];
  assert.equal(probes.length, 82); assert.equal(deferred.length, 14);
  assert.deepEqual(probes.map(([field]) => field), inventory.split(/\r?\n/).filter(line => line.startsWith("| ") && !/^\| (Field|Item|---)/.test(line)).map(line => line.split("|")[1]?.trim()).filter(field => !deferred.includes(String(field))));
  const source = fieldMappingSource();
  const check = (projected: Readonly<Record<string, unknown>>) => {
    for (const [field, paths] of probes) for (const [probe, expected] of Object.entries(paths)) {
      const [path, mode] = probe.split("#"); assert.ok(path); const keys = path.split("."); let value: unknown = projected, present = true;
      for (const key of keys) { if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) { present = false; break; } value = (value as Record<string, unknown>)[key]; }
      if (mode === "absent") assert.equal(present, false, field);
      else { assert.equal(present, true, field); if (mode === "contains") assert.ok(typeof value === "string" && value.includes(String(expected)), field); else assert.deepEqual(value, expected, field); }
    }
  };
  withProjectedFixture(source, check); withFullProjectedFixture(source, check);
  withProjectedFixture(legacyMappingSource(), projected => { const row = (projected.rows as Record<string, unknown>[])[0]; assert.ok(row); assert.equal(Object.hasOwn(row, "visualImage"), false); assert.deepEqual([((row.imageRef) as { width: number }).width, ((row.imageRef) as { height: number }).height], [3, 5]); });
});
