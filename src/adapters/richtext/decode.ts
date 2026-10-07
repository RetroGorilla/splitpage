import type { Frozen, Seal } from "../../core/document/freeze.ts";
import type { DecodeOptions } from "../../core/text/ports.ts";
import { defaultTagId, normalizeCell } from "../../core/text/runs.ts";
import type { Run, RunInput } from "../../core/text/runs.ts";

type DecodedMarks = {
  b?: true;
  i?: true;
  u?: true;
  s?: true;
  hl?: true;
  dir?: true;
  cue?: true;
  href?: string | null;
  tag?: string;
  cmt?: (string | null)[];
};

export type CellReader = (html: unknown) => Frozen<Run[]>;

const CELL_CACHE_BUDGET = 2000000;

export function decodeBody(body: Node, opts?: DecodeOptions | null): Run[] {
  const options: DecodeOptions = opts || {};
  const tagId = options.tagId || defaultTagId;
  const runs: RunInput[] = [];
  (function walk(node: Node, marks: DecodedMarks) {
    node.childNodes.forEach(function (child) {
      if (child.nodeType === 3) {
        const t = String(child.nodeValue || "").replace(/[\r\n]+/g, " ");
        if (t) runs.push({ text: t, marks: marks });
        return;
      }
      if (child.nodeType !== 1) return;
      const el = child as Element;
      const tag = el.tagName;
      if (tag === "BR") { runs.push({ text: "\n", marks: marks }); return; }
      if (tag === "IMG") {
        if (options.onMedia) {
          options.onMedia({ kind: "image", ref: {
            sha256: el.getAttribute("data-blob"),
            width: Number(el.getAttribute("data-w")) || null,
            height: Number(el.getAttribute("data-h")) || null,
            mime: el.getAttribute("data-mime") || null
          } });
        }
        return;
      }
      const cls = el.classList;
      if (tag === "A" && cls && cls.contains("video-embed-card")) {
        if (options.onMedia) options.onMedia({ kind: "video", href: el.getAttribute("href") });
        return;
      }
      if (tag === "SPAN" && cls && cls.contains("broll-key")) {
        runs.push({ atom: "broll", id: el.getAttribute("data-broll-id"), text: el.textContent, marks: marks });
        return;
      }
      const next: DecodedMarks = Object.assign({}, marks);
      if (tag === "STRONG") next.b = true;
      else if (tag === "EM") next.i = true;
      else if (tag === "U") next.u = true;
      else if (tag === "S") next.s = true;
      else if (tag === "MARK") next.hl = true;
      else if (tag === "A") next.href = el.getAttribute("href");
      else if (tag === "SPAN" && cls && cls.contains("tag-anchor")) {
        next.tag = tagId(el.getAttribute("data-tag-cat") as string, el.getAttribute("data-tag-name") as string);
      } else if (tag === "SPAN" && cls && cls.contains("cmt-anchor")) {
        next.cmt = (marks.cmt || []).concat([el.getAttribute("data-cmt")]);
      } else if (tag === "SPAN" && cls && cls.contains("stage-dir")) {
        next.dir = true;
      } else if (tag === "SPAN" && cls && cls.contains("audio-cue")) {
        next.cue = true;
      }
      walk(el, next);
    });
  })(body, {});
  return normalizeCell(runs, options);
}

export function createCellReader(decode: (html: string) => Run[], seal: Seal): CellReader {
  const cellCache = new Map<string, Frozen<Run[]>>();
  let cellCacheChars = 0;
  return function cellOf(html) {
    const key = html == null ? "" : String(html);
    const hit = cellCache.get(key);
    if (hit !== undefined) return hit;
    const cell = seal(decode(key));
    if (cellCacheChars > CELL_CACHE_BUDGET) { cellCache.clear(); cellCacheChars = 0; }
    cellCache.set(key, cell);
    cellCacheChars += key.length;
    return cell;
  };
}
