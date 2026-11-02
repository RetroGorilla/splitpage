import type { Notice, NoticeKind, NoticePort } from "../../application/effects/ports.ts";

type Toast = HTMLElement & { dismiss: () => void };

const QUICK_MS = 2600;
const ACTION_MS = 6000;
const LEAVE_MS = 220;

export function createToasts(window: Window): NoticePort {
  const document = window.document;
  const repeated = new Map<string, Toast>();

  function restoreFocus(origin: HTMLElement | null): void {
    const scope = document.querySelector<HTMLElement>('.modal-backdrop:not([hidden]), #cmdk:not([hidden])') ||
      document.querySelector<HTMLElement>('#prompter:not([hidden]), #writer:not([hidden])');
    const available = (el: HTMLElement | null): el is HTMLElement => {
      if (!el?.isConnected || el === document.body || el.closest('[hidden], [inert], .is-leaving') || el.matches(':disabled')) return false;
      for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
      return true;
    };
    const candidates = [origin, ...(scope || document).querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea, select, a[href], [contenteditable="true"], [tabindex="0"]')];
    const back = candidates.find(el => available(el) && (!scope || scope.contains(el)));
    back?.focus({ preventScroll: true });
  }

  function add(message: string, kind: NoticeKind | undefined, sticky: boolean | undefined,
    action?: { label: string; run: () => void }, onDismiss?: () => void): Toast {
    const host = document.getElementById("toast-host") as HTMLElement;
    const origin = document.activeElement as HTMLElement | null;
    const el = document.createElement("div") as unknown as Toast;
    el.className = "toast" + (kind ? " " + kind : "") + (sticky ? " is-sticky" : "") + (action ? " has-action" : "");
    el.textContent = message;
    const announcement = document.createElement("span");
    announcement.textContent = message;
    let leaving = false;
    let timer: number | undefined;
    const dismiss = (): void => {
      if (leaving) return;
      leaving = true;
      onDismiss?.();
      window.clearTimeout(timer);
      el.classList.add("is-leaving");
      window.setTimeout(() => {
        const ownedFocus = el.contains(document.activeElement);
        el.remove();
        announcement.remove();
        if (ownedFocus) restoreFocus(origin);
      }, LEAVE_MS);
    };
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "toast-action";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        if (leaving) return;
        dismiss();
        action.run();
      });
      el.appendChild(button);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-dismiss";
    close.setAttribute("aria-label", "Dismiss");
    close.innerHTML = '<svg aria-hidden="true" focusable="false"><use href="#i-close"/></svg>';
    close.addEventListener("click", dismiss);
    el.appendChild(close);
    el.dismiss = dismiss;
    host.appendChild(el);
    document.getElementById(kind === "error" ? "toast-alert" : "toast-status")?.appendChild(announcement);
    if (!sticky) timer = window.setTimeout(dismiss, action ? ACTION_MS : QUICK_MS);
    return el;
  }

  function show(message: string, kind?: NoticeKind, sticky?: boolean): Notice {
    const key = JSON.stringify([message, kind || "", !!sticky]);
    const existing = repeated.get(key);
    if (existing?.isConnected && !existing.classList.contains("is-leaving")) return existing;
    const el = add(message, kind, sticky, undefined, () => {
      if (repeated.get(key) === el) repeated.delete(key);
    });
    repeated.set(key, el);
    return el;
  }

  function showAction(message: string, kind: NoticeKind | undefined, label: string, onAction: () => void, sticky?: boolean): Notice {
    return add(message, kind, sticky, { label, run: onAction });
  }

  return { show, showAction };
}
