import type { ImageRef } from "../../core/document/ports.ts";

export interface PictureStore {
  readonly intern: (bytes: Uint8Array) => ImageRef | null;
  readonly internDataUrl: (dataUrl: string) => ImageRef | null;
  readonly recordFor: (sha: string) => ImageRef | null;
  readonly bytesFor: (sha: string) => Uint8Array | null;
  readonly urlFor: (sha: string) => string | null;
  readonly dataUrlFor: (sha: string) => string | null;
  readonly isDurable: (sha: string) => boolean;
  readonly queuePersist: (shas: readonly string[]) => void;
  readonly persist: (shas: readonly string[]) => Promise<string[]>;
  readonly ensureBytes: (shas: readonly string[]) => Promise<string[]>;
  readonly imgHtml: (ref: ImageRef, className?: string) => string;
}
