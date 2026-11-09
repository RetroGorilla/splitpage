import "./_dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { fromHtml } from "../bootstrap/richtext.ts";
import { insertText, marksAt } from "../core/text/edits.ts";
import { toHtml } from "../core/text/html.ts";
import { projection, tagIds, tagStack } from "../core/text/runs.ts";

test("controlled typing at depths zero, one, three and four retains bounded paths and linear stored growth", t => {
  const categories = ["sound", "location", "prop", "gear"];
  const typed = "rain falls gently while we carry the umbrella through town";
  const depths = [0, 1, 3, 4];
  const samples = new Map(depths.map(depth => [depth, []]));
  for (let round = -1; round < 5; round++) {
    for (const depth of depths) {
      let html = "umbrella";
      for (let i = depth - 1; i >= 0; i--) html = `<span class="tag-anchor" data-tag-cat="${categories[i]}" data-tag-name="Layer ${i}" contenteditable="false">${html}</span>`;
      const initial = html.length;
      let pos = 3;
      for (const ch of typed) {
        const start = performance.now();
        const cell = fromHtml(html);
        const edited = insertText(cell, pos, ch, marksAt(cell, pos));
        html = toHtml(edited);
        const decoded = fromHtml(html);
        const elapsed = performance.now() - start;
        if (round >= 0) samples.get(depth).push(elapsed);
        pos++;
        assert.equal(tagIds(decoded).length, depth);
        assert.ok(decoded.every(run => tagStack(run.marks).length === depth));
        assert.equal(projection(decoded), "umb" + typed.slice(0, pos - 3) + "rella");
        assert.equal(html.length, initial + pos - 3);
      }
    }
  }
  for (const depth of depths) {
    const times = samples.get(depth).sort((a, b) => a - b);
    const quantile = p => times[Math.ceil(times.length * p) - 1].toFixed(3);
    t.diagnostic(`depth ${depth}: ${times.length} keys, p50 ${quantile(0.5)} ms, p95 ${quantile(0.95)} ms (decode, insert, encode, decode)`);
  }
});
