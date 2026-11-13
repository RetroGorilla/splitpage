import type { StampPorts } from "../../src/application/session/ports.ts";
import { deepFreeze } from "../../src/core/document/freeze.ts";
import { createProductionReaders } from "../../src/core/production/readers.ts";
import { createFlowLoadRuntime } from "../core/flow/load.ts";

export const bufferReaders = createProductionReaders(createFlowLoadRuntime().cells, deepFreeze);

export function bufferStamps(name: string, at: () => string = () => "2026-11-12T10:00:00.000Z"): StampPorts {
  return { clock: { nowIso: at }, editor: { name: () => name } };
}
