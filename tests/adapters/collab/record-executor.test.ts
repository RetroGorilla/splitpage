import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { executeSharedOperations } from "../../../src/adapters/collab/execute.ts";
import { readSharedRecords } from "../../../src/adapters/collab/record-reader.ts";
import { readSharedStatus } from "../../../src/adapters/collab/status.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { encodeSharedState, transactSharedDocument, observeSharedTransactions } from "../../../src/adapters/collab/document.ts";
import { readSharedScalars } from "../../../src/adapters/collab/scalar-reader.ts";
import { commentsOracle, commentsReplyOracle } from "../../collab/oracles/oracles.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import type { SharedRecordCollection } from "../../../src/core/collab/operations.ts";
import { agree, execute, operation, ref } from "./executor-support.ts";
import { createRecord, setRecord, deleteRecord, recordReplicas, recordExamples, recordKey } from "./record-support.ts";

test("record/scalar list creates dependencies and refuses late wrong-shape changes without a live write", () => {
  const run = recordReplicas();
  try {
    execute(run.a, createRecord("people", "P1", { name: "Alice" }), setRecord("people", "P1", "name", "Alicia"));
    assert.deepEqual(readSharedRecords(run.a, "people"), [{ key: "P1", fields: { id: "P1", name: "Alicia" } }]);
    for (const bad of [setRecord("people", "P1", "name", 3), setRecord("people", "missing", "name", "X"),
      createRecord("people", "P1", { name: "duplicate" }), createRecord("people", "P2", { id: "P3", name: "wrong" }),
      createRecord("comments", "C1", { author: "Bob" }), createRecord("replies", "r1", { id: "r1", commentId: "C1" }),
      setRecord("visuals", "R1", "text", "forbidden"), { kind: "record-set", id: "clear", by: "Alice", target: { collection: "visuals", record: "R1" }, field: "text", clear: true }]) {
      const before = encodeSharedState(run.a);
      const result = executeSharedOperations(run.a, [operation(setRecord("people", "P1", "name", "staged")), operation(bad)]);
      assert.ok(!result.ok); assert.equal(result.index, 1); assert.deepEqual(encodeSharedState(run.a), before);
    }
  } finally { run.close(); }
});

test("hydration round trip root by root retains fields and applies record and scalar groups", () => {
  const run = recordReplicas();
  try {
    execute(run.a,
      createRecord("comments", "C1", { rowId: "R1", field: "audioText", anchorId: "C1", createdAt: 0, updatedAt: 1, assignee: "Bob",
        kind: "anchor", imageValue: null, conflictField: "audioText", emptyValue: false, titleValue: "Title", text: "body", quote: "abZ",
        resolution: { resolved: false, resolvedAt: null, resolvedBy: null }, rank: "1", extra: '{"future":true}' }),
      createRecord("replies", '["C1","r1"]', { id: "r1", commentId: "C1", createdAt: 2, text: "reply", rank: "1", extra: "{}" }, "Bob"),
      createRecord("people", "P1", { name: "Alice", rank: "1", extra: "{}" }),
      createRecord("tags", "t_new", { cat: "prop", name: "Mug", owner: "P1", notes: "note", rank: "1", extra: "{}" }),
      createRecord("shots", "S2", { name: "Mug", desc: "close", reshoot: true, notes: "note", audioRef: "a", location: "Desk", owner: "P1", origin: "list",
        props: [{ id: "t_new", name: "Mug" }], rank: "1", extra: "{}" }),
      createRecord("gallery", "G1", { beat: "R1", rank: "1", picture: { imageRef: { sha256: "a".repeat(64) }, name: "Mug",
        annotation: { imageRef: { sha256: "b".repeat(64), width: 1, height: 1, mime: "image/png" }, marks: [{ kind: "pen", color: "#e5383b", width: 0.01, points: [0, 0, 1, 1] }] } },
        links: [{ href: "https://example.test/video", duration: 2, poster: true }, { name: "clip.mp4", size: 7, duration: 3 }], extra: "{}" }),
      createRecord("visuals", "V1", { beat: "R1", rank: "1", extra: "{}" }),
      setRecord("comments", "C1", "text", "edited"), setRecord("replies", '["C1","r1"]', "text", "edited reply", "Bob"),
      setRecord("comments", "C1", "resolution", { resolved: true, resolvedAt: "2026-11-10", resolvedBy: "Bob" }, "Bob"),
      { kind: "scalar", id: "l", by: "Alice", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 5 },
      { kind: "status", id: "st", by: "Alice", target: { scope: "tag", record: "t_new" }, value: "have", parents: [] });
    run.queue.flush("D1");
    const expected = {
      comments: { id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", author: "Alice", createdAt: 0, updatedAt: 1, assignee: "Bob", kind: "anchor",
        imageValue: null, conflictField: "audioText", emptyValue: false, titleValue: "Title", text: "edited", quote: "abZ",
        resolution: { resolved: true, resolvedAt: "2026-11-10", resolvedBy: "Bob" }, rank: "1", extra: '{"future":true}' },
      replies: { id: "r1", commentId: "C1", author: "Bob", createdAt: 2, text: "edited reply", rank: "1", extra: "{}" },
      people: { id: "P1", name: "Alice", rank: "1", extra: "{}" },
      tags: { id: "t_new", cat: "prop", name: "Mug", owner: "P1", notes: "note", status: "needed", rank: "1", extra: "{}" },
      shots: { id: "S2", name: "Mug", desc: "close", status: "unshot", reshoot: true, notes: "note", audioRef: "a", location: "Desk", owner: "P1", origin: "list",
        props: [{ key: "t_new", fields: { id: "t_new", name: "Mug", rank: "0000000000" } }], rank: "1", extra: "{}" },
      gallery: { beat: "R1", rank: "1", picture: { annotation: { imageRef: { height: 1, mime: "image/png", sha256: "b".repeat(64), width: 1 },
        marks: [{ color: "#e5383b", kind: "pen", points: [0, 0, 1, 1], width: 0.01 }] }, imageRef: { sha256: "a".repeat(64) }, name: "Mug" },
        links: [{ key: "u:https://example.test/video", fields: { href: "https://example.test/video", duration: 2, poster: true, rank: "0000000000" } },
          { key: "f:clip.mp4:7", fields: { name: "clip.mp4", size: 7, duration: 3, rank: "0000000001" } }], extra: "{}" },
      visuals: { beat: "R1", rank: "1", extra: "{}" }
    };
    for (const kind of Object.keys(expected) as SharedRecordCollection[]) {
      agree(kind, "D1", [run.a, run.b], handle => readSharedRecords(handle, kind).filter(record => record.key === recordKey(kind)),
        [{ key: recordKey(kind), fields: expected[kind] }]);
    }
    assert.equal(readSharedStatus(run.a, { scope: "tag", record: ref("t_new") }), "have");
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`T11 comment and reply record portions and author-only edits ${order}`, () => {
  const run = recordReplicas();
  try {
    execute(run.a, createRecord("comments", "C1", recordExamples.comments));
    execute(run.b, createRecord("comments", "C2", { author: "Bob", createdAt: 0, text: "", rowId: "R1", field: "audioText" }, "Bob")); run.queue.flush(order);
    function read(handle: typeof run.a) {
      return Object.fromEntries(readSharedRecords(handle, "comments").map(({ key, fields }) => [key, {
        author: fields.author, createdAt: fields.createdAt, text: fields.text, rowId: fields.rowId, field: fields.field,
        replies: readSharedRecords(handle, "replies").filter(reply => reply.fields.commentId === key).map(reply => ({ id: reply.fields.id,
          commentId: reply.fields.commentId, author: reply.fields.author, createdAt: reply.fields.createdAt, text: reply.fields.text }))
      }]));
    }
    function expected(oracle: typeof commentsOracle) {
      const comments = oracle.records?.comments as Record<string, Record<string, unknown>>;
      return Object.fromEntries(Object.entries(comments).map(([key, value]) => [key, { author: value.author, createdAt: value.createdAt,
        text: value.text, rowId: value.rowId, field: value.field, replies: value.replies }]));
    }
    agree("T11 comment records", order, [run.a, run.b], read, expected(commentsOracle));
    execute(run.b, createRecord("replies", '["C1","r1"]', recordExamples.replies, "Bob")); run.queue.flush(order);
    agree("T11 reply records", order, [run.a, run.b], read, expected(commentsReplyOracle));
    for (const [kind, key, by] of [["comments", "C1", "Bob"], ["replies", '["C1","r1"]', "Alice"]] as const) {
      const before = encodeSharedState(run.a);
      assert.equal(executeSharedOperations(run.a, [operation(setRecord(kind, key, "text", "foreign", by))]).ok, false);
      assert.deepEqual(encodeSharedState(run.a), before);
    }
    execute(run.a, setRecord("comments", "C1", "text", ""), deleteRecord("comments", "C1")); run.queue.flush(order);
    agree("recovery inputs retained", order, [run.a, run.b], handle => readSharedRecords(handle, "replies").map(reply => reply.fields),
      [{ id: "r1", commentId: "C1", author: "Bob", createdAt: 0, text: "" }]);
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`reply code-unit ties, resolve/reopen, same-id/field collisions and removal ${order}`, () => {
  const run = recordReplicas();
  try {
    execute(run.a, createRecord("comments", "C1", { text: "body", quote: "words", rowId: "R1", anchorId: "C1", resolution: { resolved: false } })); run.queue.flush(order);
    execute(run.a, createRecord("replies", '["C1","é"]', { id: "é", commentId: "C1", createdAt: 1, text: "A" }));
    execute(run.b, createRecord("replies", '["C1","é"]', { id: "é", commentId: "C1", createdAt: 1, text: "B" }, "Bob"),
      createRecord("replies", '["C1","z-old"]', { id: "z-old", commentId: "C1", createdAt: 0, text: "old" }, "Bob")); run.queue.flush(order);
    agree("reply oldest/ties", order, [run.a, run.b], handle => readSharedRecords(handle, "replies").map(record => record.fields.id), ["z-old", "é", "é"]);
    execute(run.a, setRecord("comments", "C1", "resolution", { resolved: true, resolvedAt: "one", resolvedBy: "Alice" })); run.queue.flush(order);
    execute(run.b, setRecord("comments", "C1", "resolution", { resolved: false, resolvedAt: null, resolvedBy: null }, "Bob")); run.queue.flush(order);
    agree("later reopen", order, [run.a, run.b], handle => readSharedRecords(handle, "comments")[0]?.fields.resolution, { resolved: false, resolvedAt: null, resolvedBy: null });
    execute(run.a, setRecord("comments", "C1", "resolution", { resolved: true, resolvedAt: "2099-01-01", resolvedBy: "Alice" }));
    execute(run.b, setRecord("comments", "C1", "resolution", { resolved: false, resolvedAt: "1999-01-01", resolvedBy: "Bob" }, "Bob")); run.queue.flush(order);
    agree("concurrent resolution is atomic native order", order, [run.a, run.b], handle => readSharedRecords(handle, "comments")[0]?.fields.resolution,
      { resolved: false, resolvedAt: "1999-01-01", resolvedBy: "Bob" });
    execute(run.a, setRecord("comments", "C1", "resolution", { resolved: true, resolvedAt: "2000-01-01", resolvedBy: "Alice" })); run.queue.flush(order);
    agree("causally later resolution wins", order, [run.a, run.b], handle => readSharedRecords(handle, "comments")[0]?.fields.resolution,
      { resolved: true, resolvedAt: "2000-01-01", resolvedBy: "Alice" });
    execute(run.a, createRecord("people", "collision", { name: "A" })); execute(run.b, createRecord("people", "collision", { name: "B" }, "Bob")); run.queue.flush(order);
    agree("same id", order, [run.a, run.b], handle => readSharedRecords(handle, "people").find(record => record.key === "collision")?.fields.name, "B");
    execute(run.a, setRecord("people", "collision", "name", "A2")); execute(run.b, setRecord("people", "collision", "name", "B2", "Bob")); run.queue.flush(order);
    agree("same field", order, [run.a, run.b], handle => readSharedRecords(handle, "people").find(record => record.key === "collision")?.fields.name, "B2");
    execute(run.a, deleteRecord("people", "collision")); execute(run.b, setRecord("people", "collision", "name", "B3", "Bob")); run.queue.flush(order);
    agree("remove versus change", order, [run.a, run.b], handle => readSharedRecords(handle, "people"), []);
    execute(run.a, setRecord("comments", "C1", "text", ""));
    assert.equal(readSharedRecords(run.a, "comments")[0]?.fields.quote, "words");
    assert.equal(readSharedRecords(run.a, "comments")[0]?.fields.anchorId, "C1");
    assert.equal(readSharedRecords(run.a, "comments")[0]?.fields.rowId, "R1");
    transactSharedDocument(run.a, "remote", () => collabState(run.a).roots.people.set("wrong", new Y.Map([["name", 4]])));
    const before = encodeSharedState(run.a);
    assert.equal(executeSharedOperations(run.a, [operation(setRecord("people", "wrong", "name", "repair"))]).ok, false);
    assert.deepEqual(encodeSharedState(run.a), before);
  } finally { run.close(); }
});

for (const order of deliveryOrders) test(`every root resolves creation/field collisions and removal identically ${order}`, () => {
  const run = recordReplicas();
  try {
    for (const kind of Object.keys(recordExamples) as SharedRecordCollection[]) {
      const key = recordKey(kind), fields = { ...recordExamples[kind], author: "Alice" };
      if (kind !== "comments" && kind !== "replies") delete (fields as Record<string, unknown>).author;
      execute(run.a, createRecord(kind, key, { ...fields, winner: "Alice" }));
      execute(run.b, createRecord(kind, key, { ...fields, ...(kind === "comments" || kind === "replies" ? { author: "Bob" } : {}), winner: "Bob" }, "Bob")); run.queue.flush(order);
      agree(`creation ${kind}`, order, [run.a, run.b], handle => readSharedRecords(handle, kind));
      agree(`creation winner ${kind}`, order, [run.a, run.b], handle => readSharedRecords(handle, kind).find(record => record.key === key)?.fields.winner, "Bob");
      execute(run.a, setRecord(kind, key, "rank", "A")); execute(run.b, setRecord(kind, key, "rank", "B", "Bob")); run.queue.flush(order);
      agree(`field ${kind}`, order, [run.a, run.b], handle => readSharedRecords(handle, kind));
      agree(`field winner ${kind}`, order, [run.a, run.b], handle => readSharedRecords(handle, kind).find(record => record.key === key)?.fields.rank, "B");
      execute(run.a, deleteRecord(kind, key)); execute(run.b, setRecord(kind, key, "rank", "C", "Bob")); run.queue.flush(order);
      agree(`removal ${kind}`, order, [run.a, run.b], handle => readSharedRecords(handle, kind).filter(record => record.key === key), []);
    }
  } finally { run.close(); }
});

test("gallery links and shot props retain concurrent distinct additions through their hydrated maps", () => {
  const run = recordReplicas();
  try {
    execute(run.a, setRecord("gallery", "R1:slot:0", "links", [{ href: "https://a.test" }]), setRecord("shots", "S1", "props", [{ id: "t_1", name: "Cup" }]));
    execute(run.b, setRecord("gallery", "R1:slot:0", "links", [{ href: "https://b.test" }], "Bob"), setRecord("shots", "S1", "props", [{ id: "t_new", name: "Mug" }], "Bob")); run.queue.flush("rev");
    agree("concurrent links", "rev", [run.a, run.b], handle => readSharedRecords(handle, "gallery")[0]?.fields.links,
      [{ key: "u:https://a.test", fields: { href: "https://a.test", rank: "0000000000" } }, { key: "u:https://b.test", fields: { href: "https://b.test", rank: "0000000000" } }]);
    agree("concurrent props", "rev", [run.a, run.b], handle => readSharedRecords(handle, "shots")[0]?.fields.props,
      [{ key: "t_1", fields: { id: "t_1", name: "Cup", rank: "0000000000" } }, { key: "t_new", fields: { id: "t_new", name: "Mug", rank: "0000000000" } }]);
  } finally { run.close(); }
});

test("a local no-op after a remote record/scalar change preserves encoded state and publishes no update", () => {
  const run = recordReplicas();
  try {
    const commands = [setRecord("shots", "S1", "props", [{ id: "t_1", name: "Cup" }]), setRecord("shots", "S1", "notes", "note"),
      { kind: "scalar", id: "length", by: "Alice", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 4 }];
    execute(run.a, ...commands); run.queue.flush("D1");
    const before = encodeSharedState(run.b), updates: unknown[] = [];
    collabState(run.b).doc.on("update", update => updates.push(update));
    execute(run.b, ...commands);
    assert.deepEqual(encodeSharedState(run.b), before); assert.deepEqual(updates, []);
  } finally { run.close(); }
});

test("a hand-written hydrated document accepts one mixed batch and preserves text while roots match literal data", () => {
  const run = recordReplicas(2, { title: "Loaded", titleOrigin: "file", titleVersion: "v37", wordsPerMinute: 160,
    rows: [{ id: "R1", audioText: "Words", visualText: "Visual", status: "ready", imageRef: { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" },
      imageName: "Cup", imageLinks: [{ href: "https://example.test/loaded" }] }],
    sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
    comments: [{ id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", author: "Alice", body: "loaded comment", quotedText: "Words",
      createdAt: "2026-11-10T00:00:00Z", resolved: false, replies: [{ id: "r1", author: "Bob", body: "loaded reply", createdAt: "2026-11-10T00:00:01Z" }] }],
    people: [{ id: "P1", name: "Alice" }], productionTags: [{ id: "t_new", cat: "prop", name: "Cup", status: "needed", owner: "P1" }],
    brollShots: [{ id: "S2", name: "Cup", origin: "list", status: "unshot", props: [{ id: "t_new", name: "Cup" }] }] });
  try {
    let updates = 0, transactions = 0;
    collabState(run.a).doc.on("update", () => { updates++; });
    const detach = observeSharedTransactions(run.a, origin => { if (origin === "local-command") transactions++; });
    execute(run.a, setRecord("comments", "C1", "text", "edited comment"), setRecord("comments", "C1", "resolution", { resolved: true, resolvedAt: "later", resolvedBy: "Bob" }, "Bob"),
      setRecord("replies", '["C1","r1"]', "text", "edited reply", "Bob"), setRecord("people", "P1", "name", "Alicia"), setRecord("tags", "t_new", "notes", "tag note"),
      setRecord("shots", "S2", "notes", "shot note"), setRecord("gallery", "R1:slot:0", "picture", { name: "replacement" }), setRecord("visuals", "R1", "rank", "2"),
      { kind: "scalar", id: "wpm", by: "Alice", target: { scope: "document", record: "d00000000000000000000000000000000" }, field: "wordsPerMinute", value: 180 },
      { kind: "scalar", id: "length", by: "Alice", target: { scope: "beat", record: "R1" }, field: "lengthSeconds", value: 6 },
      { kind: "scalar", id: "heading", by: "Alice", target: { scope: "heading", record: "H1" }, field: "extra", value: '{"future":true}' });
    detach(); assert.equal(updates, 1); assert.equal(transactions, 1); run.queue.flush("rev");
    const selected: Record<SharedRecordCollection, readonly string[]> = { comments: ["id", "rowId", "field", "anchorId", "author", "text", "quote", "resolution"],
      replies: ["id", "commentId", "author", "text"], people: ["id", "name"], tags: ["id", "cat", "name", "owner", "notes", "status"],
      shots: ["id", "name", "notes", "status", "origin", "props"], gallery: ["beat", "rank", "picture", "links"], visuals: ["beat", "rank"] };
    const expected = {
      comments: [{ key: "C1", fields: { id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", author: "Alice", text: "edited comment", quote: "Words", resolution: { resolved: true, resolvedAt: "later", resolvedBy: "Bob" } } }],
      replies: [{ key: '["C1","r1"]', fields: { id: "r1", commentId: "C1", author: "Bob", text: "edited reply" } }],
      people: [{ key: "P1", fields: { id: "P1", name: "Alicia" } }], tags: [{ key: "t_new", fields: { id: "t_new", cat: "prop", name: "Cup", owner: "P1", notes: "tag note", status: "needed" } }],
      shots: [{ key: "S2", fields: { id: "S2", name: "Cup", notes: "shot note", status: "unshot", origin: "list", props: [{ key: "t_new", fields: { id: "t_new", name: "Cup", rank: "0000000000" } }] } }],
      gallery: [{ key: "R1:slot:0", fields: { beat: "R1", rank: "0000000000", picture: { name: "replacement" }, links: [{ key: "u:https://example.test/loaded", fields: { href: "https://example.test/loaded", rank: "0000000000", extra: "{}" } }] } }],
      visuals: [{ key: "R1", fields: { beat: "R1", rank: "2" } }]
    };
    for (const kind of Object.keys(selected) as SharedRecordCollection[]) agree(`loaded ${kind}`, "rev", [run.a, run.b],
      handle => readSharedRecords(handle, kind).map(({ key, fields }) => ({ key, fields: Object.fromEntries(selected[kind].map(field => [field, fields[field]])) })), expected[kind]);
    agree("loaded scalar roots", "rev", [run.a, run.b], handle => [
      readSharedScalars(handle, { scope: "document", record: ref("d00000000000000000000000000000000") })?.wordsPerMinute,
      readSharedScalars(handle, { scope: "beat", record: ref("R1") })?.lengthSeconds,
      readSharedScalars(handle, { scope: "heading", record: ref("H1") })?.extra], [180, 6, '{"future":true}']);
    const visual = collabState(run.a).roots.visuals.get("R1") as Y.Map<unknown>;
    assert.equal((visual.get("text") as Y.Text).toString(), "Visual"); assert.ok(visual.get("markRecords") instanceof Y.Map);
  } finally { run.close(); }
});

test("creation-only fields, direct status writes and visual text stores refuse atomically; only authors clear text", () => {
  const run = recordReplicas();
  try {
    for (const kind of Object.keys(recordExamples) as SharedRecordCollection[]) execute(run.a, createRecord(kind, recordKey(kind), recordExamples[kind], kind === "replies" ? "Bob" : "Alice"));
    let refusals = 0;
    for (const [kind, field, value] of [["comments", "author", "Bob"], ["comments", "createdAt", 77], ["comments", "anchorId", "other"], ["comments", "quote", "other"],
      ["comments", "kind", "conflict"], ["comments", "imageValue", null], ["comments", "conflictField", "title"], ["comments", "emptyValue", true], ["comments", "titleValue", "other"],
      ["replies", "author", "Alice"], ["replies", "createdAt", 77], ["replies", "commentId", "other"], ["people", "id", "other"], ["shots", "origin", "script"],
      ["tags", "status", "have"], ["shots", "status", "shot"], ["visuals", "text", "other"], ["visuals", "html", "other"], ["visuals", "markRecords", {}]] as const) {
      for (const raw of [setRecord(kind, recordKey(kind), field, value), { kind: "record-set", id: "clear", by: "Alice", target: { collection: kind, record: recordKey(kind) }, field, clear: true }]) {
        const before = encodeSharedState(run.a), result = executeSharedOperations(run.a, [operation(setRecord("people", "P1", "name", "staged")), operation(raw)]);
        assert.ok(!result.ok); assert.equal(result.index, 1); assert.deepEqual(encodeSharedState(run.a), before); refusals++;
      }
    }
    for (const [kind, by] of [["comments", "Bob"], ["replies", "Alice"]] as const) {
      const before = encodeSharedState(run.a);
      assert.equal(executeSharedOperations(run.a, [operation({ kind: "record-set", id: "foreign-clear", by, target: { collection: kind, record: recordKey(kind) }, field: "text", clear: true })]).ok, false);
      assert.deepEqual(encodeSharedState(run.a), before); refusals++;
    }
    execute(run.a, { kind: "record-set", id: "clear-body", by: "Alice", target: { collection: "comments", record: "C1" }, field: "text", clear: true });
    const comment = readSharedRecords(run.a, "comments")[0]; assert.ok(comment);
    assert.equal(Object.hasOwn(comment.fields, "text"), false); assert.equal(comment.fields.rowId, "R1");
    assert.equal(readSharedRecords(run.a, "replies").length, 1); assert.equal(refusals, 40);
  } finally { run.close(); }
});

test("reply timestamps use explicit ISO offsets and numeric time with UTF-16 ties", () => {
  const run = recordReplicas();
  try {
    execute(run.a, createRecord("replies", JSON.stringify(["C1", "\u00e9"]), { id: "\u00e9", commentId: "C1", createdAt: "1970-01-01T00:00:00Z", text: "A" }));
    execute(run.b, createRecord("replies", JSON.stringify(["C1", "e\u0301"]), { id: "e\u0301", commentId: "C1", createdAt: "1970-01-01T01:00:00+01:00", text: "B" }, "Bob"),
      createRecord("replies", '["C1","invalid"]', { id: "invalid", commentId: "C1", createdAt: "2025-02-29T00:00:00Z", text: "invalid time" }, "Bob"),
      createRecord("replies", '["C1","later"]', { id: "later", commentId: "C1", createdAt: 1, text: "C" }, "Bob"));
    run.queue.flush("rev");
    agree("ISO/numeric oldest-first replies", "rev", [run.a, run.b], handle => readSharedRecords(handle, "replies").map(record => record.fields.id), ["e\u0301", "invalid", "\u00e9", "later"]);
  } finally { run.close(); }
});

test("unknown JSON is interpreted only by its own record kind, including names known by other kinds", () => {
  const run = recordReplicas();
  try {
    for (const [kind, objectField, listField] of [["comments", "origin", "props"], ["replies", "picture", "quote"], ["people", "createdAt", "links"],
      ["tags", "text", "resolution"], ["shots", "field", "links"], ["gallery", "origin", "props"], ["visuals", "status", "resolution"]] as const) {
      const key = recordKey(kind), by = kind === "replies" ? "Bob" : "Alice";
      execute(run.a, createRecord(kind, key, { ...recordExamples[kind], [objectField]: { original: true }, [listField]: [1, 2] }, by),
        setRecord(kind, key, objectField, { changed: true }, by), setRecord(kind, key, listField, [3], by));
      run.queue.flush("rev");
      agree(`opaque fields ${kind}`, "rev", [run.a, run.b], handle => {
        const record = readSharedRecords(handle, kind).find(record => record.key === key); assert.ok(record);
        return { object: record.fields[objectField], list: record.fields[listField] };
      }, { object: { changed: true }, list: [3] });
    }
  } finally { run.close(); }
});
