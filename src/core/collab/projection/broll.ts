import type { SharedProjectionUnit } from "./units.ts";
import { readSharedContentRef } from "../read-operation.ts";

function encoded(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) result += value.charCodeAt(index).toString(16).padStart(4, "0");
  return result;
}
export function projectSharedBrollKeys(cells: readonly { readonly key: string; readonly units: readonly SharedProjectionUnit[] }[], shotIds: readonly string[]) {
  const reserved = new Set(shotIds), seen = new Set<string>();
  for (const cell of cells) for (const unit of cell.units) if (typeof unit.value !== "string" && unit.value.atom === "broll") reserved.add(unit.value.id);
  return cells.map(cell => ({ key: cell.key, units: cell.units.map((unit, index) => {
    const value = unit.value;
    if (typeof value === "string" || value.atom !== "broll") return unit;
    if (!seen.has(value.id)) { seen.add(value.id); return unit; }
    const identity = unit.identity ? unit.identity.client + "_" + unit.identity.clock : encoded(cell.key) + "_" + index;
    let id = "broll_" + encoded(value.id) + "_" + identity;
    while (reserved.has(id)) id += "_";
    reserved.add(id);
    const reference = readSharedContentRef(id);
    if (!reference) throw new Error("Invalid projected b-roll identity");
    return { ...unit, value: { ...value, id: reference } };
  }) }));
}
