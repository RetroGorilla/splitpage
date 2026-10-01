import { toHtml } from "../../../src/core/text/html.ts";
import type { CellDecoder } from "../../../src/core/text/ports.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { Marks, Run, RunInput } from "../../../src/core/text/runs.ts";

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", nbsp: "\xa0" };

function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, function (m: string, e: string) {
    if (e.charAt(0) !== "#") return NAMED[e] === undefined ? m : NAMED[e] as string;
    return String.fromCodePoint(e.charAt(1) === "x" || e.charAt(1) === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const m of source.matchAll(/([a-z-]+)="([^"]*)"/gi)) out[(m[1] as string).toLowerCase()] = unescapeHtml(m[2] as string);
  return out;
}

type Open = { name: string; marks: Marks; key: { id: string; text: string } | null };

const ELEMENT_RE = /<(\/?)([a-z]+)((?:\s+[a-z-]+="[^"]*")*)\s*>|([^<]+)/gi;

export function readStoredHtml(html: string): Run[] {
  const runs: RunInput[] = [];
  const open: Open[] = [{ name: "", marks: {}, key: null }];
  for (const m of html.matchAll(ELEMENT_RE)) {
    const top = open[open.length - 1] as Open;
    if (m[4] !== undefined) {
      const text = unescapeHtml(m[4]).replace(/[\r\n]+/g, " ");
      if (top.key) top.key.text += text;
      else runs.push({ text: text, marks: top.marks });
      continue;
    }
    const name = (m[2] as string).toLowerCase();
    if (name === "br") { runs.push({ text: "\n", marks: top.marks }); continue; }
    if (name === "img") throw new Error("a picture is not read here: " + html);
    if (m[1]) {
      const done = open.pop() as Open;
      if (done.name !== name) throw new Error("unbalanced </" + name + "> in " + html);
      if (done.key) runs.push({ atom: "broll", id: done.key.id, text: done.key.text, marks: done.marks });
      continue;
    }
    const attrs = attributes(m[3] || "");
    const cls = attrs["class"] || "";
    if (name === "a" && cls === "video-embed-card") throw new Error("a video card is not read here: " + html);
    if (name === "span" && cls === "broll-key") {
      open.push({ name: name, marks: top.marks, key: { id: attrs["data-broll-id"] || "", text: "" } });
      continue;
    }
    const next: Marks = Object.assign({}, top.marks);
    if (name === "strong") next.b = true;
    else if (name === "em") next.i = true;
    else if (name === "u") next.u = true;
    else if (name === "s") next.s = true;
    else if (name === "mark") next.hl = true;
    else if (name === "a") next.href = attrs["href"] || "";
    else if (name === "span" && cls === "tag-anchor") next.tag = "t:" + attrs["data-tag-cat"] + ":" + attrs["data-tag-name"];
    else if (name === "span" && cls === "cmt-anchor") next.cmt = (top.marks.cmt || []).concat([attrs["data-cmt"] || ""]);
    else if (name === "span" && cls === "stage-dir") next.dir = true;
    else if (name === "span" && cls === "audio-cue") next.cue = true;
    open.push({ name: name, marks: next, key: null });
  }
  if (open.length !== 1) throw new Error("unclosed element in " + html);
  return normalizeCell(runs);
}

export type StoredDecoder = { decode: CellDecoder; raw: Set<string> };

export function storedDecoder(): StoredDecoder {
  const cache = new Map<string, Run[]>();
  const raw = new Set<string>();
  return {
    raw: raw,
    decode: function (html) {
      const hit = cache.get(html);
      if (hit) return hit;
      const cell = readStoredHtml(html);
      if (!raw.has(html) && toHtml(cell) !== html) throw new Error("not in stored form: " + html);
      cache.set(html, cell);
      return cell;
    }
  };
}
