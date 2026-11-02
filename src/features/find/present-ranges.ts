import { withoutLoneSurrogates } from "../../core/document/text-policy.ts";

export function presentFindRanges(content: HTMLElement, query: string, matchCase: boolean): Range[] {
  const needle = withoutLoneSurrogates(query);
  if (!needle) return [];
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
  const ranges: Range[] = [];
  for (const line of content.querySelectorAll(".prompter-line")) {
    const walker = content.ownerDocument.createTreeWalker(line, 5);
    const nodes: { node: Node; start: number; end: number }[] = [];
    let text = "";
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === 1) {
        if ((node as Element).tagName === "BR") text += "\n";
        continue;
      }
      nodes.push({ node, start: text.length, end: text.length + (node.textContent?.length ?? 0) });
      text += node.textContent;
    }
    pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    let start = 0;
    while ((hit = pattern.exec(text))) {
      while (start < nodes.length && (nodes[start] as typeof nodes[number]).end <= hit.index) start++;
      let end = start;
      const to = hit.index + hit[0].length;
      while (end < nodes.length && (nodes[end] as typeof nodes[number]).end < to) end++;
      const first = nodes[start], last = nodes[end];
      if (!first || !last || hit.index < first.start || to < last.start) continue;
      const range = content.ownerDocument.createRange();
      range.setStart(first.node, hit.index - first.start);
      range.setEnd(last.node, to - last.start);
      ranges.push(range);
    }
  }
  return ranges;
}
