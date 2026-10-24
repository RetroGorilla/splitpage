import { __init as mountDraftEdit } from "../../features/editing/draft-edit.js";
import { text as portText } from "./ports/text.ts";
import type { DraftEditPorts } from "../../features/editing/ports.ts";
import { owned } from "../../features/routing/owned.ts";

const draftEdit = owned<ReturnType<typeof mountDraftEdit>>();

export function mountDraftEditFeature(): ReturnType<typeof mountDraftEdit> {
  return draftEdit.replace(function () {
    const ports: DraftEditPorts = { text: portText };
    return mountDraftEdit(ports);
  });
}

export const stopDraftEditFeature = draftEdit.stop;
