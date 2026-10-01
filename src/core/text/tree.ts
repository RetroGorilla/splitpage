import { FORMAT_MARKS, defaultTagOf, normalizeCell } from "./runs.ts";
import type { BrollRun, CellInput, FormatMark, Marks } from "./runs.ts";
import type { TagName } from "../document/tags.ts";

export type TagOf = (id: string) => TagName | null;

export type TreeOptions = { tagOf?: TagOf | null | undefined };

export type ElementKey =
  | { k: "cue" | "dir" | FormatMark; v: true }
  | { k: "cmt" | "href" | "tag"; v: string };

export type TreeElement = { el: ElementKey; kids: TreeItem[]; text?: undefined; br?: undefined; atom?: undefined };

export type TreeItem =
  | { text: string; br?: undefined; atom?: undefined; el?: undefined }
  | { br: true; text?: undefined; atom?: undefined; el?: undefined }
  | { atom: BrollRun; text?: undefined; br?: undefined; el?: undefined }
  | TreeElement;

export type TreeParent = { kids: TreeItem[] };

export type CellTree = { root: TreeParent; tagOf: TagOf };

function elementKeys(marks: Marks, isAtom: boolean): ElementKey[] {
  const keys: ElementKey[] = [];
  if (marks.cue && !isAtom) keys.push({ k: "cue", v: true });
  (marks.cmt || []).forEach(function (id) { keys.push({ k: "cmt", v: id }); });
  if (marks.dir && !isAtom) keys.push({ k: "dir", v: true });
  if (marks.href) keys.push({ k: "href", v: marks.href });
  if (marks.tag && !isAtom) keys.push({ k: "tag", v: marks.tag });
  FORMAT_MARKS.forEach(function (f) { if (marks[f]) keys.push({ k: f, v: true }); });
  return keys;
}

export function buildTree(cell: CellInput, opts?: TreeOptions | null): CellTree {
  const tagOf = (opts && opts.tagOf) || defaultTagOf;
  const root: TreeParent = { kids: [] };
  const stack: TreeParent[] = [root];
  const open: ElementKey[] = [];
  function sync(keys: readonly ElementKey[]): void {
    let n = 0;
    while (n < open.length && n < keys.length && (open[n] as ElementKey).k === (keys[n] as ElementKey).k &&
           (open[n] as ElementKey).v === (keys[n] as ElementKey).v) n++;
    open.length = n;
    stack.length = n + 1;
    for (let i = n; i < keys.length; i++) {
      const node: TreeElement = { el: keys[i] as ElementKey, kids: [] };
      (stack[stack.length - 1] as TreeParent).kids.push(node);
      stack.push(node);
      open.push(keys[i] as ElementKey);
    }
  }
  normalizeCell(cell).forEach(function (r) {
    let marks = r.marks;
    if (!r.atom && marks.tag && !tagOf(marks.tag)) {
      marks = Object.assign({}, marks);
      delete marks.tag;
    }
    sync(elementKeys(marks, !!r.atom));
    const here = (stack[stack.length - 1] as TreeParent).kids;
    if (r.atom) { here.push({ atom: r }); return; }
    const parts = r.text.split("\n");
    parts.forEach(function (p, i) {
      if (i > 0) here.push({ br: true });
      if (p) {
        const last = here[here.length - 1];
        if (last && last.text !== undefined) last.text += p; else here.push({ text: p });
      }
    });
  });
  return { root: root, tagOf: tagOf };
}
