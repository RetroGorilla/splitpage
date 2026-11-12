import { buildBenchmarkDocument, typeBenchmarkCharacter } from "./benchmark-document.ts";
import { measureLibraryReads } from "./library-read-counts.ts";
import { measureSharedReads } from "../../src/adapters/collab/read-counts.ts";
import { readCollabMarkState } from "../../src/adapters/collab/mark-store.ts";
import { createSharedPreparation } from "../../src/adapters/collab/prepare.ts";
import { cacheText } from "../adapters/collab/read-cache-support.ts";

const run = buildBenchmarkDocument({ beats: 300 });
try {
  const { text, store } = cacheText(run.a, "R0");
  const read = () => readCollabMarkState(run.a, text, store);
  const cold = measureLibraryReads(run.a, "R0", () => measureSharedReads(read));
  const warm = measureLibraryReads(run.a, "R0", () => measureSharedReads(read));
  const preparation = createSharedPreparation(run.a);
  preparation.view.text(["segments", "b:R0", "text"]); preparation.close();
  const typed = measureLibraryReads(run.a, "R0", () => measureSharedReads(() => typeBenchmarkCharacter(run.a, "R0", 2, "z", "measured-type")));
  const refreshed = measureLibraryReads(run.a, "R0", () => measureSharedReads(read));
  const summarize = (value: typeof cold) => ({ library: value.totals, unrelated: value.unrelated, rules: value.result.counts });
  console.log(JSON.stringify({ beats: 300, commands: run.commands, cold: summarize(cold), warm: summarize(warm),
    typed: { library: typed.totals, unrelated: typed.unrelated, rules: typed.result.counts }, refreshed: summarize(refreshed) }));
} finally { run.close(); }
