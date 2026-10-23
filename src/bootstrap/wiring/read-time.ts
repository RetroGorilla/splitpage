import { owned } from "../../features/routing/owned.ts";
import type { ReadTimePorts } from "../../features/rows/ports.ts";
import { __init as mountReadTime } from "../../features/rows/read-time.js";
import { paintGuard } from "../../legacy/editor-bridge.ts";
import { showToast } from "../../legacy/effects-bridge.ts";
import { sharedPorts } from "./shared-ports.ts";

const readTime = owned<ReturnType<typeof mountReadTime>>();

export function mountReadTimeFeature(): ReturnType<typeof mountReadTime> {
  return readTime.replace(function () {
    const shared = sharedPorts();
    const ports: ReadTimePorts = {
      document: shared.document,
      text: shared.text,
      edits: shared.edits,
      undo: shared.undo,
      paint: { afterThisPaint: (fn, ifFailed) => { paintGuard().afterThisPaint(fn, ifFailed); } },
      review: shared.review,
      notices: { show: showToast }
    };
    return mountReadTime(ports);
  });
}

export const stopReadTimeFeature = readTime.stop;
