import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id=\"toast-host\"></div></body></html>", { url: "https://splitpage.test/" });

for (const name of [
  "window", "document", "DOMParser", "Node", "NodeFilter", "Element",
  "HTMLElement", "Image", "File", "Blob", "FileReader", "localStorage",
  "sessionStorage", "getComputedStyle", "XMLSerializer", "Range"
]) {
  if (dom.window[name] !== undefined) globalThis[name] = dom.window[name];
}
globalThis.window = dom.window;

export { dom };
