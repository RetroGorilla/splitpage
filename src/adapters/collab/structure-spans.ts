import type { SharedProjectionStream } from "../../core/collab/projection/blocks.ts";
import type { SharedProjectionUnit } from "../../core/collab/projection/units.ts";
import type { SharedPreparationView } from "./prepare.ts";
import { interpretSharedStructure, readSharedStructureStream } from "./structure-plan.ts";
import { readProjectionHead, readProjectionInlineValue } from "./projection-reader.ts";

export function sharedStructureSpans(view: SharedPreparationView, segment: string, units: readonly { readonly value: unknown }[]) {
  const positions = new Map<SharedProjectionUnit, number>(), stored = readSharedStructureStream(view, segment);
  if (!stored) return [];
  const actual: SharedProjectionStream = { ...stored, parts: units.map((unit, from) => {
    const boundary = readProjectionHead(unit.value), value = boundary ? null : readProjectionInlineValue(unit.value);
    const visible: SharedProjectionUnit[] = value === null ? [] : [{ value, marks: [] }];
    if (visible[0]) positions.set(visible[0], from);
    return { boundary, units: visible, from, to: from + 1 };
  }) };
  return interpretSharedStructure(view, [], actual).flatMap(block => block.segment !== segment || block.reason || block.id === null ? [] : [{
    owner: block.id, field: block.kind === "h" ? "heading" as const : "audioText" as const, from: block.from, to: block.to,
    positions: block.units.map(unit => { const at = positions.get(unit); if (at === undefined) throw new Error("Projected unit lost its physical position"); return at; })
  }]);
}
