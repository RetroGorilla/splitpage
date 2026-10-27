import { startPlainTags as mountPlainTags } from "../../features/tags/plain-tags.js";
import type { PlainTagControl, PlainTagMount, PlainTagPorts } from "../../features/tags/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { cells as portCells } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";

const plainTags = owned<PlainTagMount>();

export function mountPlainTagsFeature(): PlainTagMount {
  return plainTags.replace(() => {
    const ports: PlainTagPorts = { document: portDocument, cells: portCells, text: portText };
    return mountPlainTags(ports);
  });
}

export const stopPlainTagsFeature = plainTags.stop;

export const currentPlainTags: () => PlainTagControl | null = plainTags.owner;
