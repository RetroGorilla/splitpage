import type { ActionRegistry } from "../../../application/actions.ts";
import { appActions } from "../../../legacy/app-actions.ts";

export const actions: Pick<ActionRegistry, "invoke" | "view" | "list"> = {
  list: (source) => appActions.list(source),
  invoke: (id, source, input) => appActions.invoke(id, source, input),
  view: (id, source) => appActions.view(id, source)
};
