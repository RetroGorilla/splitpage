import type * as Y from "yjs";
import { defaultTagId } from "../../core/text/runs.ts";
import type { SharedTextAddress } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { prepareSharedMarkRecord, writeSharedMarkRecord } from "./mark-store.ts";
import { assertSharedDocumentIdle, collabState } from "./state.ts";
import { editCollabText } from "./text-edit.ts";

type ImportDelta = { insert: string | Record<string, unknown>; attributes: Record<string, unknown> };

function unescape(value: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, name: string) => {
    if (name[0] !== "#") return entities[name.toLowerCase()] ?? whole;
    const point = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
  }).replace(/\p{Cs}/gu, "\ufffd");
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

export function insertSharedHtml(handle: SharedDocumentHandle, target: SharedTextAddress, text: Y.Text, html: string, tags: readonly Record<string, unknown>[], scope: string): void {
  assertSharedDocumentIdle(collabState(handle));
  const result: ImportDelta[] = [];
  const stack: { name: string; attrs: Record<string, unknown> }[] = [];
  let serial = 0;
  let atom: { value: Record<string, unknown>; attrs: Record<string, unknown>; depth: number; label: string } | null = null;
  function current(): Record<string, unknown> {
    return Object.assign({}, ...stack.map(entry => entry.attrs)) as Record<string, unknown>;
  }
  for (const token of htmlTokens(html)) {
    if (token[0] !== "<") {
      if (atom) atom.label += unescape(token);
      else result.push({ insert: unescape(token).replace(/[\r\n]+/g, " "), attributes: current() });
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
    if (source.href) attrs[`l:${scope}:${++serial}`] = source.href;
    if (source["data-cmt"]) {
      const anchor = source["data-cmt"];
      attrs[`c:${scope}:${String(++serial).padStart(10, "0")}`] = anchor;
    }
    if (classes.includes("tag-anchor")) {
      const tag = tags.find(value => value.cat === source["data-tag-cat"] && value.name === source["data-tag-name"]);
      attrs[`t:${scope}:${String(++serial).padStart(10, "0")}`] = tag?.id ?? defaultTagId(source["data-tag-cat"] ?? "", source["data-tag-name"] ?? "");
    }
    stack.push({ name, attrs });
    if (classes.includes("broll-key") || classes.includes("who-anchor")) {
      atom = {
        value: classes.includes("broll-key") ? { k: source["data-broll-id"] } : { w: source["data-who"] },
        attrs: current(), depth: stack.length, label: ""
      };
    }
  }
  let offset = 0;
  for (const entry of result) {
    if (typeof entry.insert === "string") { editCollabText(text, { type: "text", at: offset, value: entry.insert }); offset += entry.insert.length; }
    else { editCollabText(text, { type: "atom", at: offset, value: entry.insert }); offset++; }
  }
  let from = 0, addition = 0;
  for (const entry of result) {
    const to = from + (typeof entry.insert === "string" ? entry.insert.length : 1);
    if (to > from) for (const key of Object.keys(entry.attributes).sort()) {
      const value = entry.attributes[key];
      const mark = key.startsWith("c:") ? { kind: "comment", id: key.slice(2), value }
        : key.startsWith("t:") ? { kind: "tag", id: key.slice(2), value }
        : key.startsWith("l:") ? { kind: "link", id: key.slice(2), value } : { kind: key, value };
      const operation = JSON.stringify(["hydrate", target.field, target.segment, addition++]);
      const record = prepareSharedMarkRecord(handle, target, operation, from, to, { type: "add", mark });
      if (!record || !writeSharedMarkRecord(handle, target, operation, record).ok) throw new Error("Cannot hydrate mark record");
    }
    from = to;
  }
}
