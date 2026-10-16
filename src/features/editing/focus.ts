export interface EditorFocusPorts {
  readonly isScriptCell: (cellEl: Element) => boolean;
  readonly blurSuppressed: () => boolean;
  readonly leftEditable: () => void;
  readonly blurredCell: (cellEl: Element) => void;
  readonly typeAtMarks: (cellEl: Element, data: string) => Element | null;
  readonly typed: (cellEl: Element, data: string) => void;
  readonly focusedRow: (rowId: string) => void;
  readonly focusedParagraph: (paraEl: Element) => void;
  readonly selectionChanged: (active: Element | null) => void;
}

export interface EditorFocusMount {
  readonly rows: EventTarget;
  readonly writer: EventTarget;
  readonly doc: Document;
  readonly ports: EditorFocusPorts;
}

type Listener = (e: Event) => void;

function isElement(target: EventTarget | null): target is Element {
  return !!target && typeof (target as Element).closest === "function";
}

function editableCell(target: EventTarget | null): Element | null {
  return isElement(target) && target.classList.contains("cell-editable") ? target : null;
}

export function editorBlur(ports: EditorFocusPorts): Listener {
  return (e: Event) => {
    ports.leftEditable();
    const cellEl = editableCell(e.target);
    if (!cellEl || ports.blurSuppressed()) return;
    const wrap = cellEl.closest(".field-wrap");
    const related = (e as FocusEvent).relatedTarget;
    if (wrap && related && wrap.contains(related as Node)) return;
    ports.blurredCell(cellEl);
  };
}

export function mountEditorFocus(mount: EditorFocusMount): () => void {
  const ports = mount.ports;
  const onBlur = editorBlur(ports);

  function onBeforeInput(e: Event): void {
    const input = e as InputEvent;
    if (input.inputType !== "insertText" || input.isComposing || !input.data) return;
    const cellEl = isElement(e.target) ? e.target.closest(".cell-editable") : null;
    if (!cellEl || !ports.isScriptCell(cellEl)) return;
    const fresh = ports.typeAtMarks(cellEl, input.data);
    if (!fresh) return;
    e.preventDefault();
    ports.typed(fresh, input.data);
  }

  function onDocFocusIn(e: Event): void {
    const cellEl = isElement(e.target) ? e.target.closest(".cell-editable") : null;
    const rowId = cellEl ? cellEl.getAttribute("data-id") : null;
    if (rowId) ports.focusedRow(rowId);
  }

  function onWriterFocusIn(e: Event): void {
    if (isElement(e.target) && e.target.classList.contains("wr-para")) ports.focusedParagraph(e.target);
  }

  function onSelectionChange(): void {
    ports.selectionChanged(mount.doc.activeElement);
  }

  const bindings: ReadonlyArray<readonly [EventTarget, string, Listener]> = [
    [mount.rows, "focusout", onBlur],
    [mount.rows, "beforeinput", onBeforeInput],
    [mount.writer, "focusout", onBlur],
    [mount.writer, "beforeinput", onBeforeInput],
    [mount.writer, "focusin", onWriterFocusIn],
    [mount.doc, "focusin", onDocFocusIn],
    [mount.doc, "selectionchange", onSelectionChange]
  ];
  bindings.forEach(([target, type, fn]) => { target.addEventListener(type, fn); });
  let open = true;
  return () => {
    if (!open) return;
    open = false;
    bindings.forEach(([target, type, fn]) => { target.removeEventListener(type, fn); });
  };
}
