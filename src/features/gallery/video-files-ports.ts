import type { ExternalLinks } from "../../application/desktop-presence.ts";
import type { NoticePort } from "../../application/effects/ports.ts";
import type { DesktopVideo } from "../../application/media/desktop-video.ts";
import type { VideoFiles } from "../../application/media/video-files.ts";
import type { DocumentReader } from "../../application/session/document-reader.ts";

export interface VideoFilePorts {
  readonly document: Pick<DocumentReader, "current" | "read" | "onReplaced">;
  readonly notices: Pick<NoticePort, "show">;
  readonly desktop: Pick<DesktopVideo, "grant" | "opens" | "open" | "openPath" | "openBundled" | "bundle" | "move" | "cancelBundle">;
  readonly externalLinks: ExternalLinks;
}

export interface VideoFileMount extends VideoFiles {
  readonly dispose: () => void;
}
