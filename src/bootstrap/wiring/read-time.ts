import { owned } from "../../features/routing/owned.ts";
import { documentReader as portDocument } from "./ports/document.ts";
import { text as portText } from "./ports/text.ts";
import { edits as portEdits, undoControl as portUndo } from "./ports/editing.ts";
import { notices as portNotices } from "./ports/effects.ts";
import type { ReadTimePorts } from "../../features/rows/ports.ts";
import { startReadTime as mountReadTime } from "../../features/rows/read-time.js";
import { paintGuard } from "../../legacy/editor-bridge.ts";

const readTime = owned<ReturnType<typeof mountReadTime>>();

export function mountReadTimeFeature(): ReturnType<typeof mountReadTime> {
  return readTime.replace(function () {
    const ports: ReadTimePorts = {
      document: portDocument,
      text: portText,
      edits: portEdits,
      undo: portUndo,
      paint: { afterThisPaint: (fn, ifFailed) => { paintGuard().afterThisPaint(fn, ifFailed); } },
      notices: portNotices
    };
    return mountReadTime(ports);
  });
}

export const stopReadTimeFeature = readTime.stop;
