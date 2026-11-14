import { startWhoList } from "../../features/tags/who-list.ts";
import type { WhoListControl, WhoListMount, WhoListPorts } from "../../features/tags/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { cells as portCells } from "./ports/editing.ts";
import { notices as portNotices } from "./ports/effects.ts";
import { sharedCommandGuard } from "./ports/shared-command-notices.ts";
import { text as portText } from "./ports/text.ts";
import { sharedSession } from "./session-owner.ts";

const whoList = owned<WhoListMount>();

export function mountWhoListFeature(): WhoListMount {
  return whoList.replace(() => {
    const ports: WhoListPorts = { document: portDocument, cells: portCells, text: portText, sharedCommands: sharedCommandGuard(sharedSession, portNotices) };
    return startWhoList(ports);
  });
}

export const stopWhoListFeature = whoList.stop;

export const currentWhoList: () => WhoListControl | null = whoList.owner;
