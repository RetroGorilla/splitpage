import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeGalleryField as currentMergeGalleryField, galleryItemKey, mergeGalleryThumbnailRemovals, videoLinkKey } from "../../../src/core/document/gallery.ts";
import type { GalleryItem, GallerySide, VideoLink } from "../../../src/core/document/gallery.ts";
import type { ImageRef } from "../../../src/core/document/ports.ts";

function copy<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function locationKey(l: VideoLink | null | undefined): string {
  if (!l || !l.location) return "";
  return "@" + l.location.kind + ":" + (l.location.kind === "path" ? l.location.path : l.location.name);
}

// why: freeze origin/main d618e247's decisions so only #1278's removed links may differ
function mergeSet<T>(base: readonly T[] | null | undefined, mine: readonly T[] | null | undefined, theirs: readonly T[] | null | undefined, key: (x: T) => string, both?: (b: T | undefined, m: T, t: T) => T): T[] {
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

function mergeLink(b: VideoLink | undefined, m: VideoLink, t: VideoLink): VideoLink {
  const out = copy(t);
  if (!m.location) return out;
  // why: a copy beside the script travels with it, and a path works on one computer only (#1252)
  if (t.location && (m.location.kind === "bundled") !== (t.location.kind === "bundled")) {
    if (m.location.kind === "bundled") out.location = copy(m.location);
    return out;
  }
  // why: an older build drops a location when it saves, and nothing here removes one, so a missing one never wins
  if (!t.location || (locationKey(t) === locationKey(b) && locationKey(m) !== locationKey(b))) out.location = copy(m.location);
  return out;
}

function baseMergeGalleryField(f: string, b: GallerySide | null | undefined, m: GallerySide, t: GallerySide): VideoLink[] | GalleryItem[] | undefined {
  let list: VideoLink[] | GalleryItem[];
  if (f === "imageLinks") {
    list = mergeSet(b && b.imageLinks, m.imageLinks, t.imageLinks, videoLinkKey, mergeLink);
  } else {
    list = mergeSet(b && b.moreImages, m.moreImages, t.moreImages, galleryItemKey, function (bi, mi, ti) {
      const out = copy(ti);
      const links = mergeSet(bi && bi.links, mi.links, ti.links, videoLinkKey, mergeLink);
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

function image(n: number): ImageRef {
  return { sha256: n.toString(16).padStart(64, "0"), width: 1, height: 1, mime: "image/png" };
}

for (const [shape, label] of ["original moved to primary", "second successor in primary", "base item moved from primary", "two further successors"].entries()) test("video removals (#1278, seeded differential): " + label + " retains main's decision", () => {
  for (let seed = 1; seed <= 1000; seed++) {
    const r = seeded(seed);
    const video: VideoLink = r() < 0.5 ? { href: "https://example.test/" + seed, poster: true } :
      { name: "take-" + seed + ".mp4", size: seed, poster: true, location: { kind: "bundled", name: "take.mp4" } };
    const original: GalleryItem = { imageRef: image(1), links: [video] };
    const replacement: GalleryItem = { imageRef: image(2), links: [copy(video)] };
    const addition: GalleryItem = { imageRef: image(3), links: [copy(video)] };
    const base = { imageRef: image(10), moreImages: [original] };
    const changed = copy(base), removed = copy(base);
    delete removed.moreImages[0]?.links;
    changed.moreImages = [replacement];
    switch (shape) {
      case 0:
        changed.imageRef = image(1);
        Object.assign(changed, { imageLinks: [copy(video)] });
        break;
      case 1:
        changed.imageRef = image(3);
        Object.assign(changed, { imageLinks: [copy(video)] });
        break;
      case 2:
        base.imageRef = image(1);
        Object.assign(base, { imageLinks: [copy(video)] });
        base.moreImages = [];
        removed.imageRef = image(1);
        removed.moreImages = [];
        changed.moreImages = [original, addition];
        break;
      case 3:
        changed.moreImages.push(addition);
        break;
    }
    if (r() < 0.5) changed.moreImages.reverse();
    for (const [mine, theirs] of [[changed, removed], [removed, changed]] as const) {
      const before = JSON.stringify([base, mine, theirs]);
      for (const field of ["imageLinks", "moreImages"]) {
        const expected = baseMergeGalleryField(field, base, mine, theirs);
        assert.deepEqual(currentMergeGalleryField(field, base, mine, theirs), expected,
          "seed " + seed + ", shape " + shape + ", field " + field + ", changed " + (mine === changed ? "mine" : "theirs"));
      }
      assert.equal(mergeGalleryThumbnailRemovals(base, mine, theirs), false,
        "seed " + seed + ", shape " + shape + ": the review must not claim thumbnail removals were combined");
      assert.equal(JSON.stringify([base, mine, theirs]), before, "seed " + seed + ": inputs unchanged");
    }
  }
});

test("video removals (#1278, seeded differential): unchanged items sharing links are paired before thumbnail successors", () => {
  const seen = { primary: 0, moved: 0, multiple: 0, ambiguous: 0, editedNeighbor: 0, exact: 0 };
  const ambiguousShapes = { ancestors: 0, successors: 0 };
  for (let seed = 1; seed <= 3000; seed++) {
    const r = seeded(seed);
    const video: VideoLink = r() < 0.5 ? { href: "https://example.test/shared/" + seed, poster: true } :
      { name: "shared-" + seed + ".mp4", size: seed, poster: true };
    const item = (n: number): GalleryItem => ({ imageRef: image(n), links: [copy(video)] });
    const unchanged = Array.from({ length: Math.floor(r() * 4) }, (_, i) => item(10 + i));
    const base: GallerySide = { imageRef: image(1), imageLinks: [copy(video)], moreImages: [item(2), ...unchanged] };
    const changed = copy(base), removed = copy(base);
    const successor = changed.moreImages?.[0] as GalleryItem;
    successor.imageRef = image(3);
    const moved = unchanged.length > 0 && r() < 0.5, ambiguous = r() < 0.25;
    if (moved) {
      changed.imageRef = image(10);
      changed.moreImages = [successor, item(1), ...unchanged.slice(1)];
    }
    if (ambiguous) {
      if (r() < 0.5) {
        base.moreImages?.push(item(4));
        removed.moreImages?.push(item(4));
        ambiguousShapes.ancestors++;
      } else {
        changed.moreImages?.push(item(4));
        ambiguousShapes.successors++;
      }
    }
    const editedNeighbor = r() < 0.2;
    if (editedNeighbor) changed.imageLinks = [{ ...video, duration: 17 }];
    delete removed.imageLinks;
    (removed.moreImages || []).forEach((it) => { delete it.links; });
    if (r() < 0.5) changed.moreImages?.reverse();
    if (r() < 0.5) removed.moreImages?.reverse();
    for (const [mine, theirs] of [[changed, removed], [removed, changed]] as const) {
      const before = JSON.stringify([base, mine, theirs]);
      for (const field of ["imageLinks", "moreImages"]) {
        const expected = baseMergeGalleryField(field, base, mine, theirs);
        if (field === "moreImages" && !ambiguous && !editedNeighbor) {
          for (const it of expected as GalleryItem[] || []) {
            if (it.imageRef?.sha256 === image(3).sha256) delete it.links;
          }
        }
        assert.deepEqual(currentMergeGalleryField(field, base, mine, theirs), expected,
          "seed " + seed + ", moved " + moved + ", ambiguous " + ambiguous + ", edited neighbor " + editedNeighbor + ", field " + field + ", changed " + (mine === changed ? "mine" : "theirs"));
      }
      assert.equal(mergeGalleryThumbnailRemovals(base, mine, theirs), !ambiguous && !editedNeighbor,
        "seed " + seed + ": the review follows the unambiguous leftover match");
      assert.equal(JSON.stringify([base, mine, theirs]), before, "seed " + seed + ": inputs unchanged");
    }
    seen.primary += moved ? 0 : 1;
    seen.moved += moved ? 1 : 0;
    seen.multiple += unchanged.length > 1 ? 1 : 0;
    seen.ambiguous += ambiguous ? 1 : 0;
    seen.editedNeighbor += editedNeighbor ? 1 : 0;
    seen.exact += unchanged.length === 0 && !ambiguous && !editedNeighbor ? 1 : 0;
  }
  for (const [what, n] of Object.entries(seen)) assert.ok(n > (what === "exact" ? 300 : what === "editedNeighbor" ? 400 : 500), what + " covered only " + n + " times");
  for (const [what, n] of Object.entries(ambiguousShapes)) assert.ok(n > 200, what + " covered only " + n + " times");
});

test("video removals (#1278, seeded differential): a link reassigned onto an existing base key retains main's decision", () => {
  const seen = { primaryAncestor: 0, primaryTarget: 0, primaryUnchanged: 0, further: 0, movedTarget: 0, copyAdded: 0 };
  for (let seed = 1; seed <= 4000; seed++) {
    const r = seeded(seed);
    const v: VideoLink = r() < 0.5 ? { href: "https://example.test/reassigned/" + seed, poster: true } :
      { name: "reassigned-" + seed + ".mp4", size: seed, poster: true };
    const w: VideoLink = { href: "https://example.test/original/" + seed, poster: true };
    const item = (n: number, link?: VideoLink): GalleryItem => ({ imageRef: image(n), ...(link ? { links: [copy(link)] } : {}) });
    const primary = Math.floor(r() * 4), moved = primary === 1 && r() < 0.5;
    const place = (items: GalleryItem[], at: number): GallerySide => {
      const head = items.find((it) => it.imageRef?.sha256 === image(at + 1).sha256);
      return { imageRef: head?.imageRef || image(10), imageLinks: head?.links, moreImages: items.filter((it) => it !== head) };
    };
    const base = place([item(1, v), item(2, w), item(3, v)], primary);
    const copyAdded = r() < 0.25;
    const changed = place([item(2, v), item(3, v), ...(copyAdded ? [item(5, v)] : [])], moved ? 3 : primary);
    const removed = place([item(1), item(2, w), item(3)], primary);
    if (r() < 0.5) changed.moreImages?.reverse();
    if (r() < 0.5) removed.moreImages?.reverse();
    for (const [mine, theirs] of [[changed, removed], [removed, changed]] as const) {
      const before = JSON.stringify([base, mine, theirs]);
      for (const field of ["imageLinks", "moreImages"]) {
        assert.deepEqual(currentMergeGalleryField(field, base, mine, theirs), baseMergeGalleryField(field, base, mine, theirs),
          "seed " + seed + ", primary " + primary + ", moved " + moved + ", field " + field + ", changed " + (mine === changed ? "mine" : "theirs"));
      }
      assert.equal(mergeGalleryThumbnailRemovals(base, mine, theirs), false,
        "seed " + seed + ": reassignment is not a thumbnail removal in the review");
      assert.equal(JSON.stringify([base, mine, theirs]), before, "seed " + seed + ": inputs unchanged");
    }
    seen.primaryAncestor += primary === 0 ? 1 : 0;
    seen.primaryTarget += primary === 1 ? 1 : 0;
    seen.primaryUnchanged += primary === 2 ? 1 : 0;
    seen.further += primary === 3 ? 1 : 0;
    seen.movedTarget += moved ? 1 : 0;
    seen.copyAdded += copyAdded ? 1 : 0;
  }
  for (const [what, n] of Object.entries(seen)) assert.ok(n > (what === "movedTarget" ? 300 : 700), what + " covered only " + n + " times");
});

test("video removals (#1278, seeded differential): main differs only for a removal against a thumbnail-only edit", () => {
  const seen = { approved: 0, reverse: 0, url: 0, file: 0, replace: 0, secondary: 0, wholeItem: 0, noBase: 0, head: 0, control: 0 };
  const changes = Array.from({ length: 14 }, () => 0);
  for (let seed = 1; seed <= 6000; seed++) {
    const r = seeded(seed);
    const isUrl = r() < 0.5, hadThumbnail = r() < 0.5, reverse = r() < 0.5;
    const field = r() < 0.2 ? "imageLinks" : "moreImages";
    const hasBase = r() >= 0.15, kind = Math.floor(r() * changes.length), removal = Math.floor(r() * 4);
    const video: VideoLink = isUrl ? { href: "https://example.test/" + seed, poster: true } :
      { name: "take-" + seed + ".mp4", size: seed, duration: 3, poster: true,
        location: r() < 0.5 ? { kind: "path", path: "C:\\Footage\\take.mp4" } : { kind: "bundled", name: "take.mp4" } };
    const extra: VideoLink = { href: "https://example.test/extra/" + seed };
    const target: GalleryItem = { links: [video, extra] };
    if (hadThumbnail) target.imageRef = image(1);
    const noise: GalleryItem = { imageRef: image(10), links: [{ name: "noise.mp4", size: 1, location: { kind: "path", path: "D:\\noise.mp4" } }] };
    const root: GallerySide = { imageLinks: [{ name: "head.mp4", size: 1 }], moreImages: [target, noise] };
    const removed = copy(root), changed = copy(root);
    const edited = changed.moreImages?.[0] as GalleryItem;
    const editedVideo = edited.links?.[0] as VideoLink;
    edited.imageRef = image(2);
    switch (kind) {
      case 1: if (isUrl) editedVideo.href += "/edited"; else editedVideo.name = "different.mp4"; break;
      case 2: editedVideo.duration = 12; break;
      case 3: if (isUrl) editedVideo.href += "/moved"; else editedVideo.location = { kind: "path", path: "E:\\take.mp4" }; break;
      case 4: if (isUrl) editedVideo.href += "/size"; else editedVideo.size = seed + 1; break;
      case 5: delete editedVideo.poster; break;
      case 6: edited.links?.push({ href: "https://example.test/new/" + seed }); break;
      case 7: edited.name = "renamed"; break;
      case 8: edited.annotation = { imageRef: image(3), marks: [] }; break;
      case 9: edited.links?.reverse(); break;
      case 10: if (target.imageRef) edited.imageRef = copy(target.imageRef); else delete edited.imageRef; break;
      case 11: removed.imageLinks?.push(copy(video)); break;
      case 12: changed.imageLinks?.push({ name: "added.mp4", size: seed }); break;
      case 13: changed.moreImages?.push(copy(target)); break;
    }
    const missing = removal === 0 ? [videoLinkKey(video)] : removal === 1 ? [videoLinkKey(extra)] : [videoLinkKey(video), videoLinkKey(extra)];
    if (removal === 3) removed.moreImages?.shift();
    else {
      const item = removed.moreImages?.[0] as GalleryItem;
      item.links = (item.links || []).filter((l) => !missing.includes(videoLinkKey(l)));
    }
    if (r() < 0.5) removed.moreImages?.reverse();
    if (r() < 0.5) changed.moreImages?.push({ imageRef: image(20), links: [{ href: "https://example.test/addition/" + seed }] });
    if (r() < 0.5) changed.moreImages?.reverse();
    const base = hasBase ? root : null, mine = reverse ? changed : removed, theirs = reverse ? removed : changed;
    const before = JSON.stringify([base, mine, theirs]);
    const expected = baseMergeGalleryField(field, base, mine, theirs);
    const allowed = hasBase && field === "moreImages" && (kind === 0 || kind === 11 || kind === 12);
    let corrected = 0;
    if (allowed) {
      for (const it of expected as GalleryItem[] || []) {
        if (it.imageRef?.sha256 !== image(2).sha256) continue;
        const links = (it.links || []).filter((l) => {
          const remove = missing.includes(videoLinkKey(l)) && !(kind === 11 && videoLinkKey(l) === videoLinkKey(video));
          if (remove) corrected++;
          return !remove;
        });
        if (links.length) it.links = links; else delete it.links;
      }
    }
    const actual = currentMergeGalleryField(field, base, mine, theirs);
    assert.deepEqual(actual, expected, "seed " + seed + ", change " + kind + ", removal " + removal);
    assert.equal(JSON.stringify([base, mine, theirs]), before, "seed " + seed + ": inputs unchanged");
    changes[kind] = (changes[kind] || 0) + 1;
    seen.approved += corrected > 0 ? 1 : 0;
    seen.control += corrected ? 0 : 1;
    seen.reverse += corrected && reverse ? 1 : 0;
    seen.url += corrected && isUrl ? 1 : 0;
    seen.file += corrected && !isUrl ? 1 : 0;
    seen.replace += corrected && hadThumbnail ? 1 : 0;
    seen.secondary += corrected && removal === 1 ? 1 : 0;
    seen.wholeItem += corrected && removal === 3 ? 1 : 0;
    seen.noBase += hasBase ? 0 : 1;
    seen.head += field === "imageLinks" ? 1 : 0;
  }
  for (const [what, n] of Object.entries(seen)) assert.ok(n > 50, what + " covered only " + n + " times");
  for (const [kind, n] of changes.entries()) assert.ok(n > 300, "change " + kind + " covered only " + n + " times");
});
