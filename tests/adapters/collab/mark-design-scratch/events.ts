import type { SharedContentRef, SharedMarkValue } from "../../../../src/core/collab/operations.ts";
import { readMarkChange, readSharedContentRef } from "../../../../src/core/collab/read-operation.ts";
import { readSharedAnchor } from "../../../../src/adapters/collab/anchors.ts";

export type ScratchMark = SharedMarkValue;
export type ScratchBorn = { readonly client: number; readonly clock: number; readonly length: number };
export interface ScratchMarkEvent {
  readonly type: "add" | "remove" | "birth";
  readonly operation: string;
  readonly mark: ScratchMark | null;
  readonly observed: readonly string[];
  readonly born: ScratchBorn | null;
}
export interface ScratchAnchoredEvent { readonly event: ScratchMarkEvent; readonly start: SharedContentRef; readonly end: SharedContentRef }

export const scratchMarkKinds = Object.freeze(["b", "i", "u", "s", "hl", "dir", "cue", "comment", "tag", "link"] as const);

function bag(raw: unknown): raw is Record<string, unknown> { return raw !== null && typeof raw === "object" && !Array.isArray(raw); }
function exact(raw: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(raw).sort().join(",") === [...fields].sort().join(","); }
function reference(raw: unknown): string | null { return readSharedContentRef(raw); }

export function scratchMark(raw: unknown): ScratchMark | null {
  return readMarkChange({ kind: "mark", id: "validator", by: "", target: { owner: "R1", segment: "R1", field: "audioText" }, observed: [], mark: raw })?.mark ?? null;
}

export function scratchEventKey(event: ScratchMarkEvent): string {
  return JSON.stringify(["event", event.operation, event.type, event.mark?.kind ?? null, event.mark && "id" in event.mark ? event.mark.id : null])
    .replace(/[^\x20-\x7e]/g, unit => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function readScratchEvent(key: string, raw: unknown): ScratchMarkEvent | null {
  if (!bag(raw) || !exact(raw, ["type", "operation", "mark", "observed", "born"])) return null;
  if (raw.type !== "add" && raw.type !== "remove" && raw.type !== "birth") return null;
  const operation = reference(raw.operation);
  if (!operation || !Array.isArray(raw.observed)) return null;
  const observed: string[] = [];
  for (let index = 0; index < raw.observed.length; index++) {
    const id = reference(raw.observed[index]);
    if (!id) return null;
    observed.push(id);
  }
  let born: ScratchBorn | null = null;
  if (raw.born !== null) {
    if (!bag(raw.born) || !exact(raw.born, ["client", "clock", "length"])) return null;
    const { client, clock, length } = raw.born;
    if (typeof client !== "number" || typeof clock !== "number" || typeof length !== "number"
      || !Number.isSafeInteger(client) || client < 0 || !Number.isSafeInteger(clock) || clock < 0 || !Number.isSafeInteger(length) || length < 1) return null;
    born = { client, clock, length };
  }
  const mark = raw.mark === null ? null : scratchMark(raw.mark);
  if (raw.type === "birth" ? raw.mark !== null || born === null : mark === null) return null;
  if (raw.type === "add" && (mark?.value === null || observed.length !== 0)) return null;
  if (raw.type === "remove" && (mark?.value !== null || born !== null)) return null;
  const event: ScratchMarkEvent = { type: raw.type, operation, mark, observed: [...new Set(observed)].sort(), born };
  return scratchEventKey(event) === key ? event : null;
}

export function readScratchAnchored(key: string, raw: unknown): ScratchAnchoredEvent | null {
  if (!bag(raw) || !exact(raw, ["event", "start", "end"])) return null;
  const event = readScratchEvent(key, raw.event), start = readSharedAnchor(raw.start), end = readSharedAnchor(raw.end);
  return event && start && end ? { event, start, end } : null;
}

export function makeScratchEvent(type: ScratchMarkEvent["type"], operation: string, mark: ScratchMark | null, observed: readonly string[] = [], born: ScratchBorn | null = null): ScratchMarkEvent {
  const event = { type, operation: reference(operation) ?? "", mark: mark === null ? null : scratchMark(mark), observed: [...observed], born };
  const read = readScratchEvent(scratchEventKey(event), event);
  if (!read) throw new Error("Invalid scratch event");
  return read;
}

export function sameScratchMark(left: ScratchMark, right: ScratchMark): boolean {
  return left.kind === right.kind && ("id" in left ? "id" in right && left.id === right.id : !("id" in right));
}

export function scratchMarkCode(mark: ScratchMark): string { return JSON.stringify([mark.kind, "id" in mark ? mark.id : null, mark.value]); }

export function scratchMarkOutput(mark: ScratchMark): ScratchMark {
  return "id" in mark ? { kind: mark.kind, id: mark.id, value: mark.value } as ScratchMark : { kind: mark.kind, value: mark.value };
}

export function scratchExampleMark(kind: typeof scratchMarkKinds[number]): ScratchMark {
  if (kind === "comment") return { kind, id: "C" as SharedContentRef, value: true };
  if (kind === "tag") return { kind, id: "T" as SharedContentRef, value: "P" as SharedContentRef };
  if (kind === "link") return { kind, id: "L" as SharedContentRef, value: "https://x" };
  return { kind, value: true };
}
