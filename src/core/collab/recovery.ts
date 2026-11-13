import type { SharedProjectionFragmentReason } from "./projection/blocks.ts";
import type { SharedProjectionGalleryOverflow } from "./projection/gallery.ts";
import type { SharedTagProjectionRejection } from "./projection/tag-extents.ts";
import type { SharedRemovalBufferSource } from "./removal-state.ts";

export type SharedRecoveryEntry =
  | (SharedTagProjectionRejection & { readonly rowId: string; readonly field: "audioText" | "visualText" })
  | (SharedProjectionGalleryOverflow & { readonly kind: "gallery-overflow"; readonly rowId: string })
  | { readonly kind: "removed-beat"; readonly row: Readonly<Record<string, unknown>>; readonly members: readonly string[]; readonly buffer?: readonly SharedRemovalBufferSource[] }
  | { readonly kind: "unprojectable-fragment"; readonly reason: SharedProjectionFragmentReason; readonly owner: string | null; readonly segment: string;
    readonly field: "audioText" | "heading"; readonly from: number; readonly to: number; readonly html: string }
  | { readonly kind: "scene-with-no-beats"; readonly heading: Readonly<Record<string, unknown>>; readonly beforeRowId: string | null }
  | { readonly kind: "removed-heading"; readonly heading: Readonly<Record<string, unknown>> };
