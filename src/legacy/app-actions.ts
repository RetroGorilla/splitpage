import { createActionRegistry } from "../application/actions.ts";
import type { ActionRegistry } from "../application/actions.ts";

let installed: ActionRegistry | null = null;

function registry(): ActionRegistry {
  if (!installed) throw new Error("The action registry is not started yet");
  return installed;
}

export function createAppActions(): ActionRegistry {
  return createActionRegistry({
    report: (error) => {
      queueMicrotask(() => { throw error; });
    }
  });
}

export function installAppActions(actions: ActionRegistry): () => void {
  if (installed) throw new Error("The action registry is already started; stop it first");
  installed = actions;
  return () => {
    if (installed === actions) installed = null;
  };
}

export const appActions: ActionRegistry = {
  register: (definition) => registry().register(definition),
  has: (id) => registry().has(id),
  shortcuts: () => registry().shortcuts(),
  view: (id, source) => registry().view(id, source),
  list: (source) => registry().list(source),
  invoke: (id, source, input) => registry().invoke(id, source, input),
  presentRefusals: (presenter) => registry().presentRefusals(presenter)
};

export function runFromButton(id: string): void {
  appActions.invoke(id, "button");
}

export function saveFromButton(): void {
  runFromButton("save");
}
