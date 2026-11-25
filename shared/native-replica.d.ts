import type { SharedScriptCatalogueEntry } from "./shared-script.ts";

export interface NativeMembershipRecord {
  readonly token: string;
  readonly role: "owner" | "guest";
  readonly guestLinkToken?: string;
  readonly linkPasswordRequired?: boolean;
}

export type NativeReplicaRequest =
  | ["open" | "delete" | "focus-shared", name: string]
  | ["note-shared", name: string, entry: SharedScriptCatalogueEntry]
  | ["membership" | "forget" | "read-journal", name: string, lease: string]
  | ["join", name: string, lease: string, record: string | NativeMembershipRecord | null]
  | ["close", name: string, lease: string]
  | ["read", name: string, lease: string, through: number | null]
  | ["write", name: string, lease: string, generation: number, checkpoint: boolean, bytes: Uint8Array]
  | ["write", name: string, lease: string, generation: number, checkpoint: boolean, bytes: Uint8Array, journal: Uint8Array]
  | ["write-journal", name: string, lease: string, bytes: Uint8Array];

export interface NativeReplicaEntry {
  readonly generation: number;
  readonly checkpoint: boolean;
  readonly bytes: Uint8Array;
  readonly journal?: Uint8Array;
}

export type NativeReplicaReply =
  | { readonly kind: "failed"; readonly reason: "locked" | "closed" | "quota" | "io" }
  | { readonly kind: "opened"; readonly lease: string }
  | { readonly kind: "read"; readonly entries: readonly NativeReplicaEntry[] }
  | { readonly kind: "journal"; readonly bytes: Uint8Array | null }
  | { readonly kind: "membership"; readonly record: NativeMembershipRecord | null }
  | { readonly kind: "stored" };

export type NativeReplicaInvoke = (request: NativeReplicaRequest) => Promise<NativeReplicaReply>;
