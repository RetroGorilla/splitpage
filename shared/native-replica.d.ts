export type NativeReplicaRequest =
  | ["open" | "delete", name: string]
  | ["close", name: string, lease: string]
  | ["read", name: string, lease: string, through: number | null]
  | ["write", name: string, lease: string, generation: number, checkpoint: boolean, bytes: Uint8Array];

export interface NativeReplicaEntry {
  readonly generation: number;
  readonly checkpoint: boolean;
  readonly bytes: Uint8Array;
}

export type NativeReplicaReply =
  | { readonly kind: "failed"; readonly reason: "locked" | "closed" | "quota" | "io" }
  | { readonly kind: "opened"; readonly lease: string }
  | { readonly kind: "read"; readonly entries: readonly NativeReplicaEntry[] }
  | { readonly kind: "stored" };

export type NativeReplicaInvoke = (request: NativeReplicaRequest) => Promise<NativeReplicaReply>;
