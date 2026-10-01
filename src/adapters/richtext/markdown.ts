export function walkToMd(node: Node): string {
  let out = "";
  node.childNodes.forEach(function (child) {
    if (child.nodeType === 3) { out += child.nodeValue; return; }
    if (child.nodeType !== 1) return;
    const el = child as Element;
    const tag = el.tagName;
    const inner = walkToMd(el);
    if (tag === "STRONG" || tag === "B") out += "**" + inner + "**";
    else if (tag === "EM" || tag === "I") out += "*" + inner + "*";
    else if (tag === "U") out += "<u>" + inner + "</u>";
    else if (tag === "S" || tag === "STRIKE" || tag === "DEL") out += "~~" + inner + "~~";
    else if (tag === "MARK") out += "<mark>" + inner + "</mark>";
    else if (tag === "A") out += "[" + inner.replace(/([\]()])/g, "\\$1") + "](" + el.getAttribute("href") + ")";
    else if (tag === "BR") out += "\n";
    else if (tag === "SPAN" && el.classList && el.classList.contains("stage-dir")) out += "((" + inner + "))";
    else out += inner;
  });
  return out;
}
