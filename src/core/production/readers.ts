import type { Seal } from "../document/freeze.ts";
import { contentMemo } from "../document/memo.ts";
import type { TagName } from "../document/tags.ts";
import { cuesInCell } from "../text/cues.ts";
import type { CellDecoder } from "../text/ports.ts";
import { spokenText } from "../text/projections.ts";
import { tagNameOf } from "../text/runs.ts";
import { brollInCell, brollPropsInCell } from "./broll.ts";
import type { FieldTag, ProductionReaders } from "./ports.ts";

type TagSpan = { id: string; catId: string; name: string; text: string };

function readTags(cellOf: CellDecoder, html: string): FieldTag[] {
  const out: TagSpan[] = [];
  let last: TagSpan | null = null;
  cellOf(html).forEach(function (r) {
    const id = r.atom ? null : r.marks.tag;
    if (id && last && last.id === id) { last.text += r.text; return; }
    last = null;
    const t = id ? tagNameOf(id) : null;
    const name = t ? t.name.trim() : "";
    if (!name) return;
    last = { id: id as string, catId: (t as TagName).cat, name: name, text: r.text };
    out.push(last);
  });
  const found = out.map(function (m) { return { catId: m.catId, name: m.name, text: m.text.trim() }; });
  if (html.indexOf("audio-cue") !== -1) {
    cuesInCell(cellOf(html)).forEach(function (c) {
      const name = c.name.slice(0, 80).trim();
      if (name) found.push({ catId: "sound", name: name, text: c.text });
    });
  }
  return found;
}

function readCueNames(cellOf: CellDecoder, html: string): string[] {
  if (html.indexOf("audio-cue") === -1) return [];
  return cuesInCell(cellOf(html)).map(function (c) { return c.name.slice(0, 80).trim(); }).filter(Boolean);
}

function countWords(cellOf: CellDecoder, html: string): number {
  const text = spokenText(cellOf(html));
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

export function createProductionReaders(cellOf: CellDecoder, seal: Seal): ProductionReaders {
  return {
    cellOf: cellOf,
    tagsInField: contentMemo(function (html) { return readTags(cellOf, html); }, seal),
    cueNamesInField: contentMemo(function (html) { return readCueNames(cellOf, html); }, seal),
    brollInField: contentMemo(function (html) { return brollInCell(cellOf(html)); }, seal),
    brollPropsInField: contentMemo(function (html) { return brollPropsInCell(cellOf(html)); }, seal),
    wordCount: contentMemo(function (html) { return countWords(cellOf, html); }, seal)
  };
}
