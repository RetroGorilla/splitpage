import type { DocumentIdentityOwner, IdentityEntry } from "../application/identity/ports.ts";
import { standaloneHtmlFor as buildStandaloneHtml } from "../adapters/page/standalone-html.js";

let started: { readonly owner: DocumentIdentityOwner; readonly entry: IdentityEntry } | null = null;

export function handDocumentIdentityTo(owner: DocumentIdentityOwner, entry: IdentityEntry): () => void {
  const mine = { owner, entry };
  started = mine;
  return () => { if (started === mine) started = null; };
}

function running() {
  if (!started) throw new Error("The document identity is not started yet");
  return started;
}

export function noteMergedDocId(previous: unknown): void { running().owner.noteMergedDocId(previous); }
export function copyDocHistorySafe(from: unknown, to: unknown): void { running().owner.copyDocHistorySafe(from, to); }
export function syncDocIdentity(): void { running().owner.syncDocIdentity(); }
export function adoptRestoredState(snapshot: unknown) { return running().entry.adoptRestoredState(snapshot); }
export function migrateDocument(...args: Parameters<IdentityEntry["migrateDocument"]>) { return running().entry.migrateDocument(...args); }
export function standaloneHtmlFor(...args: Parameters<typeof buildStandaloneHtml>): string { running(); return buildStandaloneHtml(...args); }
