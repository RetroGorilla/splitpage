import { startPlainTags as mountPlainTags } from "../../features/tags/plain-tags.ts";
import type { PlainTagControl, PlainTagMount, PlainTagPorts } from "../../features/tags/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { cells as portCells, undoControl } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";
import { renderTagCategories } from "../../features/tags/production-tags.ts";

const plainTags = owned<PlainTagMount>();

export function mountPlainTagsFeature(): PlainTagMount {
  return plainTags.replace(() => {
    const ports: PlainTagPorts = { document: portDocument, cells: portCells, undo: undoControl, text: portText, renderCategories: renderTagCategories };
    return mountPlainTags(ports);
  });
}

export const stopPlainTagsFeature = plainTags.stop;

export const currentPlainTags: () => PlainTagControl | null = plainTags.owner;
