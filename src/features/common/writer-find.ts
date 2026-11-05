import type { FlowRange } from "../../core/flow/flow.ts";

export type WriterSearchMatch =
  | { readonly kind: "narration"; readonly range: FlowRange }
  | { readonly kind: "visual"; readonly rowId: string; readonly from: number; readonly to: number };

export interface WriterSearchResults {
  readonly matches: readonly WriterSearchMatch[];
  readonly inTags: number;
}

export interface WriterFindAccess {
  readonly visuals: () => boolean;
  readonly setVisuals: (value: boolean) => void;
  readonly search: (needle: string, matchCase: boolean) => WriterSearchResults;
  readonly reveal: (match: WriterSearchMatch) => Range | null;
  readonly replace: (matches: readonly WriterSearchMatch[], text: string) => boolean;
  readonly leave: (match?: WriterSearchMatch) => void;
  readonly selection: () => FlowRange | null;
  readonly pickedText: () => string;
  readonly firstFrom: (matches: readonly WriterSearchMatch[], range: FlowRange | null) => number;
}
