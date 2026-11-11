import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { ScratchReplica } from "./designs.ts";
import type { ScratchDesign } from "./designs.ts";
import { scratchExampleMark } from "./events.ts";

function measure(design: ScratchDesign, count: number, mix: boolean) {
  const replica = new ScratchReplica(design, 0x1234abcd, "abcdefgh"), mark = scratchExampleMark("i");
  try {
    for (let index = 0; index < count; index++) {
      const id = "m" + index;
      if (!mix || index % 3 === 0) replica.execute({ id, kind: "add", from: 0, to: 8, mark });
      else if (index % 3 === 1) replica.execute({ id, kind: "remove", from: 1, to: 7, mark });
      else {
        replica.execute({ id, kind: "insert", from: 4, to: 4, text: "X", mode: "plain" });
        replica.execute({ id: id + "-delete", kind: "delete", from: 5, to: 6 });
      }
    }
    for (let warm = 0; warm < 5; warm++) replica.read();
    const samples: number[] = [];
    let checksum = 0;
    for (let sample = 0; sample < 15; sample++) {
      const start = performance.now();
      for (let repeat = 0; repeat < 5; repeat++) checksum += replica.read().reduce((sum, char) => sum + char.marks.length, 0);
      samples.push((performance.now() - start) / 5);
    }
    samples.sort((a, b) => a - b);
    return { design, count, mix, encodedBytes: replica.state().length, storedRecords: design === "records" ? replica.events.size : 0, writtenEvents: replica.writtenKeys.size,
      liveEventKeys: new Set(replica.contributions().map(item => item.key)).size, utf16Length: replica.text.length,
      medianReadMs: samples[7], p95ReadMs: samples[14], checksum, formatItems: replica.formatItems };
  } finally { replica.destroy(); }
}

const results = [];
for (const design of ["attributes", "records"] as const) for (const mix of [false, true]) for (const count of [10, 100, 1000]) {
  const result = measure(design, count, mix); results.push(result); process.stdout.write(JSON.stringify(result) + "\n");
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ node: process.version, client: 0x1234abcd, samples: 15, repetitionsPerSample: 5, warmups: 5, results }, null, 2) + "\n");
