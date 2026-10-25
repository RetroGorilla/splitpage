import type { SceneFields } from "../../../legacy/rows-bridge.ts";
import { focusRowField } from "../../../legacy/rows-bridge.ts";

export const rows: Pick<SceneFields, "focusField"> = {
  focusField: focusRowField
};
