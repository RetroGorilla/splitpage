import * as Y from "yjs";
import { nativeRankBetween } from "./rank.ts";
import { nativeAvailability, nativeLiveRange, nativeRangeSnapshot, nativeWriteAvailability } from "./text-commands.ts";
import type { NativeRefusal, NativeTextRange } from "./text-commands.ts";
import { transactNativeCommand, transactPreparedNativeCommand } from "./script.ts";
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
  return transactPreparedNativeCommand(script, () => nativeRangeSnapshot(at), checked => {
    if (!checked || checked.target.cell !== "narration" || checked.to) return refused("range");
    if (!nativeWellFormed(id) || !id) return refused("missing");
    if (!nativeWellFormed(name)) return refused("text");
    const { roots, reader } = script, key = "h:" + id, order = roots.order.toArray();
    if (roots.headings.has(id) || roots.names.has(id) || roots.segments.has(key) || order.includes(key) || reader.hasHeadingMarker(id)) return refused("missing");
    const live = nativeLiveRange(script, checked);
    if (typeof live === "string") return refused(live);
    const beat = checked.target.beat, gap = reader.ranksAboveBeat(beat);
    if (!gap) return refused("missing");
    let rank: string;
    try { rank = nativeRankBetween(gap.before, gap.after); }
    catch (error) { if (error instanceof RangeError) return refused("rank"); throw error; }
    const placement = reader.headingPlacement(beat, id, rank);
    if (!placement) return refused("range");
    const text = roots.segments.get(placement.segment)?.get("text"), segmentIndex = order.indexOf(placement.segment);
    if (!(text instanceof Y.Text) || segmentIndex < 0) return refused("missing");
    const record = new Y.Map<unknown>(), cell = new Y.Text(), marker = { h: id };
    roots.headings.set(id, record);
    record.set("rank", rank);
    roots.names.set(id, cell);
    if (name) cell.insert(0, name, {});
    if (placement.at === null) {
      const heading = new Y.Map<unknown>();
      roots.segments.set(key, heading);
      heading.set("head", marker);
      heading.set("text", new Y.Text());
      roots.order.insert(segmentIndex, [key]);
    } else text.insertEmbed(placement.at, marker, {});
    return WRITTEN;
  }, refused);
}

export function renameNativeHeading(script: NativeScript, range: NativeTextRange, name: string): NativeHeadingOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return transactPreparedNativeCommand(script, () => nativeRangeSnapshot(range), checked => {
    if (!checked || checked.target.cell !== "name") return refused("range");
    if (!nativeWellFormed(name)) return refused("text");
    const live = nativeLiveRange(script, checked);
    if (typeof live === "string") return refused(live);
    if (live.text.toString().slice(live.from, live.until) === name) return UNCHANGED;
    if (name.length) live.text.insert(live.from, name, {});
    if (live.until > live.from) live.text.delete(live.from + name.length, live.until - live.from);
    return WRITTEN;
  }, refused, () => name !== "");
}

function markHeading(script: NativeScript, id: string, removed: boolean): NativeHeadingOutcome {
  const unavailable = nativeWriteAvailability(script);
  if (unavailable) return refused(unavailable);
  return transactNativeCommand(script, () => {
    if (!nativeWellFormed(id) || !id) return refused("missing");
    const record = script.roots.headings.get(id);
    if (!(record instanceof Y.Map) || !script.reader.headingBoundary(id, !removed)) return refused("missing");
    if (removed) record.set("removed", true);
    else record.delete("removed");
    return WRITTEN;
  });
}

export function removeNativeHeading(script: NativeScript, id: string): NativeHeadingOutcome {
  return markHeading(script, id, true);
}

export function restoreNativeHeading(script: NativeScript, id: string): NativeHeadingOutcome {
  return markHeading(script, id, false);
}
