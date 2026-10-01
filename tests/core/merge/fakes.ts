import type { Clock, IdSource } from "../../../src/core/document/ports.ts";
import type { MergePorts } from "../../../src/core/merge/states.ts";
import { toHtml } from "../../../src/core/text/html.ts";
import type { CellDecoder, DecodeOptions, DecodedMedia } from "../../../src/core/text/ports.ts";
import { normalizeCell } from "../../../src/core/text/runs.ts";
import type { Run } from "../../../src/core/text/runs.ts";

export type KnownCell = { html: string; cell: Run[]; media?: DecodedMedia[] };

export const FIXED_ISO = "2026-10-01T12:00:00.000Z";
export const EDITOR = "Fake Editor";

const DEFAULT_TAG = /^t:([a-z]+):([\s\S]+)$/;

export function picture(ch: string): DecodedMedia {
  return { kind: "image", ref: { sha256: ch.repeat(64), width: 10, height: 10, mime: "image/png" } };
}

export function fakeDecoder(cells: readonly (Run[] | KnownCell)[]): { decode: CellDecoder; calls: string[] } {
  const known = new Map<string, KnownCell>();
  known.set("", { html: "", cell: [] });
  for (const c of cells) {
    const k = Array.isArray(c) ? { html: toHtml(c), cell: normalizeCell(c) } : c;
    known.set(k.html, k);
  }
  const calls: string[] = [];
  function decode(html: string, opts?: DecodeOptions | null): Run[] {
    calls.push(html);
    const k = known.get(html);
    if (!k) throw new Error("not a known cell: " + html);
    if (opts && opts.onMedia) for (const m of k.media || []) opts.onMedia(m);
    const tagId = opts && opts.tagId;
    return (JSON.parse(JSON.stringify(k.cell)) as Run[]).map(function (r) {
      const m = !r.atom && r.marks.tag && tagId ? DEFAULT_TAG.exec(r.marks.tag) : null;
      if (!m || !tagId) return r;
      return { text: r.text, marks: { ...r.marks, tag: tagId(m[1] as string, m[2] as string) } };
    });
  }
  return { decode: decode, calls: calls };
}

export function countingIds(): IdSource & { minted: string[] } {
  const minted: string[] = [];
  return {
    minted: minted,
    id: function (prefix: string) {
      const id = prefix + "-fake-" + (minted.length + 1);
      minted.push(id);
      return id;
    },
    docId: function () { return "d" + "f".repeat(32); }
  };
}

export const fixedClock: Clock = { nowIso: function () { return FIXED_ISO; } };

export function fakePorts(decode: CellDecoder, over?: Partial<MergePorts>): MergePorts {
  return Object.assign({ decode: decode, ids: countingIds(), clock: fixedClock, editor: function () { return EDITOR; } }, over || {});
}

export function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
