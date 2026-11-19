import * as Y from "yjs";
import { nativeRankBetween } from "./rank.ts";
import { nativeSegmentSpans } from "./reader.ts";
import { nativeAvailability, nativeLiveRange, nativeRangeSnapshot } from "./text-commands.ts";
import type { NativeRefusal, NativeTextRange } from "./text-commands.ts";
import type { NativeScript } from "./script.ts";
import { nativeWellFormed } from "./values.ts";

export type NativeHeadingOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeRefusal | "rank" };

const WRITTEN: NativeHeadingOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeHeadingOutcome = Object.freeze({ kind: "unchanged" });

function refused(reason: NativeRefusal | "rank"): NativeHeadingOutcome {
  return Object.freeze({ kind: "refused", reason });
}

export function createNativeHeading(script: NativeScript, at: NativeTextRange, id: string, name: string): NativeHeadingOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return script.doc.transact(() => {
    const checked = nativeRangeSnapshot(at);
    if (!checked || checked.target.cell !== "narration" || checked.to) return refused("range");
    if (!nativeWellFormed(id) || !id) return refused("missing");
    if (!nativeWellFormed(name)) return refused("text");
    const { roots, reader } = script, key = "h:" + id, order = roots.order.toArray();
    if (roots.headings.has(id) || roots.names.has(id) || roots.segments.has(key) || order.includes(key) || reader.hasHeadingMarker(id)) return refused("missing");
    const live = nativeLiveRange(script, checked);
    if (typeof live === "string") return refused(live);
    const beat = checked.target.beat, own = reader.beatBoundary(beat), first = reader.narrationSpans(beat)[0];
    const gap = reader.ranksAboveBeat(beat);
    if (!own || !first || !gap) return refused("missing");
    const segment = roots.segments.get(first.segment), text = segment?.get("text");
    const span = nativeSegmentSpans(segment)?.[first.span], segmentIndex = order.indexOf(first.segment);
    if (!(text instanceof Y.Text) || !span || segmentIndex < 0 || (first === own && span.key !== "b:" + beat)) return refused("missing");
    let rank: string;
    try { rank = nativeRankBetween(gap.before, gap.after); }
    catch (error) { if (error instanceof RangeError) return refused("rank"); throw error; }
    const record = new Y.Map<unknown>(), cell = new Y.Text(), marker = { h: id };
    roots.headings.set(id, record);
    record.set("rank", rank);
    roots.names.set(id, cell);
    if (name) cell.insert(0, name, {});
    if (first === own && first.span === 0) {
      const heading = new Y.Map<unknown>();
      roots.segments.set(key, heading);
      heading.set("head", marker);
      heading.set("text", new Y.Text());
      roots.order.insert(segmentIndex, [key]);
    } else {
      // why: a recovered prefix belongs below the new heading with the beat's own text
      text.insertEmbed(first === own ? span.start - 1 : span.start, marker, {});
    }
    return WRITTEN;
  }, script.origin);
}

export function renameNativeHeading(script: NativeScript, range: NativeTextRange, name: string): NativeHeadingOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return script.doc.transact(() => {
    const checked = nativeRangeSnapshot(range);
    if (!checked || checked.target.cell !== "name") return refused("range");
    if (!nativeWellFormed(name)) return refused("text");
    const live = nativeLiveRange(script, checked);
    if (typeof live === "string") return refused(live);
    if (live.text.toString().slice(live.from, live.until) === name) return UNCHANGED;
    if (name.length) live.text.insert(live.from, name, {});
    if (live.until > live.from) live.text.delete(live.from + name.length, live.until - live.from);
    return WRITTEN;
  }, script.origin);
}

function markHeading(script: NativeScript, id: string, removed: boolean): NativeHeadingOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return script.doc.transact(() => {
    if (!nativeWellFormed(id) || !id) return refused("missing");
    const record = script.roots.headings.get(id);
    if (!(record instanceof Y.Map) || !script.reader.headingBoundary(id, !removed)) return refused("missing");
    if (removed) record.set("removed", true);
    else record.delete("removed");
    return WRITTEN;
  }, script.origin);
}

export function removeNativeHeading(script: NativeScript, id: string): NativeHeadingOutcome {
  return markHeading(script, id, true);
}

export function restoreNativeHeading(script: NativeScript, id: string): NativeHeadingOutcome {
  return markHeading(script, id, false);
}
