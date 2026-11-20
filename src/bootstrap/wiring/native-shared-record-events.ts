import { cellSelection } from "../../features/common/cell-selection.ts";
import { paintedFromRow } from "../../features/rows/render.ts";
import type { NativeEditorRecords } from "./native-shared-records.ts";
import { actions } from "./ports/actions.ts";
import { documentReader } from "./ports/document.ts";
import { notices } from "./ports/effects.ts";
import { ids } from "./ports/identity.ts";

function hasCaption(html: string): boolean {
  const template = document.createElement("template");
  template.innerHTML = html;
  return !!template.content.textContent?.trim();
}

export function mountNativeRecordEvents(records: NativeEditorRecords): () => void {
  function comment(event: MouseEvent): void {
    const button = event.target instanceof Element && event.target.closest('#rows .mini-toolbar button[data-cmd="comment"]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const cell = button.closest(".field-wrap")?.querySelector(".cell-editable");
    const selection = cell && cellSelection(cell);
    if (!selection || selection.from === selection.to) {
      notices.show("Select some text inside one cell, then add a comment.", "warn");
      return;
    }
    const rowId = cell.getAttribute("data-id") ?? "", field = cell.getAttribute("data-field");
    const row = documentReader.current()?.rows.find(candidate => candidate.id === rowId);
    if (!row || field !== "audioText" && field !== "visualText" || !paintedFromRow(cell, field, row)) {
      notices.show("Could not anchor a comment to that selection.", "error");
      return;
    }
    const id = ids.id("c"), quotedText = window.getSelection()?.toString() ?? "";
    if (records.anchor(id, rowId, field, selection.from, selection.to, row[field] ?? "")) {
      actions.invoke("comment-on-selection", "button", { id, rowId, field, quotedText });
    }
  }

  function pictures(event: ClipboardEvent | DragEvent): void {
    if (event.type === "drop") {
      document.querySelectorAll("#rows .visual-cell.drag-over").forEach(cell => cell.classList.remove("drag-over"));
    }
    const visual = event.target instanceof Element && event.target.closest("#rows .visual-cell");
    if (!visual) return;
    const data = "clipboardData" in event ? event.clipboardData : event.dataTransfer;
    if (!data) return;
    const files = Array.from(data.files ?? []);
    if (!files.length || files.some(file => !file.type.startsWith("image/"))) return;
    if (data.getData("text/plain") || hasCaption(data.getData("text/html"))) return;
    const rowId = visual.querySelector(".cell-editable")?.getAttribute("data-id");
    if (!rowId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void records.addPictures(rowId, files);
  }

  window.addEventListener("click", comment, true);
  window.addEventListener("paste", pictures, true);
  window.addEventListener("drop", pictures, true);
  return () => {
    window.removeEventListener("click", comment, true);
    window.removeEventListener("paste", pictures, true);
    window.removeEventListener("drop", pictures, true);
  };
}
