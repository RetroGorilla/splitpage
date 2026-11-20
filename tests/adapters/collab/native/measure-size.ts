import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { dom } from "../../../../src/test/_dom.mjs";
import { continuesSharedTypingWord } from "../../../../src/application/editing/undo/shared-undo.ts";
import { openNativeScript } from "../../../../src/adapters/collab/native/script.ts";
import type { NativeScript } from "../../../../src/adapters/collab/native/script.ts";
import { openNativeSession } from "../../../../src/adapters/collab/native/session.ts";
import { anchorNativeText, typeNativeText } from "../../../../src/adapters/collab/native/text-commands.ts";
import type { NativeEditStamp, NativeTextRange, NativeTextTarget } from "../../../../src/adapters/collab/native/text-commands.ts";
import { openNativeUndo } from "../../../../src/adapters/collab/native/undo-commands.ts";
import { createRichText } from "../../../../src/adapters/richtext/richtext.ts";
import type { Marks } from "../../../../src/core/text/runs.ts";
import { largeState } from "./structural.ts";

const ADDED_LIMIT_MS = 0.01;
const flag = (name: string, fallback: number): number => Number(process.argv.find(value => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const rounds = flag("rounds", 7), letters = flag("letters", 1000), warmup = flag("warmup", 2);

const TARGET: NativeTextTarget = Object.freeze({ beat: "B451", cell: "narration" });
const ids = { id: (prefix: string) => prefix + "-test", docId: () => "test" };
const images = { known: () => null, fromDataUrl: () => null };
const { sanitize } = createRichText({ DOMParser, images, ids });

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length / 2;
  return ((sorted[Math.floor(middle - 0.5)] ?? NaN) + (sorted[Math.ceil(middle - 0.5)] ?? NaN)) / 2;
};
const p95 = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? NaN;

interface TypingHandle {
  readonly anchorText: (target: NativeTextTarget, from: number, to?: number) => ReturnType<typeof anchorNativeText>;
  readonly typeText: (range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp) => { readonly kind: string };
  readonly close: () => void;
}

// why: mirrors the session typing path without size tracking so A/B isolates only the tracker's cost
function openUntracked(state: Uint8Array): TypingHandle {
  const doc = new Y.Doc(), script = openNativeScript(doc);
  Y.applyUpdate(doc, state);
  const undo = openNativeUndo(script);
  let active = false, scheduled = false, changed = false, closing = false;
  let typing: { readonly target: NativeTextTarget; readonly endsInSpace: boolean } | null = null;
  function publish(): void {
    scheduled = false;
    changed = false;
  }
  function schedule(): void {
    if (scheduled) return;
    queueMicrotask(publish);
    scheduled = true;
  }
  const publishUpdate = () => script.guardSharedCallback(() => {
    changed = true;
    schedule();
  });
  doc.on("update", publishUpdate);
  function refusal(): "busy" | "closed" | null {
    if (active) return "busy";
    if (closing) return "closed";
    if (!script.busy()) return null;
    schedule();
    return "busy";
  }
  function perform<T>(run: () => T): T {
    active = true;
    try { return run(); } finally { active = false; }
  }
  function bind<Args extends unknown[], Result>(command: (inner: NativeScript, ...args: Args) => Result) {
    return (...args: Args): Result => {
      const reason = refusal();
      if (reason) return command({ ...script, busy: () => reason === "busy", closed: () => reason === "closed" }, ...args);
      return perform(() => command(script, ...args));
    };
  }
  return {
    anchorText: bind(anchorNativeText),
    typeText: bind((inner, range: NativeTextRange, text: string, marks: Marks, stamp?: NativeEditStamp) =>
      typeNativeText(inner, range, text, marks, stamp, target => {
        const previous = typing?.target.beat === target.beat && typing.target.cell === target.cell ? typing : null;
        if (!previous || !continuesSharedTypingWord(previous.endsInSpace, text)) undo.stopCapturing();
        typing = { target, endsInSpace: text ? /\s$/.test(text) : previous?.endsInSpace ?? false };
      })),
    close() {
      closing = true;
      void changed;
      doc.off("update", publishUpdate);
      undo.destroy();
      script.close();
      doc.destroy();
    }
  };
}

function openTracked(state: Uint8Array): TypingHandle {
  const session = openNativeSession({ kind: "state", state }, { actor: "Alice", sanitize });
  return {
    anchorText: session.commands.anchorText,
    typeText: session.commands.typeText,
    close: () => session.close()
  };
}

function runTyping(handle: TypingHandle): { readonly medianMs: number; readonly p95Ms: number } {
  const times: number[] = [];
  for (let index = 0; index < letters; index++) {
    const ch = index % 6 === 5 ? " " : "a";
    const start = performance.now();
    const anchored = handle.anchorText(TARGET, index);
    if (anchored.kind !== "anchored") throw new Error("Failed to anchor at " + String(index));
    const outcome = handle.typeText(anchored.range, ch, {});
    const elapsed = performance.now() - start;
    if (outcome.kind !== "written") throw new Error("Failed to type at " + String(index) + ": " + outcome.kind);
    times.push(elapsed);
  }
  handle.close();
  return { medianMs: median(times), p95Ms: p95(times) };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const state = largeState();
const withoutMedians: number[] = [], withoutP95s: number[] = [];
const withMedians: number[] = [], withP95s: number[] = [];
const totalRounds = warmup + rounds;

for (let round = 0; round < totalRounds; round++) {
  const trackedFirst = round % 2 === 1;
  const first = trackedFirst ? runTyping(openTracked(state)) : runTyping(openUntracked(state));
  await flushMicrotasks();
  const second = trackedFirst ? runTyping(openUntracked(state)) : runTyping(openTracked(state));
  await flushMicrotasks();
  if (round < warmup) continue;
  const tracked = trackedFirst ? first : second;
  const untracked = trackedFirst ? second : first;
  withMedians.push(tracked.medianMs);
  withP95s.push(tracked.p95Ms);
  withoutMedians.push(untracked.medianMs);
  withoutP95s.push(untracked.p95Ms);
}

const cell = (values: number[]): string => `${median(values).toFixed(4)} [${Math.min(...values).toFixed(4)}-${Math.max(...values).toFixed(4)}]`;
const withoutMs = median(withoutMedians), withMs = median(withMedians), addedMs = withMs - withoutMs;
const within = addedMs <= ADDED_LIMIT_MS;

const lines = [
  `Node ${process.version} ${process.arch}. ${rounds} timed rounds (+ ${warmup} warmup), ${letters} letters typed into a 900-beat script.`,
  "Alternating order per round. Cells: median of per-round medians [smallest-largest].",
  "",
  `| Mode | Median ms/key | p95 ms/key | Added ms/key (limit ${ADDED_LIMIT_MS} ms) |`,
  "| --- | --- | --- | --- |",
  `| Without tracking | ${cell(withoutMedians)} | ${cell(withoutP95s)} | baseline |`,
  `| With tracking | ${cell(withMedians)} | ${cell(withP95s)} | ${addedMs >= 0 ? "+" : ""}${addedMs.toFixed(4)} (${within ? "within" : "over"}) |`
];

dom.window.close();
process.stdout.write(lines.join("\n") + "\n");
if (!within) {
  process.stderr.write(`Added median cost ${addedMs.toFixed(4)} ms exceeds ${ADDED_LIMIT_MS} ms\n`);
  process.exitCode = 1;
}
