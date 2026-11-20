import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import "../../../../src/test/_dom.mjs";
import { applyNativePeerUpdate } from "../../../../src/adapters/collab/native/peer-update.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { sanitizeHtml } from "../../../../src/bootstrap/richtext.ts";
import { cells } from "./helpers.ts";
import { structureScript } from "./structure-harness.ts";

const options = { actor: "Writer", sanitize: sanitizeHtml };
const target = { beat: "A", cell: "narration" } as const, other = { ...target, beat: "B" };

function type(session: ReturnType<typeof openNativeSession>, cell: typeof target | typeof other, offset: number, text: string): void {
  const at = session.commands.anchorText(cell, offset);
  assert.ok(at.kind === "anchored");
  assert.equal(session.commands.typeText(at.range, text, {}).kind, "written");
}

function median(samples: number[]): string {
  return (samples.sort((a, b) => a - b)[2] ?? NaN).toFixed(2);
}

for (const [characters, writes] of [[500, 100], [2000, 400], [5000, 1000]] as const) {
  const document = structureScript({ A: "a", B: "b" });
  const native = openNativeSession({ kind: "document", document, conversion: { cells, creation: document.docId, at: "2026-11-20", by: "Writer" } }, options);
  const samples = { capture: [] as number[], peer: [] as number[], control: [] as number[] };
  try {
    const perWrite = characters / writes;
    for (let i = 0; i < writes; i++) type(native, target, (i * 7919) % (1 + i * perWrite), "b".repeat(perWrite));
    const peer = openNativeSession({ kind: "state", state: native.encodeState() }, options);
    try {
      for (let i = 0; i < 5; i++) {
        const paint = native.trackNarrationPaint("A");
        const start = performance.now();
        native.ydoc.transact(() => {}, "peer");
        samples.capture.push(performance.now() - start);
        paint.dispose();

        for (const key of ["control", "peer"] as const) {
          type(peer, other, 0, "x");
          const bytes = Y.encodeStateAsUpdate(peer.ydoc, Y.encodeStateVector(native.ydoc));
          const tracked = key === "peer" ? native.trackNarrationPaint("A") : null;
          const received = performance.now();
          const applied = applyNativePeerUpdate(native, bytes);
          samples[key].push(performance.now() - received);
          tracked?.dispose();
          assert.equal(applied, true);
        }
      }
      assert.equal(native.narrationHtml("A")?.length, characters + 1);
      assert.equal(native.narrationHtml("B"), "x".repeat(10) + "b");
      console.log(`${characters} added chars / ${writes} writes, median ms: capture ${median(samples.capture)}, other-beat update with capture ${median(samples.peer)}, without ${median(samples.control)}`);
    } finally { peer.close(); }
  } finally { native.close(); }
}
