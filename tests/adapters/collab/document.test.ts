import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { createSharedDocument, applySharedUpdate, encodeSharedState, encodeSharedStateVector, encodeSharedUpdate, transactSharedDocument, observeSharedTransactions, destroySharedDocument } from "../../../src/adapters/collab/document.ts";
import { hydrateSharedDocument } from "../../../src/adapters/collab/hydrate.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { assertReplicasAgree } from "../../collab/agreement.ts";
import type { ReplicaReading } from "../../collab/agreement.ts";
import { DeliveryQueue } from "../../collab/delivery.ts";
import { decodeBody } from "../../../src/adapters/richtext/decode.ts";
import { jsdomParser } from "../richtext/jsdom.mjs";
import { validatedFixture, storedValue, readRoots, deliveryReplica } from "./helpers.ts";

test("empty script hydrates all sixteen roots without inventing a beat", () => {
  const handle = createSharedDocument();
  hydrateSharedDocument(handle, validatedFixture({ title: "", rows: [] }));
  assert.deepEqual(readRoots(handle), {
    segments: {}, order: [], beats: {}, visuals: {}, gallery: {}, comments: {}, replies: {}, people: {}, tags: {}, shots: {},
    meta: { capture: { rev: 0 }, docId: "d00000000000000000000000000000000", extra: "{}", schema: 2, title: [], wordsPerMinute: 150 },
    removalRecords: {}, retiredJoins: {}, statusEvents: {}, retiredStatus: {}, headings: {}
  });
  destroySharedDocument(handle);
});

test("hydration preserves headings, paragraphs, stored characters, marks, atoms and visual components", () => {
  const source = validatedFixture({
    title: "Title", paragraphsDecided: true,
    sections: [{ id: "H1", name: "Intro", firstSceneId: "R1" }],
    rows: [{ id: "R1", audioText: '<b>A</b><br><span class="audio-cue">\u200bB</span>',
      visualText: '<span class="who-anchor" data-who="Jo">@Jo</span><span class="broll-key" data-broll-id="S1">B-roll:</span>', paragraphStart: true, status: "shot", lengthSeconds: 7 },
    { id: "R2", audioText: '<a href="https://example.test/?x=&quot;y&quot;">link</a><span class="stage-dir">D</span>', visualText: "" }]
  });
  const handle = createSharedDocument();
  hydrateSharedDocument(handle, source);
  const { roots } = collabState(handle);
  assert.deepEqual(roots.order.toArray(), ["h:H1", "b:R1", "b:R2"]);
  assert.deepEqual(storedValue(roots.segments), {
    "b:R1": { head: { b: "R1" }, text: [{ attributes: { b: true }, insert: "A" }, { insert: "\n" }, { attributes: { cue: true }, insert: "\u200bB" }] },
    "b:R2": { head: { b: "R2" }, text: [{ attributes: { "l:b:R2:audioText:1": 'https://example.test/?x="y"' }, insert: "link" }, { attributes: { dir: true }, insert: "D" }] },
    "h:H1": { head: { h: "H1" }, text: [{ insert: "Intro" }] }
  });
  assert.deepEqual(storedValue(roots.visuals.get("R1")), { beat: "R1", rank: "0000000000", text: [{ insert: { w: "Jo" } }, { insert: { k: "S1", label: "B-roll:" } }] });
  assert.deepEqual(storedValue(roots.beats.get("R1")), { extra: "{}", id: "R1", joins: {}, lengthSeconds: 7, paragraphStart: true, removals: {}, stamp: { at: "", by: null }, status: "shot" });
  assert.deepEqual(storedValue(roots.headings), { H1: { extra: "{}", id: "H1" } });
  destroySharedDocument(handle);
});

test("hydration collapses stored line-end runs exactly like the editor decoder", () => {
  for (const [html, expected] of [
    ["a\n\nb", "a b"], ["\r\n", " "], ["\n\na", " a"], ["a\r\n\r", "a "],
    ["a\n\n<br>\r\nb", "a \n b"], ["\n<br>\n", " \n "]
  ] as const) {
    const Parser: new () => DOMParser = jsdomParser();
    const decoded = decodeBody(new Parser().parseFromString(`<body>${html}</body>`, "text/html").body).map(run => run.text).join("");
    assert.equal(decoded, expected, JSON.stringify(html));
    const handle = createSharedDocument();
    hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: html, visualText: html }] }));
    for (const record of [collabState(handle).roots.segments.get("b:R1"), collabState(handle).roots.visuals.get("R1")]) {
      assert.ok(record instanceof Y.Map);
      const text: unknown = record.get("text");
      assert.ok(text instanceof Y.Text);
      assert.equal(text.toString(), expected, JSON.stringify(html));
      assert.equal(text.toString(), decoded);
    }
    destroySharedDocument(handle);
  }
});

test("hydration keeps comments, replies, tags, gallery metadata, stamps and unknown fields", () => {
  const ref = { sha256: "a".repeat(64), width: 2, height: 3, mime: "image/png" };
  const source = validatedFixture({
    title: "Records", titleOrigin: "user", titleVersion: 2, rev: 4, lastEditedBy: "Jo", lastEditedAt: "yesterday", personColors: { Jo: "#7c3aed" }, targetSeconds: 30,
    unknownField: { kept: true }, people: [{ id: "P1", name: "Jo", future: 1 }],
    productionTags: [{ id: "t_one", cat: "prop", name: "Cup", owner: "P1", notes: "notes", status: "have", future: 2 }],
    brollShots: [{ id: "S1", name: "Shot", desc: "Details", status: "unshot", props: [{ id: "t_one", name: "Cup" }], origin: "list", future: 3 }],
    rows: [{ id: "R1", audioText: '<span data-cmt="C1">words</span><span class="tag-anchor" data-tag-cat="prop" data-tag-name="Cup">Cup</span>', visualText: "Visual", imageRef: ref,
      imageName: "Picture", imageAnnotation: { imageRef: { ...ref, sha256: "b".repeat(64) }, marks: [{ kind: "text", color: "#ef4444", size: 0.1, x: 0.2, y: 0.3, text: "Note" }] },
      imageLinks: [{ href: "https://example.test/v", poster: true }, { name: "clip.mp4", size: 9, location: { kind: "path", path: "private-device-path" } }],
      moreImages: [{ imageRef: { ...ref, sha256: "c".repeat(64) }, name: "Second" }], updatedAt: "then", updatedBy: "Jo", future: 4 }],
    comments: [{ id: "C1", rowId: "R1", field: "audioText", anchorId: "C1", quotedText: "words", body: "Body", author: "Jo", createdAt: "2026-01-01", updatedAt: "2026-01-02", resolved: true, resolvedBy: "Jo", resolvedAt: "2026-01-02", assignee: "Jo", future: 5,
      replies: [{ id: "RP1", author: "Jo", body: "Reply", createdAt: "2026-01-02", future: 6 }] }]
  });
  const handle = createSharedDocument();
  hydrateSharedDocument(handle, source);
  const { roots } = collabState(handle);
  assert.deepEqual(storedValue((roots.segments.get("b:R1") as Y.Map<unknown>).get("text")), [
    { attributes: { "c:C1": true }, insert: "words" },
    { attributes: { "t:b:R1:audioText:0000000001": "t_one" }, insert: "Cup" }
  ]);
  assert.deepEqual(storedValue(roots.comments.get("C1")), { anchorId: "C1", assignee: "Jo", author: "Jo", createdAt: "2026-01-01", extra: '{"future":5}', field: "audioText", id: "C1", kind: "anchor", quote: "words", rank: "0000000000", resolution: { resolved: true, resolvedAt: "2026-01-02", resolvedBy: "Jo" }, rowId: "R1", text: "Body", updatedAt: "2026-01-02" });
  assert.deepEqual(storedValue(roots.replies), { '["C1","RP1"]': { author: "Jo", commentId: "C1", createdAt: "2026-01-02", extra: '{"future":6}', id: "RP1", rank: "0000000000", text: "Reply" } });
  assert.deepEqual(storedValue(roots.people), { P1: { extra: '{"future":1}', id: "P1", name: "Jo", rank: "0000000000" } });
  assert.deepEqual(storedValue(roots.tags.get("t_one")), { cat: "prop", extra: '{"future":2}', id: "t_one", name: "Cup", notes: "notes", owner: "P1", rank: "0000000000", status: "have" });
  assert.deepEqual(storedValue((roots.shots.get("S1") as Y.Map<unknown>).get("props")), { t_one: { rank: "0000000000", value: { id: "t_one", name: "Cup" } } });
  const slot = roots.gallery.get("R1:slot:0") as Y.Map<unknown>;
  assert.deepEqual(storedValue(slot.get("links")), { "f:clip.mp4:9": { extra: "{}", name: "clip.mp4", rank: "0000000001", size: 9 }, "u:https://example.test/v": { extra: "{}", href: "https://example.test/v", poster: true, rank: "0000000000" } });
  assert.deepEqual(storedValue((roots.gallery.get("R1:slot:1") as Y.Map<unknown>).get("picture")), { imageRef: { height: 3, mime: "image/png", sha256: "c".repeat(64), width: 2 }, name: "Second" });
  assert.equal((slot.get("picture") as { name: string }).name, "Picture");
  assert.equal(roots.meta.get("extra"), '{"unknownField":{"kept":true}}');
  assert.equal((roots.meta.get("capture") as { rev: number }).rev, 4);
  assert.equal(Buffer.from(encodeSharedState(handle)).includes(Buffer.from("private-device-path")), false);
  const clone = createSharedDocument();
  assert.deepEqual(applySharedUpdate(clone, encodeSharedState(handle)), { ok: true });
  assertReplicasAgree("records", [{ order: "D1", replica: "A", output: readRoots(handle) }, { order: "late-C", replica: "C", output: readRoots(clone) }]);
  destroySharedDocument(handle);
  destroySharedDocument(clone);
});

test("duplicated identity: hydration keeps original ids and two hydrations have equal root content", () => {
  const source = validatedFixture({ title: "Same", rows: [{ id: "R1", audioText: "Same" }, { id: "R2", audioText: "Same" }], comments: [{ id: "C1", rowId: "R1", body: "C" }] });
  const a = createSharedDocument(), b = createSharedDocument();
  hydrateSharedDocument(a, source);
  hydrateSharedDocument(b, source);
  assert.deepEqual([...collabState(a).roots.beats.keys()], ["R1", "R2"]);
  assert.deepEqual(collabState(a).roots.order.toArray(), ["b:R1", "b:R2"]);
  assertReplicasAgree("independent hydration", [{ order: "D1", replica: "A", output: readRoots(a) }, { order: "late-C", replica: "C", output: readRoots(b) }]);
  destroySharedDocument(a);
  destroySharedDocument(b);
});

test("hydration refuses a second use, loaded state, emptied history and local transactions", () => {
  const source = validatedFixture({ rows: [] });
  for (const prepare of [
    (handle: ReturnType<typeof createSharedDocument>) => hydrateSharedDocument(handle, source),
    (handle: ReturnType<typeof createSharedDocument>) => { applySharedUpdate(handle, new Uint8Array([0, 0])); },
    (handle: ReturnType<typeof createSharedDocument>) => transactSharedDocument(handle, "local-command", () => {}),
    (handle: ReturnType<typeof createSharedDocument>) => { const roots = collabState(handle).roots; roots.meta.set("x", 1); roots.meta.delete("x"); }
  ]) {
    const handle = createSharedDocument();
    prepare(handle);
    const before = encodeSharedState(handle);
    assert.throws(() => hydrateSharedDocument(handle, source), /fresh empty/);
    assert.deepEqual(encodeSharedState(handle), before);
    destroySharedDocument(handle);
  }
});

test("duplicated source identities are refused before any hydration write", () => {
  const source = validatedFixture({ rows: [{ id: "R1", audioText: "one" }] });
  source.rows.push({ id: "R1", audioText: "two" });
  const handle = createSharedDocument();
  assert.throws(() => hydrateSharedDocument(handle, source), /Duplicated/);
  assert.deepEqual(encodeSharedState(handle), new Uint8Array([0, 0]));
  source.rows.pop();
  hydrateSharedDocument(handle, source);
  assert.deepEqual(collabState(handle).roots.order.toArray(), ["b:R1"]);
  destroySharedDocument(handle);
});

test("local command, undo, hydration and received update each publish their named origin", () => {
  const a = createSharedDocument(), b = createSharedDocument();
  const origins: unknown[] = [];
  const detach = observeSharedTransactions(a, origin => origins.push(origin));
  hydrateSharedDocument(a, validatedFixture({ rows: [] }));
  transactSharedDocument(a, "local-command", () => collabState(a).roots.meta.set("x", 1));
  transactSharedDocument(a, "local-undo", () => collabState(a).roots.meta.delete("x"));
  hydrateSharedDocument(b, validatedFixture({ rows: [] }));
  assert.deepEqual(applySharedUpdate(a, encodeSharedState(b)), { ok: true });
  assert.deepEqual(origins, ["hydration", "local-command", "local-undo", "remote"]);
  detach();
  destroySharedDocument(a);
  destroySharedDocument(b);
});

test("seeded truncated and random updates are refused without changing state or publishing an event", () => {
  const handle = createSharedDocument(), writer = createSharedDocument();
  hydrateSharedDocument(handle, validatedFixture({ rows: [{ id: "R1", audioText: "retained" }] }));
  hydrateSharedDocument(writer, validatedFixture({ title: "incoming", rows: [{ id: "R2", audioText: "incoming" }] }));
  const update = encodeSharedState(writer);
  const before = encodeSharedState(handle);
  const origins: unknown[] = [];
  const detach = observeSharedTransactions(handle, origin => origins.push(origin));
  for (let length = 0; length < update.length; length++) {
    assert.deepEqual(applySharedUpdate(handle, update.slice(0, length)), { ok: false, reason: "invalid-update" }, `truncated ${length}`);
    assert.deepEqual(encodeSharedState(handle), before);
  }
  let seed = 0x5a1414;
  for (let caseNumber = 0; caseNumber < 200; caseNumber++) {
    const bytes = Uint8Array.from({ length: 1 + caseNumber % 47 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 24; });
    assert.deepEqual(applySharedUpdate(handle, bytes), { ok: false, reason: "invalid-update" }, `seeded ${caseNumber}`);
    assert.deepEqual(encodeSharedState(handle), before);
  }
  assert.deepEqual(origins, []);
  detach();
  destroySharedDocument(handle);
  destroySharedDocument(writer);
});

test("remote formatting cleanup has its own origin and releases the origin scope afterward", () => {
  const a = createSharedDocument(), b = createSharedDocument();
  hydrateSharedDocument(a, validatedFixture({ rows: [{ id: "R1", audioText: "abcd" }] }));
  assert.deepEqual(applySharedUpdate(b, encodeSharedState(a)), { ok: true });
  for (const handle of [a, b]) {
    const segment = collabState(handle).roots.segments.get("b:R1") as Y.Map<unknown>;
    const text = segment.get("text") as Y.Text;
    transactSharedDocument(handle, "local-command", () => text.format(0, 4, { b: true }));
  }
  const origins: unknown[] = [];
  const detach = observeSharedTransactions(a, origin => origins.push(origin));
  assert.deepEqual(applySharedUpdate(a, encodeSharedState(b)), { ok: true });
  assert.deepEqual(origins, ["remote", "cleanup"]);
  collabState(a).doc.transact(() => collabState(a).roots.meta.set("raw", true));
  assert.deepEqual(origins, ["remote", "cleanup", null]);
  detach();
  destroySharedDocument(a);
  destroySharedDocument(b);
});

test("zero-length decoded structs are refused in both orders without blocking pending valid dependencies", () => {
  const zeroLength = new Uint8Array([1, 1, 1, 0, 40, 1, 4, 109, 101, 116, 97, 1, 120, 0, 0]);
  const writer = new Y.Doc();
  writer.clientID = 1;
  writer.getMap("meta").set("x", 1);
  const normal = Y.encodeStateAsUpdate(writer);
  const vector = Y.encodeStateVector(writer);
  writer.getMap("meta").set("x", 2);
  const dependent = Y.encodeStateAsUpdate(writer, vector);
  for (const badFirst of [true, false]) {
    const handle = createSharedDocument();
    if (!badFirst) assert.deepEqual(applySharedUpdate(handle, normal), { ok: true });
    const before = encodeSharedState(handle);
    assert.deepEqual(applySharedUpdate(handle, zeroLength), { ok: false, reason: "invalid-update" });
    assert.deepEqual(encodeSharedState(handle), before);
    if (badFirst) assert.deepEqual(applySharedUpdate(handle, normal), { ok: true });
    assert.equal(collabState(handle).roots.meta.get("x"), 1);
    destroySharedDocument(handle);
  }
  const pending = createSharedDocument();
  assert.deepEqual(applySharedUpdate(pending, dependent), { ok: true });
  assert.equal(collabState(pending).roots.meta.get("x"), undefined);
  assert.deepEqual(applySharedUpdate(pending, normal), { ok: true });
  assert.equal(collabState(pending).roots.meta.get("x"), 2);
  destroySharedDocument(pending);
  writer.destroy();
});

test("vectors, reverse and duplicated deliveries and a late joiner agree root by root", () => {
  const readings: ReplicaReading<unknown>[] = [];
  for (const order of ["D1", "rev", "dup"] as const) {
    const a = createSharedDocument(), b = createSharedDocument(), c = createSharedDocument();
    hydrateSharedDocument(a, validatedFixture({ rows: [{ id: "R1", audioText: "base" }] }));
    assert.deepEqual(applySharedUpdate(b, encodeSharedState(a)), { ok: true });
    const vector = encodeSharedStateVector(b);
    const queue = new DeliveryQueue<Uint8Array>(update => update.slice(), update => `${update.length}`);
    queue.addReplica("A", deliveryReplica(a));
    queue.addReplica("B", deliveryReplica(b));
    transactSharedDocument(a, "local-command", () => collabState(a).roots.meta.set("alpha", 1));
    transactSharedDocument(a, "local-command", () => collabState(a).roots.meta.set("beta", 2));
    transactSharedDocument(b, "local-command", () => collabState(b).roots.people.set("P2", "malformed"));
    queue.flush(order);
    assert.deepEqual(applySharedUpdate(b, encodeSharedUpdate(a, vector)), { ok: true });
    queue.lateJoin("C", deliveryReplica(c), "A", encodeSharedState(a));
    readings.push({ order, replica: "A", output: readRoots(a) }, { order, replica: "B", output: readRoots(b) }, { order: "late-C", replica: "C", output: readRoots(c) });
    queue.destroy();
    for (const handle of [a, b, c]) destroySharedDocument(handle);
  }
  assertReplicasAgree("shared roots", readings);
});

test("seeded arbitrary shared root values have the same inspection on the writer and encoded late joiner", () => {
  let seed = 0x14145a;
  const next = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const readings: ReplicaReading<unknown>[] = [];
  const values: unknown[] = [null, true, false, 0, "", "é", "e\u0301", { z: 1, a: 2 }, [null, "missing"], { id: 7, text: [], rank: {} }, { extra: "invalid-json" }, new Array<unknown>(3)];
  for (let index = 0; index < 128; index++) {
    const a = createSharedDocument(), c = createSharedDocument();
    const { roots } = collabState(a);
    for (const root of Object.values(roots)) {
      if (root instanceof Y.Array) root.push(["dangling", "dangling"]);
      else {
        root.set("é", values[next() % values.length]);
        root.set("e\u0301", values[next() % values.length]);
      }
    }
    assert.deepEqual(applySharedUpdate(c, encodeSharedState(a)), { ok: true });
    readings.length = 0;
    readings.push({ order: "D1", replica: "A", output: readRoots(a) }, { order: "late-C", replica: "C", output: readRoots(c) });
    assertReplicasAgree(`arbitrary roots ${index}`, readings);
    destroySharedDocument(a);
    destroySharedDocument(c);
  }
});
