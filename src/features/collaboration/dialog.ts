export function mountCollaborationDialog(id: string, content: string) {
  const focus = document.activeElement;
  const lifetime = new AbortController();
  const backdrop = document.createElement("div");
  backdrop.id = id;
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = content;

  function dispose() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    window.removeEventListener("pagehide", dispose);
    backdrop.remove();
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
  }

  backdrop.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      backdrop.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.click();
    }
    if (event.key !== "Tab") return;
    const controls = [...backdrop.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")]
      .filter(control => !control.closest("[hidden]"));
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (document.activeElement === (event.shiftKey ? first : last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  });
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
