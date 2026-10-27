import * as productionTags from "../../features/tags/production-tags.js";
import type { ProductionTagPorts } from "../../features/tags/ports.ts";
import { tagComposerActions as composerDefinitions } from "../../features/tags/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { handTagProductionTo } from "../../legacy/tag-production.ts";
import { documentReader, refresh, stamping } from "./ports/document.ts";
import { edits, tagEditing, undoControl } from "./ports/editing.ts";
import { text } from "./ports/text.ts";
import { productionOwner } from "./ports/production.ts";
import { tagView } from "./ports/preferences.ts";
import { notices } from "./ports/effects.ts";
import { ids } from "./ports/identity.ts";
import type { ProjectFileServices } from "../../application/formats/project-file-services.ts";

const production = owned<ReturnType<typeof productionTags.startProductionTags>>();

export function mountProductionTagsFeature() {
  return production.replace(() => {
    const ports: ProductionTagPorts = {
      document: documentReader, edits, refresh, stamping, text, production: productionOwner,
      editing: tagEditing, undo: undoControl, view: tagView, notices, ids
    };
    return productionTags.startProductionTags(ports);
  });
}

export const stopProductionTagsFeature = production.stop;

export function wireTagProduction() {
  handTagProductionTo(productionTags);
  return {
    refresh: productionTags.runIdleRefresh,
    bulkCell: productionTags.bulkTagCell,
    tagOccurrences: productionTags.tagFieldOccurrences as ProjectFileServices["tagFieldOccurrences"]
  };
}

export function tagComposerActions() {
  return composerDefinitions();
}

export const currentProductionTags = production.owner;
