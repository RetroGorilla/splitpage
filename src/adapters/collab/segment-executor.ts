import type { SharedSegmentCreate } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import type { SharedStructureOrderView } from "./structure-order.ts";
import { prepareSharedOrderInsertion, applySharedOrderInsertion } from "./structure-order.ts";
import { prepareStructureIdentity, SharedStructurePreparationError } from "./structure-identity.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { applySharedTextCreation } from "./text-target.ts";
import { prepareSharedTextCreation } from "./text-creation.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { scalarFieldAllowed } from "./scalar-executor.ts";

export function prepareSharedSegmentCreation(operation: SharedSegmentCreate, view: SharedPreparationView, order: SharedStructureOrderView) {
  try {
    if (!isStableSharedIdentity(operation.by) || !isStableSharedIdentity(operation.segment)) return { ok: false as const, reason: "unstable-identity" };
    const beat = prepareStructureIdentity(view, operation.id, "beat", operation.beat), segment = operation.segment === operation.beat
      ? JSON.stringify(["structure", view.writer, operation.id, "segment"]) : prepareStructureIdentity(view, operation.id, "segment", operation.segment);
    const path = ["segments", segment], beatPath = ["beats", beat];
    if (view.has(path) || view.has(beatPath)) return { ok: false as const, reason: "existing-identity" };
    const writes: SharedPreparedWrite[] = [{ kind: "map", path }, { kind: "set", path: [...path, "head"], value: { b: beat } },
      { kind: "map", path: beatPath }, { kind: "set", path: [...beatPath, "id"], value: beat },
      { kind: "set", path: [...beatPath, "segment"], value: segment }, { kind: "map", path: [...beatPath, "joins"] }, { kind: "map", path: [...beatPath, "removals"] }];
    for (const [field, value] of Object.entries(operation.fields)) {
      if ((field === "audioText" || field === "visualText") && value === "" || field === "imageRef" && value === null) continue;
      if (field !== "status" && !scalarFieldAllowed("beat", field, value, false) || field === "status" && !["todo", "ready", "shot"].includes(String(value))) return { ok: false as const, reason: "unsupported-beat-field" };
      writes.push({ kind: "set", path: [...beatPath, field], value });
    }
    const virtual: SharedPreparationView = { ...view, kind: candidate => candidate.length === 2 && candidate.every((part, index) => part === path[index]) ? "map" : view.kind(candidate) };
    const text = prepareSharedTextCreation(virtual, path);
    if (!text.ok) return text;
    const placement = { index: prepareSharedOrderInsertion(view, order, operation.at, segment), segment };
    const description = freezeSharedPreparedValue({ writes, text: text.description, placement });
    return { ok: true as const, description, writes: freezeSharedPreparedValue([...writes, ...text.writes]), apply: (handle: SharedDocumentHandle) => {
      applySharedMapWrites(handle, description.writes); applySharedTextCreation(handle, description.text); applySharedOrderInsertion(handle, description.placement);
    } };
  } catch (error) { if (error instanceof SharedStructurePreparationError) return { ok: false as const, reason: error.message }; throw error; }
}
