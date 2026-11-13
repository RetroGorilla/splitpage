import type { SharedSegmentCreate, SharedContentRef } from "../../core/collab/operations.ts";
import type { SharedDocumentHandle } from "./types.ts";
import type { SharedPreparationView, SharedPreparedWrite } from "./prepare.ts";
import type { SharedStructureOrderView } from "./structure-order-index.ts";
import type { SharedStructureContentPorts } from "./structure-content.ts";
import type { SharedTextWritePlan } from "./text-edit.ts";
import type { SharedTextExecutionDescription } from "./text-description.ts";
import { applySharedOrderInsertion } from "./structure-order.ts";
import { prepareStructureIdentity, prepareStructureAlias, sharedStructureIdentity, reserveSharedStructureIdentity, SharedStructurePreparationError } from "./structure-identity.ts";
import type { SharedStructureIdentityReservations } from "./structure-identity.ts";
import { prepareSharedBeatPlacement } from "./structure-placement.ts";
import { isStableSharedIdentity } from "./identity.ts";
import { applySharedMapWrites } from "./prepare.ts";
import { applySharedTextCreation } from "./text-target.ts";
import { prepareSharedTextCreation } from "./text-creation.ts";
import { freezeSharedPreparedValue } from "./prepare-value.ts";
import { scalarFieldAllowed } from "./scalar-fields.ts";
import { spliceSharedTextPlan, addSharedTextSource, sharedTextOverlay, SharedTextPreparationError } from "./executor-text-plan.ts";
import { applySharedTextEdit } from "./text-edit.ts";
import { applySharedTextDescription } from "./text-description.ts";
import { sharedStructureView, prepareSharedInitialContent, sharedCreatedAttachments } from "./structure-content.ts";
import { prepareSharedInitialGallery } from "./structure-gallery.ts";
import { planSharedStructureOwner, planSharedStructureHead } from "./structure-plan.ts";
import { readSharedBufferRecoveryMetadata } from "../../core/collab/removal-state.ts";

export function prepareSharedSegmentCreation(operation: SharedSegmentCreate, view: SharedPreparationView, order: SharedStructureOrderView, ports: SharedStructureContentPorts, identities: SharedStructureIdentityReservations) {
  try {
    if (!isStableSharedIdentity(operation.by) || !isStableSharedIdentity(operation.segment)) return { ok: false as const, reason: "unstable-identity" };
    const beat = prepareStructureIdentity(view, operation.id, "beat", operation.beat, identities), createdSegment = sharedStructureIdentity(view.writer, operation.id, "segment");
    const placement = prepareSharedBeatPlacement(view, order, operation.at, createdSegment, operation.beat);
    if (placement.kind === "order") reserveSharedStructureIdentity(view, createdSegment, identities);
    const segment = placement.kind === "inline" ? placement.plan.target.segment : createdSegment;
    if (operation.segment !== operation.beat) prepareStructureAlias(view, operation.segment, segment as SharedContentRef);
    const path = ["segments", segment], beatPath = ["beats", beat], visual = sharedStructureIdentity(view.writer, operation.id, "visual");
    reserveSharedStructureIdentity(view, visual, identities);
    if (placement.kind === "order" && view.has(path) || view.has(beatPath) || view.has(["visuals", visual])) return { ok: false as const, reason: "existing-identity" };
    const writes: SharedPreparedWrite[] = [...(placement.kind === "order" ? [{ kind: "map" as const, path }, { kind: "set" as const, path: [...path, "head"], value: { b: beat } }] : []),
      { kind: "map", path: beatPath }, { kind: "set", path: [...beatPath, "id"], value: beat }, { kind: "set", path: [...beatPath, "segment"], value: segment },
      { kind: "set", path: [...beatPath, "visual"], value: visual }, { kind: "map", path: [...beatPath, "joins"] }, { kind: "map", path: [...beatPath, "removals"] },
      { kind: "map", path: ["visuals", visual] }, { kind: "set", path: ["visuals", visual, "beat"], value: beat }, { kind: "set", path: ["visuals", visual, "rank"], value: "0000000000" }];
    const extra: [string, unknown][] = [], stamp: Record<string, unknown> = {};
    if (Object.hasOwn(operation.fields, "bufferSourceOwner") || Object.hasOwn(operation.fields, "bufferPaintedBase")) {
      const metadata = readSharedBufferRecoveryMetadata(operation.fields);
      if (!metadata) throw new SharedStructurePreparationError("invalid-buffer-recovery-metadata");
      writes.push({ kind: "set", path: [...beatPath, "bufferRecovery"], value: metadata });
    }
    for (const [field, value] of Object.entries(operation.fields)) {
      if (field === "bufferSourceOwner" || field === "bufferPaintedBase") continue;
      if (["audioText", "visualText"].includes(field)) { if (typeof value !== "string" && value !== null) throw new SharedStructurePreparationError("unsupported-beat-field"); continue; }
      if (["imageRef", "imageName", "imageAnnotation", "imageLinks", "moreImages", "visualImage"].includes(field)) continue;
      if (field === "updatedAt" || field === "updatedBy") {
        if (typeof value !== "string" && value !== null) throw new SharedStructurePreparationError("unsupported-beat-field");
        stamp[field === "updatedAt" ? "at" : "by"] = value; continue;
      }
      if (["status", "lengthSeconds", "paragraphStart", "id", "stamp"].includes(field)) {
        if (field !== "status" && !scalarFieldAllowed("beat", field, value, false) || field === "status" && !["todo", "ready", "shot"].includes(String(value))) throw new SharedStructurePreparationError("unsupported-beat-field");
        writes.push({ kind: "set", path: [...beatPath, field], value });
      } else extra.push([field, value]);
    }
    if (Object.hasOwn(stamp, "at") && Object.hasOwn(stamp, "by")) writes.push({ kind: "set", path: [...beatPath, "stamp"], value: stamp });
    else for (const [key, value] of Object.entries(stamp)) extra.push([key === "at" ? "updatedAt" : "updatedBy", value]);
    writes.push({ kind: "set", path: [...beatPath, "extra"], value: JSON.stringify(Object.fromEntries(extra.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) });
    writes.push(...prepareSharedInitialGallery(operation, view, beat, identities));
    const overlay = [...writes], texts: { readonly path: readonly string[]; readonly title: boolean }[] = [], content: SharedTextExecutionDescription[] = [];
    planSharedStructureOwner(view, beat, segment);
    let boundary: SharedTextWritePlan | null = null;
    if (placement.kind === "inline") {
      const { plan, offset } = placement, value = { b: beat };
      spliceSharedTextPlan(plan, offset, offset, [value]); addSharedTextSource(view, plan, beat, offset + 1, offset + 1, "audioText");
      boundary = { target: plan.target, edit: { type: "atom", at: offset, value }, marks: [] }; overlay.push(sharedTextOverlay(plan));
    } else {
      planSharedStructureHead(view, segment, { b: beat });
      const text = prepareSharedTextCreation(sharedStructureView(view, overlay), path); if (!text.ok) return text;
      texts.push(text.description); overlay.push(...text.writes);
    }
    const visualText = prepareSharedTextCreation(sharedStructureView(view, overlay), ["visuals", visual]); if (!visualText.ok) return visualText;
    texts.push(visualText.description); overlay.push(...visualText.writes);
    for (const field of ["audioText", "visualText"] as const) {
      const html = operation.fields[field] ?? ""; if (typeof html !== "string") throw new SharedStructurePreparationError("unsupported-beat-field");
      if (html) {
        const target = { owner: beat, segment: field === "audioText" ? segment as SharedContentRef : visual, field };
        const initial = prepareSharedInitialContent(sharedStructureView(view, overlay), target, html, JSON.stringify(["initial", operation.id, field]), operation.by, ports);
        content.push(initial.description); overlay.push(...initial.writes);
      }
    }
    sharedCreatedAttachments(view).push({ collection: "visuals", beat, html: String(operation.fields.visualText ?? ""), record: visual });
    const description = freezeSharedPreparedValue({ writes, texts, content, boundary, placement: placement.kind === "order" ? { index: placement.index, segment } : null });
    return { ok: true as const, description, writes: freezeSharedPreparedValue(overlay), apply: (handle: SharedDocumentHandle) => {
      applySharedMapWrites(handle, description.writes);
      for (const text of description.texts) applySharedTextCreation(handle, text);
      if (description.boundary) applySharedTextEdit(handle, description.boundary);
      for (const initial of description.content) applySharedTextDescription(handle, initial);
      if (description.placement) applySharedOrderInsertion(handle, description.placement);
    } };
  } catch (error) { if (error instanceof SharedStructurePreparationError || error instanceof SharedTextPreparationError) return { ok: false as const, reason: error.message }; throw error; }
}
