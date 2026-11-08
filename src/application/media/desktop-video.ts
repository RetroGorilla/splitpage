import type {
  DesktopIpcArgs, DesktopIpcResult, DesktopWireBundleCarryNote, DesktopWireBundleExport, DesktopWireBundleExportPlan, DesktopWireBundleSavePlan
} from "../../../shared/desktop-contract.d.ts";
import type { BundledPathLink } from "../../core/document/gallery.ts";

export type DesktopVideoResult = DesktopIpcResult<"splitpage:video-file-open">;
export type DesktopVideoThumbnail = DesktopIpcResult<"splitpage:video-thumbnail">;
export type DesktopBundleCopy = DesktopIpcResult<"splitpage:bundle-file">;
export type DesktopBundleMove = DesktopIpcResult<"splitpage:bundle-move">;
export type DesktopBundleCarry = DesktopWireBundleCarryNote;
export type DesktopBundleSavePlan = DesktopWireBundleSavePlan;
export type BundleSaveChoice = "copy" | "link";
export type DesktopBundleExportPlan = DesktopWireBundleExportPlan;
export type DesktopBundleExport = DesktopWireBundleExport;
export type BundleProgressListener = (progress: Pick<DesktopIpcArgs<"splitpage:bundle-progress">[0], "done" | "total">) => void;

export interface DesktopVideo {
  readonly present: () => boolean;
  readonly grant: (file: unknown) => Promise<string | null> | null;
  readonly opens: () => boolean;
  readonly open: (token: string) => Promise<DesktopVideoResult | null>;
  readonly pathOf: (file: unknown) => string | null;
  readonly openPath: (path: string, size?: number) => Promise<DesktopVideoResult | null>;
  readonly openBundled: (name: string) => Promise<DesktopVideoResult | null>;
  readonly bundle: (token: string, job: string, onProgress: BundleProgressListener) => Promise<DesktopBundleCopy | null>;
  readonly move: (token: string, job: string, onProgress: BundleProgressListener) => Promise<DesktopBundleMove | null>;
  readonly onCarry: (listener: (note: DesktopBundleCarry) => void) => void;
  readonly cancelBundle: (job: string) => void;
  readonly planSave: (handle: unknown, names: readonly string[]) => Promise<DesktopBundleSavePlan | null>;
  readonly chooseSave: (handle: unknown, choice: BundleSaveChoice) => Promise<readonly BundledPathLink[] | null>;
  readonly planExport: (job: string, scriptName: string, body: string, script: unknown) => Promise<DesktopBundleExportPlan | null>;
  readonly pickExport: (suggestedName: string, job: string) => Promise<{ readonly id: string; readonly name: string } | null>;
  readonly exportBundle: (job: string, fileId: string, onProgress: BundleProgressListener) => Promise<DesktopBundleExport | null>;
  readonly thumbnail: (host: string, ref: string) => Promise<DesktopVideoThumbnail | null> | null;
}
