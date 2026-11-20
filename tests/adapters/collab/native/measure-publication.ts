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

const native = openNativeSession({ kind: "state", state: largeState() }, { actor: "Writer", sanitize: sanitizeHtml });
const publication = nativePublication(), allowed = () => ({ allowed: true as const }), noop = () => {};
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
const elapsed: number[] = [], reads: number[] = [], diffs: number[] = [], staleChecks: number[] = [];
const stop = native.subscribe(event => {
  if (event.kind !== "changed") return;
  const start = performance.now(), snapshot = native.document(), read = performance.now();
  publication.publish(snapshot, "remote");
  const end = performance.now();
  reads.push(read - start);
  diffs.push(end - read);
  elapsed.push(end - start);
});
try {
  const warmup = 10, count = 100;
  for (let sample = 0; sample < warmup + count; sample++) {
    const checking = performance.now();
    const checkedRow = native.document().rows.find(row => row.id === "B451");
    staleChecks.push(performance.now() - checking);
    assert.ok(checkedRow);
    const at = native.commands.anchorText({ beat: "B451", cell: "narration" }, 60);
    if (at.kind !== "anchored") throw new Error(at.reason);
    const stamp = { by: "Writer", at: new Date(sample * 1000).toISOString() };
    assert.equal(native.commands.typeText(at.range, "x", {}, stamp).kind, "written");
    await Promise.resolve();
    if (sample >= warmup) assert.deepEqual(new Set(latest.map(change => JSON.stringify(change))), new Set([
      '{"rowId":"B451","field":"audioText"}', '{"rowId":"B451","field":"updatedAt"}'
    ]));
  }
  console.log(`Node ${process.version} ${process.arch}, ${LARGE_BEATS} beats, ${count} samples after ${warmup} warmups. DOM paint excluded.`);
  for (const [label, values] of [["Snapshot + publication", elapsed], ["Snapshot", reads], ["Publication and app diff", diffs],
    ["Pre-write stale check snapshot and row lookup", staleChecks]] as const) {
    assert.equal(values.length, warmup + count);
    const timed = values.slice(warmup).sort((a, b) => a - b);
    const median = ((timed[49] ?? NaN) + (timed[50] ?? NaN)) / 2, p95 = timed[94] ?? NaN;
    console.log(`${label}: median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`);
  }
} finally {
  stop();
  app.dispose();
  native.close();
}
