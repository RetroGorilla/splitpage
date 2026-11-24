import * as Y from "yjs";
import { normalizeBeatLength, rowStatusId } from "../../../core/document/timing.ts";
import { nativeBeatEntries } from "./convert.ts";
import { prepareNativeRuns, writeNativeRuns } from "./inline.ts";
import type { NativeSavedBeat } from "./pending-edits.ts";
import { isValidNativeRank, nativeRankBetween, NativeRankError } from "./rank.ts";
import type { NativeRankedBlock } from "./reader.ts";
import { copyRecordValue } from "./record-values.ts";
import { transactPreparedNativeCommand } from "./script.ts";
import type { NativeScript } from "./script.ts";
import { encodeNativeEditStamp, nativeAvailability } from "./text-commands.ts";
import type { NativeEditStamp, NativeRefusal } from "./text-commands.ts";
import { decodeNativeValue, mintNativeId, nativeWellFormed, recordBag } from "./values.ts";

export type NativePutBackBeat = Pick<NativeSavedBeat, "id" | "placement" | "narration" | "visual" | "fields">;

export type NativePutBackOutcome =
  | { readonly kind: "written"; readonly created: string }
  | { readonly kind: "refused"; readonly reason: NativeRefusal | "stored" | "taken" };

function refused(reason: Extract<NativePutBackOutcome, { kind: "refused" }>["reason"]): NativePutBackOutcome {
  return Object.freeze({ kind: "refused", reason });
}

function prepare(saved: NativePutBackBeat) {
  try {
    const { id, placement, narration, visual, fields } = saved;
    const { scene, sceneOrder } = placement;
    if (!Array.isArray(sceneOrder)) return null;
    const old = Array.from(structuredClone(sceneOrder) as readonly unknown[]), record = copyRecordValue(fields, "stored");
    if (!id || (scene !== null && !nativeWellFormed(scene)) ||
      !old.every(nativeWellFormed) || !old.includes(id) || !recordBag(record)) return null;
    const audio = prepareNativeRuns(structuredClone(narration)), picture = prepareNativeRuns(structuredClone(visual));
    if (!audio || !picture) return null;
    const content: Record<string, unknown> = {
      ...record, status: rowStatusId(record.status) ?? "todo", lengthSeconds: normalizeBeatLength(record.lengthSeconds)
    };
    for (const key of ["rank", "joined"]) Reflect.deleteProperty(content, key);
    if (content.paragraphStart !== true) Reflect.deleteProperty(content, "paragraphStart");
    return { id, scene, old, audio, picture, entries: nativeBeatEntries(content) };
  } catch { return null; }
}

type SavedInsertPlan = NonNullable<ReturnType<typeof prepare>>;
type InsertPlan = Omit<SavedInsertPlan, "id"> & { readonly id: string | null };

function gap(order: readonly NativeRankedBlock[], saved: InsertPlan): string {
  const heading = order.findIndex(block => block.kind === "heading" && block.id === saved.scene);
  const start = heading + 1, next = order.findIndex((block, index) => index >= start && block.kind === "heading");
  const stop = next === -1 ? order.length : next;
  const neighbourhood = new Map(order.slice(start, stop).map((block, index) => [block.id, start + index]));
  const oldAt = saved.id === null ? -1 : saved.old.indexOf(saved.id), sameScene = saved.scene === null || heading !== -1;
  const left = sameScene ? saved.old.slice(0, oldAt).findLast(id => neighbourhood.has(id)) : undefined;
  const right = sameScene ? saved.old.slice(oldAt + 1).find(id => neighbourhood.has(id)) : undefined;
  const leftAt = left === undefined ? undefined : neighbourhood.get(left), rightAt = right === undefined ? undefined : neighbourhood.get(right);
  let at = leftAt === undefined ? (rightAt ?? stop) : leftAt + 1;
  const overlaps = (index: number) => {
    const previous = order[index - 1], following = order[index];
    return previous && following && (previous.rank === following.rank || previous.head !== null && previous.head === following.head);
  };
  if (leftAt === undefined && rightAt !== undefined) {
    while (at > start && order[at]?.head !== null && order[at]?.head === order[at - 1]?.head) at--;
  }
  while (at < stop && (overlaps(at) || order[at]?.rank === "" && order[at]?.bound === null)) at++;
  while (at > start && overlaps(at)) at--;
  const lower = order[at - 1], upper = order[at];
  return nativeRankBetween(lower?.rank === "" && lower.bound === null ? null : lower?.rank ?? null, upper?.rank ?? null);
}

function insertBeat(script: NativeScript, plan: Pick<InsertPlan, "id" | "audio" | "picture" | "entries">,
  placement: () => { rank: string; writes?: ReadonlyMap<Y.Map<unknown>, string> } | null,
  stamp?: NonNullable<ReturnType<typeof encodeNativeEditStamp>>): NativePutBackOutcome {
  const { doc, roots, reader } = script;
  const created = mintNativeId(doc, "r"), key = "b:" + created;
  if (created === plan.id || roots.beats.has(created) || roots.visuals.has(created) || roots.segments.has(key) ||
    roots.order.toArray().includes(key) || reader.hasBeatMarker(created)) return refused("taken");
  let place: ReturnType<typeof placement>;
  try { place = placement(); }
  catch (error) { if (error instanceof NativeRankError) return refused("stored"); throw error; }
  if (!place) return refused("stored");
  for (const [record, rank] of place.writes ?? []) record.set("rank", rank);
  const segment = new Y.Map<unknown>(), record = new Y.Map<unknown>(), audio = new Y.Text(), visual = new Y.Text();
  roots.segments.set(key, segment);
  segment.set("head", { b: created });
  segment.set("text", audio);
  writeNativeRuns(doc, audio, 0, plan.audio, null);
  roots.order.push([key]);
  roots.beats.set(created, record);
  record.set("rank", place.rank);
  for (const [field, value] of plan.entries) record.set(field, value);
  roots.visuals.set(created, visual);
  writeNativeRuns(doc, visual, 0, plan.picture, null);
  if (stamp) roots.edited.set(created, stamp);
  return Object.freeze({ kind: "written", created });
}

function blankBeat(audio: InsertPlan["audio"] = [], paragraphStart?: true) {
  return { id: null, audio, picture: [], entries: nativeBeatEntries({ status: "todo", lengthSeconds: normalizeBeatLength(undefined), paragraphStart }) };
}

function adjacentPlacement(script: NativeScript, order: readonly NativeRankedBlock[], at: number) {
  const left = order[at - 1], right = order[at];
  if (left?.bound === "" || right?.bound === "") return null;
  if (left?.rank !== "" && right?.rank !== "" && left?.rank !== right?.rank) {
    return { rank: nativeRankBetween(left?.rank ?? null, right?.rank ?? null) };
  }
  const lower = left?.rank || null;
  let end = at;
  while (end < order.length && order[end]?.rank === (lower ?? "")) end++;
  const upper = order[end]?.rank ?? null, rank = nativeRankBetween(lower, upper);
  const writes = new Map<Y.Map<unknown>, string>(), overrides = new Map<string, string>();
  function assign(block: NativeRankedBlock, value: string): boolean {
    const record = (block.kind === "beat" ? script.roots.beats : script.roots.headings).get(block.id);
    if (!(record instanceof Y.Map) || record.has("rank") && !isValidNativeRank(record.get("rank"))) return false;
    writes.set(record, value);
    overrides.set((block.kind === "beat" ? "b:" : "h:") + block.id, value);
    return true;
  }
  if (lower === null) {
    let cursor: string | null = null;
    for (const block of order.slice(0, at)) {
      cursor = nativeRankBetween(cursor, rank);
      if (!assign(block, cursor)) return null;
    }
  }
  let cursor = rank;
  for (const block of order.slice(at, end)) {
    cursor = nativeRankBetween(cursor, upper);
    if (!assign(block, cursor)) return null;
  }
  if (script.reader.previewMoveOrder(overrides).some((block, index) => block.id !== order[index]?.id || block.kind !== order[index]?.kind)) return null;
  return { rank, writes };
}

export function insertNativeBeatAdjacent(script: NativeScript, beat: string, side: "above" | "below", stamp?: NativeEditStamp,
  transferParagraphStart = false, narration = ""): NativePutBackOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!beat || !nativeWellFormed(beat) || side !== "above" && side !== "below") return refused("missing");
  return transactPreparedNativeCommand(script, () => ({
    encoded: encodeNativeEditStamp(stamp),
    audio: typeof narration === "string" ? prepareNativeRuns(narration ? [{ text: narration, marks: {} }] : []) : null
  }), ({ encoded, audio }) => {
    if (encoded === null || !audio) return refused("text");
    const order = script.reader.rankedOrder();
    const at = order.findIndex(block => block.kind === "beat" && block.id === beat && block.head === beat);
    if (at < 0 || !script.reader.beatBoundary(beat)) return refused("missing");
    let insertAt = at;
    if (side === "below") {
      do insertAt++; while (order[insertAt]?.head === beat);
    }
    const record = script.roots.beats.get(beat);
    const paragraphStart = side === "above" && transferParagraphStart && decodeNativeValue(record?.get("paragraphStart"))?.value === true;
    const outcome = insertBeat(script, blankBeat(audio, paragraphStart ? true : undefined), () => adjacentPlacement(script, order, insertAt), encoded);
    if (outcome.kind === "written" && paragraphStart) record?.delete("paragraphStart");
    return outcome;
  }, refused, () => true, true);
}

export function putBackNativeBeat(script: NativeScript, saved: NativePutBackBeat | null): NativePutBackOutcome {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  if (!saved) return refused("missing");
  return transactPreparedNativeCommand(script, () => prepare(saved), plan =>
    plan ? insertBeat(script, plan, () => ({ rank: gap(script.reader.rankedOrder(), plan) })) : refused("text"), refused);
}

export function createFirstNativeBeat(script: NativeScript, narration = "", stamp?: NativeEditStamp): NativePutBackOutcome | { readonly kind: "unchanged" } {
  const unavailable = nativeAvailability(script);
  if (unavailable) return refused(unavailable);
  return transactPreparedNativeCommand(script, () => ({
    audio: typeof narration === "string" ? prepareNativeRuns(narration ? [{ text: narration, marks: {} }] : []) : null,
    encoded: encodeNativeEditStamp(stamp)
  }), ({ audio, encoded }) => {
    if (!audio || encoded === null) return refused("text");
    const order = script.reader.rankedOrder();
    if (order.some(block => block.kind === "beat")) return Object.freeze({ kind: "unchanged" });
    const plan = { ...blankBeat(audio), scene: null, old: [] };
    return insertBeat(script, plan, () => ({ rank: gap(order, plan) }), encoded);
  }, refused, () => true, true);
}
