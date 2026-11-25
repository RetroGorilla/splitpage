import { handleDialogKey, restoreDialogFocus } from "../common/dialog-focus.ts";

export function mountCollaborationDialog(id: string, content: string) {
  const focus = document.activeElement;
  const lifetime = new AbortController();
  const backdrop = document.createElement("div");
  backdrop.id = id;
  backdrop.className = "modal-backdrop collaboration-dialog";
  backdrop.innerHTML = content;
  const panel = backdrop.querySelector<HTMLElement>('[role="dialog"]');
  if (!panel) throw new Error("Missing collaboration dialog");
  panel.tabIndex = -1;

  function dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    window.removeEventListener("pagehide", dispose);
    backdrop.remove();
    restoreDialogFocus(document, focus);
  }

  backdrop.addEventListener("keydown", event => handleDialogKey(event, panel, () => {
    backdrop.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.click();
  }));
  window.addEventListener("pagehide", dispose);
  document.body.append(backdrop);

  return {
    signal: lifetime.signal, dispose,
    part(selector: string): HTMLElement {
      const element = backdrop.querySelector<HTMLElement>(selector);
      if (!element) throw new Error("Missing collaboration dialog control");
      return element;
    }
  };
}
