import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as Y from "yjs";
import { openLink } from "./link.ts";
import { openCopy, openRelay, until } from "./relay.ts";
import { silentReconnect } from "./silent.ts";
import { measureFirstTrip, pairs, runPair } from "./pairs.ts";

async function fullUpload(source: string, rate: number, serverSeconds: number, attempts: number, down: number, providerSeconds: number) {
  const doc = new Y.Doc();
  const mb = Number(source);
  if (Number.isFinite(mb)) doc.getText("upload").insert(0, "x".repeat(Math.round(mb * 1e6)));
  else Y.applyUpdate(doc, await readFile(source));
  const encoded = Y.encodeStateAsUpdate(doc);
  const accepted: { at: number; bytes: number }[] = [];
  let observed: Y.Doc | undefined;
  const relay = await openRelay({ timeout: serverSeconds * 1_000,
    async onChange({ document, update }) { observed = document; accepted.push({ at: performance.now(), bytes: update.length }); }
  });
  try {
    const link = await openLink(relay.address.port, rate, down);
    try {
      const writer = openCopy(link.url, 2, { messageReconnectTimeout: providerSeconds * 1_000 }, doc);
      try {
        const start = performance.now();
        writer.connect();
        await until(() => accepted.length && writer.provider.synced && !writer.provider.hasUnsyncedChanges ||
          writer.closeEvents.length >= attempts, "full state applied and acknowledged or disconnect limit", 330_000);
        if (observed) assert.deepEqual(Y.encodeStateAsUpdate(observed), encoded);
        const elapsed = (at: number) => Number(((at - start) / 1_000).toFixed(3));
        return { adapter: process.env.SPLITPAGE_E13_WS === "1" ? "ws" : "crossws", bytes: encoded.length, rate, down,
          serverSeconds, providerSeconds, seconds: elapsed(performance.now()), applied: accepted.map(event => elapsed(event.at)),
          acknowledged: Boolean(observed && !writer.provider.hasUnsyncedChanges), wire: link.bytes,
          closes: writer.closeEvents.map(event => [elapsed(event.at), event.code]) };
      } finally { writer.close(); }
    } finally { await link.close(); }
  } finally { await relay.destroy(); doc.destroy(); }
}

const [mode, first, rate, timeout, attempts, download, watchdog] = process.argv.slice(2);
if (mode === "silent") console.log(JSON.stringify(await silentReconnect(first ? Number(first) * 1_000 : undefined)));
else if (mode === "pairs") {
  for (const scenario of pairs) {
    const baseline = await runPair(scenario, "ordered");
    let different = 0, wrappedDifferent = 0;
    let example = baseline.current.marks;
    for (let index = 0; index < 5; index++) {
      const stock = await runPair(scenario, "queued");
      const wrapped = await runPair(scenario, "wrapped");
      assert.deepEqual(stock.current.content, baseline.current.content, scenario.label);
      assert.deepEqual(wrapped.current.content, baseline.current.content, scenario.label);
      if (JSON.stringify(stock.current) !== JSON.stringify(baseline.current)) { different++; example = stock.current.marks; }
      if (JSON.stringify(wrapped.current) !== JSON.stringify(baseline.current)) wrappedDifferent++;
    }
    console.log(JSON.stringify({ pair: scenario.label, different, wrappedDifferent, want: baseline.current.marks, stock: example }));
    assert.equal(wrappedDifferent, 0, scenario.label);
  }
} else if (mode === "wrapper") {
  const scenario = pairs[0];
  assert(scenario);
  const baseline = await runPair(scenario, "ordered");
  for (const schedule of ["queued", "queue-only", "early", "wrapped", "wrapped-early"] as const) {
    let different = 0;
    const bytes: number[] = [];
    const frames: number[][][] = [];
    for (let index = 0; index < 5; index++) {
      const result = await runPair(scenario, schedule);
      if (JSON.stringify(result.current) !== JSON.stringify(baseline.current)) different++;
      bytes.push(result.upload);
      frames.push(result.frames);
    }
    console.log(JSON.stringify({ schedule, different, total: 5, bytes, frames }));
  }
  for (const schedule of ["early", "wrapped-early"] as const) {
    const cuts = [];
    for (let index = 0; index < 5; index++) cuts.push(await measureFirstTrip(schedule, 25));
    console.log(JSON.stringify({ schedule, firstTripMs: cuts.map(cut => cut.latency), bytes: cuts.map(cut => cut.upload), frames: cuts[0]?.frames }));
  }
} else if (mode === "ranges") {
  const base = pairs[3];
  assert(base);
  for (let from = 0; from < 4; from++) for (let to = from + 1; to <= 4; to++) {
    if (from === 0 && to === 4) continue;
    const scenario: typeof base = { ...base, prep: [target => target.mark(from, to, { b: true })],
      marks: [...base.text].map((_, index) => index >= from && index < to ? "b" : "") };
    const ordered = await runPair(scenario, "ordered"), stock = await runPair(scenario, "queued");
    console.log(JSON.stringify({ from, to, want: ordered.current.marks, stock: stock.current.marks }));
  }
} else if (mode === "full-upload") {
  assert(first && rate, "Pass a fixture path or MB count and an upload rate");
  console.log(JSON.stringify(await fullUpload(first, Number(rate), Number(timeout ?? 60), Number(attempts ?? 1),
    download === "uncapped" ? Infinity : Number(download ?? rate), Number(watchdog ?? 180))));
} else assert.fail("Use pairs, wrapper, ranges, silent [provider seconds], or full-upload <state.yjs|MB> <rate> [server seconds] [attempts] [download rate|uncapped] [provider seconds]");
