import type { DesktopIpcResult } from "../../../shared/desktop-contract.d.ts";
export type FileSaveCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly current: { readonly lastModified: number } | null }
  | { readonly ok: false; readonly current: null; readonly denied: true };

export interface LocalFileHandle {
  readonly name?: string;
  readonly _desktopId?: string;
  readonly getFile: () => Promise<LocalFileData>;
  readonly queryPermission: (options: { mode: "readwrite" }) => Promise<string>;
  readonly requestPermission: (options: { mode: "readwrite" }) => Promise<string>;
  readonly createWritable?: () => Promise<LocalFileWritable>;
}

export type LocalFileReference = Partial<LocalFileHandle>;

export interface LocalFileWritable {
  readonly abort?: () => Promise<void>;
  readonly write: (data: unknown) => Promise<void>;
  readonly close: () => Promise<unknown>;
}

export interface LocalFileAccess {
  readonly read: (handle: LocalFileReference | null | undefined) => Promise<LocalFileData>;
  readonly text: (file: LocalFileData) => Promise<string>;
  readonly permission: (handle: LocalFileReference | null | undefined, options: { mode: "readwrite" }) => Promise<string>;
  readonly openPicker: ((options: unknown) => Promise<LocalFileHandle[]>) | null;
  readonly desktopHandle: (entry: Pick<DesktopIpcResult<"splitpage:read-file">, "id" | "name">) => LocalFileHandle;
  readonly checkConflict: (handle: LocalFileReference | null | undefined, lastModified: number | null | undefined) => Promise<FileSaveCheck>;
  readonly createWritable: (handle: LocalFileReference | null | undefined) => Promise<LocalFileWritable>;
}

export interface LocalFileData {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly text: () => Promise<string>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}
