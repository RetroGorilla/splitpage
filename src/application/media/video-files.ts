import type { VideoLink } from "../../core/document/gallery.ts";
import type { BundleProgressListener, DesktopBundleCopy, DesktopBundleMove } from "./desktop-video.ts";

export interface VideoPosterFrame {
  readonly dataUrl: string;
  readonly duration: number;
}

export interface VideoFiles {
  readonly movedPath: (path: string) => void;
  readonly grant: (file: unknown, link: VideoLink) => void;
  readonly has: (link: VideoLink | null | undefined) => boolean;
  readonly url: (link: VideoLink) => string | null;
  readonly releaseUrls: () => void;
  readonly openFile: (link: VideoLink) => void;
  readonly openGallery: (rowId: string, slot: number, key: unknown) => void;
  readonly bundle: (link: VideoLink, job: string, onProgress: BundleProgressListener) => Promise<DesktopBundleCopy>;
  readonly move: (link: VideoLink, job: string, onProgress: BundleProgressListener) => Promise<DesktopBundleMove>;
  readonly cancelBundle: (job: string) => void;
}
