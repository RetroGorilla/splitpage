import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSplitStaleEvidence, readSplitStaleLocalization } from "./records.ts";

export function splitStaleHistories(): Map<string, string> {
  const localized = readSplitStaleLocalization(); const evidence = readSplitStaleEvidence();
  const contract = ["Shows the prototype issuing the forbidden T02 repaint; Writer and repaired Split preserve the genuinely stale native base. Removing the binding repair reproduces all three failures.", "", `App ${evidence.appCommit}; candidate B; mechanism M1. Diagnostic frames come from an unminified archived app with observational probes. Normal replay uses the normal minified app.`, ""];
  for (const item of localized.cases) {
    contract.push(`${item.surface}: ${item.failure ? "FAIL" : "completed"}`, "", "```text", `remote order: ${JSON.stringify(item.remoteTrace.map(entry => entry.site))}`);
    for (const entry of item.remoteTrace.filter(entry => ["binding.requestRepaint", "app.render", "replaceChild:enter"].includes(entry.site))) contract.push(entry.site, entry.stack);
    for (const entry of item.probe.states.filter(entry => ["before-remote", "after-remote", "native.begin"].includes(entry.site))) contract.push(JSON.stringify(entry));
    contract.push("```", "");
  }
  for (const item of evidence.controls) {
    contract.push(`repair removed / ${item.order}: ${item.failure}`, "", "```text");
    for (const stage of item.stages) contract.push(`${stage.phase}: ${JSON.stringify({ state: stage.probe.state, commits: stage.binding.commits, errors: stage.binding.errors })}`);
    contract.push("```", "");
  }
  const whitespace = ["Shows the T03 extension failing before remote formatting: the third native Backspace changes the trailing space to U+00A0 outside its captured deletion range. No second repair attempted.", "", `App ${evidence.appCommit}; corrected T02 binding bundle ${evidence.bundleSha256}.`, ""];
  const units = (text: string): number[] => [...text].map(character => character.charCodeAt(0));
  for (const item of evidence.cases.filter(item => item.status === "FAIL")) {
    const after = item.stages.find(stage => stage.phase === "after-input");
    whitespace.push(`${item.trace}/${item.order}: ${item.failure}`, "", "```text");
    if (after) {
      for (const [index, before] of after.probe.states.filter(state => state.site === "native.begin").entries()) whitespace.push(`native ${index + 1} before: ${JSON.stringify({ text: before.state.dom, units: units(before.state.dom), selection: before.state.selection, input: before.input })}`);
      for (const [index, event] of after.binding.events.filter(event => event.type === "input" && event.phase === "capture").entries()) whitespace.push(`native ${index + 1} after: ${JSON.stringify({ text: event.text, units: typeof event.text === "string" ? units(event.text) : [], selection: event.selection })}`);
    }
    for (const stage of item.stages) whitespace.push(`${stage.phase}: ${JSON.stringify({ text: stage.binding.text, selection: stage.binding.selection, base: stage.probe.state.painted, errors: stage.binding.errors, commits: stage.binding.commits, syncs: stage.binding.syncs })}`);
    whitespace.push("```", "");
  }
  return new Map([["T02-Split-stale-contract.md", contract.join("\n")], ["T03-Split-native-whitespace.md", whitespace.join("\n")]]);
}

export function checkSplitStaleHistories(): void {
  for (const [name, content] of splitStaleHistories()) if (readFileSync(new URL(`../../histories/${name}`, import.meta.url), "utf8") !== content) throw new Error(`Stale history: ${name}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) for (const [name, content] of splitStaleHistories()) writeFileSync(new URL(`../../histories/${name}`, import.meta.url), content);
  else checkSplitStaleHistories();
}
