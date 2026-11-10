import { mapValue } from "../schema.ts";
import type { SchemaReplica } from "../schema.ts";
import { DocumentProjectionHarness } from "./harness.ts";
import { copy, records } from "./value.ts";
import type { ProjectionBag } from "./value.ts";

export const projectionConcurrentSeed: ProjectionBag = {
  schema: 2, title: "Concurrent fields", docId: "d11111111111111111111111111111111", rev: 0, wordsPerMinute: 150,
  rows: [
    { id: "R1", status: "todo", audioText: "a", visualText: "v", imageRef: null, updatedAt: "", updatedBy: null, futureRow: { kept: 1 }, ["__proto__"]: { kept: "row" } },
    { id: "R2", status: "todo", audioText: "b", visualText: "w", imageRef: null, updatedAt: "", updatedBy: null }
  ],
  comments: [{ id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", author: "A", body: "note", quotedText: "", resolved: false,
    resolvedBy: null, resolvedAt: null, createdAt: null, updatedAt: null, assignee: "", kind: "anchor", futureComment: { kept: 2 },
    ["__proto__"]: { kept: "comment" },
    replies: [{ id: "P1", author: "B", body: "reply", createdAt: null, futureReply: [3], ["__proto__"]: { kept: "reply" } }] }],
  people: [{ id: "p1", name: "A", futurePerson: { kept: 4 }, ["__proto__"]: { kept: "person" } }],
  productionTags: [{ id: "t_seed", cat: "prop", name: "Cup", owner: "", notes: "", status: "needed", futureTag: [5], ["__proto__"]: { kept: "tag" } }],
  brollShots: [{ id: "s1", name: "List shot", desc: "", status: "unshot", reshoot: false, owner: "", notes: "", audioRef: "", location: "", origin: "list", props: [], futureShot: { kept: 6 }, ["__proto__"]: { kept: "shot" } }],
  unknownField: { kept: [7, null] }, ["__proto__"]: { kept: "document" }, constructor: ["kept"], prototype: { kept: true }
};

export const projectionConcurrentCases = ["same beat scalars", "different beats", "text and scalar", "unknown record extras"] as const;

export function projectionConcurrentCaseName(value: { candidate: string; order: string; swapped: boolean; name: string }): string {
  return `concurrent/${value.name}/${value.candidate}/${value.order}/${value.swapped ? "swapped" : "normal"}`;
}

export function applyConcurrentCase(name: typeof projectionConcurrentCases[number], alice: SchemaReplica, bob: SchemaReplica): ProjectionBag {
  const expected = copy(projectionConcurrentSeed);
  const rows = records(expected.rows);
  if (name === "same beat scalars") {
    mapValue(alice.doc.getMap("beats").get("R1")).set("lengthSeconds", 12);
    mapValue(bob.doc.getMap("beats").get("R1")).set("status", "ready");
    Object.assign(rows[0] as ProjectionBag, { lengthSeconds: 12, status: "ready" });
  } else if (name === "different beats") {
    mapValue(alice.doc.getMap("beats").get("R1")).set("lengthSeconds", 12);
    mapValue(bob.doc.getMap("beats").get("R2")).set("paragraphStart", true);
    (rows[0] as ProjectionBag).lengthSeconds = 12;
    (rows[1] as ProjectionBag).paragraphStart = true;
  } else if (name === "text and scalar") {
    const location = alice.locate("R1");
    location.text.insert(location.start + 1, "!", {});
    mapValue(bob.doc.getMap("beats").get("R1")).set("lengthSeconds", 12);
    Object.assign(rows[0] as ProjectionBag, { audioText: "a!", lengthSeconds: 12 });
  } else {
    alice.doc.transact(() => {
      mapValue(alice.doc.getMap("people").get("p1")).set("name", "Ana");
      mapValue(alice.doc.getMap("tags").get("t_seed")).set("notes", "new tag note");
      mapValue(alice.doc.getMap("shots").get("s1")).set("notes", "new shot note");
    });
    bob.doc.transact(() => {
      mapValue(bob.doc.getMap("comments").get("C1")).set("assignee", "Ana");
      mapValue(bob.doc.getMap("replies").get("C1:P1")).set("text", "new reply");
      mapValue(bob.doc.getMap("beats").get("R1")).set("lengthSeconds", 12);
    });
    (records(expected.people)[0] as ProjectionBag).name = "Ana";
    (records(expected.productionTags)[0] as ProjectionBag).notes = "new tag note";
    (records(expected.brollShots)[0] as ProjectionBag).notes = "new shot note";
    const comment = records(expected.comments)[0] as ProjectionBag;
    comment.assignee = "Ana";
    (records(comment.replies)[0] as ProjectionBag).body = "new reply";
    (rows[0] as ProjectionBag).lengthSeconds = 12;
  }
  return expected;
}

export function runConcurrentProjections() {
  const results = [];
  for (const candidate of ["A", "B"] as const) for (const order of ["D1", "dup", "rev", "late-C"] as const) {
    for (const swapped of [false, true]) for (const name of projectionConcurrentCases) {
      const harness = new DocumentProjectionHarness(projectionConcurrentSeed, candidate, swapped);
      try {
        const expected = applyConcurrentCase(name, harness.alice, harness.bob);
        harness.queue.flush(order);
        if (order === "late-C") harness.lateJoin();
        results.push({ candidate, order, swapped, name, expected, documents: harness.documents(), history: [...harness.queue.history] });
      } finally { harness.destroy(); }
    }
  }
  return results;
}
