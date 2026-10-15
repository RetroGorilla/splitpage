type Files = FileList | readonly File[] | null | undefined;

export interface RowsEditorPorts {
  readonly click: (e: MouseEvent) => void;
  readonly mousedown: (e: MouseEvent) => void;
  readonly input: (e: Event) => void;
  readonly keydown: (e: KeyboardEvent) => void;
  readonly rowDragging: () => boolean;
  readonly rowDragOver: (e: DragEvent) => boolean;
  readonly rowDrop: (e: DragEvent) => boolean;
  readonly scriptCell: (cell: Element) => boolean;
  readonly reviewOnly: () => boolean;
  readonly hasMedia: (files: Files) => boolean;
  readonly insert: (cell: Element, html: string, text: string, files: Files) => void;
  readonly notMedia: () => void;
}

export interface RowsEditorMount {
  readonly window: Window;
  readonly rows: Element;
  readonly addBar: Element | null;
  readonly ports: RowsEditorPorts;
}

export interface RowsEditor {
  readonly dispose: () => void;
}

type Realm = Window & typeof globalThis & {
  document: Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
};

export function mountRowsEditor(mount: RowsEditorMount): RowsEditor {
  const ports = mount.ports;
  const realm = mount.window as Realm;
  const rows = mount.rows;
  const addBar = mount.addBar;
  let open = true;

  function targetOf(e: Event): Element | null {
    return e.target instanceof realm.Element ? e.target : null;
  }

  function isFileDrag(e: DragEvent): boolean {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
    return false;
  }

  function imageDropTarget(e: DragEvent): Element | null {
    if (ports.rowDragging() || !isFileDrag(e)) return null;
    const target = targetOf(e);
    const cell = target ? target.closest(".visual-cell") : null;
    return cell ? cell.querySelector(".visual-media") : null;
  }

  function copyEffect(e: DragEvent): void {
    try {
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    } catch {
      return;
    }
  }

  function placeCaretAt(cell: Element, e: DragEvent): void {
    try {
      const doc = realm.document;
      const range = doc.caretRangeFromPoint ? doc.caretRangeFromPoint(e.clientX, e.clientY) : null;
      if (range && cell.contains(range.startContainer)) {
        const sel = realm.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } catch {
      return;
    }
  }

  function onClick(e: Event): void {
    if (open) ports.click(e as MouseEvent);
  }

  function onMouseDown(e: Event): void {
    if (open) ports.mousedown(e as MouseEvent);
  }

  function onInput(e: Event): void {
    if (open) ports.input(e);
  }

  function onKeyDown(e: Event): void {
    if (open) ports.keydown(e as KeyboardEvent);
  }

  function onDragOver(ev: Event): void {
    if (!open) return;
    const e = ev as DragEvent;
    const drop = imageDropTarget(e);
    if (drop) {
      e.preventDefault();
      copyEffect(e);
      rows.querySelectorAll(".visual-cell.drag-over").forEach(function (c) {
        c.classList.remove("drag-over");
      });
      const cell = drop.closest(".visual-cell");
      if (cell) cell.classList.add("drag-over");
      return;
    }
    if (ports.rowDragOver(e)) return;
    const target = targetOf(e);
    if (target && target.closest(".cell-editable")) {
      e.preventDefault();
      copyEffect(e);
    }
  }

  function onDragLeave(ev: Event): void {
    if (!open) return;
    const e = ev as DragEvent;
    const target = targetOf(e);
    const cell = target ? target.closest(".visual-cell") : null;
    const related = e.relatedTarget instanceof realm.Node ? e.relatedTarget : null;
    if (cell && !cell.contains(related)) cell.classList.remove("drag-over");
  }

  function onDrop(ev: Event): void {
    if (!open) return;
    const e = ev as DragEvent;
    const drop = imageDropTarget(e);
    const files = e.dataTransfer ? e.dataTransfer.files : null;
    const mediaDrop = !!drop && ports.hasMedia(files);
    const visual = drop ? drop.closest(".visual-cell") : null;
    if (visual) visual.classList.remove("drag-over");
    const target = targetOf(e);
    const cell = target ? target.closest(".cell-editable") : null;
    if (drop && !mediaDrop) {
      e.preventDefault();
      if (files && files.length) ports.notMedia();
      return;
    }
    if (mediaDrop && !cell) {
      e.preventDefault();
      if (ports.reviewOnly()) return;
      const visualCell = visual ? visual.querySelector(".cell-editable") : null;
      if (visualCell) ports.insert(visualCell, "", "", files);
      return;
    }
    if (ports.rowDrop(e)) return;
    if (!cell) return;
    e.preventDefault();
    const data = e.dataTransfer;
    const html = data ? data.getData("text/html") : "";
    const text = data ? data.getData("text/plain") : "";
    if (!html && !text && !ports.hasMedia(files)) return;
    const script = ports.scriptCell(cell);
    if (script && ports.reviewOnly()) return;
    if (cell instanceof realm.HTMLElement) cell.focus();
    placeCaretAt(cell, e);
    if (script) ports.insert(cell, html, text, files);
  }

  rows.addEventListener("click", onClick);
  rows.addEventListener("mousedown", onMouseDown);
  rows.addEventListener("input", onInput);
  rows.addEventListener("keydown", onKeyDown);
  rows.addEventListener("dragover", onDragOver);
  rows.addEventListener("dragleave", onDragLeave);
  rows.addEventListener("drop", onDrop);
  if (addBar) addBar.addEventListener("click", onClick);

  return {
    dispose(): void {
      if (!open) return;
      open = false;
      rows.removeEventListener("click", onClick);
      rows.removeEventListener("mousedown", onMouseDown);
      rows.removeEventListener("input", onInput);
      rows.removeEventListener("keydown", onKeyDown);
      rows.removeEventListener("dragover", onDragOver);
      rows.removeEventListener("dragleave", onDragLeave);
      rows.removeEventListener("drop", onDrop);
      if (addBar) addBar.removeEventListener("click", onClick);
    }
  };
}
