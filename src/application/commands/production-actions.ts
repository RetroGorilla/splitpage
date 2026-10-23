import { newBrollShot } from "../../core/document/broll.ts";
import type { IdSource } from "../../core/document/ports.ts";
import type { DocumentShot } from "../../core/document/validated.ts";
import { cappedText } from "../../core/document/text-policy.ts";
import { addShotCommand, removeShotPropCommand } from "./broll-records.ts";
import { retagCommand } from "./production-records.ts";
import type { TagRef } from "./production-records.ts";
import type { ShotFields } from "./broll-records.ts";
import type { RewritePlanner } from "./document-edit.ts";
import type { Command, DocumentView } from "../session/document-session.ts";
import type { StampPorts } from "../session/ports.ts";

export interface ProductionActionPorts {
  readonly run: (command: Command) => boolean;
}

export interface RenameTagPorts extends ProductionActionPorts {
  readonly rewrites: (tags: readonly TagRef[], name: string | null) => RewritePlanner;
  readonly stamps: StampPorts;
}

export interface RemoveTagPorts extends RenameTagPorts {
  readonly read: <T>(select: (doc: DocumentView | null) => T) => T;
  readonly mentions: (doc: DocumentView | null, tags: readonly TagRef[]) => number;
}

export interface NewBrollPorts extends ProductionActionPorts {
  readonly ids: IdSource;
}

export function renameTag(cat: string, oldName: string, newName: unknown, ports: RenameTagPorts): boolean {
  const clean = cappedText(newName, 80);
  if (!clean) return false;
  const tag = { cat: cat, name: oldName };
  return ports.run(retagCommand(tag, clean, ports.rewrites([tag], clean), ports.stamps));
}

export function removeTag(cat: string, name: string, ports: RemoveTagPorts): number {
  const tag = { cat: cat, name: name };
  const n = ports.read(function (doc) { return ports.mentions(doc, [tag]); });
  if (!n) return 0;
  return ports.run(retagCommand(tag, null, ports.rewrites([tag], null), ports.stamps)) ? n : 0;
}

export function newBrollRecord(fields: ShotFields | null | undefined, ports: NewBrollPorts): DocumentShot {
  const rec = newBrollShot(ports.ids.id("bs"), fields || {});
  ports.run(addShotCommand(rec));
  return rec;
}

export function removeBrollProp(shotId: string, ref: string, ports: ProductionActionPorts): boolean {
  return ports.run(removeShotPropCommand(shotId, ref));
}
