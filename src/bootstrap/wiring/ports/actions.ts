import type { ActionRegistry } from "../../../application/actions.ts";
import { appActions } from "../../../legacy/app-actions.ts";

export const actions: Pick<ActionRegistry, "invoke" | "view"> = {
  invoke: (id, source, input) => appActions.invoke(id, source, input),
  view: (id, source) => appActions.view(id, source)
};
