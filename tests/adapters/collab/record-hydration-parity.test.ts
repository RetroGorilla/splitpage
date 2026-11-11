import { test } from "node:test";
import type { SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { agree, execute } from "./executor-support.ts";
import { createRecord, deleteRecord, recordReplicas } from "./record-support.ts";

test("the same seven record roots are exactly equal after hydration or handler creation", () => {
  const source = { title: "Parity", rows: [{ id: "R1", audioText: "Words", visualText: "Visual", imageLinks: [{ href: "https://review.test/video" }] }],
    comments: [{ id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", author: "Alice", body: "comment", quotedText: "Words",
      createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z", assignee: "", kind: "anchor", resolved: false, resolvedAt: null, resolvedBy: null,
      replies: [{ id: "r1", author: "Bob", body: "reply", createdAt: "2026-11-10T00:00:01Z" }] }],
    people: [{ id: "P1", name: "Alice" }], productionTags: [{ id: "t_new", cat: "prop", name: "Cup", owner: "", notes: "", status: "needed" }],
    brollShots: [{ id: "S2", name: "Cup", desc: "", status: "unshot", reshoot: false, notes: "", audioRef: "", location: "", owner: "", origin: "list", props: [{ id: "t_new", name: "Cup" }] }] };
  const loaded = recordReplicas(2, source), authored = recordReplicas(2, { title: "Parity", rows: [{ id: "R1", audioText: "Words", visualText: "Visual" }] });
  try {
    execute(authored.a, deleteRecord("gallery", "R1:slot:0"), deleteRecord("visuals", "R1"),
      createRecord("comments", "C1", { rowId: "R1", field: "audioText", anchorId: "C1", author: "Alice", text: "comment", quote: "Words",
        createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z", assignee: "", kind: "anchor",
        resolution: { resolved: false, resolvedAt: null, resolvedBy: null }, rank: "0000000000", extra: "{}" }),
      createRecord("replies", '["C1","r1"]', { id: "r1", commentId: "C1", author: "Bob", createdAt: "2026-11-10T00:00:01Z", text: "reply", rank: "0000000000", extra: "{}" }, "Bob"),
      createRecord("people", "P1", { name: "Alice", rank: "0000000000", extra: "{}" }),
      createRecord("tags", "t_new", { cat: "prop", name: "Cup", owner: "", notes: "", status: "needed", rank: "0000000000", extra: "{}" }),
      createRecord("shots", "S2", { name: "Cup", desc: "", status: "unshot", reshoot: false, notes: "", audioRef: "", location: "", owner: "", origin: "list",
        props: [{ id: "t_new", name: "Cup" }], rank: "0000000000", extra: "{}" }),
      createRecord("gallery", "R1:slot:0", { beat: "R1", rank: "0000000000", picture: { imageRef: null }, links: [{ href: "https://review.test/video" }], extra: "{}" }),
      createRecord("visuals", "R1", { beat: "R1", rank: "0000000000" })); authored.queue.flush("D1");
    const kinds: readonly SharedRecordCollection[] = ["comments", "replies", "people", "tags", "shots", "gallery", "visuals"];
    const read = (handle: typeof loaded.a) => Object.fromEntries(kinds.map(kind => [kind, readSharedRecords(handle, kind)]));
    const expected = {
      comments: [{ key: "C1", fields: { id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", author: "Alice", createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z",
        assignee: "", kind: "anchor", text: "comment", quote: "Words", resolution: { resolved: false, resolvedAt: null, resolvedBy: null }, rank: "0000000000", extra: "{}" } }],
      replies: [{ key: '["C1","r1"]', fields: { id: "r1", commentId: "C1", author: "Bob", createdAt: "2026-11-10T00:00:01Z", text: "reply", rank: "0000000000", extra: "{}" } }],
      people: [{ key: "P1", fields: { id: "P1", name: "Alice", rank: "0000000000", extra: "{}" } }],
      tags: [{ key: "t_new", fields: { id: "t_new", cat: "prop", name: "Cup", owner: "", notes: "", status: "needed", rank: "0000000000", extra: "{}" } }],
      shots: [{ key: "S2", fields: { id: "S2", name: "Cup", desc: "", status: "unshot", reshoot: false, notes: "", audioRef: "", location: "", owner: "", origin: "list",
        props: [{ key: "t_new", fields: { id: "t_new", name: "Cup", rank: "0000000000" } }], rank: "0000000000", extra: "{}" } }],
      gallery: [{ key: "R1:slot:0", fields: { beat: "R1", rank: "0000000000", picture: { imageRef: null }, links: [{ key: "u:https://review.test/video",
        fields: { href: "https://review.test/video", rank: "0000000000", extra: "{}" } }], extra: "{}" } }],
      visuals: [{ key: "R1", fields: { beat: "R1", rank: "0000000000" } }]
    };
    agree("hydrated and authored roots", "D1", [loaded.a, loaded.b, authored.a, authored.b], read, expected);
    agree("authored encoded reload", "D1", [authored.a, authored.b], read, expected);
  } finally { loaded.close(); authored.close(); }
});
