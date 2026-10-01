import { makeId } from "./02-state.js";
import { internDataUrl, queuePersist, recordFor } from "./02c-blobs.js";
import { isSha256Hex, normalizeImageRef } from "../../shared/blob-policy.js";
import { tagCategory } from "./07-production-tags.js";
import { BROLL_MARKER_RE } from "./08c-broll.js";

export function inertBody(html) {
  var doc = new DOMParser().parseFromString(
    "<!doctype html><body>" + (html == null ? "" : String(html)), "text/html");
  return doc.body;
}

export function sanitizeHtml(html) {
  var out = document.createElement("div");
  walkSanitize(inertBody(html), out);
  return out.innerHTML;
}

export function safeImageSrc(src) {
  if (typeof src !== "string") return null;
  return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/.test(src) ? src : null;
}

export function imageRefOf(node) {
  var sha = node.getAttribute("data-blob");
  if (isSha256Hex(sha)) {
    return recordFor(sha) || normalizeImageRef({
      sha256: sha,
      width: imageDimAttr(node.getAttribute("data-w")),
      height: imageDimAttr(node.getAttribute("data-h")),
      mime: node.getAttribute("data-mime")
    }) || { sha256: sha };
  }
  var src = safeImageSrc(node.getAttribute("src") || "");
  var rec = src ? internDataUrl(src) : null;
  if (rec) queuePersist([rec.sha256]);
  return rec;
}

function imageDimAttr(v) {
  return typeof v === "string" && /^[1-9][0-9]{0,6}$/.test(v) ? parseInt(v, 10) : NaN;
}

function storedImageEl(ref) {
  var img = document.createElement("img");
  img.className = "comment-img";
  img.setAttribute("data-blob", ref.sha256);
  if (ref.width && ref.height && ref.mime) {
    img.setAttribute("data-w", String(ref.width));
    img.setAttribute("data-h", String(ref.height));
    img.setAttribute("data-mime", ref.mime);
  }
  return img;
}

export function storedImageHtml(ref) {
  var clean = normalizeImageRef(ref);
  if (!clean) return "";
  return storedImageEl(clean).outerHTML;
}

var STORED_IMG_ATTRS = { "class": true, "data-blob": true, "data-w": true, "data-h": true, "data-mime": true };

export function storedHtmlFromDom(html) {
  if (typeof html !== "string" || html.indexOf("data-blob") === -1) return html;
  var body = inertBody(html);
  var imgs = body.querySelectorAll("img[data-blob]");
  if (!imgs.length) return html;
  Array.prototype.forEach.call(imgs, function (img) {
    Array.prototype.slice.call(img.attributes).forEach(function (a) {
      if (!STORED_IMG_ATTRS[a.name]) img.removeAttribute(a.name);
    });
  });
  return body.innerHTML;
}

export function safeHref(href) {
  if (typeof href !== "string") return null;
  var trimmed = href.trim();
  /* eslint-disable-next-line no-control-regex -- deliberate: "java\\0script:"
     resolves as javascript: in a browser, so the probe has to see past them. */
  var probe = trimmed.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (probe.indexOf("javascript:") === 0 || probe.indexOf("vbscript:") === 0) return null;
  if (probe.indexOf("data:") === 0) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.indexOf("mailto:") === 0) return trimmed;
  return null;
}

export function plainText(v) {
  /* eslint-disable-next-line no-control-regex -- C0 controls, minus tab/LF/CR,
     are exactly what a plain-text field must not carry. */
  return String(v == null ? "" : v).replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function plainName(v) {
  var name = plainText(v).trim().slice(0, 80);
  return name || "Anonymous";
}

export function safeId(id, prefix) {
  var clean = String(id == null ? "" : id).replace(/[^A-Za-z0-9_-]/g, "");
  return clean || makeId(prefix);
}

export function cssAttr(value) {
  return String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function wrapNodes(nodesArr, tagName) {
  var w = document.createElement(tagName);
  nodesArr.forEach(function (n) { w.appendChild(n); });
  return [w];
}

function walkSanitize(srcParent, destParent) {
  var kids = Array.prototype.slice.call(srcParent.childNodes);
  kids.forEach(function (node) {
    if (node.nodeType === 3) {
      destParent.appendChild(document.createTextNode(node.nodeValue));
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.tagName;

    if (tag === "DIV" || tag === "P") {
      var isBlankPara = node.childNodes.length === 1 &&
        node.firstChild.nodeType === 1 && node.firstChild.tagName === "BR";
      if (!isBlankPara) walkSanitize(node, destParent);
      destParent.appendChild(document.createElement("br"));
      return;
    }
    if (tag === "BR") { destParent.appendChild(document.createElement("br")); return; }

    if (tag === "STRONG" || tag === "B") {
      var bStyle = node.style || {};
      var bWeight = bStyle.fontWeight;
      var bWeightNum = parseInt(bWeight, 10);
      var boldCancelled = bWeight === "normal" || bWeight === "400" ||
        (!isNaN(bWeightNum) && bWeightNum < 600);
      if (boldCancelled) { walkSanitize(node, destParent); return; }
      var st = document.createElement("strong"); walkSanitize(node, st); destParent.appendChild(st); return;
    }
    if (tag === "EM" || tag === "I") { var em = document.createElement("em"); walkSanitize(node, em); destParent.appendChild(em); return; }
    if (tag === "U") { var u = document.createElement("u"); walkSanitize(node, u); destParent.appendChild(u); return; }
    if (tag === "S" || tag === "STRIKE" || tag === "DEL") { var s = document.createElement("s"); walkSanitize(node, s); destParent.appendChild(s); return; }
    if (tag === "MARK") { var m = document.createElement("mark"); walkSanitize(node, m); destParent.appendChild(m); return; }
    if (tag === "IMG") {
      var ref = imageRefOf(node);
      if (ref) destParent.appendChild(storedImageEl(ref));
      return;
    }
    if (tag === "A" && node.classList && node.classList.contains("video-embed-card")) {
      var vhref = safeHref(node.getAttribute("href") || "");
      if (vhref) destParent.appendChild(buildVideoCardEl(vhref));
      return;
    }
    if (tag === "SPAN" && node.classList && node.classList.contains("tag-anchor")) {
      var tcat = tagCategory(node.getAttribute("data-tag-cat"));
      var tname = plainText(node.getAttribute("data-tag-name")).trim().slice(0, 80);
      if (!tcat || !tname) { walkSanitize(node, destParent); return; }
      var tagSpan = document.createElement("span");
      tagSpan.className = "tag-anchor";
      tagSpan.setAttribute("data-tag-cat", tcat.id);
      tagSpan.setAttribute("data-tag-name", tname);
      tagSpan.setAttribute("contenteditable", "false");
      walkSanitize(node, tagSpan);
      destParent.appendChild(tagSpan);
      return;
    }
    if (tag === "SPAN" && node.classList && node.classList.contains("broll-key")) {
      var brollText = (node.textContent || "").trim();
      if (!BROLL_MARKER_RE.test(brollText)) { walkSanitize(node, destParent); return; }
      var brollSpan = document.createElement("span");
      brollSpan.className = "broll-key";
      brollSpan.setAttribute("data-broll-id", safeId(node.getAttribute("data-broll-id") || "", "bs"));
      brollSpan.setAttribute("contenteditable", "false");
      brollSpan.appendChild(document.createTextNode(brollText));
      destParent.appendChild(brollSpan);
      return;
    }
    if (tag === "SPAN" && node.classList && node.classList.contains("cmt-anchor")) {
      var cmtId = safeId(node.getAttribute("data-cmt") || "", "c");
      var anchorSpan = document.createElement("span");
      anchorSpan.className = "cmt-anchor";
      anchorSpan.setAttribute("data-cmt", cmtId);
      walkSanitize(node, anchorSpan);
      destParent.appendChild(anchorSpan);
      return;
    }
    if (tag === "SPAN" && node.classList && node.classList.contains("stage-dir")) {
      var dirSpan = document.createElement("span");
      dirSpan.className = "stage-dir";
      walkSanitize(node, dirSpan);
      destParent.appendChild(dirSpan);
      return;
    }
    if (tag === "SPAN" && node.classList && node.classList.contains("audio-cue")) {
      var cueSpan = document.createElement("span");
      cueSpan.className = "audio-cue";
      walkSanitize(node, cueSpan);
      destParent.appendChild(cueSpan);
      return;
    }
    if (tag === "A") {
      var href = safeHref(node.getAttribute("href") || "");
      if (href) {
        var a = document.createElement("a");
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener");
        walkSanitize(node, a);
        destParent.appendChild(a);
      } else {
        walkSanitize(node, destParent);
      }
      return;
    }
    if (tag === "SPAN") {
      var stObj = node.style || {};
      var holder = document.createElement("span");
      walkSanitize(node, holder);
      var current = Array.prototype.slice.call(holder.childNodes);
      var isBold = stObj.fontWeight === "bold" || stObj.fontWeight === "700" || (parseInt(stObj.fontWeight, 10) >= 600);
      var isItalic = stObj.fontStyle === "italic";
      var deco = (stObj.textDecorationLine || stObj.textDecoration || "");
      var isUnderline = deco.indexOf("underline") !== -1;
      var isStrike = deco.indexOf("line-through") !== -1;
      var bg = stObj.backgroundColor;
      var isHighlight = !!bg && bg !== "transparent" && bg.indexOf("rgba(0, 0, 0, 0)") === -1;
      if (isStrike) current = wrapNodes(current, "s");
      if (isUnderline) current = wrapNodes(current, "u");
      if (isItalic) current = wrapNodes(current, "em");
      if (isBold) current = wrapNodes(current, "strong");
      if (isHighlight) current = wrapNodes(current, "mark");
      current.forEach(function (n) { destParent.appendChild(n); });
      return;
    }
    walkSanitize(node, destParent);
  });
}

export function ensureTrailingCaretSpot(container) {
  var last = container && container.lastChild;
  if (last && last.nodeType === 1 && last.getAttribute && last.getAttribute("contenteditable") === "false") {
    container.appendChild(document.createTextNode("​"));
  }
}

function walkToMd(node) {
  var out = "";
  node.childNodes.forEach(function (child) {
    if (child.nodeType === 3) { out += child.nodeValue; return; }
    if (child.nodeType !== 1) return;
    var tag = child.tagName;
    var inner = walkToMd(child);
    if (tag === "STRONG" || tag === "B") out += "**" + inner + "**";
    else if (tag === "EM" || tag === "I") out += "*" + inner + "*";
    else if (tag === "U") out += "<u>" + inner + "</u>";
    else if (tag === "S" || tag === "STRIKE" || tag === "DEL") out += "~~" + inner + "~~";
    else if (tag === "MARK") out += "<mark>" + inner + "</mark>";
    else if (tag === "A" && !child.getAttribute("href")) out += inner;
    else if (tag === "A") out += "[" + inner.replace(/([\]()])/g, "\\$1") + "](" + child.getAttribute("href") + ")";
    else if (tag === "BR") out += "\n";
    else if (tag === "SPAN" && child.classList && child.classList.contains("stage-dir")) out += "((" + inner + "))";
    else out += inner;
  });
  return out;
}

export function htmlToMarkdown(html) {
  if (!html) return "";
  return walkToMd(inertBody(html)).replace(/\n{3,}/g, "\n\n").trim();
}

export function buildVideoCardEl(href) {
  var a = document.createElement("a");
  a.className = "video-embed-card";
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener");
  var host;
  try { host = new URL(href).hostname.replace(/^www\./, ""); } catch (e) { host = href; }
  var play = document.createElement("span");
  play.className = "vec-play";
  play.textContent = "▶";
  var label = document.createElement("span");
  label.textContent = "Watch video";
  var hostSpan = document.createElement("span");
  hostSpan.className = "vec-host";
  hostSpan.textContent = "· " + host;
  a.appendChild(play);
  a.appendChild(label);
  a.appendChild(hostSpan);
  return a;
}

export function __init() {}
