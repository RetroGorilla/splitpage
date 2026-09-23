import { makeId } from "./02-state.js";
import { internDataUrl, queuePersist, recordFor } from "./02c-blobs.js";
import { isSha256Hex, normalizeImageRef } from "../../shared/blob-policy.js";
import { tagCategory } from "./07-production-tags.js";
import { BROLL_MARKER_RE } from "./08c-broll.js";

/* ================= sanitizing rich text ================= */

/* Parse untrusted HTML INERTLY. A detached <div> is still live: assigning
   innerHTML loads images and fires onerror/onload handlers, so parsing a
   hostile string that way executes it before any sanitizer can run. A
   DOMParser document has no browsing context, so nothing loads or fires. */
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

/* Only ever accept images we produced ourselves: an inline data: image. */
export function safeImageSrc(src) {
  if (typeof src !== "string") return null;
  return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/.test(src) ? src : null;
}

/* ---- images inside HTML (#82 P6) ----

   An image in a comment, a reply or a pasted cell is stored the way a row's
   picture is: by the SHA-256 of its bytes, which live in the image registry
   (02c-blobs.js) and its durable store, never in the HTML. The one stored
   form is

     <img class="comment-img" data-blob="<sha>" data-w="<w>" data-h="<h>" data-mime="<type>">

   with NO src. The src is added only in the live DOM, by the hydrator
   (02c-blobs.js), which gives every <img data-blob> a blob: URL once it has
   the bytes; storedHtmlFromDom() takes it (and the hydrator's other
   attributes) back out wherever the app reads the DOM into state without
   sanitising it.

   The sanitiser decides what an <img> becomes, synchronously:
     - a valid data-blob sha stays, with data-w/h/mime taken from the
       registry's record when this page holds the bytes, else from the
       element's own attributes when they form a valid record, else left
       off. An unknown sha is kept: its bytes may be in the durable store or
       on the server, and the hydrator asks both. Any src it carries — a
       blob: URL from the live DOM, or anything else — is dropped.
     - otherwise an inline data: image (png/jpeg/gif/webp, safeImageSrc) is
       interned — hashed and measured by its bytes, never by what it
       claims — and becomes the stored form, its bytes queued to be stored.
     - anything else — an http src, an SVG, a data: URI that is not a
       picture, an upper-case or short sha — is dropped, as before. */
function imageRefOf(node) {
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

/* The stored form of an image record, as the sanitiser writes it — for
   HTML built outside the sanitiser (an image conflict card's body). */
export function storedImageHtml(ref) {
  var clean = normalizeImageRef(ref);
  if (!clean) return "";
  return storedImageEl(clean).outerHTML;
}

/* HTML read out of the live DOM, with what the hydrator added to every
   <img data-blob> taken back out, so it can go into state: everything on
   such an image but its stored attributes. Only the images change;
   anything else is left for the sanitiser, wherever it runs. */
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
  /* strip control characters browsers ignore when resolving a scheme */
  /* eslint-disable-next-line no-control-regex -- deliberate: "java\\0script:"
     resolves as javascript: in a browser, so the probe has to see past them. */
  var probe = trimmed.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (probe.indexOf("javascript:") === 0 || probe.indexOf("vbscript:") === 0) return null;
  if (probe.indexOf("data:") === 0) return null;
  if (/^https?:\/\//i.test(trimmed) || trimmed.indexOf("mailto:") === 0) return trimmed;
  return null;
}

/* names and titles are plain text — never markup */
export function plainText(v) {
  /* eslint-disable-next-line no-control-regex -- C0 controls, minus tab/LF/CR,
     are exactly what a plain-text field must not carry. */
  return String(v == null ? "" : v).replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

export function plainName(v) {
  var name = plainText(v).trim().slice(0, 80);
  return name || "Anonymous";
}

/* ids end up inside CSS selectors and HTML attributes */
export function safeId(id, prefix) {
  var clean = String(id == null ? "" : id).replace(/[^A-Za-z0-9_-]/g, "");
  return clean || makeId(prefix);
}

/* Escape a value for use inside a double-quoted CSS attribute selector.
   Merely stripping quotes (what these lookups used to do) leaves any
   backslash behind, and CSS then reads it as the start of an escape
   sequence — so an item named "cam\rig" quietly matched nothing, and some
   values threw a SyntaxError straight out of querySelector. */
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
      /* A div/p whose only content is a single <br> is contenteditable's
         way of marking "this paragraph is empty" (so the empty line
         stays visible/selectable) — it is not an extra line break ON TOP
         OF the paragraph separator appended below. Walking into it first
         re-emitted that same <br>, so a single blank paragraph between
         two others doubled into two blank lines instead of one. */
      var isBlankPara = node.childNodes.length === 1 &&
        node.firstChild.nodeType === 1 && node.firstChild.tagName === "BR";
      if (!isBlankPara) walkSanitize(node, destParent);
      destParent.appendChild(document.createElement("br"));
      return;
    }
    if (tag === "BR") { destParent.appendChild(document.createElement("br")); return; }

    if (tag === "STRONG" || tag === "B") {
      /* Google Docs wraps its whole clipboard fragment in a <b
         style="font-weight:normal" id="docs-internal-guid-…">, relying on
         that inline style to cancel the tag's own boldness — real bold
         runs inside it are separate <span style="font-weight:700"> spans
         (below). Reading the tag alone as bold ignored that override and
         made the entire paste bold. The inline style, when present, wins. */
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
      /* A tag is a fixed label, not prose — the caret should never be able
         to land inside it and grow it (by typing) or shrink it (by
         backspacing) into silently no longer matching its own name. This
         makes it a single atomic unit: click-to-select still works, arrow
         keys and clicks skip over it as one piece, same as an <img>. */
      tagSpan.setAttribute("contenteditable", "false");
      walkSanitize(node, tagSpan);
      destParent.appendChild(tagSpan);
      return;
    }
    /* A b-roll marker (08c-broll.js). Only the keyword itself is markup —
       the shot's description is ordinary prose after it — so all this
       span carries is the id that ties the line to its record. Atomic for
       the same reason a tag is: the caret must never be able to land
       inside the marker and type it into no longer being one. */
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
    /* unknown tag: unwrap, keep its text/children */
    walkSanitize(node, destParent);
  });
}

/* A tag/b-roll span is contenteditable="false" — an atomic unit the caret
   skips over rather than enters. That's fine wherever something follows
   it, but as the very last node in a cell there is nothing after it for
   contenteditable to put the caret AT either: no click target, no
   ArrowRight/End destination, nowhere for typing to land. A trailing
   zero-width space is real DOM the caret can actually sit in, invisible,
   and harmless if left in place — syncFieldFromDom strips it back out
   before anything is saved (see there), so it never reaches stored text
   or an export. */
export function ensureTrailingCaretSpot(container) {
  var last = container && container.lastChild;
  if (last && last.nodeType === 1 && last.getAttribute && last.getAttribute("contenteditable") === "false") {
    container.appendChild(document.createTextNode("​"));
  }
}

/* ================= html -> markdown (for export) ================= */

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
    /* A link's visible text becomes markdown's [text](href) — but a
       literal "]" in that text closes the link early for any standard
       parser, and "(" / ")" break the destination parse the same way;
       escaping them is what CommonMark itself expects inside link text. */
    else if (tag === "A") out += "[" + inner.replace(/([\]()])/g, "\\$1") + "](" + child.getAttribute("href") + ")";
    else if (tag === "BR") out += "\n";
    else out += inner;
  });
  return out;
}

export function htmlToMarkdown(html) {
  if (!html) return "";
  return walkToMd(inertBody(html)).replace(/\n{3,}/g, "\n\n").trim();
}

/* ================= video link cards (comments) ================= */

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

/* Eval-time work for this module. _entry.js calls every module's __init()
   in filename order — the order these statements used to run in. */
export function __init() {}
