function reachTarget(t) {
  if (!t || !t.classList) return null;
  if (!(t.classList.contains("cell") || t.classList.contains("field-wrap") ||
        (t.classList.contains("visual-media") && t.classList.contains("is-empty")))) return null;
  var cell = t.closest("#rows > .row > .cell");
  if (!cell) return null;
  return cell.querySelector(":scope > .field-wrap > .cell-editable");
}

export function placeCaretAtEnd(el) {
  el.focus({ preventScroll: true });
  var sel = window.getSelection();
  if (!sel) return;
  var range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function __init() {
  var rowsEl = document.getElementById("rows");
  if (!rowsEl) return;
  rowsEl.addEventListener("mousedown", function (e) {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    var field = reachTarget(e.target);
    if (!field) return;
    e.preventDefault();
    placeCaretAtEnd(field);
  });
}
