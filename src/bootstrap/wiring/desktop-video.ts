import type { DesktopVideo } from "../../application/media/desktop-video.ts";
import { presence } from "./ports/desktop-presence.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";
import { bundleRefusalText } from "../../adapters/desktop/desktop-handle.ts";

function desktopIdOf(handle: unknown): string | null {
  const id = handle && typeof handle === "object" ? (handle as { readonly _desktopId?: unknown })._desktopId : null;
  return typeof id === "string" && id ? id : null;
}

export const desktopVideo: DesktopVideo = {
  present: presence.running,
  grant: (file) => {
    const port = desktopPort();
    if (!presence.running() || !port || typeof port.grantVideoFile !== "function") return null;
    return Promise.resolve(port.grantVideoFile(file));
  },
  opens: () => {
    const port = desktopPort();
    return presence.running() && !!port && typeof port.openVideoFile === "function";
  },
  open: (token) => {
    const port = desktopPort();
    if (!port) return Promise.resolve(null);
    return Promise.resolve(port.openVideoFile(token));
  },
  pathOf: (file) => {
    const port = desktopPort();
    if (!presence.running() || !port || typeof port.videoFilePath !== "function") return null;
    const found = port.videoFilePath(file);
    return typeof found === "string" && found ? found : null;
  },
  openPath: (path, size) => {
    const port = desktopPort();
    if (!port || typeof port.openVideoPath !== "function") return Promise.resolve(null);
    return Promise.resolve(port.openVideoPath(path, size));
  },
  openBundled: (name) => {
    const port = desktopPort();
    if (!port || typeof port.openBundledFile !== "function") return Promise.resolve(null);
    return Promise.resolve(port.openBundledFile(name));
  },
  bundle: (token, job, onProgress) => {
    const port = desktopPort();
    if (!presence.running() || !port || typeof port.bundleVideoFile !== "function") return Promise.resolve(null);
    return Promise.resolve(port.bundleVideoFile(token, job, onProgress));
  },
  move: (token, job, onProgress) => {
    const port = desktopPort();
    if (!presence.running() || !port || typeof port.moveVideoFile !== "function") return Promise.resolve(null);
    return Promise.resolve(port.moveVideoFile(token, job, onProgress));
  },
  onCarry: (listener) => {
    const port = desktopPort();
    if (port && typeof port.onBundleCarry === "function") port.onBundleCarry(listener);
  },
  cancelBundle: (job) => {
    const port = desktopPort();
    if (port && typeof port.cancelBundle === "function") port.cancelBundle(job);
  },
  planSave: async (handle, names) => {
    const port = desktopPort();
    const id = desktopIdOf(handle);
    if (!presence.running() || !port || typeof port.planBundleSave !== "function" || !id) return null;
    const answer = await port.planBundleSave(id, [...names]);
    if (answer && !answer.ok && "refused" in answer) throw new Error(bundleRefusalText(answer.refused));
    return answer && answer.ok ? answer.plan : null;
  },
  chooseSave: async (handle, choice) => {
    const port = desktopPort();
    const id = desktopIdOf(handle);
    if (!port || typeof port.chooseBundleSave !== "function" || !id) return null;
    const answer = await port.chooseBundleSave(id, choice);
    if (answer && !answer.ok && "refused" in answer) throw new Error(bundleRefusalText(answer.refused));
    return answer && answer.ok && Array.isArray(answer.links) ? answer.links : null;
  },
  planExport: async (job, scriptName, body, script) => {
    const port = desktopPort();
    if (!presence.running() || !port || typeof port.planBundleExport !== "function") return null;
    const answer = await port.planBundleExport(job, scriptName, new TextEncoder().encode(body), desktopIdOf(script) || "");
    return answer && answer.ok ? answer.plan : null;
  },
  pickExport: async (suggestedName, job) => {
    const port = desktopPort();
    if (!presence.running() || !port) return null;
    const picked = await port.saveFileDialog({ suggestedName, filters: [{ name: "ZIP file", extensions: ["zip"] }], bundleExport: true, exportJob: job });
    return picked ? { id: picked.id, name: picked.name } : null;
  },
  exportBundle: (job, fileId, onProgress) => {
    const port = desktopPort();
    if (!presence.running() || !port || typeof port.exportBundle !== "function") return Promise.resolve(null);
    return Promise.resolve(port.exportBundle(job, fileId, onProgress));
  },
  thumbnail: (host, ref) => {
    const port = desktopPort();
    if (!port || typeof port.videoThumbnail !== "function") return null;
    return Promise.resolve(port.videoThumbnail(host, ref));
  }
};
