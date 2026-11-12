import { writerFor } from "./painted-base-support.ts";
import { beatPos } from "../../../src/core/flow/flow.ts";

export function standaloneNativeCases() {
  const keys: readonly KeyboardEventInit[] = [
    { key: "Enter" }, { key: "Enter", shiftKey: true }, { key: "Enter", ctrlKey: true }, { key: "Enter", ctrlKey: true, shiftKey: true },
    { key: "Backspace" }, { key: "Delete" }, { key: "Tab" }, { key: "z", ctrlKey: true }, { key: "z", ctrlKey: true, shiftKey: true },
    { key: "y", ctrlKey: true }, { key: "b", ctrlKey: true }, { key: "i", ctrlKey: true }, { key: "u", ctrlKey: true },
    { key: "ArrowUp", altKey: true }, { key: "ArrowDown", altKey: true }, { key: "Backspace", altKey: true },
    { key: "f", ctrlKey: true }, { key: "ArrowLeft" }, { key: "ArrowRight" }
  ];
  const lifecycle = ["finish", "repaint", "dispose", "format"] as const;
  const extensions = ["copy", "cut", "paste", "focusout-body", "focusout-control", "focusin", "drop",
    "insertParagraph", "insertLineBreak", "historyUndo", "historyRedo", "formatBold", "formatItalic", "formatUnderline",
    "insertFromDrop", "insertFromPaste", "deleteByCut", "deleteByDrag"] as const;
  const cases: unknown[] = [];
  for (const composing of [false, true]) for (const offset of [0, 2, 5]) for (const request of [...keys, ...lifecycle, ...extensions]) {
    const page = writerFor(), eventResults: unknown[] = [];
    const snapshot = () => ({ rows: page.doc.rows.map(row => ({ id: row.id, audioText: row.audioText, visualText: row.visualText,
      paragraphStart: row.paragraphStart, status: row.status })), sections: page.doc.sections, html: page.root.innerHTML, selection: page.writer.selection() });
    try {
      page.writer.repaint(); page.writer.caret("a", offset);
      let beat = page.root.querySelector<HTMLElement>('.wr-beat[data-id="a"]');
      if (!beat) throw new Error("Missing comparison beat");
      if (composing) {
        page.root.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
        beat.textContent = "Alpha".slice(0, offset) + "n" + "Alpha".slice(offset);
        const node = beat.firstChild;
        if (node) window.getSelection()?.setBaseAndExtent(node, offset + 1, node, offset + 1);
        page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "n", isComposing: true, bubbles: true }));
      }
      const before = snapshot();
      if (typeof request !== "string") {
        const event = new window.KeyboardEvent("keydown", { ...request, bubbles: true, cancelable: true });
        eventResults.push(page.root.dispatchEvent(event), event.defaultPrevented);
      } else if (request === "finish") eventResults.push(page.writer.finish());
      else if (request === "repaint") page.writer.repaint();
      else if (request === "dispose") page.writer.dispose();
      else if (request === "format") page.writer.format("bold");
      else if (request === "copy" || request === "cut" || request === "paste") {
        page.writer.place({ anchor: beatPos("a", 0), head: beatPos("a", composing ? 6 : 5) });
        const values = new Map([["text/plain", "P"]]), event = new window.Event(request, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: { getData: (key: string) => values.get(key) ?? "",
          setData: (key: string, value: string) => { values.set(key, value); }, types: ["text/plain"] } });
        eventResults.push(page.root.dispatchEvent(event), event.defaultPrevented, [...values]);
      } else if (request === "focusout-body" || request === "focusout-control") {
        const control = document.body.appendChild(document.createElement("button"));
        const event = new window.FocusEvent("focusout", { bubbles: true, relatedTarget: request === "focusout-body" ? document.body : control });
        eventResults.push(page.root.dispatchEvent(event), event.defaultPrevented); control.remove();
      } else if (request === "drop" || request === "focusin") {
        const event = new window.Event(request, { bubbles: true, cancelable: true });
        eventResults.push(page.root.dispatchEvent(event), event.defaultPrevented);
      } else {
        const event = new window.InputEvent("beforeinput", { inputType: request, isComposing: composing, bubbles: true, cancelable: true });
        const selection = window.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        Object.defineProperty(event, "getTargetRanges", { value: () => range ? [range] : [] });
        eventResults.push(page.root.dispatchEvent(event), event.defaultPrevented);
      }
      const after = snapshot();
      if (composing) {
        beat = page.root.querySelector<HTMLElement>('.wr-beat[data-id="a"]');
        if (beat) {
          beat.textContent = "Alpha".slice(0, offset) + "你" + "Alpha".slice(offset);
          const node = beat.firstChild;
          if (node) window.getSelection()?.setBaseAndExtent(node, offset + 1, node, offset + 1);
          page.root.dispatchEvent(new window.InputEvent("input", { inputType: "insertCompositionText", data: "你", bubbles: true }));
          page.root.dispatchEvent(new window.CompositionEvent("compositionend", { data: "你", bubbles: true }));
        }
      }
      const final = snapshot(); page.writer.dispose();
      cases.push({ composing, offset, request, eventResults, before, after, final, disposed: snapshot() });
    } finally { page.writer.dispose(); }
  }
  return { keyAndLifecycleCases: (keys.length + lifecycle.length) * 6, additionalCases: extensions.length * 6, cases };
}
