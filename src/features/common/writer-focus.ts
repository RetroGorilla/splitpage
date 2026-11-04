export function writerFocusTarget(document: Document): HTMLElement | null {
  return document.querySelector<HTMLElement>("#writer-doc .wr-para, #writer-doc.is-flow") || document.getElementById("wr-close");
}
