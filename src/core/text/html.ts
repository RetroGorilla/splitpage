import { buildTree } from "./tree.ts";
import type { TreeOptions, TreeParent } from "./tree.ts";
import type { CellInput, FormatMark } from "./runs.ts";
import type { TagName } from "../document/tags.ts";

export type Where = { dir: boolean };

export type TextHtml = (text: string, esc: (t: string) => string, where: Where) => string;

export type HtmlOptions = TreeOptions & { textHtml?: TextHtml | null | undefined };

function escText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
}
function escAttr(t: unknown): string {
  return String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\u00a0/g, "&nbsp;");
}

const FORMAT_TAG: Record<FormatMark, string> = { hl: "mark", b: "strong", i: "em", u: "u", s: "s" };

const OUTSIDE_DIRECTION: Where = { dir: false };
const INSIDE_DIRECTION: Where = { dir: true };

export function toHtml(cell: CellInput, opts?: HtmlOptions | null): string {
  const t = buildTree(cell, opts);
  const textHtml: (s: string, where: Where) => string = opts && opts.textHtml
    ? function (s, where) { return (opts.textHtml as TextHtml)(s, escText, where); }
    : escText;
  function render(node: TreeParent, where: Where): string {
    let out = "";
    node.kids.forEach(function (n) {
      if (n.text !== undefined) { out += textHtml(n.text, where); return; }
      if (n.br) { out += "<br>"; return; }
      if (n.atom) {
        out += '<span class="broll-key" data-broll-id="' + escAttr(n.atom.id) + '" contenteditable="false">' + textHtml(n.atom.text, where) + "</span>";
        return;
      }
      const e = n.el;
      const inner = render(n, e.k === "dir" ? INSIDE_DIRECTION : where);
      if (e.k === "cmt") out += '<span class="cmt-anchor" data-cmt="' + escAttr(e.v) + '">' + inner + "</span>";
      else if (e.k === "dir") out += '<span class="stage-dir">' + inner + "</span>";
      else if (e.k === "cue") out += '<span class="audio-cue">' + inner + "</span>";
      else if (e.k === "href") out += '<a href="' + escAttr(e.v) + '" target="_blank" rel="noopener">' + inner + "</a>";
      else if (e.k === "tag") {
        const info = t.tagOf(e.v) as TagName;
        out += '<span class="tag-anchor" data-tag-cat="' + escAttr(info.cat) + '" data-tag-name="' + escAttr(info.name) +
          '" contenteditable="false">' + inner + "</span>";
      } else {
        out += "<" + FORMAT_TAG[e.k] + ">" + inner + "</" + FORMAT_TAG[e.k] + ">";
      }
    });
    return out;
  }
  return render(t.root, OUTSIDE_DIRECTION);
}
