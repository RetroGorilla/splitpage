import type * as Fs from "node:fs";
import type * as FsPromises from "node:fs/promises";
import type * as Path from "node:path";

export type DesktopNativePath = Omit<typeof Path, "resolve" | "basename" | "dirname"> & {
  resolve: (...paths: unknown[]) => ReturnType<typeof Path.resolve>;
  basename: (path: unknown, suffix?: string) => ReturnType<typeof Path.basename>;
  dirname: (path: unknown) => ReturnType<typeof Path.dirname>;
};

export type DesktopNativeFs = typeof Fs & {
  statSync: (path: unknown) => Fs.Stats;
};

export type DesktopNativeFsPromises = typeof FsPromises & {
  stat: (path: unknown) => Promise<Fs.Stats>;
  readFile: {
    (path: unknown): Promise<Buffer<ArrayBuffer>>;
    (path: unknown, encoding: "utf8"): Promise<string>;
  };
  rename: (oldPath: Parameters<typeof FsPromises.rename>[0], newPath: unknown) => ReturnType<typeof FsPromises.rename>;
};
