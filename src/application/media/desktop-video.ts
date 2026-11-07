import type { DesktopIpcArgs, DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

export type DesktopVideoResult = DesktopIpcResult<"splitpage:video-file-open">;
export type DesktopVideoThumbnail = DesktopIpcResult<"splitpage:video-thumbnail">;
export type DesktopBundleCopy = DesktopIpcResult<"splitpage:bundle-file">;
export type DesktopBundleCarry = DesktopIpcResult<"splitpage:bundle-carry">;
export type BundleProgressListener = (progress: Pick<DesktopIpcArgs<"splitpage:bundle-progress">[0], "done" | "total">) => void;

export interface DesktopVideo {
  readonly present: () => boolean;
  readonly grant: (file: unknown) => Promise<string | null> | null;
  readonly opens: () => boolean;
  readonly open: (token: string) => Promise<DesktopVideoResult | null>;
  readonly pathOf: (file: unknown) => string | null;
  readonly openPath: (path: string) => Promise<DesktopVideoResult | null>;
  readonly openBundled: (name: string) => Promise<DesktopVideoResult | null>;
  readonly bundle: (token: string, job: string, onProgress: BundleProgressListener) => Promise<DesktopBundleCopy | null>;
  readonly carry: (toFileId: string, names: readonly string[], job: string, onProgress: BundleProgressListener) => Promise<DesktopBundleCarry | null>;
  readonly cancelBundle: (job: string) => void;
  readonly thumbnail: (host: string, ref: string) => Promise<DesktopVideoThumbnail | null> | null;
}
