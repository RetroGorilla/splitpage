import type { BrollEntry } from "../core/production/broll.ts";

export interface BrollPanelHandlers {
  readonly brollEntries: () => BrollEntry[];
  readonly addBrollProp: (shotId: string, rawName: string) => boolean;
  readonly renameBrollInScript: (entry: BrollEntry, newName: string) => boolean;
  readonly updateBrollBadge: () => void;
}

let handlers: BrollPanelHandlers | null = null;

export function handBrollPanelTo(next: BrollPanelHandlers | null): void {
  handlers = next;
}

export function brollEntries(): BrollEntry[] {
  return handlers ? handlers.brollEntries() : [];
}

export function addBrollProp(shotId: string, rawName: string): boolean {
  return handlers ? handlers.addBrollProp(shotId, rawName) : false;
}

export function renameBrollInScript(entry: BrollEntry, newName: string): boolean {
  return handlers ? handlers.renameBrollInScript(entry, newName) : false;
}

export function updateBrollBadge(): void {
  handlers?.updateBrollBadge();
}
