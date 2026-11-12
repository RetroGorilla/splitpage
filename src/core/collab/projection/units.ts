import type { SharedInlineValue, SharedMarkValue } from "../operations.ts";

export interface SharedProjectionUnit {
  readonly identity?: { readonly client: number; readonly clock: number };
  readonly value: SharedInlineValue;
  readonly marks: readonly { readonly kind: SharedMarkValue["kind"]; readonly id?: string; readonly value: true | string }[];
}
