type DomCharacterPosition = { sc: Node; so: number; ec: Node; eo: number; text?: string };

import { BROLL_MARKER_RE } from "../../core/document/broll.ts";

export function domProjection(root: Node) {
  const out: DomCharacterPosition[] = [];
  function at(node: Node, index: number) { return { sc: node, so: index, ec: node, eo: index + 1 }; }
  function push(ch: string, pos: DomCharacterPosition) { pos.text = ch; out.push(pos); }
  (function walk(parent: Node) {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const child = parent.childNodes[i] as Node & Partial<Element>;
      if (child.nodeType === 3) {
        const v = child.nodeValue || "";
        for (let k = 0; k < v.length; k++) {
          const c = (v[k] as string);
          if (c === "\n" || c === "\r") {
            let e = k + 1;
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
      const tag = child.tagName;
      const cls = child.classList;
      if (tag === "BR") { push("\n", at(parent, i)); continue; }
      if (tag === "IMG") continue;
      if (tag === "A" && cls && cls.contains("video-embed-card")) continue;
      if (tag === "SPAN" && cls && cls.contains("broll-key") &&
          BROLL_MARKER_RE.test((child.textContent || "").replace(DROPPED_CHARS_RE, "").trim())) {
        push(OBJ, at(parent, i));
        continue;
      }
      if (tag === "DIV" || tag === "P") {
        const blank = child.childNodes.length === 1 && (child.firstChild as ChildNode).nodeType === 1 && (child.firstChild as Element).tagName === "BR";
        if (!blank) walk(child);
        push("\n", { sc: parent, so: i + 1, ec: parent, eo: i + 1 });
        continue;
      }
      walk(child);
    }
  })(root);
  return out;
}

const DROPPED_CHAR_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/;
const DROPPED_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u200B\uFFFC]/g;
const OBJ = "\uFFFC";

export function domRangeFor(root: Node, from: number, to: number, expect: string) {
  const chars = domProjection(root);
  const text = chars.map(function (c) { return c.text; }).join("");
  if (text !== expect || from >= to || to > chars.length) return null;
  const range = (root.ownerDocument || document).createRange();
  range.setStart((chars[from] as DomCharacterPosition).sc, (chars[from] as DomCharacterPosition).so);
  range.setEnd((chars[to - 1] as DomCharacterPosition).ec, (chars[to - 1] as DomCharacterPosition).eo);
  return range;
}
