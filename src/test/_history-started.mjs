import { createHistoryBackends } from "../adapters/storage/history-backends.ts";
import { createHistoryBackendProbe } from "../adapters/storage/history-backend-testing.ts";
import { mountHistoryOwner } from "../bootstrap/wiring/history.ts";
import { historyPorts } from "../bootstrap/wiring/ports/history.ts";
import { createLegacySnapshots } from "../application/recovery/legacy-snapshots.ts";

export function startTestHistory() {
  return mountHistoryOwner(historyPorts(createLegacySnapshots({ storage: () => localStorage }), (options) => createHistoryBackends(options, createHistoryBackendProbe())));
}
