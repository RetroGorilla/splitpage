import { rowIndexOf } from "../../core/document/rows.ts";
import { safeHref } from "../../core/document/text-policy.ts";
import { normalizeVideoLink, rowSlots, videoLinkKey } from "../../core/document/gallery.ts";
import type { DesktopVideoResult } from "../../application/media/desktop-video.ts";
import type { DocumentView } from "../../application/session/document-session.ts";
import type { VideoLink } from "../../core/document/gallery.ts";
import type { VideoFileMount, VideoFilePorts } from "./video-files-ports.ts";

export function startVideoFiles(ports: VideoFilePorts): VideoFileMount {
  let disposed = false;
  let videoFileTokens: Record<string, string> = {};
  let sessionVideoFiles: Record<string, unknown> = {};
  const sessionVideoUrls: Record<string, string> = {};

  function grantVideoFile(file: unknown, link: VideoLink): void {
    if (disposed) return;
    const key = videoLinkKey(normalizeVideoLink(link) || link);
    if (file && typeof (file as { size?: unknown }).size === "number") {
      if (sessionVideoUrls[key] && sessionVideoFiles[key] !== file) {
        try { URL.revokeObjectURL(sessionVideoUrls[key]); } catch (e) { }
        Reflect.deleteProperty(sessionVideoUrls, key);
      }
      sessionVideoFiles[key] = file;
    }
    const granting = ports.desktop.grant(file);
    if (granting === null) return;
    Promise.resolve(granting).then(function (token: string | null) {
      if (disposed) return;
      if (typeof token === "string" && token) videoFileTokens[key] = token;
    }, function () {});
  }

  function hasSessionVideo(link: VideoLink | null | undefined): boolean {
    return !!(!disposed && link && !link.href && sessionVideoFiles[videoLinkKey(link)]);
  }

  function sessionVideoUrl(link: VideoLink): string | null {
    if (!hasSessionVideo(link)) return null;
    const key = videoLinkKey(link);
    if (!sessionVideoUrls[key]) {
      try { sessionVideoUrls[key] = URL.createObjectURL(sessionVideoFiles[key] as Blob); } catch (e) { return null; }
    }
    return sessionVideoUrls[key];
  }

  function releaseSessionVideoUrls(): void {
    Object.keys(sessionVideoUrls).forEach(function (key) {
      try { URL.revokeObjectURL(sessionVideoUrls[key] as string); } catch (e) { }
      Reflect.deleteProperty(sessionVideoUrls, key);
    });
  }

  function openVideoFile(link: VideoLink): void {
    if (disposed) return;
    const name = link.name || "that video";
    if (!ports.desktop.opens()) {
      ports.notices.show("“" + name + "” is a video file on the computer it was added from — only its name is kept here. " +
        "Open it from there, or in the Splitpage desktop app.", "warn", true);
      return;
    }
    const token = videoFileTokens[videoLinkKey(link)];
    if (!token) {
      ports.notices.show("Splitpage only opens a video file you dropped or pasted in since it started — " +
        "drop “" + name + "” onto this beat again to open it from here.", "warn", true);
      return;
    }
    Promise.resolve(ports.desktop.open(token)).then(function (res: DesktopVideoResult | null) {
      if (disposed) return;
      if (res && res.ok) return;
      ports.notices.show("Could not open “" + name + "”" + (res && res.code === "GONE" ? " — it is no longer where it was." : "."), "error");
    }, function () { if (!disposed) ports.notices.show("Could not open “" + name + "”.", "error"); });
  }

  function openGalleryLink(rowId: string, slot: number, key: unknown): void {
    if (disposed) return;
    const idx = ports.document.read(function (doc: DocumentView | null) { return rowIndexOf(doc, rowId); });
    if (idx === -1) return;
    const s = rowSlots((ports.document.current() as { rows: readonly unknown[] }).rows[idx])[slot];
    const link = s && s.links.filter(function (l: VideoLink) { return videoLinkKey(l) === key; })[0];
    if (!link) return;
    if (link.href) {
      const href = safeHref(link.href);
      if (!href || !/^https?:\/\//i.test(href)) return;
      if (ports.externalLinks.available()) { ports.externalLinks.open(href); return; }
      const win = window.open(href, "_blank", "noopener");
      if (win) win.opener = null;
      return;
    }
    openVideoFile(link);
  }

  const off = ports.document.onReplaced(releaseSessionVideoUrls);
  return {
    grant: grantVideoFile, has: hasSessionVideo, url: sessionVideoUrl,
    releaseUrls: releaseSessionVideoUrls, openFile: openVideoFile, openGallery: openGalleryLink,
    dispose: function (): void {
      if (disposed) return;
      disposed = true;
      off();
      releaseSessionVideoUrls();
      sessionVideoFiles = {};
      videoFileTokens = {};
    }
  };
}
