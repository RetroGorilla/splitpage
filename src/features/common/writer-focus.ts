export function writerFocusTarget(document: Document): HTMLElement | null {
  return document.querySelector<HTMLElement>("#writer-doc.is-flow") || document.getElementById("wr-close");
}

export function writerCaretBeat(document: Document): string | null {
  const node = document.getSelection()?.focusNode;
  const el = node?.nodeType === 3 ? node.parentElement : node as Element | null;
  return el?.closest?.("#writer-doc .wr-beat")?.getAttribute("data-id") ?? null;
}
