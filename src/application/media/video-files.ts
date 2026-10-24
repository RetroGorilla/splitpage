import type { VideoLink } from "../../core/document/gallery.ts";

export interface VideoFiles {
  readonly grant: (file: unknown, link: VideoLink) => void;
  readonly has: (link: VideoLink | null | undefined) => boolean;
  readonly url: (link: VideoLink) => string | null;
  readonly releaseUrls: () => void;
  readonly openFile: (link: VideoLink) => void;
  readonly openGallery: (rowId: string, slot: number, key: unknown) => void;
}
