import { rowIndexOf } from "../../core/document/rows.ts";
import { safeHref } from "../../core/document/text-policy.ts";
import { normalizeVideoLink, rowSlots, videoLinkKey } from "../../core/document/gallery.ts";

export function startVideoFiles(ports) {
  var disposed = false;
  var videoFileTokens = {};
  var sessionVideoFiles = {};
  var sessionVideoUrls = {};

  function grantVideoFile(file, link) {
    if (disposed) return;
    var key = videoLinkKey(normalizeVideoLink(link) || link);
    if (file && typeof file.size === "number") {
      if (sessionVideoUrls[key] && sessionVideoFiles[key] !== file) {
        try { URL.revokeObjectURL(sessionVideoUrls[key]); } catch (e) { }
        delete sessionVideoUrls[key];
      }
      sessionVideoFiles[key] = file;
    }
    var granting = ports.desktop.grant(file);
    if (granting === null) return;
    Promise.resolve(granting).then(function (token) {
      if (disposed) return;
      if (typeof token === "string" && token) videoFileTokens[key] = token;
    }, function () {});
  }

  function hasSessionVideo(link) {
    return !!(!disposed && link && !link.href && sessionVideoFiles[videoLinkKey(link)]);
  }

  function sessionVideoUrl(link) {
    if (!hasSessionVideo(link)) return null;
    var key = videoLinkKey(link);
    if (!sessionVideoUrls[key]) {
      try { sessionVideoUrls[key] = URL.createObjectURL(sessionVideoFiles[key]); } catch (e) { return null; }
    }
    return sessionVideoUrls[key];
  }

  function releaseSessionVideoUrls() {
    Object.keys(sessionVideoUrls).forEach(function (key) {
      try { URL.revokeObjectURL(sessionVideoUrls[key]); } catch (e) { }
      delete sessionVideoUrls[key];
    });
  }

  function openVideoFile(link) {
    if (disposed) return;
    var name = link.name || "that video";
    if (!ports.desktop.opens()) {
      ports.notices.show("“" + name + "” is a video file on the computer it was added from — only its name is kept here. " +
        "Open it from there, or in the Splitpage desktop app.", "warn", true);
      return;
    }
    var token = videoFileTokens[videoLinkKey(link)];
    if (!token) {
      ports.notices.show("Splitpage only opens a video file you dropped or pasted in since it started — " +
        "drop “" + name + "” onto this scene again to open it from here.", "warn", true);
      return;
    }
    Promise.resolve(ports.desktop.open(token)).then(function (res) {
      if (disposed) return;
      if (res && res.ok) return;
      ports.notices.show("Could not open “" + name + "”" + (res && res.code === "GONE" ? " — it is no longer where it was." : "."), "error");
    }, function () { if (!disposed) ports.notices.show("Could not open “" + name + "”.", "error"); });
  }

  function openGalleryLink(rowId, slot, key) {
    if (disposed) return;
    var idx = ports.document.read(function (doc) { return rowIndexOf(doc, rowId); });
    if (idx === -1) return;
    var s = rowSlots(ports.document.current().rows[idx])[slot];
    var link = s && s.links.filter(function (l) { return videoLinkKey(l) === key; })[0];
    if (!link) return;
    if (link.href) {
      var href = safeHref(link.href);
      if (!href || !/^https?:\/\//i.test(href)) return;
      if (ports.externalLinks.available()) { ports.externalLinks.open(href); return; }
      var win = window.open(href, "_blank", "noopener");
      if (win) win.opener = null;
      return;
    }
    openVideoFile(link);
  }

  var off = ports.document.onReplaced(releaseSessionVideoUrls);
  return {
    grant: grantVideoFile, has: hasSessionVideo, url: sessionVideoUrl,
    releaseUrls: releaseSessionVideoUrls, openFile: openVideoFile, openGallery: openGalleryLink,
    dispose: function () {
      if (disposed) return;
      disposed = true;
      off();
      releaseSessionVideoUrls();
      sessionVideoFiles = {};
      videoFileTokens = {};
    }
  };
}
