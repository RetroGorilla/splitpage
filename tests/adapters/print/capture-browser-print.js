export function captureBrowserPrint(host = globalThis.window) {
  const opened = host.open;
  const pages = [];
  const pending = [];
  const state = { blocked: false, failImages: false, holdFonts: false, holdDialog: false };
  host.open = () => {
    if (state.blocked) return null;
    const frame = host.document.createElement("iframe");
    frame.style.cssText = "position:absolute;left:-10000px;width:816px;height:1056px";
    host.document.body.appendChild(frame);
    const popup = frame.contentWindow;
    const close = () => { record.closed = true; frame.remove(); };
    const record = { popup, frame, closed: false, html: "", images: [], release: null };
    const write = popup.document.write.bind(popup.document);
    popup.document.write = (html) => {
      record.html = html;
      write(html);
      if (state.holdFonts) {
        Object.defineProperty(popup.document, "fonts", { value: { ready: new Promise((resolve) => { record.release = resolve; }) } });
      }
    };
    popup.HTMLImageElement.prototype.decode = state.failImages ? () => Promise.reject(new Error("broken picture")) : popup.HTMLImageElement.prototype.decode;
    Object.defineProperty(popup, "closed", { get: () => record.closed });
    popup.close = close;
    popup.focus = () => {};
    popup.print = () => {
      record.images = Array.from(popup.document.images, (img) => ({
        width: img.naturalWidth, height: img.naturalHeight, src: img.src,
        box: img.getBoundingClientRect().toJSON(), parent: img.parentElement.getBoundingClientRect().toJSON()
      }));
      const blob = new host.Blob([record.html], { type: "text/html" });
      record.blob = blob;
      record.name = "Print dialog";
      pages.push(record);
      host.__blobs?.push(blob);
      host.__files?.push(record);
      if (!state.holdDialog) popup.dispatchEvent(new popup.Event("afterprint"));
    };
    pending.push(record);
    return popup;
  };
  return { pages, pending, state, restore: () => { host.open = opened; pending.forEach((record) => record.popup.close()); } };
}
