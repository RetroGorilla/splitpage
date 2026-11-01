"use strict";

import type { DesktopPrintIpcDependencies, DesktopRegisterIpcGroup } from "./ipc-boundaries.d.ts";

function createPrintIpc({ pdfPrinter }: DesktopPrintIpcDependencies) {
  function registerPrintIpc({ ipcHandle }: Parameters<DesktopRegisterIpcGroup>[0]) {
    ipcHandle("splitpage:print-to-pdf", (event, html) => pdfPrinter.print(event.sender, html));
  }

  return { registerPrintIpc };
}

export type { createPrintIpc };

module.exports = { createPrintIpc };
