/* ================= the whole cell is the field (#182) =================

   A script field is only as tall as its words, but its column runs the
   height of the row — the other column, a picture or the gutter can make
   it far taller — and since #169 nothing marks where the field ends. A
   press anywhere in the Visual or Audio cell that is not on the field
   itself, its toolbar, its picture or one of their controls (the room
   under a short line, the phone's "Visual"/"Audio" label) puts the caret
   at the end of that cell's field, as if the field filled its cell.

   A press ON the field is the browser's, as always. */

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
    /* keep the browser from moving the focus to nothing first */
    e.preventDefault();
    placeCaretAtEnd(field);
  });
}
