import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { cleanId } from "../../core/document/text-policy.ts";

export interface SharedStructureIdentityReservations { readonly has: (identity: string) => boolean }

export class SharedStructurePreparationError extends Error {}

function identityPlan(view: SharedPreparationView) {
  return view.scratch("structure-identity-plan", () => ({ minted: new Set<string>(), records: new Set<string>() }));
}

export function requireSharedStructureOperationId(operation: string): void {
  if (!operation || cleanId(operation) !== operation || !isStableSharedIdentity(operation)) throw new SharedStructurePreparationError("invalid-structure-operation-id");
}

export function sharedStructureIdentity(writer: string, operation: string, role: "beat" | "segment" | "visual" | "gallery" | "removal" | "restore" | "join" | "heading", slot = 0): SharedContentRef {
  requireSharedStructureOperationId(operation);
  if (!/^(0|[1-9][0-9]*)$/.test(writer) || !Number.isSafeInteger(slot) || slot < 0) throw new SharedStructurePreparationError("unstable-identity");
  const encoded = operation.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return ("structure_" + writer + "_" + encoded + "_" + role + "_" + slot) as SharedContentRef;
}

export function reserveSharedStructureIdentity(view: SharedPreparationView, identity: SharedContentRef, reserved: SharedStructureIdentityReservations): void {
  const plan = identityPlan(view);
  if (reserved.has(identity) || plan.minted.has(identity) || plan.records.has(identity)) throw new SharedStructurePreparationError("existing-identity");
  plan.minted.add(identity);
}

export function reserveSharedCommandIdentities(view: SharedPreparationView, names: readonly string[]): boolean {
  const plan = identityPlan(view), identities = names.map(cleanId);
  if (identities.some(identity => plan.minted.has(identity))) return false;
  for (const identity of identities) plan.records.add(identity);
  return true;
}

function structureAliases(view: SharedPreparationView): { alias: string; identity: SharedContentRef }[] {
  return view.scratch("structure-aliases", () => []);
}

export function prepareStructureAlias(view: SharedPreparationView, alias: SharedContentRef, identity: SharedContentRef): void {
  if (!isStableSharedIdentity(alias) || !isStableSharedIdentity(identity)) throw new SharedStructurePreparationError("unstable-identity");
  const aliases = structureAliases(view);
  if (aliases.some(entry => entry.alias === alias) || ["beats", "headings", "segments", "visuals", "gallery"].some(root => view.has([root, alias]))) throw new SharedStructurePreparationError("existing-identity");
  aliases.push({ alias, identity });
}

export function sharedStructureReference(view: SharedPreparationView, reference: string): SharedContentRef {
  return structureAliases(view).find(entry => entry.alias === reference)?.identity ?? reference as SharedContentRef;
}

export function prepareStructureIdentity(view: SharedPreparationView, operation: string, role: "beat" | "segment" | "visual" | "gallery", alias: SharedContentRef, reserved: SharedStructureIdentityReservations, slot = 0): SharedContentRef {
  if (!isStableSharedIdentity(alias)) throw new SharedStructurePreparationError("unstable-identity");
  const identity = sharedStructureIdentity(view.writer, operation, role, slot);
  reserveSharedStructureIdentity(view, identity, reserved);
  prepareStructureAlias(view, alias, identity);
  return identity;
}
