import { readFileSync, writeFileSync } from "node:fs";
import { ScratchHistory } from "./driver.ts";
import type { ScratchCommand } from "./designs.ts";

interface Intent { writer: number; command: ScratchCommand; selected: string[]; before: string | null; after: string | null; position?: number }
const trace = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as Intent[];
const initial = process.argv[4] ?? "abcdefghijklmnopqrstuvwxyz0123456789", order = process.argv[5] === "D1" ? "D1" : "D3";
const direction = process.argv[6] ?? "any";
let trials = 0;
function replay(keep: ReadonlySet<number>) {
  trials++;
  const history = new ScratchHistory("attributes", order, 2, initial); history.checkLocal = false;
  try {
    for (const [step, intent] of trace.entries()) {
      history.prepare(intent.writer);
      if (!keep.has(step)) continue;
      const characters = history.model.characters(history.known[intent.writer] ?? new Set());
      let from: number, to: number;
      if (intent.command.kind === "insert") {
        from = intent.after === null ? characters.length : characters.findIndex(char => char.id === intent.after);
        if (from < 0) return null;
        to = from;
      } else {
        const offsets = characters.map((char, index) => intent.selected.includes(char.id) ? index : -1).filter(index => index >= 0);
        if (!offsets.length) continue;
        from = offsets[0] ?? 0; to = (offsets.at(-1) ?? 0) + 1;
      }
      history.execute(intent.writer, { ...intent.command, from, to }, intent.position);
    }
    history.flush();
    const actual = history.replicas[0]?.readNamed(history.book), expected = history.expected(0);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return null;
    if (!actual || actual.length !== expected.length || expected.some((char, index) => char.id !== actual[index]?.id || char.value !== actual[index]?.value)) return null;
    if (direction === "extra" && !actual.some((char, index) => char.marks.some(mark => !expected[index]?.marks.some(other => JSON.stringify(other) === JSON.stringify(mark))))) return null;
    if (direction === "missing" && !expected.some((char, index) => char.marks.some(mark => !actual[index]?.marks.some(other => JSON.stringify(other) === JSON.stringify(mark))))) return null;
    return { actual, expected, commands: history.commands, disagreements: expected.filter((char, index) => JSON.stringify(char) !== JSON.stringify(actual?.[index])) };
  } catch { return null; }
  finally { history.destroy(); }
}

let keep = new Set(trace.map((_, index) => index));
if (!replay(keep)) throw new Error("Original trace is not a final-state violation");
let granularity = 2;
while (keep.size > 1) {
  const indices = [...keep], size = Math.ceil(indices.length / granularity);
  let reduced = false;
  for (let start = 0; start < indices.length; start += size) {
    const omit = new Set(indices.slice(start, start + size)), candidate = new Set(indices.filter(index => !omit.has(index)));
    if (replay(candidate)) { keep = candidate; reduced = true; granularity = Math.max(2, granularity - 1); break; }
  }
  if (!reduced) { if (granularity >= keep.size) break; granularity = Math.min(keep.size, granularity * 2); }
}
const result = { trials, kept: [...keep], trace: trace.filter((_, index) => keep.has(index)), result: replay(keep) };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + "\n");
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
