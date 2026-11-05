import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, caretAt, enterInHeading, finalizeHeading, headingPos, inlineMarkdown } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowEdit, FlowOutcome, FlowPorts, FlowRow } from "../../../src/core/flow/flow.ts";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { projection } from "../../../src/core/text/runs.ts";
import { jsdomParser } from "../../adapters/richtext/jsdom.mjs";
import { countingIds } from "../migrate-ports.ts";

const rich = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(() => null), ids: countingIds() });
const cells = (html: string | null | undefined) => rich.decode(html ?? "", { media: true });
const row = (id: string, audioText: string, extra: Partial<FlowRow> = {}): FlowRow => ({ id, audioText, visualText: "", ...extra });
const doc = (rows: readonly FlowRow[], sections?: unknown): FlowDoc => ({ rows, sections, comments: [] });
function ports(): FlowPorts {
  let next = 0;
  return { cells, newId: () => "new" + ++next, hasVisual: beat => !!beat.visualText || !!beat.imageRef };
}
function edit(out: FlowOutcome): FlowEdit {
  assert.ok(out && "rows" in out, JSON.stringify(out));
  return out;
}

test("a converted beat without a visual goes away even at the script end or before another scene", () => {
  for (const rows of [[row("a", "# Title")], [row("a", "# Title"), row("b", "Next")]]) {
    const original = doc(rows, rows.length > 1 ? [{ id: "s", name: "Next scene", firstSceneId: "b" }] : undefined);
    const before = JSON.stringify(original);
    const out = edit(finalizeHeading(original, "a", 7, null, ports()));
    assert.ok(!out.rows.some(beat => beat.id === "a"));
    assert.equal(out.rows[0]?.audioText, "");
    assert.equal(out.sections?.[0]?.name, "Title");
    assert.equal(out.sections?.[0]?.firstSceneId, out.rows[0]?.id);
    assert.deepEqual(out.selection, caretAt(beatPos(out.rows[0]?.id ?? "", 0)));
    assert.equal(JSON.stringify(original), before);
  }
});

test("heading conversion retains visual metadata and later Shift+Enter narration", () => {
  const original = doc([row("a", "# Title<br>Later", { visualText: "Desk", status: "shot", imageRef: "pic" }), row("b", "Body")]);
  const out = edit(finalizeHeading(original, "a", null, caretAt(beatPos("b", 2)), ports()));
  assert.equal(out.sections?.[0]?.name, "Title");
  assert.deepEqual(out.rows[0], row("a", "Later", { visualText: "Desk", status: "shot", imageRef: "pic" }));
  assert.deepEqual(out.selection, caretAt(beatPos("b", 2)));
});

test("leaving a pending heading remaps either direction of a selection in its surviving narration", () => {
  for (const reverse of [false, true]) {
    const anchor = beatPos("a", 10), head = beatPos("b", 2);
    const keep = reverse ? { anchor: head, head: anchor } : { anchor, head };
    const out = edit(finalizeHeading(doc([row("a", "# Title<br>Later"), row("b", "Body")]), "a", null, keep, ports()));
    assert.equal(out.rows[0]?.audioText, "Later");
    const remapped = beatPos("a", 2);
    assert.deepEqual(out.selection, reverse ? { anchor: head, head: remapped } : { anchor: remapped, head });
  }
});

test("refused pending headings keep every word and adjust selections after removing only the marker", () => {
  for (const text of ["# Heading", "# " + "x".repeat(201)]) {
    const original = doc([row("a", text), row("b", "Body", { paragraphStart: text.length > 200 })]);
    const out = edit(finalizeHeading(original, "a", null, caretAt(beatPos("a", 4)), ports()));
    assert.equal(out.rows[0]?.audioText, text.slice(2));
    assert.deepEqual(out.selection, caretAt(beatPos("a", 2)));
    assert.equal(out.notice, text.length > 200
      ? "A scene name can be up to 200 characters, so this stays as narration."
      : "A scene header can't hold several beats. Press Enter after the header's words.");
    assert.equal(out.rows[1]?.audioText, "Body");
  }
});

test("Enter at the first heading or a later heading adds a blank last beat to the scene above", () => {
  for (const above of [[], [row("above", "Earlier")]]) {
    const original = doc([...above, row("a", "Body", { visualText: "Desk" })], [{ id: "s", name: "Title", firstSceneId: "a" }]);
    const out = edit(enterInHeading(original, headingPos("s", 0), ports()));
    assert.deepEqual(out.rows.map(beat => beat.id), [...above.map(beat => beat.id), "new1", "a"]);
    assert.equal(out.rows[above.length]?.audioText, "");
    assert.equal(out.rows[above.length]?.paragraphStart, undefined);
    assert.deepEqual(out.sections, original.sections);
    assert.deepEqual(out.rows[out.rows.length - 1], original.rows[original.rows.length - 1]);
  }
});

test("seeded inline Markdown retains outside text and formatting over fragmented runs", () => {
  for (let seed = 1; seed <= 200; seed++) {
    for (const [marker, mark] of [["**", "b"], ["*", "i"], ["~~", "s"]] as const) {
      const prefix = "Before " + seed + " ", word = "word" + seed;
      const input = prefix + marker + word + marker + " after";
      const cell = Array.from(input, (text, index) => ({ text, marks: index % 2 ? { u: true as const } : {} }));
      const out = inlineMarkdown(cell, prefix.length + word.length + marker.length * 2);
      assert.ok(out, "seed=" + seed + " marker=" + marker);
      assert.equal(projection(out.cell), prefix + word + " after");
      assert.equal(out.caret, prefix.length + word.length);
      const marked = out.cell.filter(run => run.marks[mark]).map(run => run.text).join("");
      assert.equal(marked, word);
      assert.equal(projection(cell), input);
    }
  }
});
