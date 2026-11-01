import type { DesktopIpcArgs, DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";

export type RecentFileData = Pick<DesktopIpcResult<"splitpage:read-file">, "id" | "name" | "bytes" | "lastModified">;

export type RecentFileOpenRequest = DesktopIpcArgs<"splitpage:route-open">[0];

export interface RecentFiles {
  readonly available: () => boolean;
  readonly canRemove: () => boolean;
  readonly canClear: () => boolean;
  readonly list: () => Promise<DesktopIpcResult<"splitpage:recents-list">> | undefined;
  readonly remove: (fileId: string) => Promise<DesktopIpcResult<"splitpage:recents-remove">> | undefined;
  readonly clear: () => Promise<DesktopIpcResult<"splitpage:recents-clear">> | undefined;
  readonly read: (id: string) => Promise<RecentFileData> | undefined;
  readonly routeOpen: (request: RecentFileOpenRequest) => Promise<DesktopIpcResult<"splitpage:route-open">> | undefined;
}
