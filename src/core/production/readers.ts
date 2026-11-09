import type { Frozen, Seal } from "../document/freeze.ts";
import { contentMemo } from "../document/memo.ts";
import { cappedName } from "../document/text-policy.ts";
import type { TagName } from "../document/tags.ts";
import { cuesInCell } from "../text/cues.ts";
import type { CellDecoder } from "../text/ports.ts";
import { spokenText } from "../text/projections.ts";
import { tagNameOf } from "../text/runs.ts";
import { whoSentences } from "../text/who.ts";
import { brollInCell, brollPropsInCell } from "./broll.ts";
import type { FieldTag, FieldWho, ProductionReaders, WhoPair } from "./ports.ts";

type TagSpan = { id: string; catId: string; name: string; text: string };

function readTags(cellOf: CellDecoder, html: string): FieldTag[] {
  const out: TagSpan[] = [];
  let last: TagSpan | null = null;
  cellOf(html).forEach(function (r) {
    const id = r.atom ? null : r.marks.innerTags?.at(-1) || r.marks.tag;
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
      const name = cappedName(c.name, 80);
      if (name) found.push({ catId: "sound", name: name, text: c.text });
    });
  }
  return found;
}

function readCueNames(cellOf: CellDecoder, html: string): string[] {
  if (html.indexOf("audio-cue") === -1) return [];
  return cuesInCell(cellOf(html)).map(function (c) { return cappedName(c.name, 80); }).filter(Boolean);
}

function countWords(cellOf: CellDecoder, html: string): number {
  const text = spokenText(cellOf(html));
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function readWho(cellOf: CellDecoder, html: string): FieldWho {
  const names: string[] = [], pairs: WhoPair[] = [];
  whoSentences(cellOf(html)).forEach(function (s) {
    s.names.forEach(function (who) { if (names.indexOf(who) === -1) names.push(who); });
    s.tags.forEach(function (id) {
      const t = tagNameOf(id);
      const name = t ? t.name.trim() : "";
      if (!name) return;
      const who = s.names[s.names.length - 1];
      if (who) pairs.push({ cat: (t as TagName).cat, name: name, who: who });
    });
  });
  return { names: names, pairs: pairs };
}

export function createProductionReaders(cellOf: CellDecoder, seal: Seal): ProductionReaders {
  const noWho: Frozen<FieldWho> = seal({ names: [], pairs: [] });
  const whoMemo = contentMemo(function (html) { return readWho(cellOf, html); }, seal);
  return {
    whoInField: function (html) { return html && html.indexOf("who-anchor") !== -1 ? whoMemo(html) : noWho; },
    cellOf: cellOf,
    tagsInField: contentMemo(function (html) { return readTags(cellOf, html); }, seal),
    cueNamesInField: contentMemo(function (html) { return readCueNames(cellOf, html); }, seal),
    brollInField: contentMemo(function (html) { return brollInCell(cellOf(html)); }, seal),
    brollPropsInField: contentMemo(function (html) { return brollPropsInCell(cellOf(html)); }, seal),
    wordCount: contentMemo(function (html) { return countWords(cellOf, html); }, seal)
  };
}
