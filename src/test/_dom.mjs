/* The one thing a `node --test` suite over src/js needs that Node does not
 * have: a DOM.
 *
 * #66 made every file in src/js a real ES module that does nothing at
 * evaluation time but declare functions, so importing one here is free —
 * no boot, no listeners, no `__init()`. What is NOT free is *calling* the
 * pure cores: `migrateRows` sanitises every cell it is handed, and
 * `sanitizeHtml` (04-richtext.js) parses untrusted HTML through a real
 * DOMParser and re-serialises it through a real element. That is the whole
 * point of it — the sanitizer is the security boundary, and a hand-rolled
 * string parser standing in for a browser's would be testing the stand-in,
 * not the app.
 *
 * So the suites borrow a spec-compliant DOM (jsdom, which parses with
 * parse5) rather than stub one. jsdom is a devDependency, never shipped:
 * the bundle build (build.mjs) has only ever seen esbuild, and the app
 * itself still has no runtime dependencies at all.
 *
 * Import this module BEFORE any src/js module — an ES module's imports are
 * evaluated in declaration order, so `import "./_dom.mjs";` on the first
 * line has the globals installed before anything else is even evaluated.
 *
 * What this does NOT give you is the app's *page*: there is no #rows, no
 * #state-data, no modal. Anything that reads the document's markup belongs
 * in a browser suite, not here.
 */
import { JSDOM } from "jsdom";

/* A URL, not about:blank: jsdom only gives a page localStorage when it has
   an origin to key it by, and getSavedAuthorName() (03-sync.js) reads one
   on every merge. */
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://splitpage.test/" });

/* Only the names src/js actually reaches for as globals. A blanket copy of
   every window property would drag Node's own globals out from under the
   test runner (setTimeout, queueMicrotask, Event) and replace them with
   jsdom's. */
for (const name of [
  "window", "document", "DOMParser", "Node", "NodeFilter", "Element",
  "HTMLElement", "Image", "File", "Blob", "FileReader", "localStorage",
  "sessionStorage", "getComputedStyle", "XMLSerializer", "Range"
]) {
  if (dom.window[name] !== undefined) globalThis[name] = dom.window[name];
}
globalThis.window = dom.window;

export { dom };
