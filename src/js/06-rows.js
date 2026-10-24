import { rowIndexOf } from "../core/document/rows.ts";
import { safeHref } from "./04-richtext.js";
import { currentDocument, onDocumentReplaced, readSession } from "../legacy/session-bridge.ts";
import { showToast } from "../legacy/effects-bridge.ts";
import { normalizeVideoLink, rowSlots, videoLinkKey } from "../core/document/gallery.ts";
import { desktopPort } from "../adapters/desktop/desktop-port.ts";
import { runningOnDesktop } from "../application/desktop-presence.ts";

var videoFileTokens = {};
var sessionVideoFiles = {};
var sessionVideoUrls = {};

export function grantVideoFile(file, link) {
  var key = videoLinkKey(normalizeVideoLink(link) || link);
  if (file && typeof file.size === "number") {
    if (sessionVideoUrls[key] && sessionVideoFiles[key] !== file) {
      try { URL.revokeObjectURL(sessionVideoUrls[key]); } catch (e) { }
      delete sessionVideoUrls[key];
    }
    sessionVideoFiles[key] = file;
  }
  if (!runningOnDesktop() || typeof desktopPort().grantVideoFile !== "function") return;
  Promise.resolve(desktopPort().grantVideoFile(file)).then(function (token) {
    if (typeof token === "string" && token) videoFileTokens[key] = token;
  }, function () {});
}

export function hasSessionVideo(link) {
  return !!(link && !link.href && sessionVideoFiles[videoLinkKey(link)]);
}

export function sessionVideoUrl(link) {
  if (!hasSessionVideo(link)) return null;
  var key = videoLinkKey(link);
  if (!sessionVideoUrls[key]) {
    try { sessionVideoUrls[key] = URL.createObjectURL(sessionVideoFiles[key]); } catch (e) { return null; }
  }
  return sessionVideoUrls[key];
}

export function releaseSessionVideoUrls() {
  Object.keys(sessionVideoUrls).forEach(function (key) {
    try { URL.revokeObjectURL(sessionVideoUrls[key]); } catch (e) { }
    delete sessionVideoUrls[key];
  });
}

export function openVideoFile(link) {
  var name = link.name || "that video";
  if (!runningOnDesktop() || typeof desktopPort().openVideoFile !== "function") {
    showToast("“" + name + "” is a video file on the computer it was added from — only its name is kept here. " +
      "Open it from there, or in the Splitpage desktop app.", "warn", true);
    return;
  }
  var token = videoFileTokens[videoLinkKey(link)];
  if (!token) {
    showToast("Splitpage only opens a video file you dropped or pasted in since it started — " +
      "drop “" + name + "” onto this scene again to open it from here.", "warn", true);
    return;
  }
  Promise.resolve(desktopPort().openVideoFile(token)).then(function (res) {
    if (res && res.ok) return;
    showToast("Could not open “" + name + "”" + (res && res.code === "GONE" ? " — it is no longer where it was." : "."), "error");
  }, function () { showToast("Could not open “" + name + "”.", "error"); });
}

export function openGalleryLink(rowId, slot, key) {
  var idx = readSession(function (doc) { return rowIndexOf(doc, rowId); });
  if (idx === -1) return;
  var s = rowSlots(currentDocument().rows[idx])[slot];
  var link = s && s.links.filter(function (l) { return videoLinkKey(l) === key; })[0];
  if (!link) return;
  if (link.href) {
    var href = safeHref(link.href);
    if (!href || !/^https?:\/\//i.test(href)) return;
    if (runningOnDesktop() && desktopPort().openExternal) { desktopPort().openExternal(href); return; }
    var win = window.open(href, "_blank", "noopener");
    if (win) win.opener = null;
    return;
  }
  openVideoFile(link);
}

export function __init() {
  onDocumentReplaced(releaseSessionVideoUrls);
}
