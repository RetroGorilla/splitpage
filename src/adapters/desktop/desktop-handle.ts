import { mimeForFilename } from "../../../shared/file-names.ts";
import { concatBytes, strBytes } from "../formats/bytes.ts";
import { desktopPort } from "./desktop-port.ts";
import type { DesktopFileEntry, DesktopPort } from "./desktop-port.ts";

export interface DesktopWritable {
  readonly write: (chunk: unknown) => Promise<void>;
  readonly close: () => Promise<{ readonly lastModified: number } | undefined>;
}

export interface DesktopFileHandle {
  readonly kind: "file";
  name: string;
  readonly _desktopId: string;
  readonly getFile: () => Promise<File>;
  readonly createWritable: () => Promise<DesktopWritable>;
  readonly queryPermission: () => Promise<"granted">;
  readonly requestPermission: () => Promise<"granted">;
  readonly isSameEntry: (other: unknown) => boolean;
}

function bundleRefusalText(refused: { readonly reason: string; readonly folder: string; readonly name: string }): string {
  const folder = "“" + refused.folder + "”";
  if (refused.reason === "clash") return folder + " already has a different “" + refused.name + "”. Rename or move that file, then save again";
  if (refused.reason === "cancelled") return "copying the videos to " + folder + " was stopped, so the script was not saved there";
  return "“" + refused.name + "” could not be copied to " + folder + ", so the script was not saved there";
}

function bridge(): DesktopPort {
  const port = desktopPort();
  if (!port) throw new Error("The desktop bridge is not available");
  return port;
}

function chunkBytes(chunk: unknown): Uint8Array | Promise<Uint8Array> {
  if (typeof chunk === "string") return strBytes(chunk);
  if (chunk instanceof Blob) return chunk.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return strBytes(String(chunk));
}

export function makeDesktopHandle(entry: Pick<DesktopFileEntry, "id" | "name"> | undefined): DesktopFileHandle {
  const id = (entry as NonNullable<typeof entry>).id;
  let name = (entry as NonNullable<typeof entry>).name;
  const handle: DesktopFileHandle = {
    kind: "file",
    name: name,
    _desktopId: id,
    getFile: function () {
      return bridge().readFile(id).then(function (fresh) {
        name = fresh.name || name;
        handle.name = name;
        const bytes = fresh.bytes instanceof Uint8Array ? fresh.bytes : new Uint8Array(fresh.bytes || []);
        return new File([bytes as BlobPart], name, { lastModified: fresh.lastModified, type: mimeForFilename(name) as string });
      });
    },
    createWritable: function () {
      const chunks: Uint8Array[] = [];
      return Promise.resolve({
        write: function (chunk: unknown) {
          const bytes = chunkBytes(chunk);
          if (bytes instanceof Uint8Array) {
            chunks.push(bytes);
            return Promise.resolve();
          }
          return bytes.then(function (b) { chunks.push(b); });
        },
        close: function () {
          return bridge().writeFile(id, concatBytes(chunks)).then(function (written) {
            const refused = written && written.bundleRefused;
            if (refused) throw new Error(bundleRefusalText(refused));
            const stamp = written && written.lastModified;
            return typeof stamp === "number" && isFinite(stamp) ? { lastModified: stamp } : undefined;
          });
        }
      });
    },
    queryPermission: function () { return Promise.resolve("granted" as const); },
    requestPermission: function () { return Promise.resolve("granted" as const); },
    isSameEntry: function (other: unknown) { return !!other && (other as { _desktopId?: unknown })._desktopId === id; }
  };
  return handle;
}
