import type { Beats } from "../../../features/rows/ports.ts";
import { focusRowField } from "../rows.ts";

export const rows: Pick<Beats, "focusField"> = {
  focusField: focusRowField
};
