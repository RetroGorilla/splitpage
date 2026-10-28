export interface RecentFileData {
  readonly id: string;
  readonly name: string;
  readonly bytes?: Uint8Array;
  readonly lastModified?: number;
}

export interface RecentFileOpenRequest {
  readonly kind: "file";
  readonly fileId: string;
}

export interface RecentFiles {
  readonly available: () => boolean;
  readonly canRemove: () => boolean;
  readonly canClear: () => boolean;
  readonly list: () => Promise<readonly unknown[]> | undefined;
  readonly remove: (fileId: string) => Promise<readonly unknown[]> | undefined;
  readonly clear: () => Promise<readonly unknown[]> | undefined;
  readonly read: (id: string) => Promise<RecentFileData> | undefined;
  readonly routeOpen: (request: RecentFileOpenRequest) => Promise<{ readonly where?: string } | null> | undefined;
}
