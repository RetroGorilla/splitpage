import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { text as portText } from "./ports/text.ts";
import { edits as portEdits } from "./ports/editing.ts";
import { sharedAwareUndo, sharedValueCommands } from "./ports/shared-commands.ts";
import { notices as portNotices } from "./ports/effects.ts";
import type { ReadTimePorts } from "../../features/rows/ports.ts";
import { startReadTime as mountReadTime } from "../../features/rows/read-time.ts";
import { paintGuard } from "./editor-owners.ts";

const readTime = owned<ReturnType<typeof mountReadTime>>();

export function mountReadTimeFeature(): ReturnType<typeof mountReadTime> {
  return readTime.replace(function () {
    const ports: ReadTimePorts = {
      document: portDocument,
      text: portText,
      edits: portEdits,
      shared: sharedValueCommands,
      undo: sharedAwareUndo,
      paint: { afterThisPaint: (fn, ifFailed) => { paintGuard().afterThisPaint(fn, ifFailed); } },
      notices: portNotices
    };
    return mountReadTime(ports);
  });
}

export const stopReadTimeFeature = readTime.stop;
