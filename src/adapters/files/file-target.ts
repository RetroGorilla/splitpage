export interface FileWritable {
  readonly write: (body: unknown) => Promise<unknown>;
  readonly close: () => Promise<unknown>;
}

export interface FileHandle {
  readonly name: string;
  readonly createWritable: () => Promise<FileWritable>;
  readonly getFile: () => Promise<{ readonly lastModified: number }>;
}

export type FileTarget<H extends FileHandle> =
  | { readonly kind: "handle"; readonly handle: H; readonly picked: boolean }
  | { readonly kind: "download" };

export type PickedTarget<H extends FileHandle> = FileTarget<H> | { readonly kind: "cancelled" };

export interface SaveDialogs<H extends FileHandle> {
  readonly desktop: (() => Promise<H | null>) | null;
  readonly browser: (() => Promise<H>) | null;
}

export interface Written {
  readonly lastModified: number | null;
}

const CANCELLED = Object.freeze({ kind: "cancelled" as const });
const DOWNLOAD = Object.freeze({ kind: "download" as const });

export function isAbort(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

export function existingTarget<H extends FileHandle>(handle: H): FileTarget<H> {
  return Object.freeze({ kind: "handle", handle: handle, picked: false });
}

export async function pickTarget<H extends FileHandle>(dialogs: SaveDialogs<H>): Promise<PickedTarget<H>> {
  try {
    if (dialogs.desktop) {
      const chosen = await dialogs.desktop();
      return chosen ? Object.freeze({ kind: "handle", handle: chosen, picked: true }) : CANCELLED;
    }
    if (dialogs.browser) return Object.freeze({ kind: "handle", handle: await dialogs.browser(), picked: true });
  } catch (error) {
    if (isAbort(error)) return CANCELLED;
    throw error;
  }
  return DOWNLOAD;
}

function stampOf(closed: unknown): number | null {
  if (!closed || typeof closed !== "object") return null;
  const stamp = (closed as { lastModified?: unknown }).lastModified;
  return typeof stamp === "number" && Number.isFinite(stamp) ? stamp : null;
}

export async function writeToHandle(handle: FileHandle, body: unknown): Promise<Written> {
  const writable = await handle.createWritable();
  await writable.write(body);
  const stamped = stampOf(await writable.close());
  if (stamped !== null) return Object.freeze({ lastModified: stamped });
  try {
    return Object.freeze({ lastModified: (await handle.getFile()).lastModified });
  } catch {
    return Object.freeze({ lastModified: null });
  }
}

export type FileCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly current: { readonly lastModified: number } | null };

export async function checkFileConflict(handle: Pick<FileHandle, "getFile">, lastModified: number | null | undefined): Promise<FileCheck> {
  if (!lastModified) return { ok: true };
  let current: { readonly lastModified: number };
  try {
    current = await handle.getFile();
  } catch {
    return { ok: false, current: null };
  }
  if (current.lastModified && current.lastModified !== lastModified) {
    return { ok: false, current: current };
  }
  return { ok: true };
}
