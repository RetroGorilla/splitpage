import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { attachNativeLocalStore } from "../../../../src/adapters/collab/native/local-store.ts";
import { encodeNativePendingEdits } from "../../../../src/adapters/collab/native/pending-edits.ts";
import { noticeCopy, noticeRange } from "./notice-harness.ts";
import { measureNoticeGrowth } from "./notice-growth.ts";
import { largeState } from "./structural.ts";

const state = largeState(), samples = 1000, warmup = 100;

function timing(enabled: boolean): number[] {
  const copy = noticeCopy(state, 2, enabled ? true : undefined);
  copy.document();
  const times: number[] = [];
  try {
    for (let index = 0; index < warmup + samples; index++) {
      const start = performance.now();
      const caret = noticeRange(copy, "B451", "narration", 60 + index);
      const result = copy.commands.typeText(caret, "x", {});
      const elapsed = performance.now() - start;
      assert.equal(result.kind, "written");
      if (index >= warmup) times.push(elapsed);
    }
    if (enabled) assert.equal(copy.pendingEdits?.data().entries.length, 1);
    return times;
  } finally { copy.close(); }
}

async function measureWithStore(enabled: boolean, stuckSize: number): Promise<{
  readonly commandMs: number;
  readonly storedBytes: number;
  readonly journalBytes: number;
}> {
  let storedBytes = 0;
  let journalBytes = 0;
  let lastJournal: Uint8Array | null = null;
  const entries = [{ generation: 1, checkpoint: true, bytes: new Uint8Array(state) }];
  const opened = await attachNativeLocalStore({
    read: async through => entries.filter(entry => through === undefined || entry.generation <= through),
    write: async entry => {
      storedBytes += entry.bytes.byteLength + (entry.journal?.byteLength ?? 0);
      if (entry.journal) { lastJournal = entry.journal; journalBytes = entry.journal.byteLength; }
      entries.push({ generation: entry.generation, checkpoint: entry.checkpoint, bytes: new Uint8Array(entry.bytes) });
    },
    readJournal: async () => lastJournal,
    writeJournal: async bytes => {
      storedBytes += bytes.byteLength;
      lastJournal = bytes;
      journalBytes = bytes.byteLength;
    },
    release: async () => {},
    persistent: async () => true
  }, { actor: "writer", sanitize: html => String(html), ...(enabled && { noticeJournal: true }) });
  assert.equal(opened.kind, "opened");
  const copy = opened.session;
  copy.document();
  if (enabled && stuckSize > 0) {
    const stuckCaret = noticeRange(copy, "B450", "narration", 0);
    assert.equal(copy.commands.typeText(stuckCaret, "s".repeat(stuckSize), {}).kind, "written");
  }
  const times: number[] = [];
  try {
    for (let index = 0; index < warmup + samples; index++) {
      const start = performance.now();
      const caret = noticeRange(copy, "B451", "narration", 60 + index);
      const result = copy.commands.typeText(caret, "x", {});
      const elapsed = performance.now() - start;
      assert.equal(result.kind, "written");
      if (index >= warmup) times.push(elapsed);
    }
    await opened.flush();
    if (enabled && stuckSize === 0 && copy.pendingEdits) {
      journalBytes = encodeNativePendingEdits(copy.pendingEdits.data()).byteLength;
    }
    return { commandMs: median(times), storedBytes, journalBytes };
  } finally {
    copy.close();
    await opened.closed;
  }
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((left, right) => left - right), middle = (sorted.length - 1) / 2;
  return ((sorted[Math.floor(middle)] ?? NaN) + (sorted[Math.ceil(middle)] ?? NaN)) / 2;
}

try {
  const runs = Array.from({ length: 5 }, (_, round) => {
    const [first, second] = [timing(round % 2 === 1), timing(round % 2 === 0)];
    const [plain, journal] = round % 2 === 0 ? [first, second] : [second, first];
    return { plain: median(plain), journal: median(journal), added: median(journal.map((value, index) => value - (plain[index] ?? NaN))) };
  });
  const result = Object.fromEntries((["plain", "journal", "added"] as const).map(key => [key, median(runs.map(run => run[key]))]));
  const growth = [measureNoticeGrowth(state, false), measureNoticeGrowth(state, true)];
  const storePlain = await measureWithStore(false, 0);
  const storeOneEntry = await measureWithStore(true, 0);
  const storeLargeStuck = await measureWithStore(true, 100_000);
  const docBytes = Y.encodeStateAsUpdate(new Y.Doc()).byteLength + state.byteLength;
  const store = {
    docBytes,
    plain: storePlain,
    oneEntry: { ...storeOneEntry, addedMs: storeOneEntry.commandMs - storePlain.commandMs },
    largeStuck: { ...storeLargeStuck, addedMs: storeLargeStuck.commandMs - storePlain.commandMs }
  };
  process.stdout.write(JSON.stringify({ runtime: process.version, arch: process.arch, samples, warmup, runs, result, growth, store }, null, 2) + "\n");
} finally { dom.window.close(); }
