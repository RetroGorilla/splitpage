import type { VideoFiles } from "../../application/media/video-files.ts";
import { startVideoFiles as mountVideoFiles } from "../../features/gallery/video-files.ts";
import type { VideoFileMount, VideoFilePorts } from "../../features/gallery/video-files-ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { desktopVideo } from "./desktop-video.ts";
import { externalLinks } from "./ports/desktop.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";

const owner = owned<VideoFileMount>();

function running(): VideoFileMount {
  const current = owner.owner();
  if (!current) throw new Error("The session video files are not mounted yet");
  return current;
}

export const videoFiles: VideoFiles = {
  grant: (file, link) => running().grant(file, link),
  has: (link) => running().has(link),
  url: (link) => running().url(link),
  releaseUrls: () => running().releaseUrls(),
  openFile: (link) => running().openFile(link),
  openGallery: (rowId, slot, key) => running().openGallery(rowId, slot, key),
  bundle: (link, job, onProgress) => running().bundle(link, job, onProgress),
  move: (link, job, onProgress) => running().move(link, job, onProgress),
  cancelBundle: (job) => running().cancelBundle(job)
};

export function mountVideoFilesFeature(): VideoFileMount {
  return owner.replace(() => {
    const ports: VideoFilePorts = { document: documentReader, notices, desktop: desktopVideo, externalLinks };
    return mountVideoFiles(ports);
  });
}

export const stopVideoFilesFeature = owner.stop;
