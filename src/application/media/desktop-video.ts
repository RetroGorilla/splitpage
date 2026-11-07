import type { DesktopIpcArgs, DesktopIpcResult, DesktopWireBundleCarryNote, DesktopWireBundleSavePlan } from "../../../shared/desktop-contract.d.ts";

export type DesktopVideoResult = DesktopIpcResult<"splitpage:video-file-open">;
export type DesktopVideoThumbnail = DesktopIpcResult<"splitpage:video-thumbnail">;
export type DesktopBundleCopy = DesktopIpcResult<"splitpage:bundle-file">;
export type DesktopBundleCarry = DesktopWireBundleCarryNote;
export type DesktopBundleSavePlan = DesktopWireBundleSavePlan;
export type BundleSaveChoice = "copy" | "link";
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
  readonly onCarry: (listener: (note: DesktopBundleCarry) => void) => void;
  readonly cancelBundle: (job: string) => void;
  readonly planSave: (handle: unknown, names: readonly string[]) => Promise<DesktopBundleSavePlan | null>;
  readonly chooseSave: (handle: unknown, choice: BundleSaveChoice) => Promise<boolean>;
  readonly thumbnail: (host: string, ref: string) => Promise<DesktopVideoThumbnail | null> | null;
}
