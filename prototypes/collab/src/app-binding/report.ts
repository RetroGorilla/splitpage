import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkModel, IdentityBook } from "../model.ts";
import type { ScriptOracle } from "../model.ts";
import type { AppBindingEvidence, AppBindingSnapshot } from "./run.ts";

export function readAppBindingEvidence(): AppBindingEvidence {
  return JSON.parse(readFileSync(new URL("../../app-binding/evidence.json", import.meta.url), "utf8")) as AppBindingEvidence;
}

export function serializeAppBindingEvidence(evidence: AppBindingEvidence): string {
  const list = (name: string, values: readonly unknown[]): string[] => [`  "${name}": [`, ...values.map((value, index) => `    ${JSON.stringify(value)}${index === values.length - 1 ? "" : ","}`), "  ]"];
  return ["{", `  "appCommit": ${JSON.stringify(evidence.appCommit)},`, `  "harnessSha256": ${JSON.stringify(evidence.harnessSha256)},`,
    `  "instanceDocId": ${JSON.stringify(evidence.instanceDocId)},`, `  "version": ${JSON.stringify(evidence.version)},`, `  "off": ${JSON.stringify(evidence.off)},`,
    ...list("inputs", evidence.inputs).map((line, index, lines) => line + (index === lines.length - 1 ? "," : "")),
    ...list("traces", evidence.traces).map((line, index, lines) => line + (index === lines.length - 1 ? "," : "")),
    ...list("probes", evidence.probes), "}", ""].join("\n");
}

export function checkAppBindingSnapshot(snapshot: AppBindingSnapshot, oracle: ScriptOracle, mechanism: string, order: string): void {
  if (snapshot.errors.length) throw new Error(snapshot.errors.join("; "));
  const identities = new IdentityBook();
  for (const [name, identity] of Object.entries(snapshot.bindings)) identities.bind(name, identity);
  const expected = ["A.E", "B.E", ...(mechanism === "M3" ? ["A.N", "B.N"] : []), ...(order === "late-C" ? ["C.E", ...(mechanism === "M3" ? ["C.N"] : [])] : [])];
  if (JSON.stringify(Object.keys(snapshot.models).sort()) !== JSON.stringify(expected.sort())) throw new Error("Missing real-app replica snapshot");
  for (const [name, model] of Object.entries(snapshot.models)) checkModel(model, oracle, identities, name);
  const caret = oracle.carets.A;
  const row = oracle.rows.find(row => row.id === caret?.beat);
  if (!caret || !row) throw new Error("No literal DOM oracle");
  if (snapshot.text !== row.characters.map(character => character[1]).join("")) throw new Error("Retained app DOM text differs from oracle");
  if (JSON.stringify(snapshot.selection) !== JSON.stringify([caret.selection?.from ?? caret.offset, caret.selection?.to ?? caret.offset])) throw new Error("Retained app DOM selection differs from oracle");
  if (snapshot.dirty || snapshot.composing || snapshot.heldBytes) throw new Error("Real-app buffer did not settle");
}

export function appBindingHistories(evidence: AppBindingEvidence): Map<string, string> {
  const histories = new Map<string, string>();
  for (const [file, names, shows] of [
    ["T04-app-unbound-reconcile.md", ["unbound whole-beat reconciliation overwrites remote"], "The real Writer's unbound whole-beat composition sync overwrites Bob's insertion and restores his deletion."],
    ["T03-app-undo-hold.md", ["standalone undo hold bypass M1", "standalone undo hold bypass M2", "standalone undo hold bypass M3"], "The experimental selective-undo route bypasses the standalone owner's hold under every mechanism."],
    ["T03-app-sync-hook-removed.md", ["sync hook removed"], "Removing the real Writer sync hook is detected; a later driver commit cannot endorse this run."]
  ] as const) {
    const lines = [shows, "", `App: ${evidence.appCommit} on proto/collab-1a-app-binding-throwaway; browser ${String(evidence.version.product)}.`, "",
      "Reproduce: the app-binding runner under the smoke lock. The literal expected results are unchanged.", ""];
    for (const name of names) {
      const probe = evidence.probes.find(probe => probe.name === name);
      if (!probe) throw new Error(`Missing app binding probe ${name}`);
      lines.push(name, "", "```text");
      probe.stages.forEach((stage, index) => {
        const app = stage.app as { document: { rows: { id: string; audioText: string }[] }; counts: { hold: number } };
        lines.push(`stage ${index}: DOM=${JSON.stringify(stage.text)} selection=${JSON.stringify(stage.selection)} bufferDirty=${stage.dirty} bufferComposition=${stage.composing} undoHold=${app.counts.hold}`,
          `session=${JSON.stringify(app.document.rows.map(row => [row.id, row.audioText]))}`, `commits=${JSON.stringify(stage.commits)}`,
          ...stage.errors.map(error => `STOP: ${error}`));
        const previous = index === 0 ? 0 : probe.stages[index - 1]?.events.length ?? 0;
        for (const event of stage.events.slice(previous).filter(event => event.phase === "bubble" && ["compositionstart", "compositionend", "input"].includes(String(event.type)))) {
          lines.push(`${String(event.type)}${event.inputType ? `(${String(event.inputType)})` : ""} DOM=${JSON.stringify(event.text)} nativeComposition=${String(event.composing)}`);
        }
      });
      lines.push("```", "");
    }
    histories.set(file, lines.join("\n"));
  }
  return histories;
}

export function writeAppBindingHistories(evidence: AppBindingEvidence): void {
  for (const [file, contents] of appBindingHistories(evidence)) writeFileSync(new URL(`../../histories/${file}`, import.meta.url), contents);
}

export function checkAppBindingHistories(evidence: AppBindingEvidence): void {
  for (const [file, contents] of appBindingHistories(evidence)) {
    if (readFileSync(new URL(`../../histories/${file}`, import.meta.url), "utf8") !== contents) throw new Error(`Stale app binding history ${file}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const evidence = readAppBindingEvidence();
  if (process.argv.includes("--write")) {
    writeFileSync(new URL("../../app-binding/evidence.json", import.meta.url), serializeAppBindingEvidence(evidence));
    writeAppBindingHistories(evidence);
  } else checkAppBindingHistories(evidence);
}
