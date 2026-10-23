import { __init as mountDraftEdit } from "../../features/editing/draft-edit.js";
import type { DraftEditPorts } from "../../features/editing/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { sharedPorts } from "./shared-ports.ts";

const draftEdit = owned<ReturnType<typeof mountDraftEdit>>();

export function mountDraftEditFeature(): ReturnType<typeof mountDraftEdit> {
  return draftEdit.replace(function () {
    const ports: DraftEditPorts = { text: sharedPorts().text };
    return mountDraftEdit(ports);
  });
}

export const stopDraftEditFeature = draftEdit.stop;
