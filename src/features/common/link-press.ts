export function linkOpenedBy(e: MouseEvent, mac: boolean, scriptCell: (cell: Element) => boolean): Element | null {
  const held = mac ? e.metaKey : e.ctrlKey;
  if (e.button !== 0 || !held || e.shiftKey || e.altKey) return null;
  const target = e.target as Element | null;
  if (!target || typeof target.closest !== "function") return null;
  const link = target.closest("a[href]");
  const cell = link && link.closest(".cell-editable");
  return link && cell && scriptCell(cell) ? link : null;
}
