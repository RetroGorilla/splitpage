import type { Scenes } from "../../../features/rows/ports.ts";
import { focusRowField } from "../rows.ts";

export const rows: Pick<Scenes, "focusField"> = {
  focusField: focusRowField
};
