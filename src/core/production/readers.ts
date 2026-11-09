import type { Frozen, Seal } from "../document/freeze.ts";
import { contentMemo } from "../document/memo.ts";
import { cappedName } from "../document/text-policy.ts";
import type { TagName } from "../document/tags.ts";
import { cuesInCell } from "../text/cues.ts";
import type { CellDecoder } from "../text/ports.ts";
import { spokenText } from "../text/projections.ts";
import { tagNameOf, tagStack } from "../text/runs.ts";
import { whoSentences } from "../text/who.ts";
import { brollInCell, brollPropsInCell } from "./broll.ts";
import type { FieldTag, FieldWho, ProductionReaders, WhoPair } from "./ports.ts";

type TagSpan = { id: string; catId: string; name: string; text: string };

function readTags(cellOf: CellDecoder, html: string): FieldTag[] {
  const out: TagSpan[] = [];
  let active: TagSpan[] = [];
  cellOf(html).forEach(function (r) {
    const ids = r.atom ? [] : tagStack(r.marks);
    let shared = 0;
    while (shared < ids.length && shared < active.length && active[shared]?.id === ids[shared]) shared++;
    active = active.slice(0, shared);
    ids.slice(shared).forEach(function (id) {
      const t = tagNameOf(id);
      const span = { id: id, catId: t?.cat || "", name: t?.name.trim() || "", text: "" };
      active.push(span);
      if (span.name) out.push(span);
    });
    active.forEach(function (span) { span.text += r.text; });
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
