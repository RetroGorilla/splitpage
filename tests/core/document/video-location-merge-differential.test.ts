import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeGalleryField, videoLinkKey } from "../../../src/core/document/gallery.ts";
import type { GallerySide, VideoLink, VideoLocation } from "../../../src/core/document/gallery.ts";
import { mergeGalleryMoves, mergeGallerySummary } from "../../../src/core/merge/review.ts";

type Item = { links?: VideoLink[] };
type Side = { imageLinks?: VideoLink[]; moreImages?: Item[] };
type Field = "imageLinks" | "moreImages";

function copy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function baseMergeSet<T>(base: readonly T[] | null | undefined, mine: readonly T[] | null | undefined, theirs: readonly T[] | null | undefined, key: (x: T) => string, both?: (b: T | undefined, m: T, t: T) => T): T[] {
  const b: Record<string, T> = {}, m: Record<string, T> = {}, t: Record<string, T> = {};
  (base || []).forEach(function (x) { b[key(x)] = x; });
  (mine || []).forEach(function (x) { m[key(x)] = x; });
  (theirs || []).forEach(function (x) { t[key(x)] = x; });
  const out: T[] = [];
  (theirs || []).forEach(function (x) {
    const k = key(x);
    const mk = m[k];
    if (!mk) { if (b[k]) return; out.push(copy(x)); return; }
    out.push(both ? both(b[k], mk, x) : copy(x));
  });
  (mine || []).forEach(function (x) {
    const k = key(x);
    if (t[k] || b[k]) return;
    out.push(copy(x));
  });
  return out;
}

function baseLocationKey(l: VideoLink | null | undefined): string {
  if (!l || !l.location) return "";
  return "@" + l.location.kind + ":" + (l.location.kind === "path" ? l.location.path : l.location.name);
}

function baseMergeLink(b: VideoLink | undefined, m: VideoLink, t: VideoLink): VideoLink {
  const out = copy(t);
  if (!m.location) return out;
  if (!t.location || (baseLocationKey(t) === baseLocationKey(b) && baseLocationKey(m) !== baseLocationKey(b))) out.location = copy(m.location);
  return out;
}

function baseItemKey(it: Item | null | undefined): string {
  if (!it) return "";
  const poster = (Array.isArray(it.links) ? it.links : []).filter(function (l) { return l && l.poster; })[0];
  return poster ? "v:" + videoLinkKey(poster) : "";
}

function baseMergeGalleryField(f: Field, b: Side | null, m: Side, t: Side): VideoLink[] | Item[] | undefined {
  let list: VideoLink[] | Item[];
  if (f === "imageLinks") {
    list = baseMergeSet(b && b.imageLinks, m.imageLinks, t.imageLinks, videoLinkKey, baseMergeLink);
  } else {
    list = baseMergeSet(b && b.moreImages, m.moreImages, t.moreImages, baseItemKey, function (bi, mi, ti) {
      const out = copy(ti);
      const links = baseMergeSet(bi && bi.links, mi.links, ti.links, videoLinkKey, baseMergeLink);
      if (links.length) out.links = links; else delete out.links;
      return out;
    });
  }
  return list.length ? list : undefined;
}

function seeded(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) / 16777216;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;
const NAMES = ["a.mp4", "b.mov", "c.mp4"];

function places(name: string): (VideoLocation | null)[] {
  const stem = name.replace(/\.[^.]+$/, ""), ext = name.slice(stem.length);
  return [null, { kind: "path", path: "C:\\Footage\\" + name }, { kind: "path", path: "D:\\Archive\\" + name },
    { kind: "path", path: "/Users/adam/Movies/" + name }, { kind: "bundled", name }, { kind: "bundled", name: stem + " (2)" + ext }];
}

function link(r: () => number, name: string, poster: boolean): VideoLink {
  const at = pick(r, places(name));
  const out: VideoLink = { name, size: 3 };
  if (at) out.location = at;
  if (poster) out.poster = true;
  return out;
}

function moved(r: () => number, l: VideoLink): VideoLink | null {
  const roll = r();
  if (roll < 0.1) return null;
  if (roll < 0.45) return copy(l);
  const out = copy(l);
  const at = pick(r, places(l.name as string));
  if (at) out.location = at; else delete out.location;
  return out;
}

function evolve(r: () => number, base: Side, f: Field): Side {
  if (f === "imageLinks") {
    const links = (base.imageLinks || []).map((l) => moved(r, l)).filter((l): l is VideoLink => !!l);
    if (r() < 0.2) {
      const name = pick(r, NAMES);
      if (!links.some((l) => l.name === name)) links.push(link(r, name, false));
    }
    return links.length ? { imageLinks: links } : {};
  }
  const items: Item[] = [];
  (base.moreImages || []).forEach((it) => {
    const links = (it.links || []).map((l, i) => i === 0 ? moved(r, l) ?? copy(l) : moved(r, l)).filter((l): l is VideoLink => !!l);
    if (r() >= 0.1) items.push({ links });
  });
  return items.length ? { moreImages: items } : {};
}

function start(r: () => number, f: Field): Side {
  const names = NAMES.filter(() => r() < 0.7);
  if (f === "imageLinks") return names.length ? { imageLinks: names.map((n, i) => link(r, n, i === 0)) } : {};
  return names.length ? { moreImages: names.map((n) => ({ links: [link(r, n, true)].concat(r() < 0.5 ? [link(r, "extra " + n, false)] : []) })) } : {};
}

function linksOf(side: Side | VideoLink[] | Item[] | undefined, f: Field): Map<string, VideoLink> {
  const out = new Map<string, VideoLink>();
  const list = Array.isArray(side) ? side : side ? side[f] : undefined;
  if (f === "imageLinks") (list as VideoLink[] | undefined || []).forEach((l) => out.set(videoLinkKey(l), l));
  else (list as Item[] | undefined || []).forEach((it) => (it.links || []).forEach((l) => out.set(baseItemKey(it) + "\n" + videoLinkKey(l), l)));
  return out;
}

const isBundled = (l: VideoLink | undefined) => !!l && !!l.location && l.location.kind === "bundled";
const isPath = (l: VideoLink | undefined) => !!l && !!l.location && l.location.kind === "path";
const place = (l: VideoLink | undefined) => JSON.stringify((l && l.location) || null);

function approved(f: Field, expected: VideoLink[] | Item[] | undefined, m: Side, t: Side): number {
  const mine = linksOf(m, f), theirs = linksOf(t, f);
  let changed = 0;
  linksOf(expected, f).forEach((out, k) => {
    const ml = mine.get(k), tl = theirs.get(k);
    if (!ml || !tl) return;
    const winner = isBundled(ml) && isPath(tl) ? ml : isBundled(tl) && isPath(ml) ? tl : null;
    if (!winner || !winner.location || place(out) === place(winner)) return;
    out.location = copy(winner.location);
    changed++;
  });
  return changed;
}

test("merging links (#1252, seeded differential): the head matches main except that a bundled copy beats a path", () => {
  const seen = { approved: 0, bundledNames: 0, noBase: 0, removed: 0, more: 0, moves: 0, notOnly: 0 };
  for (let seed = 1; seed <= 3000; seed++) {
    const r = seeded(seed);
    const f: Field = r() < 0.5 ? "imageLinks" : "moreImages";
    const root = start(r, f);
    const b = r() < 0.2 ? null : root;
    const m = evolve(r, root, f), t = evolve(r, root, f);
    const head = mergeGalleryField(f, b as GallerySide | null, m as GallerySide, t as GallerySide);
    const expected = baseMergeGalleryField(f, b, m, t);
    const diff = approved(f, expected, m, t);
    assert.deepEqual(head, expected, "seed " + seed);
    seen.approved += diff ? 1 : 0;
    seen.noBase += b ? 0 : 1;
    seen.more += f === "moreImages" ? 1 : 0;
    seen.removed += linksOf(m, f).size < linksOf(root, f).size || linksOf(t, f).size < linksOf(root, f).size ? 1 : 0;
    const mine = linksOf(m, f), theirs = linksOf(t, f), merged = linksOf(head, f);
    mine.forEach((ml, k) => {
      const tl = theirs.get(k);
      if (tl && isBundled(ml) && isBundled(tl) && place(ml) !== place(tl)) seen.bundledNames++;
    });

    const moves = mergeGalleryMoves(f, b, m, t);
    const sides = new Set<string>();
    let allBundled = true;
    mine.forEach((ml, k) => {
      const tl = theirs.get(k);
      if (!tl || place(ml) === place(tl)) {
        assert.ok(!moves.keys.has(k), "seed " + seed + ": an unmoved link is not a move");
        return;
      }
      assert.ok(moves.keys.has(k), "seed " + seed + ": every moved link is a move");
      const kept = merged.get(k);
      const side = place(kept) === place(ml) ? "mine" : "theirs";
      assert.equal(place(kept), place(side === "mine" ? ml : tl), "seed " + seed + ": the merge keeps one side's location");
      sides.add(side);
      const won = side === "mine" ? ml : tl, lost = side === "mine" ? tl : ml;
      if (!(isBundled(won) && !isBundled(lost))) allBundled = false;
    });
    assert.equal(moves.keys.size, [...moves.keys].length);
    if (!moves.keys.size) {
      assert.deepEqual([moves.kept, moves.bundled, moves.only], [null, false, false], "seed " + seed);
      continue;
    }
    seen.moves++;
    assert.equal(moves.kept, sides.size > 1 ? "mixed" : [...sides][0], "seed " + seed + ": the header names the side the merge keeps");
    assert.equal(moves.bundled, allBundled, "seed " + seed + ": the header says a copy beside the script is kept only when it is");
    if ([...mine.keys()].sort().join("|") !== [...theirs.keys()].sort().join("|")) {
      assert.equal(moves.only, false, "seed " + seed + ": a link added or removed too is not a move alone");
      seen.notOnly++;
    }
    if (moves.only) {
      assert.notEqual(mergeGallerySummary(m, f, moves.keys), mergeGallerySummary(t, f, moves.keys),
        "seed " + seed + ": a move alone never shows two identical sides");
    }
  }
  for (const [what, n] of Object.entries(seen)) assert.ok(n > 50, what + " covered only " + n + " times");
});
