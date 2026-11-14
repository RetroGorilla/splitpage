import "../../src/test/_dom.mjs";

type Direction = "forward" | "backward" | "none";

export type EdgeInput = ReturnType<typeof edgeInput>;

interface Modifiers {
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
}

export function edgeInput(current: () => HTMLInputElement) {
  const key = (field: HTMLInputElement, type: string, name: string, init: KeyboardEventInit = {}) =>
    field.dispatchEvent(new window.KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init }));
  const before = (field: HTMLInputElement, inputType: string, data: string | null, isComposing = false) =>
    field.dispatchEvent(new window.InputEvent("beforeinput", { bubbles: true, cancelable: !isComposing, inputType, data, isComposing }));
  const after = (field: HTMLInputElement, inputType: string, data: string | null, isComposing = false) => {
    field.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType, data, isComposing }));
  };
  const composition = (field: HTMLInputElement, type: string, data: string) => {
    field.dispatchEvent(new window.CompositionEvent(type, { bubbles: true, cancelable: true, data }));
  };
  let copied = "";
  const clipboard = (field: HTMLInputElement, type: "cut" | "paste", text = "") => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (format: string) => format === "text/plain" ? text : "" } });
    return field.dispatchEvent(event);
  };
  const span = (field: HTMLInputElement) => { const from = field.selectionStart ?? 0; return [from, field.selectionEnd ?? from] as const; };
  function replace(field: HTMLInputElement, from: number, to: number, text: string): void {
    field.value = field.value.slice(0, from) + text + field.value.slice(to);
    field.setSelectionRange(from + text.length, from + text.length);
  }
  function fitted(field: HTMLInputElement, text: string): string {
    const [from, to] = span(field);
    if (field.maxLength < 0) return text;
    const available = Math.max(0, field.maxLength - field.value.length + to - from);
    let put = "";
    for (const character of text) { if (put.length + character.length > available) break; put += character; }
    return put;
  }
  function chord(name: string, modifiers: Modifiers, act: (field: HTMLInputElement) => boolean): boolean {
    const field = current();
    const done = key(field, "keydown", name, modifiers) && act(field);
    key(field, "keyup", name, modifiers);
    return done;
  }
  function insert(field: HTMLInputElement, text: string, during?: () => void): boolean {
    if (!before(field, "insertText", text)) return false;
    during?.();
    const [from, to] = span(field), put = fitted(field, text);
    if (!put) return false;
    replace(field, from, to, put); after(field, "insertText", put);
    return true;
  }
  function character(name: string, text: string, modifiers: Modifiers, during?: () => void): boolean {
    return chord(name, modifiers, field => {
      return key(field, "keypress", text, modifiers) && insert(field, text, during);
    });
  }
  function erased(field: HTMLInputElement, name: "Backspace" | "Delete"): boolean {
    const [from, to] = span(field), type = name === "Backspace" ? "deleteContentBackward" : "deleteContentForward";
    if (!before(field, type, null)) return false;
    const [start, end] = from !== to ? [from, to] : name === "Backspace" ? [from - 1, from] : [from, from + 1];
    if (start < 0 || end > field.value.length) return false;
    replace(field, start, end, ""); after(field, type, null);
    return true;
  }
  function erase(name: "Backspace" | "Delete"): boolean {
    return chord(name, {}, field => erased(field, name));
  }
  function held(name: "Backspace" | "Delete", repeats: number): number {
    const field = current();
    let count = key(field, "keydown", name) && erased(field, name) ? 1 : 0;
    for (let repeat = 0; repeat < repeats; repeat++) if (key(field, "keydown", name, { repeat: true }) && erased(field, name)) count++;
    key(field, "keyup", name);
    return count;
  }
  function history(name: string, type: string, restored: string | null, selection?: readonly [number, number]): boolean {
    return chord(name, { ctrlKey: true }, field => {
      if (restored === null || !before(field, type, null)) return false;
      field.value = restored;
      field.setSelectionRange(selection?.[0] ?? restored.length, selection?.[1] ?? restored.length);
      after(field, type, null);
      return true;
    });
  }
  let composed: { readonly from: number; length: number } | null = null;
  return {
    select: (from: number, to = from, direction: Direction = "none") => { current().setSelectionRange(from, to, direction); },
    selectAll: () => chord("a", { ctrlKey: true }, field => { field.select(); return true; }),
    press: (name: string) => chord(name, {}, field => {
      const [from, to] = span(field);
      if (name === "ArrowLeft") field.setSelectionRange(from === to ? Math.max(0, from - 1) : from, from === to ? Math.max(0, from - 1) : from);
      else if (name === "ArrowRight") field.setSelectionRange(from === to ? Math.min(field.value.length, to + 1) : to, from === to ? Math.min(field.value.length, to + 1) : to);
      return false;
    }),
    type: (text: string, during?: () => void) => character(text, text, {}, during),
    shiftType: (text: string) => {
      const field = current();
      key(field, "keydown", "Shift", { shiftKey: true });
      const done = character(text, text, { shiftKey: true });
      key(field, "keyup", "Shift");
      return done;
    },
    deadType: (text: string) => {
      const field = current();
      key(field, "keydown", "Dead"); key(field, "keyup", "Dead");
      return character(text, text, {});
    },
    backspace: () => erase("Backspace"),
    delete: () => erase("Delete"),
    hold: held,
    enter: () => chord("Enter", {}, field => {
      if (!key(field, "keypress", "Enter") || !before(field, "insertLineBreak", null)) return false;
      field.form?.requestSubmit();
      return true;
    }),
    escape: () => chord("Escape", {}, () => false),
    cut: () => chord("x", { ctrlKey: true }, field => {
      const [from, to] = span(field);
      if (!clipboard(field, "cut") || from === to) return false;
      copied = field.value.slice(from, to);
      if (!before(field, "deleteByCut", null)) return false;
      replace(field, from, to, ""); after(field, "deleteByCut", null);
      return true;
    }),
    copied: () => copied,
    paste: (text: string, during?: () => void) => chord("v", { ctrlKey: true }, field => {
      const native = text.replace(/\r\n|\r|\n/g, "\r\n");
      if (!clipboard(field, "paste", native) || !before(field, "insertFromPaste", native || null)) return false;
      during?.();
      const [from, to] = span(field), put = fitted(field, native.replace(/\r\n/g, " "));
      if (native && !put && from === to) return false;
      replace(field, from, to, put); after(field, "insertFromPaste", put || null);
      return true;
    }),
    undo: (restored: string | null, selection?: readonly [number, number]) => history("z", "historyUndo", restored, selection),
    redo: (restored: string | null, selection?: readonly [number, number]) => history("y", "historyRedo", restored, selection),
    drop: (text: string) => {
      const field = current();
      if (!field.dispatchEvent(new window.Event("drop", { bubbles: true, cancelable: true })) || !before(field, "insertFromDrop", text)) return false;
      const [from, to] = span(field), put = fitted(field, text);
      replace(field, from, to, put); field.setSelectionRange(from, from + put.length, "forward");
      after(field, "insertFromDrop", put);
      return true;
    },
    blur: () => { current().blur(); },
    selectNode: (node: Node) => {
      document.getSelection()?.selectAllChildren(node);
      document.dispatchEvent(new window.Event("selectionchange"));
    },
    imeSet: (text: string) => {
      const field = current();
      if (composed) field.setSelectionRange(composed.from, composed.from + composed.length, "forward");
      else {
        const [from, to] = span(field);
        composition(field, "compositionstart", field.value.slice(from, to));
        composed = { from, length: to - from };
      }
      const at = composed;
      composition(field, "compositionupdate", text);
      before(field, "insertCompositionText", text, true);
      replace(field, at.from, at.from + at.length, text); at.length = text.length;
      after(field, "insertCompositionText", text, true);
    },
    imeCommit: (text: string) => {
      const field = current(), at = composed; if (!at) throw new Error("No composition");
      field.setSelectionRange(at.from, at.from + at.length, "forward");
      composition(field, "compositionupdate", text);
      before(field, "insertCompositionText", text, true);
      replace(field, at.from, at.from + at.length, text);
      after(field, "insertCompositionText", text, true);
      composed = null;
      composition(field, "compositionend", text);
    },
    imeCancel: () => {
      const field = current(), at = composed; if (!at) throw new Error("No composition");
      field.setSelectionRange(at.from, at.from + at.length, "forward");
      composition(field, "compositionupdate", "");
      before(field, "insertCompositionText", "", true);
      replace(field, at.from, at.from + at.length, "");
      after(field, "insertCompositionText", null, true);
      composed = null;
      composition(field, "compositionend", "");
    }
  };
}
