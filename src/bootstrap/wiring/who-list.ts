import { startWhoList } from "../../features/tags/who-list.ts";
import type { WhoListControl, WhoListMount, WhoListPorts } from "../../features/tags/ports.ts";
import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { cells as portCells } from "./ports/editing.ts";
import { text as portText } from "./ports/text.ts";

const whoList = owned<WhoListMount>();

export function mountWhoListFeature(): WhoListMount {
  return whoList.replace(() => {
    const ports: WhoListPorts = { document: portDocument, cells: portCells, text: portText };
    return startWhoList(ports);
  });
}

export const stopWhoListFeature = whoList.stop;

export const currentWhoList: () => WhoListControl | null = whoList.owner;
