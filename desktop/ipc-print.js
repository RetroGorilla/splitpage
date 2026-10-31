"use strict";

function createPrintIpc({ pdfPrinter }) {
  function registerPrintIpc({ ipcHandle }) {
    ipcHandle("splitpage:print-to-pdf", (event, html) => pdfPrinter.print(event.sender, html));
  }

  return { registerPrintIpc };
}

module.exports = { createPrintIpc };
