export interface HtmlRun {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  mark?: boolean;
  href?: string | null;
}

interface Format {
  b: boolean;
  i: boolean;
  u: boolean;
  s: boolean;
  mark: boolean;
  href: string | null;
}

export type InertBody = (html: unknown) => HTMLElement;

export function htmlToRuns(html: unknown, inertBody: InertBody): HtmlRun[] {
  const runs: HtmlRun[] = [];
  const walk = (node: Node, fmt: Format): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const t = (child.nodeValue || "").replace(/\u00A0/g, " ");
        if (t) runs.push({ text: t, b: fmt.b, i: fmt.i, u: fmt.u, s: fmt.s, mark: fmt.mark, href: fmt.href });
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName;
      if (tag === "BR") {
        runs.push({ text: "\n" });
        continue;
      }
      walk(el, {
        b: fmt.b || tag === "STRONG" || tag === "B",
        i: fmt.i || tag === "EM" || tag === "I",
        u: fmt.u || tag === "U",
        s: fmt.s || tag === "S" || tag === "STRIKE" || tag === "DEL",
        mark: fmt.mark || tag === "MARK",
        href: tag === "A" ? (el.getAttribute("href") || fmt.href) : fmt.href
      });
    }
  };
  walk(inertBody(html), { b: false, i: false, u: false, s: false, mark: false, href: null });
  return runs;
}
