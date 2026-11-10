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
        lines.push(`peak=${JSON.stringify(last.peak)} timings=${JSON.stringify(last.timings)} actualPaints=${JSON.stringify(last.paints)} rawLocalMarks=${JSON.stringify(last.rawLocalMarks)} remoteDOM=${JSON.stringify(last.remoteDOM)}`,
          ...last.reentry.map(event => `re-entry ${JSON.stringify(event)}`));
      }
      lines.push(...result.failures.map(failure => `FAIL: ${failure}`), "```", "");
    }
    files.set(file, lines.join("\n"));
  }
  return files;
}

export function bindingFollowupMeasurements(evidence: BindingFollowupEvidence): string {
  const lines = ["# Real Writer follow-up measurements", "", `App ${evidence.appCommit}; bundle ${evidence.bundleSha256}.`, "",
    `Machine: ${evidence.machine.host}; ${evidence.machine.cpu.trim()}; ${evidence.machine.platform} ${evidence.machine.release}; ${evidence.machine.node}; ${String(evidence.version.product)}.`, "",
    "PASS denotes the declared invariants, or the complete unchanged T04 removed literal oracle. New combined visible scripts and marks are observations, not product oracles. Comment/tag DOM projection is unbound.", "",
    "| Case | M1 | M2 | M3 |", "| --- | --- | --- | --- |"];
  const names = [...new Set(evidence.results.filter(result => !result.name.startsWith("reentry-")).map(result => result.name))];
  for (const name of names) {
    const cells = ["M1", "M2", "M3"].map(mechanism => {
      const results = evidence.results.filter(result => result.name === name && result.mechanism === mechanism);
      return `${results.filter(result => result.status === "PASS").length}/${results.length} PASS`;
    });
    lines.push(`| ${name} | ${cells.join(" | ")} |`);
  }
  lines.push("", "| Native gesture / intervention | M1 | M2 | M3 |", "| --- | --- | --- | --- |");
  for (const name of ["reentry-type", "reentry-replace", "reentry-paste"]) for (const [retained, gate] of [[false, false], [true, false], [true, true]] as const) {
    const cells = ["M1", "M2", "M3"].map(mechanism => evidence.results.find(result => result.name === name && result.mechanism === mechanism && result.retained === retained && result.paintGate === gate)?.status ?? "MISSING");
    lines.push(`| ${name} / ${!retained ? "no early hold" : gate ? "early hold + native DOM gate" : "early hold only"} | ${cells.join(" | ")} |`);
  }
  lines.push("", "## Composition-end timings", "",
    "Each run holds composition across 240 declared B updates: 160 inserts and 80 deletes across R1/R2. Commit includes buffer planning, Yjs transaction, held-update drain and session projection. Paint is the first actual flow-surface.paint DOM reconciliation after that commit, including internally owed paints. These are single samples with instrumentation, not a performance budget, raster timing or controlled A/B benchmark. Zeros are permitted at the browser clock's resolution.", "",
    "| Mechanism | Delivery | Peak held bytes | Peak held messages | Commit + projection ms | First actual DOM paint ms |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const result of evidence.results.filter(result => result.name === "long")) {
    const committed = result.stages[3];
    const peak = result.stages[2]?.peak;
    const timing = committed?.timings.find(timing => timing.phase === "commit-and-projection");
    const paint = committed?.paints[0]; const end = committed?.paints[1];
    lines.push(`| ${result.mechanism} | ${result.order} | ${peak?.bytes ?? "MISSING"} | ${peak?.messages ?? "MISSING"} | ${timing?.ms.toFixed(3) ?? "MISSING"} | ${paint && end ? (end.at - paint.at).toFixed(3) : "MISSING"} |`);
  }
  lines.push("", "All nine long-composition runs retain 40 live B characters in each beat and exactly one xy insertion. The source records two actual DOM reconciliations by return from compositionend and a third during the driver's explicit final verification paint. M1 queues duplicate bytes; M3's network document filters duplicates before forwarding to E. M2 retains no inbound editor queue.", "");
  return lines.join("\n");
}

export function writeBindingFollowupArtifacts(evidence: BindingFollowupEvidence): void {
  const lines = ["{", `  "appCommit": ${JSON.stringify(evidence.appCommit)},`, `  "bundleSha256": ${JSON.stringify(evidence.bundleSha256)},`,
    `  "machine": ${JSON.stringify(evidence.machine)},`, `  "version": ${JSON.stringify(evidence.version)},`, `  "off": ${JSON.stringify(evidence.off)},`,
    '  "results": [', ...evidence.results.map((result: BindingFollowupResult, index) => `    ${JSON.stringify(result)}${index === evidence.results.length - 1 ? "" : ","}`), "  ]", "}", ""];
  writeFileSync(new URL("../../app-binding-2/evidence.json", import.meta.url), lines.join("\n"));
  writeFileSync(new URL("../../app-binding-2-measurements.md", import.meta.url), bindingFollowupMeasurements(evidence));
  for (const [file, contents] of bindingFollowupHistories(evidence)) writeFileSync(new URL(`../../histories/${file}`, import.meta.url), contents);
}

export function checkBindingFollowupHistories(evidence: BindingFollowupEvidence): void {
  if (readFileSync(new URL("../../app-binding-2-measurements.md", import.meta.url), "utf8") !== bindingFollowupMeasurements(evidence)) throw new Error("Stale follow-up measurements");
  for (const [file, contents] of bindingFollowupHistories(evidence)) {
    if (readFileSync(new URL(`../../histories/${file}`, import.meta.url), "utf8") !== contents) throw new Error(`Stale follow-up history ${file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidence = readBindingFollowupEvidence();
  if (process.argv.includes("--write")) writeBindingFollowupArtifacts(evidence);
  else checkBindingFollowupHistories(evidence);
}
