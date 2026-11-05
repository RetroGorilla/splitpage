import { test } from "node:test";
import assert from "node:assert/strict";
import { beatPos, caretAt, finalizeHeading, inlineMarkdown } from "../../../src/core/flow/flow.ts";
import type { FlowDoc, FlowPorts } from "../../../src/core/flow/flow.ts";
import { createRichText } from "../../../src/adapters/richtext/richtext.ts";
import { createImageIngestion } from "../../../src/core/document/media.ts";
import { projection } from "../../../src/core/text/runs.ts";
import { jsdomParser } from "../../adapters/richtext/jsdom.mjs";
import { countingIds } from "../migrate-ports.ts";

const rich = createRichText({ DOMParser: jsdomParser(), images: createImageIngestion(() => null), ids: countingIds() });
const cells = (html: string | null | undefined) => rich.decode(html ?? "");
const ports: FlowPorts = { cells, newId: () => "new", hasVisual: row => !!row.visualText };
const tag = (text: string) => '<span class="tag-anchor" data-tag-cat="prop" data-tag-name="' + text + '" contenteditable="false">' + text + "</span>";

test("every heading finalization route refuses protected heading content and preserves its beat and marks", () => {
  for (const html of [tag("Camera"), '<span class="cmt-anchor" data-cmt="c">Title</span>']) {
    for (const enter of [null, 7]) {
      for (const reverse of [false, true]) {
        const anchor = beatPos("a", 4), head = beatPos("b", 2);
        const keep = enter === null ? reverse ? { anchor: head, head: anchor } : { anchor, head } : null;
        const doc: FlowDoc = { rows: [{ id: "a", audioText: "# " + html, visualText: "" }, { id: "b", audioText: "Body", paragraphStart: true }], comments: [{ id: "c", rowId: "a", anchorId: "c", field: "audioText" }] };
        const before = JSON.stringify(doc);
        const out = finalizeHeading(doc, "a", enter, keep, ports);
        assert.ok(out && "rows" in out);
        assert.equal(out.notice, "A scene header can't hold tags or comments.");
        assert.deepEqual(out.rows.map(row => row.id), ["a", "b"]);
        assert.deepEqual(cells(out.rows[0]?.audioText), cells(html));
        assert.deepEqual(out.removedComments, []);
        assert.equal(out.sections, undefined);
        if (keep) {
          const mapped = beatPos("a", 2);
          assert.deepEqual(out.selection, reverse ? { anchor: head, head: mapped } : { anchor: mapped, head });
        }
        assert.equal(JSON.stringify(doc), before);
      }
    }
  }
});

test("ordinary inline formatting in a heading is discarded while protected later narration stays intact", () => {
  const tail = tag("Camera") + '<span class="cmt-anchor" data-cmt="c">Later</span>';
  const doc: FlowDoc = { rows: [{ id: "a", audioText: "# <strong>Title</strong><br>" + tail }], comments: [{ id: "c", rowId: "a" }] };
  const out = finalizeHeading(doc, "a", null, caretAt(beatPos("a", 9)), ports);
  assert.ok(out && "rows" in out);
  assert.equal(out.sections?.[0]?.name, "Title");
  assert.deepEqual(cells(out.rows[0]?.audioText), cells(tail));
  assert.deepEqual(out.removedComments, []);
});

test("inline Markdown cannot borrow delimiters from tags or span a tag boundary", () => {
  for (const marker of ["*", "**", "~~"]) {
    for (const html of [tag(marker + "Camera") + marker, marker + tag("Camera" + marker), marker + "left " + tag("Camera") + " right" + marker]) {
      const cell = cells(html);
      const before = JSON.stringify(cell);
      assert.equal(inlineMarkdown(cell, projection(cell).length), null, html);
      assert.equal(JSON.stringify(cell), before);
    }
    const cell = cells(tag("Camera") + " " + marker + "word" + marker);
    const out = inlineMarkdown(cell, projection(cell).length);
    assert.ok(out);
    assert.equal(projection(out.cell), "Camera word");
    assert.deepEqual(out.cell[0], cell[0]);
    const adjacent = cells(tag("Camera" + marker) + marker + "word" + marker);
    const converted = inlineMarkdown(adjacent, projection(adjacent).length);
    assert.ok(converted, "an adjacent tag must not participate in delimiters");
    assert.equal(projection(converted.cell), "Camera" + marker + "word");
    assert.deepEqual(converted.cell[0], adjacent[0]);
  }
});
