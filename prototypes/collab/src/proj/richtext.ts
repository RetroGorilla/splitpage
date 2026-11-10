import type * as Y from "yjs";
import { cleanMarks, defaultTagId, defaultTagOf, settleCues } from "../../../../src/core/text/runs.ts";
import type { Marks, Run } from "../../../../src/core/text/runs.ts";
import { records } from "./value.ts";
import type { ProjectionBag } from "./value.ts";
import { storedRunsToHtml } from "./stored-html.ts";
import { readContentAtom, readMarkRecord, readWireValue } from "../readers/records.ts";

export interface ProjectionDelta {
  insert: string | ProjectionBag;
  attributes?: Record<string, unknown>;
}

export type ProjectionSurfacePart = { storedHtml: string } | { caretSentinel: "\u200b" };

export function surfaceToDelta(parts: readonly ProjectionSurfacePart[], tags: unknown, comments: unknown): ProjectionDelta[] {
  return htmlToDelta(parts.map(part => "storedHtml" in part ? part.storedHtml : "").join(""), tags, comments);
}

function unescape(value: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name: string) => {
    if (name[0] !== "#") return entities[name.toLowerCase()] ?? whole;
    const point = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
  });
}

function attributes(token: string): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const match of token.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    result[match[1] as string] = unescape(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function htmlTokens(html: string): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < html.length) {
    if (html[start] !== "<") {
      const next = html.indexOf("<", start);
      const end = next < 0 ? html.length : next;
      result.push(html.slice(start, end));
      start = end;
      continue;
    }
    let quote: string | null = null;
    let end = start + 1;
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === html.length) throw new Error("Unterminated sanitized HTML tag");
    result.push(html.slice(start, end + 1));
    start = end + 1;
  }
  return result;
}

export function htmlToDelta(html: string, tags: unknown, comments: unknown): ProjectionDelta[] {
  const registry = records(tags);
  const anchors = records(comments);
  const result: ProjectionDelta[] = [];
  const stack: { name: string; attrs: Record<string, unknown> }[] = [];
  let serial = 0;
  let atom: { value: ProjectionBag; attrs: Record<string, unknown>; depth: number; label: string } | null = null;
  function current(): Record<string, unknown> {
    return Object.assign({}, ...stack.map(entry => entry.attrs)) as Record<string, unknown>;
  }
  for (const token of htmlTokens(html)) {
    if (token[0] !== "<") {
      if (atom) atom.label += unescape(token);
      else result.push({ insert: unescape(token).replace(/[\n\r]/g, " "), attributes: current() });
      continue;
    }
    const name = /^<\/?([\w-]+)/.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    if (token.startsWith("</")) {
      const index = stack.findLastIndex(entry => entry.name === name);
      if (index >= 0) stack.length = index;
      if (atom && stack.length < atom.depth) {
        if ("k" in atom.value) atom.value.label = atom.label;
        result.push({ insert: atom.value, attributes: atom.attrs });
        atom = null;
      }
      continue;
    }
    if (name === "br") {
      if (!atom) result.push({ insert: "\n", attributes: current() });
      continue;
    }
    const source = attributes(token);
    const attrs: Record<string, unknown> = {};
    const format: Record<string, string> = { strong: "b", b: "b", em: "i", i: "i", u: "u", s: "s", strike: "s", mark: "hl" };
    if (format[name]) attrs[format[name] as string] = true;
    const classes = (source.class ?? "").split(/\s+/);
    if (classes.includes("stage-dir")) attrs.dir = true;
    if (classes.includes("audio-cue")) attrs.cue = true;
    if (source.href) attrs[`l:${++serial}`] = source.href;
    if (source["data-cmt"]) {
      const anchor = source["data-cmt"];
      const comment = anchors.find(value => value.anchorId === anchor);
      attrs[`c:${String(comment?.id ?? anchor)}`] = true;
    }
    if (classes.includes("tag-anchor")) {
      const tag = registry.find(value => value.cat === source["data-tag-cat"] && value.name === source["data-tag-name"]);
      attrs[`t:${String(++serial).padStart(10, "0")}`] = tag?.id ?? defaultTagId(source["data-tag-cat"] ?? "", source["data-tag-name"] ?? "");
    }
    stack.push({ name, attrs });
    if (classes.includes("broll-key") || classes.includes("who-anchor")) {
      atom = {
        value: classes.includes("broll-key") ? { k: source["data-broll-id"] } : { w: source["data-who"] },
        attrs: current(), depth: stack.length, label: ""
      };
    }
  }
  return result;
}

export function deltaToRuns(delta: readonly ProjectionDelta[], tags: unknown, comments: unknown, deriveCue = false): Run[] {
  const registry = records(tags);
  const anchors = records(comments);
  const result: Run[] = [];
  for (const item of delta) {
    const attrs = item.attributes ?? {};
    const marks: Marks = cleanMarks(attrs, typeof item.insert !== "string");
    const cmts = Object.keys(attrs).filter(key => key.startsWith("c:") && attrs[key])
      .map(key => { const anchor = anchors.find(comment => comment.id === key.slice(2))?.anchorId; return typeof anchor === "string" ? anchor : key.slice(2); });
    if (cmts.length) marks.cmt = cmts.sort();
    const links = Object.keys(attrs).filter(key => key.startsWith("l:") && attrs[key]).sort();
    if (links.length) marks.href = String(attrs[links[0] as string]);
    const tagged = Object.keys(attrs).filter(key => key.startsWith("t:") && attrs[key]).sort()
      .map(key => String(attrs[key])).filter(id => registry.some(tag => tag.id === id) || defaultTagOf(id));
    if (typeof item.insert === "string") {
      if (tagged[0]) marks.tag = tagged[0];
      if (tagged.length > 1) marks.innerTags = tagged.slice(1);
      if (deriveCue) marks.cue = true;
      result.push({ text: item.insert, marks });
    } else if ("k" in item.insert) {
      result.push({ atom: "broll", id: String(item.insert.k), text: String(item.insert.label ?? "B-roll:"), marks });
    } else if ("w" in item.insert) {
      const name = String(item.insert.w);
      result.push({ atom: "who", name, text: "@" + name, marks });
    } else throw new Error("Unsupported content atom");
  }
  return deriveCue ? settleCues(result) : result;
}

export function deltaToHtml(delta: readonly ProjectionDelta[], tags: unknown, comments: unknown, deriveCue = false): string {
  const registry = records(tags);
  return storedRunsToHtml(deltaToRuns(delta, registry, comments, deriveCue), id => {
    const tag = registry.find(entry => entry.id === id);
    return tag && typeof tag.cat === "string" && typeof tag.name === "string" ? { cat: tag.cat, name: tag.name } : defaultTagOf(id);
  });
}

export function insertHtml(text: Y.Text, html: string, tags: unknown, comments: unknown, scope: string): void {
  const delta = htmlToDelta(html, tags, comments);
  for (const item of delta) item.attributes = Object.fromEntries(Object.entries(item.attributes ?? {}).map(([key, value]) => [
    key.startsWith("t:") || key.startsWith("l:") ? `${key.slice(0, 2)}${scope}:${key.slice(2)}` : key, value
  ]));
  text.applyDelta([{ retain: text.length }, ...delta]);
}

export function readDelta(text: Y.Text): ProjectionDelta[] {
  const delta = text.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[];
  return delta.flatMap((item): ProjectionDelta[] => {
    const insert = typeof item.insert === "string" ? readWireValue(item.insert) as string : readContentAtom(item.insert);
    return insert === null ? [] : [{ insert, attributes: { ...readMarkRecord(item.attributes) } }];
  });
}
