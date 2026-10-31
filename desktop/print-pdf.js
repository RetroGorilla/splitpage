"use strict";

const crypto = require("node:crypto");

const PRINT_PARTITION = "splitpage-print";
const PRINT_ORIGIN = "splitpage://print";
const MAX_PRINT_HTML_CHARS = 256 * 1024 * 1024;
const PRINT_TIMEOUT_MS = 60000;
const PRINT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
const PDF_OPTIONS = Object.freeze({
  preferCSSPageSize: true,
  printBackground: true,
  generateDocumentOutline: true,
  generateTaggedPDF: true
});
// why: img.decode() never settles in a view no window shows, so readiness reads the load state the load event left
const READY_SCRIPT = "document.fonts.ready.then(() => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0))";

function createPdfPrinter({ app, session, WebContentsView, timeoutMs = PRINT_TIMEOUT_MS, maxChars = MAX_PRINT_HTML_CHARS }) {
  const pages = new Map();
  const jobs = new Set();
  let printSession = null;
  let quitting = false;

  function sessionForPrint() {
    if (printSession) return printSession;
    const ses = session.fromPartition(PRINT_PARTITION, { cache: false });
    ses.protocol.handle("splitpage", (request) => {
      const html = pages.get(request.url);
      if (html === undefined) return new Response("not found", { status: 404 });
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PRINT_CSP }
      });
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !(pages.has(details.url) || details.url.startsWith("data:")) });
    });
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    printSession = ses;
    return ses;
  }

  function print(owner, html) {
    if (quitting) return Promise.reject(new Error("Splitpage is quitting"));
    if (typeof html !== "string" || !html.length || html.length > maxChars) {
      return Promise.reject(new Error("The print page is empty or too large"));
    }
    const url = PRINT_ORIGIN + "/" + crypto.randomBytes(16).toString("hex") + ".html";
    const view = new WebContentsView({
      webPreferences: {
        session: sessionForPrint(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false
      }
    });
    const contents = view.webContents;
    pages.set(url, html);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, pdf) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        owner.removeListener("destroyed", ownerGone);
        pages.delete(url);
        jobs.delete(job);
        if (!contents.isDestroyed()) contents.close();
        if (error) reject(error); else resolve(pdf);
      };
      const ownerGone = () => finish(new Error("The page that asked to print has closed"));
      // why: a WebContentsView in no window is garbage once unreferenced, and collecting it stops the page mid-load
      const job = { view, cancel: () => finish(new Error("Printing was cancelled")) };
      const timer = setTimeout(() => finish(new Error("The print page took too long to prepare")), timeoutMs);
      jobs.add(job);
      owner.once("destroyed", ownerGone);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event) => event.preventDefault());
      contents.on("render-process-gone", () => finish(new Error("The print page stopped")));
      contents.loadURL(url)
        .then(() => contents.executeJavaScript(READY_SCRIPT))
        .then((ready) => {
          if (ready !== true) throw new Error("A picture could not be prepared for printing");
          return contents.printToPDF(PDF_OPTIONS);
        })
        .then((pdf) => finish(null, pdf), (error) => finish(error));
    });
  }

  function cancelAll() {
    quitting = true;
    for (const job of [...jobs]) job.cancel();
  }

  app.on("will-quit", cancelAll);

  return { print, cancelAll, openJobs: () => jobs.size };
}

module.exports = { createPdfPrinter, PDF_OPTIONS, PRINT_CSP, PRINT_ORIGIN, PRINT_PARTITION, MAX_PRINT_HTML_CHARS };
