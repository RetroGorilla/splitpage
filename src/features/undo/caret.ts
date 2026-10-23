import { normalizeCell } from "../../core/text/runs.ts";
import type { Run } from "../../core/text/runs.ts";

export type CellDecoder = (html: unknown) => readonly Run[];

export interface CellStep {
  readonly before?: unknown;
  readonly after?: unknown;
}

export function caretAfterStep(decode: CellDecoder, step: CellStep): number {
  function domChars(h: unknown): { text: string; keys: string[] } {
    let text = "";
    const keys: string[] = [];
    normalizeCell(decode(h == null ? "" : h)).forEach(function (r) {
      const t = r.text.replace(/\n/g, "");
      const key = (r.atom ? r.atom + ":" + String((r as { readonly id?: unknown }).id) : "") + JSON.stringify(r.marks || {});
      for (let i = 0; i < t.length; i++) keys.push(t[i] + key);
      text += t;
    });
    return { text: text, keys: keys };
  }
  const a = domChars(step.before).keys, bc = domChars(step.after), b = bc.text, bk = bc.keys;
  let s = 0;
  while (s < a.length && s < bk.length && a[a.length - 1 - s] === bk[bk.length - 1 - s]) s++;
  let offset = b.length - s;
  if (offset > 0 && offset < b.length) {
    const hi = b.charCodeAt(offset - 1), lo = b.charCodeAt(offset);
    if (hi >= 0xD800 && hi <= 0xDBFF && lo >= 0xDC00 && lo <= 0xDFFF) offset--;
  }
  return offset;
}
