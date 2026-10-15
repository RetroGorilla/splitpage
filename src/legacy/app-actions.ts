import { createActionRegistry } from "../application/actions.ts";

export const appActions = createActionRegistry({
  report: (error) => {
    queueMicrotask(() => { throw error; });
  }
});

export function runFromButton(id: string): void {
  appActions.invoke(id, "button");
}

export function saveFromButton(): void {
  runFromButton("save");
}
