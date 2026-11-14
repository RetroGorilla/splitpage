import * as productionTags from "../../features/tags/production-tags.ts";
import type { ProductionTagPorts } from "../../features/tags/ports.ts";
import { tagComposerActions as composerDefinitions } from "../../features/tags/actions.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader, refresh, stamping } from "./ports/document.ts";
import { edits, tagEditing, undoControl } from "./ports/editing.ts";
import { text } from "./ports/text.ts";
import { productionOwner } from "./ports/production.ts";
import { tagView } from "./ports/preferences.ts";
import { notices } from "./ports/effects.ts";
import { ids } from "./ports/identity.ts";
import type { ProjectFileServices } from "../../application/formats/project-file-services.ts";
import { currentPlainTags } from "./plain-tags.ts";
import { sharedCommandGuard } from "./ports/shared-command-notices.ts";
import { sharedSession } from "./session-owner.ts";

const production = owned<ReturnType<typeof productionTags.startProductionTags>>();

export function mountProductionTagsFeature() {
  return production.replace(() => {
    const ports: ProductionTagPorts = {
      sharedCommands: sharedCommandGuard(sharedSession, notices),
      document: documentReader, edits, refresh, stamping, text, production: productionOwner,
      editing: tagEditing, undo: undoControl, view: tagView, notices, ids
    };
    return productionTags.startProductionTags(ports);
  });
}

export const stopProductionTagsFeature = production.stop;

export function wireTagProduction() {
  return {
    refresh: (jobs: ReadonlySet<string>) => { production.owner()?.refresh(jobs); },
    bulkCell: productionTags.bulkTagCell,
    tagOccurrences: productionTags.tagFieldOccurrences as ProjectFileServices["tagFieldOccurrences"]
  };
}

export function tagComposerActions() {
  return composerDefinitions(currentPlainTags, notices);
}

export const currentProductionTags = production.owner;
