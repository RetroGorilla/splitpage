import { createActionRegistry } from "../application/actions.ts";

export const appActions = createActionRegistry({
  report: (error) => {
    queueMicrotask(() => { throw error; });
  }
});
