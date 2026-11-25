import type { SharedScriptIdentity } from "./shared-script.ts";

export interface SharedFileRecord extends SharedScriptIdentity {
  readonly absPath: string;
  readonly docId: string;
  readonly fingerprint: string;
  readonly missing: number;
}

export interface SharedFileInfo {
  readonly name: string;
  readonly docId: string;
  readonly missing: number;
}

export type SharedFileRequest =
  | ["file-copy-status" | "file-copy-stop", name: string]
  | ["file-copy-write", name: string, data: Uint8Array, missing: number, mode: "check" | "overwrite" | "new" | "export", docId: string]
  | ["file-copy-choice", name: string, problem: "changed" | "unavailable" | "missing", reason: "leave" | "stop"];

export type SharedFileResult =
  | { readonly kind: "file-copy"; readonly file: SharedFileInfo | null }
  | { readonly kind: "file-copy-problem"; readonly problem: "changed" | "unavailable" }
  | { readonly kind: "file-copy-choice"; readonly choice: "retry" | "new" | "continue" | "cancel" }
  | { readonly kind: "file-copy-written"; readonly file: SharedFileInfo; readonly id: string; readonly lastModified?: number };
