import type { DesktopVideo } from "../../application/media/desktop-video.ts";
import { presence } from "./ports/desktop-presence.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";

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
  openPath: (path) => {
    const port = desktopPort();
    if (!port || typeof port.openVideoPath !== "function") return Promise.resolve(null);
    return Promise.resolve(port.openVideoPath(path));
  },
  thumbnail: (host, ref) => {
    const port = desktopPort();
    if (!port || typeof port.videoThumbnail !== "function") return null;
    return Promise.resolve(port.videoThumbnail(host, ref));
  }
};
