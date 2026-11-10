import { beatPos, caretAt, flowOf, headingPos, replaceRange } from "./flow.ts";
import type { FlowDoc, FlowOutcome, FlowPorts, FlowRange } from "./flow.ts";
import { describeFlow } from "./operations.ts";
import { cellLength } from "../text/runs.ts";

export function removeEmptyHeading(doc: FlowDoc, id: string, range: FlowRange | null, landing: "above" | "below" | "keep", ports: FlowPorts): FlowOutcome {
  if (ports.operations) return describeFlow(doc, ports, traced => removeEmptyHeading(doc, id, range, landing, traced));
  const scene = flowOf(doc).find(block => block.kind === "heading" && block.scene.id === id);
  if (!scene || scene.kind !== "heading") return null;
  const result = replaceRange(doc, { anchor: headingPos(id, 0), head: headingPos(id, scene.scene.name.length) }, [], ports);
  if (!result || !("selection" in result)) return result;
  if (landing === "above") {
    const previous = doc.rows[doc.rows.findIndex(row => row.id === scene.scene.firstSceneId) - 1];
    if (previous) return { ...result, selection: caretAt(beatPos(previous.id, cellLength(ports.cells(previous.audioText)))) };
  }
  const keep = landing === "keep" && range && [range.anchor, range.head].every(pos => pos.kind !== "heading" || pos.sceneId !== id);
  return keep ? { ...result, selection: range } : result;
}
