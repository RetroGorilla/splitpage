export interface RecentFileData {
  readonly id: string;
  readonly name: string;
  readonly bytes?: Uint8Array;
  readonly lastModified?: number;
}

export interface RecentFileOpenRequest {
  readonly kind: "file" | "server";
  readonly fileId?: string;
  readonly serverDocId?: string;
  readonly serverUrl?: string;
  readonly token?: string;
  readonly tunnel?: unknown;
}

export interface RecentFiles {
  readonly list: () => Promise<readonly unknown[]> | undefined;
  readonly remove: (fileId: string) => Promise<readonly unknown[]> | undefined;
  readonly clear: () => Promise<readonly unknown[]> | undefined;
  readonly read: (id: string) => Promise<RecentFileData> | undefined;
  readonly routeOpen: (request: RecentFileOpenRequest) => Promise<{ readonly where?: string } | null> | undefined;
}
