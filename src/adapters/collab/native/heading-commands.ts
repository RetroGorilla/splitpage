import * as Y from "yjs";
import { nativeAvailability, nativeLiveRange, nativeRangeSnapshot } from "./text-commands.ts";
import type { NativeRefusal, NativeTextRange } from "./text-commands.ts";
import type { NativeScript } from "./script.ts";
import { nativeWellFormed } from "./values.ts";

export type NativeHeadingOutcome =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: NativeRefusal };

const WRITTEN: NativeHeadingOutcome = Object.freeze({ kind: "written" });
const UNCHANGED: NativeHeadingOutcome = Object.freeze({ kind: "unchanged" });

function refused(reason: NativeRefusal): NativeHeadingOutcome {
  return Object.freeze({ kind: "refused", reason });
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
    if (!(record instanceof Y.Map) || typeof record.get("rank") !== "string" || !script.reader.headingBoundary(id, !removed)) return refused("missing");
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
