import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bufferTraceOrder } from "../../test/buffer-oracles.ts";
import type { BSurfaceEvidence } from "./run.ts";

export function bSurfaceArtifacts(): Map<string, string> {
  const evidence = ["writer", "slice", "split"].map(surface => JSON.parse(readFileSync(new URL(`../../b-surfaces/${surface}.json`, import.meta.url), "utf8")) as BSurfaceEvidence);
  const lines = ["# Candidate B with M1: retained counts", "", "PASS means the existing scoped checker or complete literal forward/undo check passed. Split failures occur before those checks complete. Deliberate re-entry controls are listed separately. No timing results are reported.", "",
    "| Trace | Writer B/M1 | Page slice B/M1 | Split narration B/M1 |", "| --- | --- | --- | --- |"];
  for (const trace of bufferTraceOrder) lines.push(`| ${trace} | ${evidence.map(data => {
    const cases = data.traces.filter(item => item.trace === trace && item.mechanism === "M1");
    return cases.length ? `${cases.filter(item => item.status === "PASS").length}/${cases.length} PASS` : "Not extended after T04 failure";
  }).join(" | ")} |`);
  const writer = evidence[0]; const split = evidence[2];
  if (!writer || !split) throw new Error("Missing B evidence");
  lines.push("", "| Writer follow-up | M1 scoped result |", "| --- | --- |");
  for (const name of [...new Set(writer.followup.filter(item => !item.name.startsWith("reentry-")).map(item => item.name))]) {
    const cases = writer.followup.filter(item => item.name === name && item.mechanism === "M1");
    lines.push(`| ${name} | ${cases.filter(item => item.status === "PASS").length}/${cases.length} PASS |`);
  }
  lines.push("", "| Deliberate Writer re-entry | No early hold | Early hold | Early hold + native paint gate |", "| --- | --- | --- | --- |");
  for (const name of ["reentry-type", "reentry-replace", "reentry-paste"]) lines.push(`| ${name} | ${writer.followup.filter(item => item.name === name && item.mechanism === "M1").map(item => item.status).join(" | ")} |`);
  lines.push("", "The 72-case Writer and page matrices each include M1/M2/M3, 24 cases per mechanism. Writer follow-up includes 96 cases, 32 per mechanism; M1 has 29 scoped passes and three deliberate baseline re-entry failures. Split has five isolated M1 cases, all failing final repaint. All app results pin " + writer.appCommit + ".", "");
  const result = new Map<string, string>([["b-surfaces-counts.md", lines.join("\n")]]);
  const compact = (stage: { models: BSurfaceEvidence["traces"][number]["stages"][number]["models"]; errors: string[]; commits: string[]; dirty: boolean; composing: boolean; selection?: [number, number] | null; text?: string; [key: string]: unknown }): string => JSON.stringify({
    text: stage.text, selection: stage.selection, dirty: stage.dirty, composing: stage.composing, errors: stage.errors, commits: stage.commits,
    replicas: Object.fromEntries(Object.entries(stage.models).map(([name, model]) => [name, { rows: model.rows.map(row => [row.id, row.characters.map(character => character.value).join(""), row.characters.length < 20 ? row.characters.map(character => character.notation) : row.characters.length]), recovery: model.recovery.map(item => [item.row.id, item.row.characters.map(character => character.value).join(""), item.edited]), caret: model.carets.A }]))
  });
  const failure = ["Shows Split's final native-composition repaint failing during a focusout callback, after the M1 commit; this is a binding/reconciliation failure, not evidence of a schema or deferral failure.", "", `App ${split.appCommit}. Each case starts on a freshly navigated app; no earlier failure supplies state.`, "", "Input: paint R1 abcd and R2 ef, compose x after b, then deliver B's declared remote operations while dirty. Finish real protocol composition as xy. T04: insert Z at R1 start and delete original d. Removed: remove R1. No source fix was added after these failures.", ""];
  for (const item of split.traces) {
    failure.push(`${item.trace}/${item.order}: ${item.status}`, "", "```text");
    for (const [index, stage] of item.stages.entries()) failure.push(`stage ${index}: ${compact({ ...stage })}`);
    const last = item.stages.at(-1);
    failure.push(`FAIL: ${item.difference}`, `native event order: ${JSON.stringify(last?.events.map(event => [event.type, "phase" in event ? event.phase : null]))}`, "```", "");
  }
  result.set("histories/T04-B-split-repaint.md", failure.join("\n"));
  const differences = ["Shows the B Writer's retained mapper failure, deliberate re-entry controls, T21 mismatch and mark observations under the unchanged mechanism interface.", "", `App ${writer.appCommit}. Counts and observations only.`, ""];
  for (const item of writer.followup.filter(item => item.status === "FAIL" || ["bold", "comment-tag", "join-previous", "long"].includes(item.name))) {
    const last = item.stages.at(-1); if (!last) throw new Error("Missing follow-up stage");
    differences.push(`${item.name}/${item.mechanism}/${item.order}/retain=${item.retained}/gate=${item.paintGate}: ${item.status}${item.name === "bold" && item.mechanism === "M2" ? "; T21 MISMATCH on new xy (outside scoped checker)" : ""}`, "", "```text");
    if (item.status === "FAIL") for (const [index, stage] of item.stages.entries()) differences.push(`stage ${index}: ${compact({ ...stage })}`);
    else differences.push(compact({ ...last }));
    differences.push(`raw new marks: ${JSON.stringify(last.rawLocalMarks)}; composing DOM: ${JSON.stringify(last.remoteDOM)}; reentry: ${JSON.stringify(last.reentry)}`, ...item.failures.map(failure => `FAIL: ${failure}`), "```", "");
  }
  result.set("histories/T04-B-writer-differences.md", differences.join("\n"));
  return result;
}

export function checkBSurfaceArtifacts(): void {
  for (const [file, content] of bSurfaceArtifacts()) if (readFileSync(new URL(`../../${file}`, import.meta.url), "utf8") !== content) throw new Error(`Stale B artifact: ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) for (const [file, content] of bSurfaceArtifacts()) writeFileSync(new URL(`../../${file}`, import.meta.url), content);
  else checkBSurfaceArtifacts();
}
