import { selection } from "./ports/editing.ts";
import { onDocumentReplaced, sessionEntryRefusal } from "./session-owner.ts";

const SCRIPT_TEXT = '#writer-doc, .wr-flow-visual-text, #rows .cell-editable:is([data-field="audioText"], [data-field="visualText"])';
let stopWaiting: (() => void) | null = null;

function inScript(node: EventTarget | null): boolean {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  return !!element?.closest(SCRIPT_TEXT);
}

export function stopNativeCaretWait(): void {
  stopWaiting?.();
}

export function waitForNativeCaret(): void {
  stopNativeCaretWait();
  const events = new window.AbortController();
  const options = { capture: true, signal: events.signal };
  document.body.setAttribute("data-native-caret-unplaced", "");
  const offReplacement = onDocumentReplaced(() => { if (!sessionEntryRefusal()) stopNativeCaretWait(); });
  stopWaiting = () => {
    stopWaiting = null;
    events.abort();
    offReplacement();
    document.body.removeAttribute("data-native-caret-unplaced");
  };
  const clear = (): void => {
    const range = document.getSelection();
    if (inScript(range?.anchorNode ?? null) || inScript(range?.focusNode ?? null)) range?.removeAllRanges();
    selection.forget();
  };
  const block = (event: Event): void => {
    if (!inScript(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clear();
  };
  document.addEventListener("focusin", clear, options);
  document.addEventListener("selectionchange", clear, options);
  document.addEventListener("pointerdown", event => { if (inScript(event.target)) stopNativeCaretWait(); }, options);
  document.addEventListener("keydown", event => {
    if (!inScript(event.target)) return;
    if (!event.altKey && /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down))$/.test(event.key)) stopNativeCaretWait();
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey || /^(Enter|Backspace|Delete)$/.test(event.key)) block(event);
  }, options);
  for (const event of ["beforeinput", "compositionstart", "paste", "cut", "drop"]) {
    document.addEventListener(event, block, options);
  }
  clear();
}
