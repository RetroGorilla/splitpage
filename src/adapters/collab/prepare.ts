import * as Y from "yjs";
import type { SharedDocumentHandle } from "./types.ts";
import { collabState, SharedExecutionWriteError } from "./state.ts";
import { sharedPreparedValue } from "./prepare-value.ts";
import { createCollabTextFacade } from "./prepare-text.ts";
import type { SharedPreparationText } from "./prepare-text.ts";
import type { SharedStatusEvent } from "../../core/collab/operations.ts";
import { sharedStatusEventKeys } from "./status-index.ts";
import { observeSharedStructureIndex } from "./structure-index.ts";
import { bindSharedStructurePlan, resolveSharedStructureOwner } from "./structure-plan.ts";

export type SharedPreparedWrite = {
  readonly path: readonly string[];
  readonly kind: "set" | "delete" | "map" | "text" | "array";
  readonly value?: unknown;
};
export interface SharedPreparationView {
  readonly writer: string;
  readonly base: number | null;
  readonly get: (path: readonly string[]) => unknown;
  readonly has: (path: readonly string[]) => boolean;
  readonly kind: (path: readonly string[]) => "map" | "text" | "array" | "value" | "missing";
  readonly keys: (path: readonly string[]) => readonly string[];
  readonly statusEvents: (target: SharedStatusEvent["target"]) => readonly string[];
  readonly text: (path: readonly string[]) => SharedPreparationText | null;
  readonly scratch: <T>(key: string, create: () => T) => T;
  readonly resolveOwner: (owner: string, field: "audioText" | "heading") => { readonly owner: string; readonly segment: string } | null;
}
export type SharedPreparationResult = { readonly ok: false; readonly reason: string } | {
  readonly ok: true; readonly writes: readonly SharedPreparedWrite[]; readonly apply: (handle: SharedDocumentHandle) => void;
  readonly complete?: () => string | null;
};

function liveValue(handle: SharedDocumentHandle, path: readonly string[]): unknown {
  const roots = collabState(handle).roots;
  let value: unknown = roots[path[0] as keyof typeof roots];
  for (const key of path.slice(1)) value = value instanceof Y.Map ? value.get(key) : undefined;
  return value;
}

export function createSharedPreparation(handle: SharedDocumentHandle, base: number | null = null) {
  const overlay = new Map<string, SharedPreparedWrite>();
  const scratch = new Map<string, unknown>(), texts = new Map<string, SharedPreparationText>();
  let open = true;
  const ensureOpen = (): void => { if (!open) throw new Error("Preparation has ended"); };
  const lookup = (path: readonly string[]): { kind: ReturnType<SharedPreparationView["kind"]>; value: unknown } => {
    const exact = overlay.get(JSON.stringify(path));
    if (exact) return { kind: exact.kind === "delete" ? "missing" : exact.kind === "set" ? "value" : exact.kind, value: exact.value };
    for (let length = path.length - 1; length > 0; length--) {
      if (overlay.has(JSON.stringify(path.slice(0, length)))) return { kind: "missing", value: undefined };
    }
    const value = liveValue(handle, path);
    return { kind: value instanceof Y.Map ? "map" : value instanceof Y.Text ? "text" : value instanceof Y.Array ? "array" : value === undefined ? "missing" : "value", value };
  };
  const view: SharedPreparationView = Object.freeze({
    writer: String(collabState(handle).doc.clientID),
    base,
    resolveOwner: (owner: string, field: "audioText" | "heading") => {
      ensureOpen(); bindSharedStructurePlan(view, observeSharedStructureIndex(handle)); return resolveSharedStructureOwner(view, owner, field);
    },
    get: (path: readonly string[]): unknown => {
      ensureOpen();
      const item = lookup(path);
      return item.kind === "map" ? undefined : item.value instanceof Y.Text ? sharedPreparedValue(item.value.toDelta())
        : item.value instanceof Y.Array ? sharedPreparedValue(item.value.toArray()) : sharedPreparedValue(item.value);
    },
    kind: (path: readonly string[]) => { ensureOpen(); return lookup(path).kind; },
    has: (path: readonly string[]): boolean => {
      ensureOpen();
      if (!path.length) return false;
      const exact = overlay.get(JSON.stringify(path));
      if (exact) return exact.kind !== "delete";
      for (let length = path.length - 1; length > 0; length--) if (overlay.has(JSON.stringify(path.slice(0, length)))) return false;
      if (path.length === 1) return Object.hasOwn(collabState(handle).roots, path[0] as string);
      const parent = liveValue(handle, path.slice(0, -1));
      return parent instanceof Y.Map && parent.has(path.at(-1) as string);
    },
    keys: (path: readonly string[]): readonly string[] => {
      ensureOpen();
      const item = lookup(path);
      if (item.kind !== "map") return Object.freeze([]);
      const keys = new Set(item.value instanceof Y.Map ? item.value.keys() : []);
      for (const write of overlay.values()) {
        if (write.path.length === path.length + 1 && path.every((key, index) => write.path[index] === key)) {
          const key = write.path.at(-1);
          if (key !== undefined) { if (write.kind === "delete") keys.delete(key); else keys.add(key); }
        }
      }
      return Object.freeze([...keys].sort());
    },
    statusEvents: (target: SharedStatusEvent["target"]): readonly string[] => {
      ensureOpen();
      const indexed = sharedStatusEventKeys(handle, target);
      if (!indexed) return view.keys(["statusEvents"]);
      const keys = new Set(indexed);
      for (const write of overlay.values()) {
        const key = write.path[1];
        if (write.path.length !== 2 || write.path[0] !== "statusEvents" || key === undefined) continue;
        if (write.kind === "delete") keys.delete(key); else keys.add(key);
      }
      return Object.freeze([...keys].sort());
    },
    text: (path: readonly string[]): SharedPreparationText | null => {
      ensureOpen();
      if (lookup(path).kind !== "text") return null;
      const key = JSON.stringify(path), cached = texts.get(key);
      if (cached) return cached;
      const text = liveValue(handle, path);
      if (!(text instanceof Y.Text)) return null;
      const parent = liveValue(handle, path.slice(0, -1));
      if (!(parent instanceof Y.Map)) return null;
      const facade = createCollabTextFacade(handle, text, parent.get(path.at(-1) === "title" ? "titleMarks" : "markRecords"), ensureOpen);
      texts.set(key, facade);
      return facade;
    },
    scratch: <T>(key: string, create: () => T): T => {
      ensureOpen();
      if (!scratch.has(key)) scratch.set(key, create());
      return scratch.get(key) as T;
    }
  });
  return { view, include: (writes: readonly SharedPreparedWrite[]): void => {
    ensureOpen();
    for (const write of writes) if (write.kind === "set" && write.value === undefined) throw new Error("Prepared set writes cannot contain undefined");
    for (const write of writes) {
      for (const [key, previous] of overlay) {
        if (previous.path.length > write.path.length && write.path.every((part, index) => previous.path[index] === part)) overlay.delete(key);
      }
      overlay.set(JSON.stringify(write.path), { path: [...write.path], kind: write.kind, value: sharedPreparedValue(write.value) });
    }
  }, close: (): void => { open = false; scratch.clear(); texts.clear(); overlay.clear(); } };
}

export function applySharedMapWrites(handle: SharedDocumentHandle, writes: readonly SharedPreparedWrite[]): void {
  if (!collabState(handle).execution?.applying) throw new SharedExecutionWriteError();
  for (const write of writes) {
    const parent = liveValue(handle, write.path.slice(0, -1)) as Y.Map<unknown>, key = write.path.at(-1) as string;
    if (write.kind === "delete") parent.delete(key);
    else parent.set(key, write.kind === "map" ? new Y.Map<unknown>() : write.value);
  }
}
