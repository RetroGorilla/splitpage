import type { ValidatedDocument } from "../../../src/core/document/validated.ts";
import { validatedFixture } from "./helpers.ts";
import { pngDataUrl } from "../../core/migrate-ports.ts";

export function legacyMappingSource(): ValidatedDocument {
  return validatedFixture({ rows: [{ id: "Rlegacy", audioText: "Legacy sentinel", visualImage: pngDataUrl(3, 5, 23) }] });
}

export function fieldMappingSource(): ValidatedDocument {
  return validatedFixture({
    title: "Document title sentinel", titleOrigin: "user", titleVersion: "v37",
    docId: "d00000000000000000000000000000077", rev: 37, wordsPerMinute: 223, targetSeconds: 4321,
    lastEditedBy: "Legacy editor", lastEditedAt: "2026-03-05T06:07:08Z", personColors: { "Person sentinel": "#80BDFB" },
    paragraphsDecided: true, futureTop: { kept: "top extra sentinel" },
    sections: [{ id: "Hprobe", name: "Heading sentinel", firstSceneId: "Rprobe" }],
    rows: [{
      id: "Rprobe", status: "shot", lengthSeconds: 123, paragraphStart: true,
      updatedAt: "2026-04-05T06:07:08Z", updatedBy: "Row editor sentinel", futureRow: "row extra sentinel",
      audioText: '<strong><em><u><s><mark>format sentinel</mark></s></u></em></strong>|<a href="https://example.test/text-link">link sentinel</a>|<span class="cmt-anchor" data-cmt="Canchor">comment sentinel</span>|<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Prop sentinel">tag sentinel</span>|<span class="stage-dir">direction sentinel</span>|<span class="audio-cue">cue sentinel</span>|plain<br>tail',
      visualText: '<strong><em><u><s><mark>format sentinel</mark></s></u></em></strong>|<a href="https://example.test/text-link">link sentinel</a>|<span class="cmt-anchor" data-cmt="Canchor">comment sentinel</span>|<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Prop sentinel">tag sentinel</span>|<span class="stage-dir">direction sentinel</span>|<span class="audio-cue">cue sentinel</span>|plain<br>tail|<span class="broll-key" data-broll-id="Sprobe">B-roll:</span>|<span class="who-anchor" data-who="Person sentinel">@Person sentinel</span>',
      imageRef: { sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", width: 11, height: 13, mime: "image/png" },
      imageName: "First picture sentinel",
      imageAnnotation: {
        imageRef: { sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", width: 17, height: 19, mime: "image/png" },
        marks: [
          { kind: "pen", color: "#ffb703", width: 0.02, points: [0.1, 0.2, 0.3, 0.4] },
          { kind: "text", color: "#ffb703", size: 0.1, x: 0.2, y: 0.3, text: "Annotation text sentinel" }
        ]
      },
      imageLinks: [
        { href: "https://example.test/inventory-video", duration: 91.2, poster: true },
        { name: "inventory-clip.mp4", size: 12345, location: { kind: "bundled", name: "local-sentinel.mp4" } }
      ],
      moreImages: [{
        imageRef: { sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", width: 23, height: 29, mime: "image/png" },
        name: "Other picture sentinel",
        annotation: {
          imageRef: { sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", width: 31, height: 37, mime: "image/png" },
          marks: [{ kind: "highlight", color: "#ffb703", width: 0.03, points: [0.1, 0.2, 0.7, 0.8] }]
        },
        links: [{ href: "https://example.test/other-video", duration: 82.3, poster: true }]
      }]
    }],
    comments: [{
      id: "Cprobe", rowId: "Rprobe", field: "audioText", anchorId: "Canchor", quotedText: "Quoted sentinel",
      body: "Comment body sentinel", author: "Author sentinel", createdAt: "2026-01-02T03:04:05Z", updatedAt: "2026-02-03T04:05:06Z",
      resolved: true, resolvedBy: "Resolver sentinel", resolvedAt: "2026-02-04T04:05:06Z", assignee: "Assignee sentinel", kind: "conflict",
      conflictField: "audioText", emptyValue: true, titleValue: "Title conflict sentinel", futureComment: "comment extra sentinel",
      replies: [{ id: "RPprobe", author: "Reply author sentinel", body: "Reply body sentinel", createdAt: "2026-02-05T04:05:06Z", futureReply: "reply extra sentinel" }]
    }, {
      id: "Cimage", rowId: "Rprobe", field: "visualImage", kind: "conflict",
      imageValue: { sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", width: 47, height: 53, mime: "image/png" }
    }, {
      id: "Cmedia", rowId: "Rprobe", field: "visualText",
      body: '<img class="comment-img" data-blob="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd">',
      replies: [{ id: "RPmedia", body: '<a class="video-embed-card" href="https://example.test/media"><span class="vec-host">Media host sentinel</span></a>' }]
    }],
    people: [{ id: "Pprobe", name: "Person sentinel", futurePerson: "person extra sentinel" }],
    productionTags: [{ id: "t_probe", cat: "prop", name: "Prop sentinel", owner: "Pprobe", notes: "Tag notes sentinel", status: "have", futureTag: "tag extra sentinel" }],
    brollShots: [{ id: "Sprobe", name: "Shot name sentinel", desc: "Shot description sentinel", status: "shot", reshoot: true,
      notes: "Shot notes sentinel", audioRef: "Shot audio sentinel", location: "Shot location sentinel", owner: "Pprobe", origin: "list",
      props: [{ id: "t_probe", name: "Prop sentinel" }], futureShot: "shot extra sentinel" }]
  });
}
