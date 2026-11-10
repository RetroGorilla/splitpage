import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { fromDocument, toDocument } from "../../src/proj/document.ts";
import { records } from "../../src/proj/value.ts";
import { mapValue, textValue } from "../../src/schema.ts";
import { IncrementalProjection } from "../../src/perf/incremental.ts";
import { capturePerfBeat, perfStructureView, resolvePerfIdentity, splitPerfBeat, writePerfStatus } from "../../src/perf/operations.ts";

const source = {
  title: "Perf", rows: [
    { id: "R1", audioText: '<span class="cmt-anchor" data-cmt="C1">abcd</span>', visualText: "one", status: "todo", lengthSeconds: 12 },
    { id: "R2", audioText: "efgh", visualText: "two", status: "ready" },
    { id: "R3", audioText: "ijkl", visualText: "", status: "todo" }
  ],
  sections: [{ id: "H1", name: "Scene", firstSceneId: "R1" }],
  comments: [{ id: "C1", anchorId: "C1", rowId: "R1", field: "audioText", author: "writer", body: "note", replies: [] }],
  people: [], productionTags: [], brollShots: []
};

function random(seed: number): () => number {
  let value = seed;
  return () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 2 ** 32; };
}

for (const candidate of ["A", "B"] as const) {
  for (const collection of ["visuals", "gallery"] as const) test(`${candidate}: ${collection} ownership transfer invalidates old and new beats`, () => {
    const replica = fromDocument({ ...source, rows: [
      { id: "R1", audioText: "ab", visualText: "one", status: "todo", imageName: "photo" },
      { id: "R2", audioText: "cd", visualText: "two", status: "ready" },
      { id: "R3", audioText: "ef", visualText: "", status: "todo" }
    ], comments: [], sections: [] }, candidate);
    if (collection === "gallery") replica.doc.getMap("gallery").delete("R2:slot:0");
    const projection = new IncrementalProjection(replica);
    const untouched = records(projection.document.rows)[2];
    try {
      const id = collection === "visuals" ? "visual-R1" : "R1:slot:0";
      mapValue(replica.doc.getMap(collection).get(id)).set("beat", "R2");
      const expected = collection === "visuals" ? [
        { id: "R1", audioText: "ab", visualText: "", status: "todo", imageName: "photo" },
        { id: "R2", audioText: "cd", visualText: "one<br>two", status: "ready" },
        { id: "R3", audioText: "ef", visualText: "", status: "todo" }
      ] : [
        { id: "R1", audioText: "ab", visualText: "one", status: "todo" },
        { id: "R2", audioText: "cd", visualText: "two", status: "ready", imageName: "photo" },
        { id: "R3", audioText: "ef", visualText: "", status: "todo" }
      ];
      assert.deepEqual(projection.document.rows, expected);
      assert.deepEqual(projection.document, toDocument(replica.doc, candidate));
      assert.deepEqual(projection.lastProjected, ["R1", "R2"]);
      assert.equal(records(projection.document.rows)[2], untouched);
    } finally { projection.destroy(); replica.destroy(); }
  });

  for (const seed of [1376, 0x51a, 0xdecafbad]) test(`${candidate}: incremental equals full after every transaction, literal seed ${seed}`, () => {
    const replica = fromDocument(source, candidate, 1);
    const remote = fromDocument(source, candidate, 1);
    remote.doc.clientID = 2;
    const projection = new IncrementalProjection(replica);
    const next = random(seed);
    try {
      for (let step = 0; step < 240; step++) {
        const rows = records(projection.document.rows);
        const id = String(rows[Math.floor(next() * rows.length)]?.id);
        const location = remote.locate(id);
        const length = location.end - location.start;
        const offset = Math.floor(next() * (length + 1));
        const before = new Map(rows.map(row => [String(row.id), row]));
        const sv = Y.encodeStateVector(remote.doc);
        const op = Math.floor(next() * 11);
        remote.doc.transact(() => {
          if (op === 0 && rows.length < 20) splitPerfBeat(remote, id, offset, `S${step}`);
          else if (op === 1 && length) location.text.delete(location.start + Math.min(offset, length - 1), 1);
          else if (op === 2 && length) location.text.format(location.start, length, { b: step % 2 === 0 ? true : null });
          else if (op === 3) mapValue(remote.doc.getMap("beats").get(id)).set("lengthSeconds", step);
          else if (op === 4) mapValue(remote.doc.getMap("comments").get("C1")).set("text", `body ${step}`);
          else if (op === 5) textValue(mapValue(remote.doc.getMap("visuals").get("visual-R1")).get("text")).insert(0, "v", {});
          else if (op === 6) remote.join("R2", "R1", `J${step}`);
          else if (op === 7) remote.remove(id, `D${step}`, "writer", []);
          else if (op === 8) writePerfStatus(remote, id, `status${step}`, "shot");
          else if (op === 9) location.text.format(location.start, length, { "c:C1": step % 2 ? true : null });
          else location.text.insert(location.start + offset, step % 2 ? "x" : "β", {});
        });
        const update = Y.encodeStateAsUpdate(remote.doc, sv);
        Y.applyUpdate(replica.doc, update);
        Y.applyUpdate(replica.doc, update);
        const full = toDocument(replica.doc, candidate);
        assert.deepEqual(projection.document, full, `seed ${seed}, step ${step}, operation ${op}`);
        for (const row of records(full.rows)) {
          const old = before.get(String(row.id));
          if (old && JSON.stringify(old) === JSON.stringify(row)) assert.equal(records(projection.document.rows).find(value => value.id === row.id), old);
        }
      }
    } finally { projection.destroy(); replica.destroy(); remote.destroy(); }
  });

  test(`${candidate}: literal identities survive splits, joins and soft restore; deleted identity is refused`, () => {
    const replica = fromDocument(source, candidate);
    const projection = new IncrementalProjection(replica);
    try {
      const base = capturePerfBeat(projection.index, "R2");
      assert.equal(base.length, 4);
      assert.deepEqual(resolvePerfIdentity(projection.index, base[2] as Y.RelativePosition), { beat: "R2", offset: 2 });
      splitPerfBeat(replica, "R2", 2, "R4");
      assert.deepEqual(resolvePerfIdentity(projection.index, base[2] as Y.RelativePosition), { beat: "R4", offset: 0 });
      replica.join("R4", "R2", "J1");
      assert.equal(perfStructureView(replica, projection.document).groups.find(group => group.id === "R2")?.narration, "ef gh");
      replica.remove("R4", "D1", "writer", []);
      assert.deepEqual(perfStructureView(replica, projection.document).recovery, ["R4"]);
      replica.restore("R4", "D1");
      assert.deepEqual(perfStructureView(replica, projection.document).recovery, []);
      const location = replica.locate("R4");
      location.text.delete(location.start, 1);
      assert.equal(resolvePerfIdentity(projection.index, base[2] as Y.RelativePosition), null);
      assert.deepEqual(projection.document, toDocument(replica.doc, candidate));
    } finally { projection.destroy(); replica.destroy(); }
  });

  test(`${candidate}: reverse and duplicate updates project only changed beats and preserve an earlier snapshot`, () => {
    const replica = fromDocument(source, candidate, 10);
    const remote = fromDocument(source, candidate, 10);
    remote.doc.clientID = 2;
    const projection = new IncrementalProjection(replica);
    const original = projection.document;
    const unchanged = records(original.rows)[2];
    const updates: Uint8Array[] = [];
    remote.doc.on("update", update => { updates.push(update); });
    try {
      const target = remote.locate("R2");
      target.text.insert(target.start + 1, "X", {});
      target.text.format(target.start, 2, { b: true });
      target.text.delete(target.start + 3, 1);
      for (const index of [2, 0, 1, 1, 2]) {
        Y.applyUpdate(replica.doc, updates[index] as Uint8Array);
        assert.deepEqual(projection.document, toDocument(replica.doc, candidate));
        assert.equal(records(projection.document.rows)[2], unchanged);
      }
      assert.equal(records(projection.document.rows)[1]?.audioText, "<strong>eX</strong>fh");
      assert.equal(records(original.rows)[1]?.audioText, "efgh");
      assert.deepEqual(projection.lastProjected, ["R2"]);
    } finally { projection.destroy(); replica.destroy(); remote.destroy(); }
  });

  test(`${candidate}: a burst coalesces to one projection only inside an explicit receiving transaction`, () => {
    const remote = fromDocument(source, candidate, 10);
    remote.doc.clientID = 2;
    const updates: Uint8Array[] = [];
    remote.doc.on("update", update => { updates.push(update); });
    const location = remote.locate("R2");
    for (let index = 0; index < 100; index++) location.text.insert(location.start, "X", {});
    for (const batched of [false, true]) {
      const replica = fromDocument(source, candidate, 10);
      const projection = new IncrementalProjection(replica);
      try {
        const receive = (): void => { for (const update of updates) Y.applyUpdate(replica.doc, update); };
        if (batched) replica.doc.transact(receive);
        else receive();
        assert.equal(projection.commits, batched ? 1 : 100);
        assert.equal(records(projection.document.rows)[1]?.audioText, "X".repeat(100) + "efgh");
        assert.deepEqual(projection.document, toDocument(replica.doc, candidate));
      } finally { projection.destroy(); replica.destroy(); }
    }
    remote.destroy();
  });

  test(`${candidate}: one-character projection consumes events without rereading narration streams`, () => {
    const replica = fromDocument(source, candidate);
    const projection = new IncrementalProjection(replica);
    const texts = candidate === "A" ? [replica.doc.getText("flow")]
      : [...replica.doc.getMap("segments").values()].map(value => textValue(mapValue(value).get("text")));
    const originals = texts.map(text => ({ text, read: text.toDelta }));
    let scans = 0;
    for (const { text, read } of originals) text.toDelta = (...args): unknown[] => { scans++; return read.call(text, ...args) as unknown[]; };
    try {
      const untouched = records(projection.document.rows)[0];
      const span = projection.index.locate("R2");
      span.text.insert(span.start + 1, "X", {});
      assert.equal(scans, 0);
      assert.deepEqual(projection.lastProjected, ["R2"]);
      assert.equal(records(projection.document.rows)[0], untouched);
      assert.equal(records(projection.document.rows)[1]?.audioText, "eXfgh");
    } finally {
      for (const { text, read } of originals) text.toDelta = read;
      projection.destroy(); replica.destroy();
    }
  });
}
