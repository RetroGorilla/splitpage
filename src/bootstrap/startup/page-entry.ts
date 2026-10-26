import type { DesktopPort } from "../../adapters/desktop/desktop-port.ts";
import { attachDesktop } from "../../adapters/desktop/desktop-port.ts";
import { capturePageShell } from "../../adapters/page/page-shell.ts";
import { captureSpeechRecognition } from "../../adapters/page/speech-recognition.js";

export const suppressUnloadWarning = false;

export function mountPageEntry(): void {
  capturePageShell();

  (function promoteFontCss() {
    const link = document.getElementById("font-css") as HTMLLinkElement | null;
    if (!link) return;
    if (link.sheet) { link.media = "all"; return; }
    link.addEventListener("load", function () { link.media = "all"; });
  })();

  attachDesktop((window as Window & { splitpageDesktop?: DesktopPort }).splitpageDesktop);

  captureSpeechRecognition();
}
