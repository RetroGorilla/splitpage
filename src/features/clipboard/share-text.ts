import type { ClipboardPort } from "../../application/effects/ports.ts";

export function createShareClipboard(window: Window): ClipboardPort {
  const document = window.document;

  function copyWithSelection(text: string): boolean {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "readonly");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return !!ok;
    } catch {
      return false;
    }
  }

  return {
    copyText(text) {
      const clipboard = window.navigator.clipboard;
      if (clipboard && clipboard.writeText) {
        return clipboard.writeText(text).then(() => true, () => copyWithSelection(text));
      }
      return Promise.resolve(copyWithSelection(text));
    }
  };
}
