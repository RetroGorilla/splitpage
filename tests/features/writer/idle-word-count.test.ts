import "../../../src/test/_dom.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { startWriter } from "../../../src/features/writer/writer.ts";
import type { FlowWriter } from "../../../src/features/writer/ports.ts";
import { migrateRows } from "../../../src/core/migrate.ts";
import { fakeMigration } from "../../core/migrate-ports.ts";
import { fakeWriterPorts } from "../fakes.ts";

test("flow selection and input callbacks count only the selection until the idle refresh", () => {
  document.documentElement.innerHTML = readFileSync(new URL("../../../src/page.html", import.meta.url), "utf8");
  const h = fakeWriterPorts(migrateRows({ rows: Array.from({ length: 900 }, (_, i) => ({ id: "r" + i, audioText: "Alpha bravo" })) }, fakeMigration().ports));
  let reads = 0;
  let selected: string | null = null;
  let selectionMoved = () => {};
  const noop = () => {};
  const flow: FlowWriter = {
    find: { visuals: () => false, setVisuals: noop, search: () => ({ matches: [], inTags: 0 }), reveal: () => null,
      replace: () => false, leave: noop, selection: () => null, pickedText: () => "", firstFrom: () => 0 },
    openVisual: noop, isCurrent: () => true, finish: () => null, repaint: noop, caret: noop, format: noop,
    marks: () => ({}), beforeReplay: noop, afterReplay: noop, comment: noop, jumpComment: noop,
    selection: () => null, selectedText: () => selected, place: noop, check: () => [], dispose: noop
  };
  const writer = startWriter({ ...h.ports,
    text: { ...h.ports.text, productionReaders: { ...h.ports.text.productionReaders, wordCount: html => {
      reads++;
      return String(html).trim().split(/\s+/).length;
    } } },
    flow: { prepareSplit: noop, splitReady: () => true, create: (_root, moved) => { selectionMoved = moved; return flow; } }
  });
  try {
    writer.openWriter();
    assert.equal(document.getElementById("wr-words")?.textContent, "1,800");
    const wordChanges = new window.MutationObserver(() => {});
    wordChanges.observe(document.getElementById("wr-words") as HTMLElement, { childList: true });
    reads = 0;
    selectionMoved();
    assert.equal(reads, 0, "a collapsed input selection must not scan document narration");
    selected = "One selected word";
    selectionMoved();
    assert.equal(reads, 1, "only the selected text is counted synchronously");
    assert.equal(document.getElementById("wr-words")?.textContent, "3");
    assert.equal(wordChanges.takeRecords().length, 0, "a changed count must not replace text children and invalidate body selectors");
    selected = null;
    selectionMoved();
    assert.equal(reads, 1);
    assert.equal(document.getElementById("wr-words")?.textContent, "1,800");
    assert.equal(wordChanges.takeRecords().length, 0);
    wordChanges.disconnect();
    writer.scheduleWriterStats();
    assert.ok(h.calls.some(call => call[0] === "schedule" && call[1] === "writerStats"));
    writer.updateWriterStats();
    assert.ok(reads >= 901, "the scheduled refresh recounts document totals");
  } finally { writer.dispose(); }
});
