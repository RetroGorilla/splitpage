export interface SliceEvent {
  type: string;
  inputType: string | null;
  data: string | null;
  cancelable: boolean;
  trusted: boolean;
  composing: boolean;
  ranges: [number, number][];
  selection: [number, number] | null;
  text: string;
  cancelled: boolean;
  rangeNodes: { start: string; end: string; startOffset: number; endOffset: number }[];
}

export function offsetIn(beat: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(beat);
  range.setEnd(node, offset);
  return range.toString().length;
}

export function selectedOffsets(beat: HTMLElement): [number, number] | null {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !selection.focusNode) return null;
  if (!beat.contains(selection.anchorNode) || !beat.contains(selection.focusNode)) return null;
  return [offsetIn(beat, selection.anchorNode, selection.anchorOffset), offsetIn(beat, selection.focusNode, selection.focusOffset)];
}

export function selectOffsets(beat: HTMLElement, from: number, to = from): void {
  const point = (offset: number): [Node, number] => {
    const walker = document.createTreeWalker(beat, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (offset <= (node.textContent?.length ?? 0)) return [node, offset];
      offset -= node.textContent?.length ?? 0;
      node = walker.nextNode();
    }
    if (offset !== 0) throw new Error("Selection outside beat");
    return [beat, beat.childNodes.length];
  };
  const [start, a] = point(from);
  const [end, b] = point(to);
  window.getSelection()?.setBaseAndExtent(start, a, end, b);
}

export function recordEvent(event: Event, beat: HTMLElement): SliceEvent {
  const input = event as InputEvent;
  const path = (node: Node): string => {
    if (node === beat) return "beat";
    if (!node.parentNode) return "detached";
    return `${path(node.parentNode)}/${node.nodeName}[${[...node.parentNode.childNodes].indexOf(node as ChildNode)}]`;
  };
  const ranges = typeof input.getTargetRanges === "function" ? [...input.getTargetRanges()] : [];
  return {
    type: event.type, inputType: input.inputType || null,
    data: input.data ?? null, cancelable: event.cancelable, trusted: event.isTrusted,
    composing: input.isComposing ?? false,
    ranges: ranges.map(range => [
      offsetIn(beat, range.startContainer, range.startOffset), offsetIn(beat, range.endContainer, range.endOffset)
    ]),
    rangeNodes: ranges.map(range => ({ start: path(range.startContainer), end: path(range.endContainer), startOffset: range.startOffset, endOffset: range.endOffset })),
    selection: selectedOffsets(beat), text: beat.textContent ?? "", cancelled: false
  };
}

export function paintRuns(beat: HTMLElement, runs: readonly { insert: string; attributes: Record<string, unknown> }[]): void {
  const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  beat.innerHTML = runs.map(run => {
    let html = escape(run.insert).replaceAll("\n", "<br>");
    for (const [key, tag] of [["s", "s"], ["u", "u"], ["i", "em"], ["b", "strong"], ["hl", "mark"]]) {
      if (key && tag && run.attributes[key]) html = `<${tag}>${html}</${tag}>`;
    }
    return html;
  }).join("") || "\u200b";
  if (beat.innerHTML.endsWith("<br>")) beat.append("\u200b");
}
