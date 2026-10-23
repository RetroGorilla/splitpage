import { BROLL_MARKER_RE } from "../../core/document/broll.ts";

export function domProjection(root) {
  var out = [];
  function at(node, index) { return { sc: node, so: index, ec: node, eo: index + 1 }; }
  function push(ch, pos) { pos.text = ch; out.push(pos); }
  (function walk(parent) {
    for (var i = 0; i < parent.childNodes.length; i++) {
      var child = parent.childNodes[i];
      if (child.nodeType === 3) {
        var v = child.nodeValue || "";
        for (var k = 0; k < v.length; k++) {
          var c = v[k];
          if (c === "\n" || c === "\r") {
            var e = k + 1;
            while (e < v.length && (v[e] === "\n" || v[e] === "\r")) e++;
            push(" ", { sc: child, so: k, ec: child, eo: e });
            k = e - 1;
          } else if (!DROPPED_CHAR_RE.test(c)) {
            push(c, at(child, k));
          }
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = child.tagName;
      var cls = child.classList;
      if (tag === "BR") { push("\n", at(parent, i)); continue; }
      if (tag === "IMG") continue;
      if (tag === "A" && cls && cls.contains("video-embed-card")) continue;
      if (tag === "SPAN" && cls && cls.contains("broll-key") &&
          BROLL_MARKER_RE.test((child.textContent || "").replace(DROPPED_CHARS_RE, "").trim())) {
        push(OBJ, at(parent, i));
        continue;
      }
      if (tag === "DIV" || tag === "P") {
        var blank = child.childNodes.length === 1 && child.firstChild.nodeType === 1 && child.firstChild.tagName === "BR";
        if (!blank) walk(child);
        push("\n", { sc: parent, so: i + 1, ec: parent, eo: i + 1 });
        continue;
      }
      walk(child);
    }
  })(root);
  return out;
}

var DROPPED_CHAR_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/;
var DROPPED_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/g;
var OBJ = "\uFFFC";

export function domRangeFor(root, from, to, expect) {
  var chars = domProjection(root);
  var text = chars.map(function (c) { return c.text; }).join("");
  if (text !== expect || from >= to || to > chars.length) return null;
  var range = (root.ownerDocument || document).createRange();
  range.setStart(chars[from].sc, chars[from].so);
  range.setEnd(chars[to - 1].ec, chars[to - 1].eo);
  return range;
}
