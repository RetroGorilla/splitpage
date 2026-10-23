import { BROLL_MARKER_RE } from "../../core/document/broll.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";
import { anchorBrollCell, brollAnchorTodo, planBrollAnchors } from "../../core/production/broll.ts";
import { holdsMedia } from "../../core/production/tags.ts";
import { toHtml } from "../../core/text/html.ts";
import { brollAnchoringDeclined } from "../../application/broll-anchoring.ts";

export function brollHtmlLines(body) {
  hoistNestedBrs(body);
  var kids = Array.prototype.slice.call(body.childNodes);
  var lines = [], start = 0;
  kids.forEach(function (n, i) {
    if (n.nodeType === 1 && n.tagName === "BR") {
      lines.push({ nodes: kids.slice(start, i), br: n });
      start = i + 1;
    }
  });
  lines.push({ nodes: kids.slice(start), br: null });
  return lines;
}

function hoistNestedBrs(body) {
  var guard = 0;
  while (guard++ < 1000) {
    var brs = body.getElementsByTagName("br");
    var br = null;
    for (var i = 0; i < brs.length; i++) {
      if (brs[i].parentNode !== body) { br = brs[i]; break; }
    }
    if (!br) return;
    var parent = br.parentNode;
    var grand = parent.parentNode;
    if (!grand) return;
    var tail = parent.cloneNode(false);
    while (br.nextSibling) tail.appendChild(br.nextSibling);
    parent.removeChild(br);
    var ref = parent.nextSibling;
    grand.insertBefore(br, ref);
    if (tail.childNodes.length) grand.insertBefore(tail, ref);
  }
}

function brollHtmlLineText(nodes) {
  return nodes.map(function (n) { return n.textContent || ""; }).join("");
}

export function brollKeyHtml(id, text) {
  return '<span class="broll-key" data-broll-id="' + escapeHtml(id) +
    '" contenteditable="false">' + escapeHtml(text) + '</span>';
}

function brollLineTextNodes(nodes) {
  var out = [];
  (function walk(list) {
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.nodeType === 3) out.push(n);
      else if (n.nodeType === 1) walk(n.childNodes);
    }
  })(nodes);
  return out;
}

function brollPruneEmpty(el, body) {
  while (el && el !== body && el.parentNode && !el.childNodes.length) {
    var parent = el.parentNode;
    parent.removeChild(el);
    el = parent;
  }
}

function brollWrapHtmlLine(body, line, id) {
  var m = BROLL_MARKER_RE.exec(brollHtmlLineText(line.nodes));
  if (!m) return false;
  var left = m[0].length;
  brollLineTextNodes(line.nodes).forEach(function (t) {
    if (left <= 0) return;
    var val = t.nodeValue || "";
    if (val.length > left) { t.nodeValue = val.slice(left); left = 0; return; }
    left -= val.length;
    var parent = t.parentNode;
    if (!parent) return;
    parent.removeChild(t);
    brollPruneEmpty(parent, body);
  });

  var ref = null;
  for (var i = 0; i < line.nodes.length && !ref; i++) {
    if (line.nodes[i].parentNode === body) ref = line.nodes[i];
  }
  if (!ref) ref = line.br;
  var holder = document.createElement("div");
  holder.innerHTML = brollKeyHtml(id, m[1] + m[2]) + " ";
  Array.prototype.slice.call(holder.childNodes).forEach(function (n) {
    body.insertBefore(n, ref);
  });
  return true;
}

function brollRekeyHtmlLine(line, id) {
  for (var i = 0; i < line.nodes.length; i++) {
    var n = line.nodes[i];
    if (n.nodeType !== 1) continue;
    var key = n.classList.contains("broll-key") ? n : n.querySelector(".broll-key");
    if (key) { key.setAttribute("data-broll-id", id); return true; }
  }
  return false;
}

export function anchorBrollInRows(doc, only, ports) {
  var rows = only || (doc && doc.rows);
  if (!doc || !rows || !rows.length) return 0;
  var plan = planBrollAnchors(doc, ports.readers, ports.ids);
  var total = 0;
  rows.forEach(function (row) {
    if (brollAnchoringDeclined(row.id)) return;
    var html = row.visualText;
    var cell = ports.cellOf(html);
    var todo = brollAnchorTodo(cell, row.id, plan);
    if (!todo.length) return;
    var n = 0;
    if (holdsMedia(html)) {
      var body = ports.inertBody(html);
      var htmlLines = brollHtmlLines(body);
      todo.forEach(function (t) {
        var line = htmlLines[t.found.index];
        if (!line) return;
        if (t.found.marker.key ? brollRekeyHtmlLine(line, t.id) : brollWrapHtmlLine(body, line, t.id)) n++;
      });
      if (n) row.visualText = ports.sanitize(body.innerHTML);
    } else {
      var anchored = anchorBrollCell(cell, todo);
      n = anchored.anchored;
      if (n) row.visualText = toHtml(anchored.cell);
    }
    total += n;
  });
  return total;
}
