import { runningOnDesktop } from "../../application/desktop-presence.ts";
import { makeDesktopHandle } from "../desktop/desktop-handle.ts";
import { desktopPort } from "../desktop/desktop-port.ts";
import type { DesktopPort } from "../desktop/desktop-port.ts";
import type { FileHandle, SaveDialogs } from "./file-target.ts";

interface SavePickerOptions {
  readonly suggestedName: string;
  readonly types: readonly { readonly description: string; readonly accept: Readonly<Record<string, readonly string[]>> }[];
}

interface SavePickerWindow {
  readonly showSaveFilePicker: (options: SavePickerOptions) => Promise<FileHandle>;
}

export function saveDialogs(slug: string): SaveDialogs<FileHandle> {
  return {
    desktop: runningOnDesktop() ? function () {
      return (desktopPort() as DesktopPort).saveFileDialog({
        suggestedName: slug + ".md",
        filters: [
          { name: "Markdown script", extensions: ["md"] },
          { name: "Splitpage script", extensions: ["splitpage"] }
        ]
      }).then(function (picked) { return picked ? makeDesktopHandle(picked) : null; });
    } : null,
    browser: (window as unknown as Partial<SavePickerWindow>).showSaveFilePicker ? function () {
      return (window as unknown as SavePickerWindow).showSaveFilePicker({
        suggestedName: slug + ".md",
        types: [
          { description: "Markdown script", accept: { "text/markdown": [".md"] } },
          { description: "Splitpage script", accept: { "application/json": [".splitpage"] } }
        ]
      });
    } : null
  };
}
