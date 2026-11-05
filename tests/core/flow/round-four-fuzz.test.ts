import { test } from "node:test";
import assert from "node:assert/strict";
import { flowCommand } from "../../../src/application/commands/flow.ts";
import { beatPos, caretAt, headingPos, insertBeats, joinWithPrevious, renameHeading, replaceRange } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowRow } from "../../../src/core/flow/flow.ts";
import { rowSlots } from "../../../src/core/document/gallery.ts";
import type { DocumentScene } from "../../../src/core/document/scenes.ts";
import { slotPoster } from "../../../src/features/common/gallery.ts";
import { harness, runConfined } from "../../application/session-fakes.ts";
import { createFlowLoadRuntime, expectedHeadingWhitespaceOnReload } from "./load.ts";

const stamps = { clock: { nowIso: () => "2026-11-04T12:00:00Z" }, editor: { name: () => "Editor" } };
const image = { sha256: "a".repeat(64), width: 1, height: 1, mime: "image/png" };
function edited(out: FlowOutcome): FlowEdit {
  assert.ok(out && "rows" in out, JSON.stringify(out));
  return out;
}

test("named reload normalization: only heading edge whitespace is trimmed on the expected side", () => {
  const rt = createFlowLoadRuntime();
  const doc = rt.load({ rows: [{ id: "a", audioText: "Body" }], sections: [{ id: "s", name: "Title", firstSceneId: "a" }] });
  const padded = { ...doc, sections: [{ id: "s", name: " \tTitle\u00a0 ", firstSceneId: "a" }] };
  const expected = { ...doc, sections: [{ id: "s", name: "Title", firstSceneId: "a" }] };
  assert.deepEqual(expectedHeadingWhitespaceOnReload(padded), expected);
  assert.deepEqual(rt.load(padded), expected);
  assert.equal(padded.sections[0]?.name, " \tTitle\u00a0 ");
});

test("R4 property 1: 60 shrink-pad-blank rename sequences retain later edits and exact reloads", t => {
  const started = performance.now();
  const rt = createFlowLoadRuntime();
  for (let seed = 1; seed <= 60; seed++) {
    const h = harness(undefined, { entry: rt.load });
    h.session.adopt({ rows: [{ id: "p", audioText: "Previous" }, { id: "a", audioText: "Body" }], sections: [{ id: "s", name: "Initial " + seed, firstSceneId: "a" }] });
    let expectedName = "Initial " + seed;
    let selection = caretAt(headingPos("s", expectedName.length));
    const steps = [{ rename: "T" + seed }, { text: "X" }, { rename: "  Pad " + seed + "  " }, { text: "Y" },
      { rename: ["", "   ", "\t\n", "\u00a0"][seed % 4] as string }, { text: "Z" }, { rename: "S" }, { text: " W" }];
    try {
      for (const step of steps) {
        const before = JSON.stringify(h.session.held());
        const blank = "rename" in step && !step.rename?.trim();
        const out = runConfined(h.session, flowCommand("rename-sequence", doc => {
          const result = "rename" in step ? renameHeading(doc, "s", step.rename as string, (step.rename as string).length)
            : replaceRange(doc, selection, [{ text: step.text as string, marks: {} }], rt.ports);
          if (result && "rows" in result) selection = result.selection;
          return result;
        }, stamps));
        if (blank) {
          assert.equal(out.kind, "noop", "blank rename seed=" + seed);
          assert.equal(JSON.stringify(h.session.held()), before, "blank rename wrote seed=" + seed);
        } else {
          assert.equal(out.kind, "applied", "rename seed=" + seed);
          expectedName = "rename" in step ? step.rename as string : expectedName + step.text;
        }
        const live = h.session.held() as FlowDoc;
        assert.equal((live.sections as DocumentScene[])[0]?.name, expectedName, "name seed=" + seed);
        assert.equal(selection.head.offset, expectedName.length, "selection seed=" + seed);
        assert.deepEqual(rt.load(live), expectedHeadingWhitespaceOnReload(live), "reload seed=" + seed);
        assert.equal(live.rows[1]?.paragraphStart, undefined, "paragraph seed=" + seed);
      }
    } finally { h.session.dispose(); }
  }
  t.diagnostic("480 rename/edit transactions and reloads in " + (performance.now() - started).toFixed(0) + " ms; seeds 1..60");
});

test("R4 property 2: 120 gallery joins preserve duplicate-link posters by identity and honest notices", t => {
  const rt = createFlowLoadRuntime();
  const covered = new Set<string>();
  for (let seed = 1; seed <= 120; seed++) {
    const mode = (seed - 1) % 6, count = 1 + Math.floor((seed - 1) / 6);
    covered.add(mode + ":" + count);
    const same = mode < 4;
    const secondHref = "https://example.com/" + (same ? mode === 3 ? 1 : 0 : count);
    const firstPoster = mode !== 1 && mode !== 4;
    const secondPoster = mode !== 0;
    const links = Array.from({ length: count }, (_, i) => ({ href: "https://example.com/" + i, ...(i === 0 && firstPoster ? { poster: true } : {}) }));
    const second = { href: secondHref, ...(secondPoster ? { poster: true } : {}) };
    const doc = rt.load({ rows: [{ id: "a", imageRef: image, imageLinks: links }, { id: "b", imageRef: image, imageLinks: [second] }] });
    const out = edited(joinWithPrevious(doc, "b", rt.ports));
    const slot = rowSlots(out.rows[0])[0];
    assert.ok(slot, "gallery seed=" + seed);
    const ids = [...new Set(links.concat([second]).map(link => link.href))].slice(0, 20);
    const posters = new Set(links.concat([second]).filter(link => link.poster).map(link => link.href));
    const expectedPosters = ids.some(id => posters.has(id)) ? 1 : 0;
    assert.equal(slot.links.filter(link => link.poster).length, expectedPosters, "poster seed=" + seed);
    assert.equal(!!slotPoster(slot), expectedPosters > 0, "slotPoster seed=" + seed);
    assert.equal(slotPoster(slot)?.href ?? null, ids.find(id => posters.has(id)) ?? null, "poster identity seed=" + seed);
    if (posters.size <= 1 || expectedPosters === 0) assert.doesNotMatch(out.notice ?? "", /Kept one poster/, "notice seed=" + seed);
    else assert.match(out.notice ?? "", /Kept one poster/, "notice seed=" + seed);
    assert.deepEqual(slot.links.map(link => link.href), ids, "link ids seed=" + seed);
    const live = { ...doc, rows: out.rows, sections: out.sections };
    assert.deepEqual(rowSlots(rt.load(live).rows[0]), rowSlots(out.rows[0]), "gallery reload seed=" + seed);
  }
  assert.equal(covered.size, 120, "all six poster modes must cover link counts 1..20");
  t.diagnostic("120 gallery identity/poster cases; seeds 1..120");
});

test("R4 property 3: 120 supplied-row flag combinations persist only literal true through session reload", t => {
  const rt = createFlowLoadRuntime();
  const values: unknown[] = [false, true, 0, 1, "true", "false", null, {}, [], undefined];
  for (let seed = 1; seed <= 120; seed++) {
    const value = values[seed % values.length], other = values[(seed + 3) % values.length];
    const h = harness(undefined, { entry: rt.load });
    h.session.adopt({ rows: [{ id: "a", audioText: "Body" }] });
    const supplied = [{ id: "x", audioText: "New", paragraphStart: value }, { id: "y", audioText: "Tail", paragraphStart: value },
      { id: "z", audioText: "Last", paragraphStart: other }] as unknown as FlowRow[];
    try {
      const offset = seed % 2 ? 2 : 0;
      assert.equal(runConfined(h.session, flowCommand("flag-fuzz", doc => insertBeats(doc, beatPos("a", offset), supplied, rt.ports), stamps)).kind, "applied");
      const live = h.session.held() as FlowDoc;
      const byId = new Map(live.rows.map(row => [row.id, row]));
      assert.equal(byId.get("x")?.paragraphStart, offset === 0 ? true : undefined, "first boundary seed=" + seed);
      assert.equal(byId.get("y")?.paragraphStart, value === true ? true : undefined, "later flag seed=" + seed);
      assert.equal(byId.get("z")?.paragraphStart, other === true ? true : undefined, "last flag seed=" + seed);
      assert.deepEqual(rt.load(live), live, "flag reload seed=" + seed);
    } finally { h.session.dispose(); }
  }
  t.diagnostic("120 inserted-row flag cases; seeds 1..120");
});
