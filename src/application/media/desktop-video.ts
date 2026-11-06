import type { DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

export type DesktopVideoResult = DesktopIpcResult<"splitpage:video-file-open">;
export type DesktopVideoThumbnail = DesktopIpcResult<"splitpage:video-thumbnail">;

export interface DesktopVideo {
  readonly present: () => boolean;
  readonly grant: (file: unknown) => Promise<string | null> | null;
  readonly opens: () => boolean;
  readonly open: (token: string) => Promise<DesktopVideoResult | null>;
  readonly pathOf: (file: unknown) => string | null;
  readonly openPath: (path: string) => Promise<DesktopVideoResult | null>;
  readonly thumbnail: (host: string, ref: string) => Promise<DesktopVideoThumbnail | null> | null;
}
