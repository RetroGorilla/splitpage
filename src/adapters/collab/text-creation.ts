import type { SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import type { SharedDocumentHandle } from "./types.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { applySharedTextCreation } from "./text-target.ts";

export function prepareSharedTextCreation(view: SharedPreparationView, path: readonly string[], title = false) {
  if (view.kind(path) !== "map") return { ok: false as const, reason: "missing-container" };
  if (view.has([...path, title ? "title" : "text"]) || view.has([...path, title ? "titleMarks" : "markRecords"])) return { ok: false as const, reason: "existing-text-or-store" };
  const description = freezeSharedPreparedValue({ path: [...path], title });
  const writes = freezeSharedPreparedValue<SharedPreparedWrite[]>([
    { kind: "text", path: [...path, title ? "title" : "text"], value: [] },
    { kind: "map", path: [...path, title ? "titleMarks" : "markRecords"] }
  ]);
  return { ok: true as const, description, writes, apply: (handle: SharedDocumentHandle) => applySharedTextCreation(handle, description) };
}
