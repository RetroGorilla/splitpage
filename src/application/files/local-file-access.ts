import type { FileSaveCheck } from "../save/file-saving-ports.ts";

export interface LocalFileHandle {
  readonly name?: string;
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
  readonly read: (handle: unknown) => Promise<LocalFileData>;
  readonly text: (file: LocalFileData) => Promise<string>;
  readonly permission: (handle: unknown, options: { mode: "readwrite" }) => Promise<string>;
  readonly openPicker: ((options: unknown) => Promise<LocalFileHandle[]>) | null;
  readonly desktopHandle: (entry: unknown) => LocalFileHandle;
  readonly checkConflict: (handle: unknown, lastModified: unknown) => Promise<FileSaveCheck>;
  readonly createWritable: (handle: unknown) => Promise<LocalFileWritable>;
}

export interface LocalFileData {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly text: () => Promise<string>;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}
