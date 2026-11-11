import type { SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { isStableSharedIdentity } from "./identity.ts";

export class SharedStructurePreparationError extends Error {}

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

export function prepareStructureIdentity(view: SharedPreparationView, operation: string, role: string, alias: SharedContentRef): SharedContentRef {
  if (![operation, alias].every(isStableSharedIdentity)) throw new SharedStructurePreparationError("unstable-identity");
  const identity = JSON.stringify(["structure", view.writer, operation, role]) as SharedContentRef;
  prepareStructureAlias(view, alias, identity);
  return identity;
}
