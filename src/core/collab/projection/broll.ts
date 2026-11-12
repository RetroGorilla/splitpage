import type { SharedProjectionUnit } from "./units.ts";
import { readSharedContentRef } from "../read-operation.ts";
import { cleanId } from "../../document/text-policy.ts";

function encoded(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) result += value.charCodeAt(index).toString(16).padStart(4, "0");
  return result;
}
export function projectSharedBrollKeys(cells: readonly { readonly key: string; readonly units: readonly SharedProjectionUnit[] }[], shotIds: readonly string[]) {
  const reserved = new Set(shotIds.map(cleanId)), seen = new Set<string>();
  for (const cell of cells) for (const unit of cell.units) if (typeof unit.value !== "string" && unit.value.atom === "broll") {
    if (!unit.identity) throw new Error("B-roll atom requires a stable identity");
    reserved.add(cleanId(unit.value.id));
  }
  return cells.map(cell => ({ key: cell.key, units: cell.units.map(unit => {
    const value = unit.value;
    if (typeof value === "string" || value.atom !== "broll") return unit;
    let id = cleanId(value.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      const reference = readSharedContentRef(id); if (!reference) throw new Error("Invalid projected b-roll identity");
      return id === value.id ? unit : { ...unit, value: { ...value, id: reference } };
    }
    const identity = unit.identity; if (!identity) throw new Error("B-roll atom requires a stable identity");
    id = "broll_" + encoded(value.id) + "_" + identity.client + "_" + identity.clock;
    while (reserved.has(id)) id += "_";
    reserved.add(id);
    const reference = readSharedContentRef(id);
    if (!reference) throw new Error("Invalid projected b-roll identity");
    return { ...unit, value: { ...value, id: reference } };
  }) }));
}
