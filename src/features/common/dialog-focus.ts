export function restoreDialogFocus(document: Document, trigger: Element | null, fallbackId = "btn-file"): void {
  if (trigger && "focus" in trigger && trigger.isConnected && !trigger.closest("[hidden], [inert], :disabled")) {
    (trigger as HTMLElement).focus({ preventScroll: true });
    if (document.activeElement === trigger) return;
  }
  document.getElementById(fallbackId)?.focus({ preventScroll: true });
}

export function handleDialogKey(event: KeyboardEvent, panel: HTMLElement, close: () => void): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const active = panel.ownerDocument.activeElement;
  const enabled = Array.from(panel.querySelectorAll<HTMLElement>(
    "button, input, select, textarea, a[href], summary, [tabindex]"
  )).filter(control => control.tabIndex >= 0 && !control.closest("[hidden], [inert], :disabled")
    && control.ownerDocument.defaultView?.getComputedStyle(control).visibility !== "hidden");
  const controls = enabled.filter(control => {
    if (!control.matches("input[type=radio]")) return true;
    const group = enabled.filter(peer => peer.matches("input[type=radio]")
      && (peer as HTMLInputElement).name === (control as HTMLInputElement).name
      && (peer as HTMLInputElement).form === (control as HTMLInputElement).form);
    const tabStop = group.find(peer => (peer as HTMLInputElement).checked) ?? group[0];
    return control === tabStop;
  });
  const first = controls[0], last = controls.at(-1);
  if (active && panel.contains(active) && !controls.some(control => control === active)) {
    const direction = event.shiftKey ? active.DOCUMENT_POSITION_PRECEDING : active.DOCUMENT_POSITION_FOLLOWING;
    const ordered = event.shiftKey ? controls.slice().reverse() : controls;
    const next = ordered.find(control => active.compareDocumentPosition(control) & direction);
    event.preventDefault();
    (next ?? ordered[0] ?? panel).focus();
  } else if (!first || !last || active === (event.shiftKey ? first : last) || !panel.contains(active)) {
    event.preventDefault();
    ((event.shiftKey ? last : first) ?? panel).focus();
  }
}
