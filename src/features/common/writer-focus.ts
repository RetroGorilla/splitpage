export function writerFocusTarget(document: Document): HTMLElement | null {
  return document.querySelector<HTMLElement>("#writer-doc .wr-para") || document.getElementById("wr-close");
}
