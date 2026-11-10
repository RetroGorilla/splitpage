import type { ImageInstanceConfiguration } from "../../../src/service/images/configuration.ts";
import type { JournalChild } from "../harness.ts";

export type ImageProbeTarget = {
  readonly environment: Record<string, string>;
  readonly configure: (server: JournalChild) => Promise<ImageInstanceConfiguration>;
};
