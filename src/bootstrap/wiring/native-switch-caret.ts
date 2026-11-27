import { selection } from "./ports/editing.ts";
import { onDocumentReplaced, sessionEntryRefusal } from "./session-owner.ts";

const SCRIPT_TEXT = '#writer-doc, .wr-flow-visual-text, #rows .cell-editable:is([data-field="audioText"], [data-field="visualText"])';
const UNPLACED = "data-native-caret-unplaced";
let stopWaiting: (() => void) | null = null;

export function stopNativeCaretWait(scope?: "writer"): void {
  if (stopWaiting && (!scope || document.body.getAttribute(UNPLACED) === scope)) stopWaiting();
}

export function waitForNativeCaret(scope?: "writer"): void {
  if (scope && document.body.getAttribute(UNPLACED) === "") return;
  stopNativeCaretWait();
  const target = scope ? "#writer-doc" : SCRIPT_TEXT;
  const inScript = (node: EventTarget | null): boolean => {
    const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    return !!element?.closest(target);
  };
  const events = new window.AbortController();
  const options = { capture: true, signal: events.signal };
  document.body.setAttribute(UNPLACED, scope ?? "");
  const offReplacement = onDocumentReplaced(() => { if (!sessionEntryRefusal()) stopNativeCaretWait(); });
  stopWaiting = () => {
    stopWaiting = null;
    events.abort();
    offReplacement();
    document.body.removeAttribute(UNPLACED);
  };
  const clear = (): void => {
    const range = document.getSelection();
    if (inScript(range?.anchorNode ?? null) || inScript(range?.focusNode ?? null)) range?.removeAllRanges();
    selection.forget();
  };
  const block = (event: Event): void => {
    if (!inScript(event.target)) return;
    if (scope && event.type === "beforeinput" && /^history(Undo|Redo)$/.test((event as InputEvent).inputType)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clear();
  };
  document.addEventListener("focusin", event => {
    clear();
    if (scope && !inScript(event.target)) stopNativeCaretWait(scope);
  }, options);
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
