import type { AutoSaveTarget } from "./status.ts";

export interface AutoSaveWhereInput {
  readonly onServer: boolean;
  readonly signedOut: boolean;
  readonly linkOff: boolean;
  readonly file: { readonly handle: unknown; readonly format: string | null } | null;
}

export interface AutoSaveWhenInput {
  readonly on: boolean;
  readonly halted: string;
  readonly target: AutoSaveTarget;
}

export function autoSaveWhere(input: AutoSaveWhereInput): AutoSaveTarget {
  if (input.signedOut || (input.linkOff && input.onServer)) return null;
  if (input.onServer) return "server";
  const file = input.file;
  if (!file || !file.handle) return null;
  if (file.format === "html") return null;
  return "file";
}

export function autoSaveMay(input: AutoSaveWhenInput): boolean {
  return input.on && !input.halted && input.target !== null;
}
