import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSplitRepairEvidence, readSplitLocalization } from "./records.ts";

export function splitReconcileHistories(): Map<string, string> {
  const localization = readSplitLocalization(); const evidence = readSplitRepairEvidence();
  const stacks = ["Shows browser-observed native-write/focusout nesting: the prototype bubble handler causes the second render; app blur cleanup is harmless in the standalone and guarded controls.", "", "Diagnostic builds are unminified with observational call probes/native Node wrappers. Handler source is read from the running browser's listener. Node suffixes are WeakMap identities, so equal targets mean the same Node object. Paths are redacted; frame line/column numbers are retained. Normal minified replay controls are in evidence.json.", ""];
  for (const item of localization.cases) {
    const operation = item.kind === "T04" ? "replaceChild" : "removeChild";
    stacks.push(`${item.mode}/${item.kind}; source ${item.sourceCommit}; source tree ${item.sourceTree}; ${item.failure ? "FAIL" : "completed"}`, "", "```text",
      `order: ${JSON.stringify(item.trace.map(entry => [entry.site, entry.depth]))}`);
    const first = item.trace.find(entry => entry.site === `${operation}:enter` && entry.depth === 0);
    const nested = item.trace.find(entry => entry.site === `${operation}:enter` && entry.depth === 1);
    for (const entry of [first, nested].filter(entry => !!entry)) stacks.push(`${entry.site} depth=${entry.depth} ${JSON.stringify(entry.detail)}`, entry.stack);
    const handler = item.trace.find(entry => entry.site === "focusout-handler:enter" && typeof entry.detail === "object" && entry.detail.source?.includes("repaintOwed"));
    if (handler) stacks.push(`runtime prototype listener: ${JSON.stringify(handler.detail)}`);
    const cleanup = item.trace.find(entry => entry.site === "leftEditable" && entry.depth > 0);
    if (cleanup) stacks.push("runtime app cleanup stack:", cleanup.stack);
    stacks.push(`nested render calls: ${item.trace.filter(entry => entry.site === "render" && entry.depth > 0).length}`,
      `nested app sync/blurredCell: ${item.trace.filter(entry => ["syncShown", "blurredCell"].includes(entry.site) && entry.depth > 0).length}`, "```", "");
  }
  const stale = ["Shows the separate T02 binding extension failure: its declared stale focused cell is repainted before input; DOM caret 3 cannot be used against painted ab of length 2. No second repair attempted.", "", `App ${evidence.appCommit}; candidate B; mechanism M1; same corrected prototype bundle ${evidence.bundleSha256}.`, ""];
  for (const item of evidence.cases.filter(item => item.status === "FAIL")) {
    stale.push(`${item.trace}/${item.order}: ${item.difference}`, "", "```text");
    item.stages.forEach((stage, index) => stale.push(`stage ${index}: ${JSON.stringify({ text: stage.text, selection: stage.selection, coordination: stage.coordination, commits: stage.commits, errors: stage.errors, replicas: Object.fromEntries(Object.entries(stage.models).map(([name, model]) => [name, { rows: model.rows.map(row => [row.id, row.characters.map(character => character.value).join(""), row.characters.map(character => character.notation)]), recovery: model.recovery, caret: model.carets.A }])) })}`));
    stale.push("```", "");
  }
  return new Map([["T04-Split-repaint-localization.md", stacks.join("\n")], ["T02-Split-stale-cell.md", stale.join("\n")]]);
}

export function checkSplitReconcileHistories(): void {
  for (const [name, content] of splitReconcileHistories()) if (readFileSync(new URL(`../../histories/${name}`, import.meta.url), "utf8") !== content) throw new Error(`Stale Split history: ${name}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) for (const [name, content] of splitReconcileHistories()) writeFileSync(new URL(`../../histories/${name}`, import.meta.url), content);
  else checkSplitReconcileHistories();
}
