import { updateWriterStats } from "../../js/19-writer.js";
import { onRefresh } from "../../legacy/session-bridge.ts";

export function listenWriterStats(): () => void {
  return onRefresh((jobs) => {
    if (jobs.has("writerStats")) updateWriterStats();
  });
}
