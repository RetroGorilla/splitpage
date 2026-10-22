import type { Notice, NoticeKind, NoticePort } from "../../application/effects/ports.ts";

type Toast = HTMLElement & { dismiss: () => void };

const QUICK_MS = 2600;
const ACTION_MS = 6000;
const LEAVE_MS = 220;

export function createToasts(window: Window): NoticePort {
  const document = window.document;

  function show(message: string, kind?: NoticeKind, sticky?: boolean): Notice {
    const host = document.getElementById("toast-host") as HTMLElement;
    const el = document.createElement("div") as unknown as Toast;
    el.className = "toast" + (kind ? " " + kind : "") + (sticky ? " is-sticky" : "");
    el.textContent = message;
    const dismiss = (): void => {
      el.classList.add("is-leaving");
      window.setTimeout(() => el.remove(), LEAVE_MS);
    };
    if (sticky) {
      el.title = "Click to dismiss";
      el.addEventListener("click", dismiss);
    } else {
      window.setTimeout(dismiss, QUICK_MS);
    }
    el.dismiss = dismiss;
    host.appendChild(el);
    return el as unknown as Notice;
  }

  function showAction(message: string, kind: NoticeKind | undefined, label: string, onAction: () => void, sticky?: boolean): Notice {
    const notice = show(message, kind, true);
    const el = notice as unknown as Toast;
    if (!sticky) {
      el.classList.remove("is-sticky");
      el.removeAttribute("title");
    }
    el.classList.add("has-action");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      el.dismiss();
      onAction();
    });
    el.appendChild(button);
    if (!sticky) window.setTimeout(el.dismiss, ACTION_MS);
    return notice;
  }

  return { show, showAction };
}
