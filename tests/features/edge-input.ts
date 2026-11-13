import "../../src/test/_dom.mjs";

type Direction = "forward" | "backward" | "none";

export type EdgeInput = ReturnType<typeof edgeInput>;

export function edgeInput(current: () => HTMLInputElement) {
  const key = (field: HTMLInputElement, type: string, name: string, init: KeyboardEventInit = {}) =>
    field.dispatchEvent(new window.KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init }));
  const before = (field: HTMLInputElement, inputType: string, data: string | null, isComposing = false) =>
    field.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data, isComposing }));
  const after = (field: HTMLInputElement, inputType: string, data: string | null, isComposing = false) => {
    field.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, data, isComposing }));
  };
  const clipboard = (field: HTMLInputElement, type: "cut" | "paste") => field.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const span = (field: HTMLInputElement) => { const from = field.selectionStart ?? 0; return [from, field.selectionEnd ?? from] as const; };
  function replace(field: HTMLInputElement, from: number, to: number, text: string): void {
    field.value = field.value.slice(0, from) + text + field.value.slice(to);
    field.setSelectionRange(from + text.length, from + text.length);
  }
  function fitted(field: HTMLInputElement, text: string): string {
    const [from, to] = span(field);
    return field.maxLength < 0 ? text : text.slice(0, Math.max(0, field.maxLength - field.value.length + to - from));
  }
  function chord(name: string, ctrlKey: boolean, act: (field: HTMLInputElement) => boolean): boolean {
    const field = current();
    const done = key(field, "keydown", name, { ctrlKey }) && act(field);
    key(field, "keyup", name, { ctrlKey });
    return done;
  }
  function erase(name: "Backspace" | "Delete"): boolean {
    return chord(name, false, field => {
      const [from, to] = span(field), type = name === "Backspace" ? "deleteContentBackward" : "deleteContentForward";
      const [start, end] = from !== to ? [from, to] : name === "Backspace" ? [from - 1, from] : [from, from + 1];
      if (start < 0 || end > field.value.length || !before(field, type, null)) return false;
      replace(field, start, end, ""); after(field, type, null);
      return true;
    });
  }
  let composed: { readonly from: number; length: number } | null = null;
  return {
    select: (from: number, to = from, direction: Direction = "none") => { current().setSelectionRange(from, to, direction); },
    selectAll: () => chord("a", true, field => { field.select(); return true; }),
    press: (name: string) => chord(name, false, () => false),
    type: (text: string, during?: () => void) => chord(text, false, field => {
      if (!before(field, "insertText", text)) return false;
      during?.();
      const [from, to] = span(field), put = fitted(field, text);
      if (!put) return false;
      replace(field, from, to, put); after(field, "insertText", put);
      return true;
    }),
    backspace: () => erase("Backspace"),
    delete: () => erase("Delete"),
    enter: () => chord("Enter", false, field => {
      if (!before(field, "insertLineBreak", null)) return false;
      field.form?.requestSubmit();
      return true;
    }),
    cut: () => chord("x", true, field => {
      const [from, to] = span(field);
      if (!clipboard(field, "cut") || from === to || !before(field, "deleteByCut", null)) return false;
      replace(field, from, to, ""); after(field, "deleteByCut", null);
      return true;
    }),
    paste: (text: string) => chord("v", true, field => {
      if (!clipboard(field, "paste") || !before(field, "insertFromPaste", text)) return false;
      const [from, to] = span(field), put = fitted(field, text);
      replace(field, from, to, put); after(field, "insertFromPaste", put);
      return true;
    }),
    undo: (restored: string) => chord("z", true, field => {
      if (!before(field, "historyUndo", null)) return false;
      field.value = restored; after(field, "historyUndo", null);
      return true;
    }),
    redo: (restored: string) => chord("y", true, field => {
      if (!before(field, "historyRedo", null)) return false;
      field.value = restored; after(field, "historyRedo", null);
      return true;
    }),
    drop: (text: string) => {
      const field = current();
      if (!field.dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true })) || !before(field, "insertFromDrop", text)) return false;
      const [from, to] = span(field), put = fitted(field, text);
      replace(field, from, to, put); after(field, "insertFromDrop", put);
      return true;
    },
    blur: () => { current().blur(); },
    selectNode: (node: Node) => {
      document.getSelection()?.selectAllChildren(node);
      document.dispatchEvent(new window.Event("selectionchange"));
    },
    composeStart: () => {
      const field = current(), [from, to] = span(field);
      key(field, "keydown", "Process", { keyCode: 229 });
      field.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      composed = { from, length: to - from };
    },
    composeUpdate: (text: string) => {
      const field = current(), at = composed; if (!at) throw new Error("No composition");
      key(field, "keydown", "Process", { keyCode: 229, isComposing: true });
      field.dispatchEvent(new window.CompositionEvent("compositionupdate", { bubbles: true, data: text }));
      before(field, "insertCompositionText", text, true);
      replace(field, at.from, at.from + at.length, text); at.length = text.length;
      after(field, "insertCompositionText", text, true);
    },
    composeEnd: (data: string) => {
      current().dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true, data }));
      composed = null;
    }
  };
}
