import type { SharedContentRef, SharedTextAddress } from "./operations.ts";

export interface FlowBaseSpan {
  readonly owner: string;
  readonly field: SharedTextAddress["field"];
  readonly from: number;
  readonly to: number;
}

export function flowBaseReference(owner: string, field: SharedTextAddress["field"], from: number, to = from): SharedContentRef {
  return JSON.stringify(["flow-base", owner, field, from, to]) as SharedContentRef;
}

export function readFlowBaseReference(ref: SharedContentRef): FlowBaseSpan {
  const value: unknown = JSON.parse(ref);
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== "flow-base" || typeof value[1] !== "string"
    || !["audioText", "visualText", "heading", "title"].includes(value[2] as string)
    || !Number.isSafeInteger(value[3]) || !Number.isSafeInteger(value[4]) || value[3] < 0 || value[4] < value[3]) {
    throw new Error("Invalid flow base reference");
  }
  return { owner: value[1], field: value[2] as FlowBaseSpan["field"], from: value[3] as number, to: value[4] as number };
}
