import { FORMAT_MARKS, OBJ, cleanMarks, normalizeCell, orderedMarks, sameMarks } from "../text/runs.ts";
import type { CellInput, Marks, Run } from "../text/runs.ts";
import { explode, implode } from "../text/edits.ts";
import type { AtomChar, Char, TextChar } from "../text/edits.ts";

export type CellMerge = { cell: Run[]; conflict: boolean; markConflicts: number };

export type MarksMerge = { marks: Marks; conflict: boolean };

type Token = { key: string; chars: Char[] };

type MarkSet = Record<string, true>;

function tokenize(chars: readonly Char[]): Token[] {
  const toks: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i] as Char;
    if (c.atom) { toks.push({ key: OBJ + c.atom.id, chars: [c] }); i++; continue; }
    if (/\s/.test(c.ch)) { toks.push({ key: c.ch, chars: [c] }); i++; continue; }
    let j = i;
    let key = "";
    while (j < chars.length && !(chars[j] as Char).atom && !/\s/.test((chars[j] as TextChar).ch)) { key += (chars[j] as TextChar).ch; j++; }
    toks.push({ key: key, chars: chars.slice(i, j) });
    i = j;
  }
  return toks;
}

const LCS_LIMIT = 4000000;

function lcsMap(a: readonly Token[], b: readonly Token[]): number[] | null {
  const map = new Array<number>(a.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && (a[s] as Token).key === (b[s] as Token).key) { map[s] = s; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && (a[ea - 1] as Token).key === (b[eb - 1] as Token).key) { ea--; eb--; map[ea] = eb; }
  const n = ea - s, m = eb - s;
  if (!n || !m) return map;
  if (n * m > LCS_LIMIT) return null;
  const dp: Int32Array[] = [];
  let x: number, y: number;
  for (x = 0; x <= n; x++) dp.push(new Int32Array(m + 1));
  for (x = n - 1; x >= 0; x--) {
    const row = dp[x] as Int32Array, below = dp[x + 1] as Int32Array;
    for (y = m - 1; y >= 0; y--) {
      row[y] = (a[s + x] as Token).key === (b[s + y] as Token).key
        ? (below[y + 1] as number) + 1
        : Math.max(below[y] as number, row[y + 1] as number);
    }
  }
  x = 0;
  y = 0;
  while (x < n && y < m) {
    if ((a[s + x] as Token).key === (b[s + y] as Token).key) { map[s + x] = s + y; x++; y++; }
    else if (((dp[x + 1] as Int32Array)[y] as number) >= ((dp[x] as Int32Array)[y + 1] as number)) x++;
    else y++;
  }
  return map;
}

function markSet(m: Marks): MarkSet {
  const set: MarkSet = {};
  FORMAT_MARKS.forEach(function (k) { if (m[k]) set[k] = true; });
  if (m.dir) set.dir = true;
  if (m.cue) set.cue = true;
  if (m.href) set["href=" + m.href] = true;
  if (m.tag) set["tag=" + m.tag] = true;
  (m.cmt || []).forEach(function (id) { set["cmt=" + id] = true; });
  return set;
}

function marksFromSet(set: MarkSet): Marks {
  const m: Record<string, unknown> = {};
  Object.keys(set).forEach(function (k) {
    const eq = k.indexOf("=");
    if (eq === -1) m[k] = true;
    else if (k.slice(0, eq) === "cmt") ((m.cmt = m.cmt || []) as string[]).push(k.slice(eq + 1));
    else m[k.slice(0, eq)] = k.slice(eq + 1);
  });
  return m as Marks;
}

export function mergeMarks(o: Marks, a: Marks, b: Marks): MarksMerge {
  const so = markSet(o), sa = markSet(a), sb = markSet(b);
  const keys: Record<string, true> = {};
  [so, sa, sb].forEach(function (s) { Object.keys(s).forEach(function (k) { keys[k] = true; }); });
  const out: MarkSet = {};
  Object.keys(keys).forEach(function (k) {
    const vo = !!so[k], va = !!sa[k], vb = !!sb[k];
    if (va === vo ? vb : va) out[k] = true;
  });
  let conflict = false;
  ["href", "tag"].forEach(function (name) {
    const have = Object.keys(out).filter(function (k) { return k.indexOf(name + "=") === 0; });
    if (have.length > 1) {
      conflict = true;
      have.forEach(function (k) { if (!sb[k]) Reflect.deleteProperty(out, k); });
    }
  });
  return { marks: marksFromSet(out), conflict: conflict };
}

function sameTokens(x: readonly Token[], y: readonly Token[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const tx = x[i] as Token, ty = y[i] as Token;
    if (tx.key !== ty.key) return false;
    for (let j = 0; j < tx.chars.length; j++) {
      const cx = tx.chars[j] as Char, cy = ty.chars[j] as Char;
      const mx = cx.atom ? cx.atom.marks : cx.marks, my = cy.atom ? cy.atom.marks : cy.marks;
      if (!sameMarks(orderedMarks(cleanMarks(mx)), orderedMarks(cleanMarks(my)))) return false;
    }
  }
  return true;
}

function sameKeys(x: readonly Token[], y: readonly Token[]): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if ((x[i] as Token).key !== (y[i] as Token).key) return false;
  return true;
}

export function mergeCells(base: CellInput, mine: CellInput, theirs: CellInput): CellMerge {
  const o = tokenize(explode(base)), a = tokenize(explode(mine)), b = tokenize(explode(theirs));
  const ma = lcsMap(o, a), mb = lcsMap(o, b);
  if (!ma || !mb) {
    const ca = normalizeCell(mine), cb = normalizeCell(theirs);
    const agree = JSON.stringify(ca) === JSON.stringify(cb);
    return { cell: cb, conflict: !agree, markConflicts: 0 };
  }
  const out: Char[] = [];
  let conflict = false, markConflicts = 0;

  function emitStable(ot: Token, at: Token, bt: Token): void {
    ot.chars.forEach(function (oc, i) {
      const ac = at.chars[i] as Char, bc = bt.chars[i] as Char;
      if (oc.atom) {
        const am = mergeMarks(oc.atom.marks, (ac as AtomChar).atom.marks, (bc as AtomChar).atom.marks);
        if (am.conflict) markConflicts++;
        out.push({ atom: Object.assign({}, (bc as AtomChar).atom, { marks: am.marks }) });
        return;
      }
      const r = mergeMarks(oc.marks, (ac as TextChar).marks, (bc as TextChar).marks);
      if (r.conflict) markConflicts++;
      out.push({ ch: oc.ch, marks: r.marks });
    });
  }
  function emit(toks: readonly Token[]): void { toks.forEach(function (t) { t.chars.forEach(function (c) { out.push(c); }); }); }

  function chunk(oS: readonly Token[], aS: readonly Token[], bS: readonly Token[]): void {
    if (!oS.length && !aS.length && !bS.length) return;
    const aSame = sameKeys(oS, aS), bSame = sameKeys(oS, bS);
    if (aSame && bSame) {
      for (let i = 0; i < oS.length; i++) emitStable(oS[i] as Token, aS[i] as Token, bS[i] as Token);
    } else if (aSame) {
      emit(bS);
    } else if (bSame) {
      emit(aS);
    } else if (sameTokens(aS, bS)) {
      emit(aS);
    } else {
      conflict = true;
      emit(bS);
    }
  }

  let io = 0, ia = 0, ib = 0;
  for (let i = 0; i < o.length; i++) {
    const ai = ma[i] as number, bi = mb[i] as number;
    if (ai === -1 || bi === -1) continue;
    if (ai < ia || bi < ib) continue;
    chunk(o.slice(io, i), a.slice(ia, ai), b.slice(ib, bi));
    emitStable(o[i] as Token, a[ai] as Token, b[bi] as Token);
    io = i + 1;
    ia = ai + 1;
    ib = bi + 1;
  }
  chunk(o.slice(io), a.slice(ia), b.slice(ib));
  return { cell: implode(out), conflict: conflict, markConflicts: markConflicts };
}
