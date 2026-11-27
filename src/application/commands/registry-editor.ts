import type { ShotFields } from "./broll-records.ts";
import type { OwnerChoice, TagChange, TagRef } from "./production-records.ts";
import type { RecordCommandRun, SharedRecordCommands } from "./shared-records.ts";
import type { BrollUnmergedEdit } from "../../core/document/broll.ts";

export interface RegistryEditor {
  readonly addPerson: (name: string) => RegistryCreation;
  readonly removePerson: (id: string) => RecordCommandRun;
  readonly registerTag: (cat: string, name: unknown) => RecordCommandRun;
  readonly canonicalTagId: (id: string) => string;
  readonly updateTags: (tags: readonly (TagRef & { readonly id: string | null })[], change: TagChange) => RecordCommandRun;
  readonly renameTag: (id: string | null, name: string) => RecordCommandRun;
  readonly removeTags: (ids: readonly string[]) => RecordCommandRun;
  readonly gear: (raw: string) => RecordCommandRun;
  readonly addShot: (name: string) => RegistryCreation;
  readonly shotUnmergedEdits: (id: string) => readonly BrollUnmergedEdit[];
  readonly showBrollLine: (id: string) => boolean;
  readonly setShots: (ids: readonly string[], fields: ShotFields, owner?: OwnerChoice) => RecordCommandRun;
  readonly removeShot: (id: string) => RecordCommandRun;
  readonly addShotProp: (id: string, prop: string) => RecordCommandRun;
  readonly removeShotProp: (id: string, prop: string) => RecordCommandRun;
}

interface RegistryCreation {
  readonly run: RecordCommandRun;
  readonly id: string;
}

export interface EditorRegistryCommands extends SharedRecordCommands {
  readonly native?: () => RegistryEditor | null;
}
