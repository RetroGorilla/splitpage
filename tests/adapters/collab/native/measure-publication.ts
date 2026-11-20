import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import "../../../../src/test/_dom.mjs";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { createSharedSession } from "../../../../src/application/session/shared-session.ts";
import { createSessionCapabilities } from "../../../../src/application/session/capabilities.ts";
import { nativePublication } from "../../../../src/bootstrap/wiring/native-shared-session.ts";
import { sanitizeHtml } from "../../../../src/bootstrap/richtext.ts";
import { enterSharedDocument } from "../../../../src/core/migrate.ts";
import { fakeClock } from "../../../application/session-fakes.ts";
import { largeState, LARGE_BEATS } from "./structural.ts";

const state = largeState();
const beat = "B451", warmup = 50, count = 1000;
const allowed = () => ({ allowed: true as const }), noop = () => {};

async function measure(before: boolean, batch: number): Promise<void> {
  const native = openNativeSession({ kind: "state", state }, { actor: "Writer", sanitize: sanitizeHtml });
  const publication = nativePublication();
  const app = createSharedSession({
    replica: publication.replica, entry: enterSharedDocument, undo: { record: noop },
    effects: { dirty: noop, draft: noop, save: noop, refresh: noop },
    timers: fakeClock(), capability: createSessionCapabilities("shared", { edit: allowed, comment: allowed }),
    report: error => { throw error; }
  });
  publication.publish(native.document(), "hydration");
  assert.equal(app.read(doc => doc?.rows.length), LARGE_BEATS);
  let latest: readonly unknown[] = [];
  app.subscribe(change => { latest = change.changes.cells; });
  const times = { total: [] as number[], staleCheck: [] as number[], command: [] as number[], snapshot: [] as number[], appDiff: [] as number[], caret: [] as number[] };
  let snapshot = 0, diff = 0;
  function publish(): void {
    const start = performance.now(), projected = native.document(), read = performance.now();
    publication.publish(projected, "remote");
    snapshot = read - start;
    diff = performance.now() - read;
  }
  const stop = native.subscribe(event => { if (before && event.kind === "changed") publish(); });
  try {
    let projected = "n".repeat(120);
    for (let sample = 0; sample < warmup + count; sample += batch) {
      let keys = "";
      const start = performance.now();
      const shown = app.read(doc => doc?.rows.find(row => row.id === beat)?.audioText);
      const current = before ? native.document().rows.find(row => row.id === beat)?.audioText : native.narrationHtml(beat);
      const checked = performance.now();
      if (shown !== current) throw new Error("Expected matching paint");
      const offset = 60 + sample, target = native.narrationCaret(beat, offset);
      if (!target) throw new Error("Expected visible caret");
      const at = native.commands.anchorText({ beat: target.beat, cell: "narration" }, target.offset);
      if (at.kind !== "anchored") throw new Error(at.reason);
      for (let key = 0; key < batch; key++) keys += "x";
      const result = native.commands.typeText(at.range, keys, {}, { by: "Writer", at: new Date(sample * 1000).toISOString() });
      const written = performance.now();
      let caret = 0;
      if (before) await Promise.resolve();
      else {
        publish();
        const started = performance.now(), placed = native.narrationOffset(beat, at.range);
        caret = performance.now() - started;
        assert.equal(placed, offset + batch);
        await Promise.resolve();
      }
      if (sample >= warmup) {
        times.staleCheck.push((checked - start) / batch);
        times.command.push((written - checked) / batch);
        times.snapshot.push(snapshot / batch);
        times.appDiff.push(diff / batch);
        times.caret.push(caret / batch);
        times.total.push((written - start + snapshot + diff + caret) / batch);
      }
      projected = projected.slice(0, offset) + keys + projected.slice(offset);
      assert.equal(result.kind, "written");
      assert.equal(app.read(doc => doc?.rows.find(row => row.id === beat)?.audioText), projected);
      assert.deepEqual(new Set(latest.map(change => JSON.stringify(change))), new Set([
        '{"rowId":"B451","field":"audioText"}', '{"rowId":"B451","field":"updatedAt"}'
      ]));
    }
    console.log(`${before ? "Before" : "Buffered"}, ${batch} key(s) per write, ${count} keys after ${warmup} warm-up keys.`);
    for (const [label, values] of Object.entries(times)) {
      assert.equal(values.length, count / batch);
      values.sort((a, b) => a - b);
      const middle = values.length / 2, median = ((values[middle - 1] ?? NaN) + (values[middle] ?? NaN)) / 2;
      console.log(`  ${label}: median ${median.toFixed(3)} ms per key`);
    }
  } finally {
    stop();
    app.dispose();
    native.close();
  }
}

console.log(`Node ${process.version} ${process.arch}, ${LARGE_BEATS} beats. DOM paint and buffer wait excluded.`);
await measure(true, 1);
await measure(false, 1);
await measure(false, 10);
