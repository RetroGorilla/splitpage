import * as Y from "yjs";
import { readFileSync, writeFileSync } from "node:fs";
import { readReplica } from "../reader.ts";
import { localFixture } from "../../test/local/oracles.ts";
import type { LocalBrowserSnapshot } from "../../test/local/oracles.ts";
import type { LocalExperimentEvidence } from "./run.ts";

export function readLocalEvidence(): LocalExperimentEvidence {
  return JSON.parse(readFileSync(new URL("../../local-evidence.json", import.meta.url), "utf8")) as LocalExperimentEvidence;
}

export function serializeLocalEvidence(evidence: LocalExperimentEvidence): string {
  const lines = (items: unknown[]): string[] => items.map((item, index) => `    ${JSON.stringify(item)}${index + 1 < items.length ? "," : ""}`);
  return ["{", `  "version": ${JSON.stringify(evidence.version)},`, `  "node": ${JSON.stringify(evidence.node)},`,
    '  "cases": [', ...lines(evidence.cases), "  ],", '  "unresolved": [', ...lines(evidence.unresolved), "  ]", "}", ""].join("\n");
}

function identities(bytes: number[]): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Uint8Array.from(bytes));
    return readReplica(doc, "A", localFixture().identities).rows.map(row => `${row.id}: ${row.characters.map(character => `${character.notation}(${character.value})`).join(" ")}`).join("; ") || "no rows";
  } finally { doc.destroy(); }
}

function summarize(snapshot: LocalBrowserSnapshot): string {
  return `generation=${snapshot.sequence}; status=${snapshot.status}; writable=${String(snapshot.writable)}; editor=[${identities(snapshot.editor)}]; network=[${identities(snapshot.network)}]; manifest=${JSON.stringify(snapshot.manifest)}`;
}

export function localHistoryArtifacts(evidence: LocalExperimentEvidence): Map<string, string> {
  const artifacts = new Map<string, string>();
  const take = (prefix: string): Record<string, unknown> => {
    const result = evidence.cases.find(result => result.name.startsWith(prefix));
    if (!result) throw new Error(`Missing local evidence ${prefix}`);
    return result.observation as Record<string, unknown>;
  };
  const put = (name: string, description: string, lines: string[]): void => {
    artifacts.set(name, [description, "", `Observed in ${String(evidence.version.product)}. Reproduce with the locked local browser command in local-report.md.`, "", ...lines, ""].join("\n"));
  };
  const premature = take("defect: saved before");
  put("T24-local-premature-save.md", "A local saved claim before transaction completion loses acknowledged identities on a renderer crash.", [
    "Harness sends generation 1 (a=s1) and observes Saved on this device after commit.",
    "Harness holds generation 2 (ab=s1 a1) transaction open; defective tab reports Saved on this device.",
    `Harness receipt ledger: ${JSON.stringify(premature.receipts)}. Page.crash kills the renderer while the gate remains held.`,
    `Fresh-tab hydration: ${summarize(premature.recovered as LocalBrowserSnapshot)}.`,
    `Independent checker rejects: ${String(premature.rejection)}.`
  ]);
  const unlocked = take("defect: writer without");
  put("T24-local-unlocked-write.md", "A tab bypassing writable ownership changes persisted character identities while another tab holds the Web Lock.", [
    "Generation 1 committed. The browser lock query confirms the (deployment, instance) lock is held by the first tab.",
    "The second tab is refused normally; its deliberately defective path writes generation 2 without acquiring the lock.",
    `A later reopened transaction reads: ${summarize(unlocked.recovered as LocalBrowserSnapshot)}.`,
    "The independent literal generation-1 identity oracle rejects the unauthorized a1, even though the storage write committed."
  ]);
  const split = take("M3 control:");
  put("STORE-M3-split.md", "Separate N and E transactions recover inconsistent generations after a renderer crash between commits.", [
    "Commit generation 1 for E, N and the manifest. Apply generation 2 in memory.",
    "Commit only N in a second transaction. Page.crash before E or metadata are written.",
    `Fresh-tab hydration: ${summarize(split.recovered as LocalBrowserSnapshot)}.`,
    `Checker rejects: ${String(split.rejection)}.`
  ]);
  const initial = take("library: initial whenSynced");
  put("STORE-library-initial.md", "y-indexeddb's initial whenSynced event is observable before the initial persistence transaction commits.", [
    "Seed a=s1 in memory, hold the library's initial transaction with harness-owned requests.",
    `whenSynced resolved: ${summarize(initial.loaded as LocalBrowserSnapshot)}.`,
    "Page.crash while that transaction is held.",
    `Fresh library hydration: ${summarize(initial.recovered as LocalBrowserSnapshot)}.`,
    "The literal s1 identity oracle rejects the empty recovered document; whenSynced cannot be a saved receipt."
  ]);
  const aborted = take("library: abort gives");
  put("STORE-library-abort.md", "A failed y-indexeddb update leaves synced true and the newer in-memory identities absent after recovery.", [
    "Persist a=s1; a later readonly transaction is the commit fence. Apply ab=s1 a1 and abort its write transaction.",
    `After the abort: ${summarize(aborted.failed as LocalBrowserSnapshot)}; synced=true.`,
    "Page.crash, then reopen from retained IndexedDB state.",
    `Fresh library hydration: ${summarize(aborted.recovered as LocalBrowserSnapshot)}.`
  ]);
  return artifacts;
}

export function writeLocalHistories(evidence: LocalExperimentEvidence): void {
  for (const [name, body] of localHistoryArtifacts(evidence)) writeFileSync(new URL(`../../histories/${name}`, import.meta.url), body);
}
