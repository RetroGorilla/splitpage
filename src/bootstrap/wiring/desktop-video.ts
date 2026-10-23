import type { DesktopVideo, DesktopVideoResult } from "../../application/media/desktop-video.ts";
import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { desktopPort } from "../../adapters/desktop/desktop-port.ts";

export const desktopVideo: DesktopVideo = {
  present: runningOnDesktop,
  grant: (file) => {
    const port = desktopPort();
    if (!runningOnDesktop() || !port || typeof port.grantVideoFile !== "function") return null;
    return Promise.resolve(port.grantVideoFile(file));
  },
  opens: () => {
    const port = desktopPort();
    return runningOnDesktop() && !!port && typeof port.openVideoFile === "function";
  },
  open: (token) => {
    const port = desktopPort();
    if (!port) return Promise.resolve(null);
    return Promise.resolve(port.openVideoFile(token)) as Promise<DesktopVideoResult | null>;
  },
  thumbnail: (host, ref) => {
    const port = desktopPort();
    if (!port || typeof port.videoThumbnail !== "function") return null;
    return Promise.resolve(port.videoThumbnail(host, ref)) as Promise<DesktopVideoResult | null>;
  }
};
