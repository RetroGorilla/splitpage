import { mimeForFilename } from "../../../shared/file-names.js";
import { strBytes } from "../formats/bytes.ts";
import { desktopPort } from "../desktop/desktop-port.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";

export type Delivered = "saved" | "cancelled" | "failed";

async function bytesOf(data: unknown): Promise<Uint8Array> {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return strBytes(String(data));
}

async function toDesktop(filename: string, data: unknown): Promise<Delivered> {
  try {
    const port = desktopPort();
    if (!port) throw new Error("The desktop bridge is not available");
    const ext = (/\.([a-z0-9]+)$/i.exec(filename) || ["", ""])[1]?.toLowerCase() ?? "";
    const picked = await port.saveFileDialog({
      suggestedName: filename,
      filters: [{ name: ext ? ext.toUpperCase() + " file" : "File", extensions: ext ? [ext] : [] }]
    });
    if (!picked) return "cancelled";
    await port.writeFile(picked.id, await bytesOf(data));
    return "saved";
  } catch {
    return "failed";
  }
}

function toDownload(filename: string, data: unknown): Delivered {
  try {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeForFilename(filename) as string });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return "saved";
  } catch {
    return "failed";
  }
}

export function deliverBytes(filename: string, data: unknown): Promise<Delivered> {
  if (runningOnDesktop()) return toDesktop(filename, data);
  return Promise.resolve(toDownload(filename, data));
}
