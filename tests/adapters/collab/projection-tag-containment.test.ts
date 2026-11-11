import assert from "node:assert/strict";
import { after, test } from "node:test";
import { toHtml } from "../../../src/core/text/html.ts";
import { addComment, setMark } from "../../../src/core/text/edits.ts";
import type { Run } from "../../../src/core/text/runs.ts";
import { replicas, agree, ref } from "./executor-support.ts";
import { deliveryOrders } from "../../collab/delivery.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "../../../src/adapters/collab/mark-store.ts";
import { readProjectionUnits } from "../../../src/adapters/collab/projection-text-reader.ts";
import { collabState } from "../../../src/adapters/collab/state.ts";
import * as Y from "yjs";
import { projectSharedDocument } from "../../../src/adapters/collab/project.ts";
import { readPureMergedProjection } from "./projection-merged-support.ts";
import { projectionReferences } from "./projection-roundtrip-support.ts";
import { dom } from "../../../src/test/_dom.mjs";

after(() => { dom.window.close(); });

test("same-name corpus audit: 0 of 291 reference documents contain a doubled tag name", () => {
  const matches: { fixture: string; cell: string; tag: string }[] = [];
  assert.equal(projectionReferences.length, 291);
  for (const fixture of projectionReferences) {
    const document = fixture.document;
    const cells: { path: string; value: unknown }[] = document.rows.flatMap((row, index) => ["audioText", "visualText"].map(field => ({ path: `rows.${index}.${field}`, value: row[field] })));
    for (const [index, comment] of document.comments.entries()) {
      cells.push({ path: `comments.${index}.body`, value: comment.body });
      for (const [replyIndex, reply] of (comment.replies ?? []).entries()) cells.push({ path: `comments.${index}.replies.${replyIndex}.body`, value: reply.body });
    }
    for (const cell of cells) {
      if (typeof cell.value !== "string") continue;
      const body = globalThis.document.createElement("div"); body.innerHTML = cell.value;
      const identity = (node: Element) => {
        const cat = node.getAttribute("data-tag-cat"), name = node.getAttribute("data-tag-name");
        return document.productionTags.find(tag => tag && tag.cat === cat && tag.name === name)?.id ?? `t:${cat}:${name}`;
      };
      for (const span of body.querySelectorAll(".tag-anchor")) for (let parent = span.parentElement; parent && parent !== body; parent = parent.parentElement) {
        if (parent.classList.contains("tag-anchor") && identity(parent) === identity(span)) {
          matches.push({ fixture: fixture.name, cell: cell.path, tag: identity(span) }); break;
        }
      }
    }
  }
  assert.deepEqual(matches, []);
});

const box = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Box" contenteditable="false">';
const red = '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="Red" contenteditable="false">';

for (const field of ["audioText", "visualText"] as const) for (const sameName of [false, true])
  for (const nativeOrder of ["before", "after"] as const) for (const order of deliveryOrders)
    test(`standalone containment: ${field}, ${sameName ? "same name outer" : "Red inner"}, native ${nativeOrder}, ${order}`, () => {
      const source = sameName ? "a" + box + "bc</span>d" : box + "abcd</span>";
      const literal = sameName ? box + "abcd</span>" : box + "a" + red + "bc</span>d</span>";
      const base: Run[] = sameName ? [{ text: "a", marks: {} }, { text: "bc", marks: { tag: "t_box" } }, { text: "d", marks: {} }]
        : [{ text: "abcd", marks: { tag: "t_box" } }];
      const from = sameName ? 0 : 1, to = sameName ? 4 : 3, payload = sameName ? "t_box" : "t_red";
      const standalone = toHtml(setMark(base, from, to, "tag", payload), { tagOf: id => ({ cat: "prop", name: id === "t_box" ? "Box" : "Red" }) });
      assert.equal(standalone, sameName ? box + "a" + box + "bc</span>d</span>" : literal);
      const run = replicas(2, { rows: [{ id: "R1", [field]: source }], productionTags: [{ id: "t_box", cat: "prop", name: "Box" }, { id: "t_red", cat: "prop", name: "Red" }] });
      const address = { owner: ref("R1"), segment: ref(field === "audioText" ? "b:R1" : "R1"), field };
      try {
        const roots = collabState(run.a).roots;
        const container = field === "audioText" ? roots.segments.get("b:R1") : [...roots.visuals.values()][0]; assert.ok(container instanceof Y.Map);
        const hydrated = readProjectionUnits(run.a, container.get("text"), container.get("markRecords")).flatMap(unit => unit.marks).find(mark => mark.kind === "tag")?.id;
        assert.ok(hydrated);
        const id = ref(nativeOrder === "before" ? "0-later" : "zz-later");
        assert.equal(id < hydrated, nativeOrder === "before");
        const record = prepareSharedMarkRecord(run.a, address, "later-tag", from, to, { type: "add", mark: { kind: "tag", id, value: ref(payload) } });
        assert.ok(record); assert.deepEqual(writeSharedMarkRecord(run.a, address, "later-tag", record), { ok: true });
        assert.equal(projectSharedDocument(run.a).rows[0]?.[field], literal);
        if (order === "D2") run.queue.flush(order);
        const mirror = prepareSharedMarkRecord(run.b, address, "observed-tag", sameName ? 1 : 0, sameName ? 3 : 4,
          { type: "add", mark: { kind: "tag", id: ref(hydrated), value: ref("t_box") } });
        assert.ok(mirror); assert.deepEqual(writeSharedMarkRecord(run.b, address, "observed-tag", mirror), { ok: true });
        run.queue.flush(order);
        for (const handle of [run.a, run.b]) assert.equal(projectSharedDocument(handle).rows[0]?.[field], literal);
        agree("standalone nested tag", order, [run.a, run.b], readPureMergedProjection);
      } finally { run.close(); }
    });

for (const field of ["audioText", "visualText"] as const) for (const reverse of [false, true])
  test(`links and comments follow the standalone encoder: ${field}, reversed native ids ${reverse}`, () => {
    const plain: Run[] = [{ text: "abcd", marks: {} }];
    const comments = toHtml(addComment(addComment(plain, 0, 4, "Z"), 1, 3, "A"));
    const links = toHtml(setMark(setMark(plain, 0, 4, "href", "https://z.test"), 1, 3, "href", "https://a.test"));
    assert.equal(links, '<a href="https://z.test" target="_blank" rel="noopener">a</a><a href="https://a.test" target="_blank" rel="noopener">bc</a><a href="https://z.test" target="_blank" rel="noopener">d</a>');
    assert.equal(comments, '<span class="cmt-anchor" data-cmt="Z">a</span><span class="cmt-anchor" data-cmt="A"><span class="cmt-anchor" data-cmt="Z">bc</span></span><span class="cmt-anchor" data-cmt="Z">d</span>');
    for (const kind of ["comment", "link"] as const) {
      const run = replicas(2, { rows: [{ id: "R1", [field]: "abcd" }] });
      const address = { owner: ref("R1"), segment: ref(field === "audioText" ? "b:R1" : "R1"), field };
      try {
        for (const index of [0, 1]) {
          const inner = index === 1, id = ref(kind === "link" ? inner ? "a" : "z" : (inner !== reverse) ? "a" : "z");
          const value = kind === "link" ? inner ? "https://a.test" : "https://z.test" : inner ? "A" : "Z";
          const handle = reverse ? index ? run.a : run.b : index ? run.b : run.a;
          const record = prepareSharedMarkRecord(handle, address, "mark" + index, inner ? 1 : 0, inner ? 3 : 4, { type: "add", mark: { kind, id, value } });
          assert.ok(record); assert.deepEqual(writeSharedMarkRecord(handle, address, "mark" + index, record), { ok: true });
        }
        run.queue.flush("rev");
        for (const handle of [run.a, run.b]) assert.equal(projectSharedDocument(handle).rows[0]?.[field], kind === "link" ? links : comments);
        agree("standalone visible mark nesting", "rev", [run.a, run.b], readPureMergedProjection);
      } finally { run.close(); }
    }
  });
