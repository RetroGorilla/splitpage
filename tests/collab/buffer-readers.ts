import { deepFreeze } from "../../src/core/document/freeze.ts";
import { createProductionReaders } from "../../src/core/production/readers.ts";
import { createFlowLoadRuntime } from "../core/flow/load.ts";

export const bufferReaders = createProductionReaders(createFlowLoadRuntime().cells, deepFreeze);
