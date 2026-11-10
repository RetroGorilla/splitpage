import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BindingFollowupEvidence, BindingFollowupResult, BindingFollowupStage } from "./run.ts";

export function readBindingFollowupEvidence(): BindingFollowupEvidence {
  return JSON.parse(readFileSync(new URL("../../app-binding-2/evidence.json", import.meta.url), "utf8")) as BindingFollowupEvidence;
}

export function bindingFollowupHistoryFile(name: string): string {
  if (name.startsWith("reentry-")) return "T02-app-sync-reentry.md";
  if (name === "long") return "T04-app-long-composition.md";
  if (name === "bold" || name === "comment-tag") return "T04-app-remote-marks.md";
  return "T04-app-structural-composition.md";
}

function compact(stage: BindingFollowupStage): string {
  const model = stage.models["A.E"];
  return JSON.stringify({
    rows: model?.rows.map(row => ({ id: row.id, text: row.characters.map(character => character.value).join(""), identities: row.characters.length < 15 ? row.characters.map(character => character.notation) : `${row.characters.length} characters` })),
    recovery: model?.recovery.map(item => ({ id: item.row.id, text: item.row.characters.map(character => character.value).join(""), edited: item.edited })),
    localAndMarked: [...(model?.rows ?? []), ...(model?.recovery.map(item => item.row) ?? [])].flatMap(row => row.characters.filter(character => character.identity?.client === 1 || ["s2", "s3"].includes(character.notation)).map(character => ({ id: character.notation, text: character.value, beat: row.id, marks: character.marks }))),
    dom: stage.dom.map(row => ({ id: row.id, text: row.text.length < 30 ? row.text : `${row.text.slice(0, 12)}… (${row.text.length} characters)`, selection: row.selection })),
    dirty: stage.dirty, composing: stage.composing, heldBytes: stage.heldBytes, heldMessages: stage.heldMessages,
    commits: stage.commits, errors: stage.errors
  });
}

export function bindingFollowupHistories(evidence: BindingFollowupEvidence): Map<string, string> {
  const files = new Map<string, string>();
  const shows: Record<string, string> = {
    "T02-app-sync-reentry.md": "Synchronous delivery after the app's target capture requires an early native-buffer hold; paste uses the app's command boundary because it has no native beforeinput/input pair.",
    "T04-app-long-composition.md": "A 240-update composition exposes the different held queues and composition-end commit/paint costs.",
    "T04-app-remote-marks.md": "Remote formatting during composition can produce different marks on the new local identities; comment/tag projection remains unbound in the app.",
    "T04-app-structural-composition.md": "A split before the composition's painted range distinguishes immediate integration from deferral; these are invariant observations except the literal T04 removed cases."
  };
  for (const file of Object.keys(shows)) {
    const lines = [shows[file] ?? "", "", `App ${evidence.appCommit}; ${String(evidence.version.product)}; machine ${evidence.machine.host}, ${evidence.machine.cpu}, ${evidence.machine.node}.`, "",
      "Generated from retained observations. New combinations use invariant checks, not newly invented visible-script oracles.", ""];
    for (const result of evidence.results.filter(result => bindingFollowupHistoryFile(result.name) === file)) {
      lines.push(`${result.name} / ${result.mechanism} / ${result.order} / retainBeforeInput=${result.retained} / nativePaintGate=${result.paintGate}: ${result.status}`, "", "```text");
      result.stages.forEach((stage, index) => {
        lines.push(`stage ${index}: ${compact(stage)}`);
      });
      const last = result.stages.at(-1);
      if (last) {
        lines.push(`peak=${JSON.stringify(last.peak)} timings=${JSON.stringify(last.timings)} rawLocalMarks=${JSON.stringify(last.rawLocalMarks)}`,
          ...last.reentry.map(event => `re-entry ${JSON.stringify(event)}`));
      }
      lines.push(...result.failures.map(failure => `FAIL: ${failure}`), "```", "");
    }
    files.set(file, lines.join("\n"));
  }
  return files;
}

export function writeBindingFollowupArtifacts(evidence: BindingFollowupEvidence): void {
  const lines = ["{", `  "appCommit": ${JSON.stringify(evidence.appCommit)},`, `  "bundleSha256": ${JSON.stringify(evidence.bundleSha256)},`,
    `  "machine": ${JSON.stringify(evidence.machine)},`, `  "version": ${JSON.stringify(evidence.version)},`, `  "off": ${JSON.stringify(evidence.off)},`,
    '  "results": [', ...evidence.results.map((result: BindingFollowupResult, index) => `    ${JSON.stringify(result)}${index === evidence.results.length - 1 ? "" : ","}`), "  ]", "}", ""];
  writeFileSync(new URL("../../app-binding-2/evidence.json", import.meta.url), lines.join("\n"));
  for (const [file, contents] of bindingFollowupHistories(evidence)) writeFileSync(new URL(`../../histories/${file}`, import.meta.url), contents);
}

export function checkBindingFollowupHistories(evidence: BindingFollowupEvidence): void {
  for (const [file, contents] of bindingFollowupHistories(evidence)) {
    if (readFileSync(new URL(`../../histories/${file}`, import.meta.url), "utf8") !== contents) throw new Error(`Stale follow-up history ${file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidence = readBindingFollowupEvidence();
  if (process.argv.includes("--write")) writeBindingFollowupArtifacts(evidence);
  else checkBindingFollowupHistories(evidence);
}
