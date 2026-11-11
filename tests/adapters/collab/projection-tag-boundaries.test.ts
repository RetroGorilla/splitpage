import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { toHtml } from "../../../src/core/text/html.ts";
import { setMark } from "../../../src/core/text/edits.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { replicas, agree, ref } from "./executor-support.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { readPureMergedProjection } from "./projection-merged-support.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import { transactSharedDocument } from "../../../src/adapters/collab/document.ts";

const box = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">';
const red = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Red" contenteditable="false">';
const tags = [{ id: "t_box", cat: "prop", name: "Box" }, { id: "t_red", cat: "prop", name: "Red" }];
const tagOf = (id: string) => ({ cat: "prop", name: id === "t_box" ? "Box" : "Red" });
const atoms: readonly { run: Run; html: string }[] = [
  { run: { atom: "who", name: "Ada", text: "@Ada", marks: {} }, html: '<span class="who-anchor" data-who="Ada" contenteditable="false">@Ada</span>' },
  { run: { atom: "broll", id: "S1", text: "B-roll:", marks: {} }, html: '<span class="broll-key" data-broll-id="S1" contenteditable="false">B-roll:</span>' },
  { run: { atom: "image", ref: { sha256: "a".repeat(64) }, text: "", marks: {} }, html: '<img class="comment-img" data-blob="' + "a".repeat(64) + '">' },
  { run: { atom: "video", href: "https://example.test/video", host: "example.test", text: "", marks: {} },
    html: '<a class="video-embed-card" href="https://example.test/video" target="_blank" rel="noopener"><span class="vec-play">▶</span><span>Watch video</span><span class="vec-host">· example.test</span></a>' }
];
for (const atom of atoms) for (const field of ["audioText", "visualText"] as const) for (const reversed of [false, true])
  for (const writer of [0, 1]) for (const order of deliveryOrders)
    test(`tag wrappers split at ${atom.run.atom}: ${field}, reversed=${reversed}, writer=${writer}, ${order}`, () => {
      const plain: Run[] = [{ text: "a", marks: {} }, atom.run, { text: "bc", marks: {} }];
      const standalone = toHtml(setMark(setMark(plain, 0, 3, "tag", "t_box"), 2, 4, "tag", "t_red"), { tagOf });
      const literal = box + "a</span>" + atom.html + red + box + "b</span>c</span>";
      assert.equal(standalone, literal);
      const run = replicas(2, { rows: [{ id: "R1", [field]: "abc" }], productionTags: tags });
      const handles = [run.a, run.b], address = { owner: ref("R1"), segment: ref(field === "audioText" ? "b:R1" : "R1"), field };
      try {
        transactSharedDocument(run.a, "local-command", () => {
          const roots = collabState(run.a).roots, container = field === "audioText" ? roots.segments.get("b:R1") : roots.visuals.get("R1");
          assert.ok(container instanceof Y.Map); const text = container.get("text"); assert.ok(text instanceof Y.Text);
          const value = atom.run;
          const wire = value.atom === "who" ? { w: value.name } : value.atom === "broll" ? { k: value.id, label: value.text }
            : value.atom === "image" ? { img: value.ref } : value.atom === "video" ? { video: value.href, host: value.host } : null;
          assert.ok(wire); text.insertEmbed(1, wire);
        });
        run.queue.flush("D1");
        for (const [index, payload] of ["t_box", "t_red"].entries()) {
          const handle = handles[(writer + index) % 2]; assert.ok(handle);
          const record = prepareSharedMarkRecord(handle, address, "tag" + index, index ? 2 : 0, index ? 4 : 3,
            { type: "add", mark: { kind: "tag", id: ref(index !== Number(reversed) ? "a" : "z"), value: ref(payload) } });
          assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, address, "tag" + index, record), { ok: true });
          if (order === "D2") run.queue.flush(order);
        }
        run.queue.flush(order);
        for (const handle of handles) {
          const actual = readPureMergedProjection(handle);
          assert.equal(actual.view.document.rows?.[0]?.[field], standalone); assert.deepEqual(actual.view.recovery, []);
        }
        agree("atom closes tag occurrence", order, handles, readPureMergedProjection);
      } finally { run.close(); }
    });

for (const field of ["audioText", "visualText"] as const) for (const copies of [2, 3]) for (const reversed of [false, true])
  for (const order of deliveryOrders) test(`united name uses its smallest contributing identity: ${field}, ${copies} copies, reversed=${reversed}, ${order}`, () => {
    const run = replicas(copies, { rows: [{ id: "R1", [field]: "abcdef" }], productionTags: tags });
    const handles = [run.a, run.b, ...(copies === 3 ? [run.c] : [])];
    const address = { owner: ref("R1"), segment: ref(field === "audioText" ? "b:R1" : "R1"), field };
    try {
      for (const [index, [from, to, payload, identity]] of [[0, 3, "t_box", reversed ? "a" : "z"], [3, 6, "t_box", reversed ? "z" : "a"], [0, 6, "t_red", "m"]].entries()) {
        const handle = handles[index % copies]; assert.ok(handle && typeof from === "number" && typeof to === "number" && typeof payload === "string" && typeof identity === "string");
        const record = prepareSharedMarkRecord(handle, address, "part" + index, from, to, { type: "add", mark: { kind: "tag", id: ref(identity), value: ref(payload) } });
        assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, address, "part" + index, record), { ok: true });
      }
      run.queue.flush(order);
      for (const handle of handles) {
        const actual = readPureMergedProjection(handle);
        assert.equal(actual.view.document.rows?.[0]?.[field], box + red + "abcdef</span></span>"); assert.deepEqual(actual.view.recovery, []);
      }
      agree("united native identity", order, handles, readPureMergedProjection);
    } finally { run.close(); }
  });

const checks: readonly { name: string; source: string; plain: readonly Run[]; boxParts: readonly (readonly [number, number])[];
  from: number; to: number; html: string; rejection: readonly unknown[] }[] = [
  { name: "a real crossing after an atom still recovers", source: atoms[0]?.html + "abcd",
    plain: [{ atom: "who", name: "Ada", text: "@Ada", marks: {} }, { text: "abcd", marks: {} }], boxParts: [[1, 4]], from: 3, to: 5,
    html: atoms[0]?.html + box + "abc</span>d", rejection: [{ kind: "crossing-tag", occurrence: "m", tag: "t_red", from: 3, to: 5, words: "cd", rowId: "R1" }] },
  { name: "line feeds stay inside the tag wrapper", source: "a<br>bc", plain: [{ text: "a\nbc", marks: {} }], boxParts: [[0, 3]], from: 2, to: 4,
    html: box + "a<br>b</span>c", rejection: [{ kind: "crossing-tag", occurrence: "m", tag: "t_red", from: 2, to: 4, words: "bc", rowId: "R1" }] },
  { name: "an untagged gap closes the occurrence", source: "axbc", plain: [{ text: "axbc", marks: {} }], boxParts: [[0, 1], [2, 3]], from: 2, to: 4,
    html: box + "a</span>x" + red + box + "b</span>c</span>", rejection: [] },
  { name: "formatting inside a tag does not close it", source: "a<strong>b</strong>cd",
    plain: [{ text: "a", marks: {} }, { text: "b", marks: { b: true } }, { text: "cd", marks: {} }], boxParts: [[0, 3]], from: 2, to: 4,
    html: box + "a<strong>b</strong>c</span>d", rejection: [{ kind: "crossing-tag", occurrence: "m", tag: "t_red", from: 2, to: 4, words: "cd", rowId: "R1" }] }
];
for (const scenario of checks) for (const field of ["audioText", "visualText"] as const) for (const order of deliveryOrders)
  test(`tag extent boundary: ${scenario.name}, ${field}, ${order}`, () => {
    let standalone = [...scenario.plain];
    for (const [from, to] of scenario.boxParts) standalone = setMark(standalone, from, to, "tag", "t_box");
    standalone = setMark(standalone, scenario.from, scenario.to, "tag", "t_red");
    assert.equal(toHtml(standalone, { tagOf }), scenario.html);
    const run = replicas(2, { rows: [{ id: "R1", [field]: scenario.source }], productionTags: tags });
    const address = { owner: ref("R1"), segment: ref(field === "audioText" ? "b:R1" : "R1"), field };
    try {
      for (const [index, [from, to]] of [...scenario.boxParts, [scenario.from, scenario.to] as const].entries()) {
        const isRed = index === scenario.boxParts.length, handle = isRed ? run.b : run.a;
        const record = prepareSharedMarkRecord(handle, address, "range" + index, from, to,
          { type: "add", mark: { kind: "tag", id: ref(isRed ? "m" : "z"), value: ref(isRed ? "t_red" : "t_box") } });
        assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, address, "range" + index, record), { ok: true });
      }
      run.queue.flush(order);
      for (const handle of [run.a, run.b]) {
        const actual = readPureMergedProjection(handle);
        assert.equal(actual.view.document.rows?.[0]?.[field], scenario.html);
        assert.deepEqual(actual.view.recovery, scenario.rejection.map(entry => ({ ...entry as object, field })));
      }
      agree(scenario.name, order, [run.a, run.b], readPureMergedProjection);
    } finally { run.close(); }
  });
