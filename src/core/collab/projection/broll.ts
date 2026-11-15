import type { SharedProjectionUnit } from "./units.ts";
import { readSharedContentRef } from "../read-operation.ts";
import { cleanId } from "../../document/text-policy.ts";

export interface SharedBrollAtom { readonly index: number; readonly unit: SharedProjectionUnit }

export interface SharedBrollCell { readonly key: string; readonly atoms: readonly SharedBrollAtom[] }

export interface SharedBrollRewrite { readonly key: string; readonly replaced: readonly { readonly index: number; readonly unit: SharedProjectionUnit }[] }

function encoded(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) result += value.charCodeAt(index).toString(16).padStart(4, "0");
  return result;
}

export function readSharedBrollAtoms(units: readonly SharedProjectionUnit[]): readonly SharedBrollAtom[] {
  const atoms: SharedBrollAtom[] = [];
  for (let index = 0; index < units.length; index++) {
    const unit = units[index];
    if (!unit || typeof unit.value === "string" || unit.value.atom !== "broll") continue;
    if (!unit.identity) throw new Error("B-roll atom requires a stable identity");
    atoms.push({ index, unit });
  }
  return atoms;
}

export function assignSharedBrollKeys(cells: readonly SharedBrollCell[], shotIds: readonly string[]): readonly SharedBrollRewrite[] {
  const reserved = new Set(shotIds.map(cleanId)), seen = new Set<string>();
  for (const cell of cells) for (const { unit } of cell.atoms) if (typeof unit.value !== "string" && unit.value.atom === "broll") {
    reserved.add(cleanId(unit.value.id));
  }
  return cells.map(cell => ({ key: cell.key, replaced: cell.atoms.flatMap(({ index, unit }) => {
    const value = unit.value;
    if (typeof value === "string" || value.atom !== "broll") return [];
    let id = cleanId(value.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      const reference = readSharedContentRef(id); if (!reference) throw new Error("Invalid projected b-roll identity");
      return id === value.id ? [] : [{ index, unit: { ...unit, value: { ...value, id: reference } } }];
    }
    const identity = unit.identity; if (!identity) throw new Error("B-roll atom requires a stable identity");
    id = "broll_" + encoded(value.id) + "_" + identity.client + "_" + identity.clock;
    while (reserved.has(id)) id += "_";
    reserved.add(id);
    const reference = readSharedContentRef(id);
    if (!reference) throw new Error("Invalid projected b-roll identity");
    return [{ index, unit: { ...unit, value: { ...value, id: reference } } }];
  }) }));
}

export function applySharedBrollRewrite(units: readonly SharedProjectionUnit[], rewrite: SharedBrollRewrite): readonly SharedProjectionUnit[] {
  if (!rewrite.replaced.length) return units;
  const next = units.slice();
  for (const { index, unit } of rewrite.replaced) next[index] = unit;
  return next;
}

export function projectSharedBrollKeys(cells: readonly { readonly key: string; readonly units: readonly SharedProjectionUnit[] }[], shotIds: readonly string[]) {
  const rewrites = assignSharedBrollKeys(cells.map(cell => ({ key: cell.key, atoms: readSharedBrollAtoms(cell.units) })), shotIds);
  return cells.map((cell, at) => ({ key: cell.key, units: applySharedBrollRewrite(cell.units, rewrites[at] ?? { key: cell.key, replaced: [] }) }));
}
