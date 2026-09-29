import { JSDOM } from "jsdom";

// URL needed: jsdom localStorage requires an origin
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://splitpage.test/" });

// Don't copy all props; would clobber Node timers/Event
for (const name of [
  "window", "document", "DOMParser", "Node", "NodeFilter", "Element",
  "HTMLElement", "Image", "File", "Blob", "FileReader", "localStorage",
  "sessionStorage", "getComputedStyle", "XMLSerializer", "Range"
]) {
  if (dom.window[name] !== undefined) globalThis[name] = dom.window[name];
}
globalThis.window = dom.window;

export { dom };
