import type { EmptyScriptPorts } from "./ports.ts";

export function startEmptyScript(ports: EmptyScriptPorts) {
  const epoch = ports.lifetime.epoch(), area = ports.host.ownerDocument.createElement("div");
  area.className = "empty-script";
  const input = area.appendChild(ports.host.ownerDocument.createElement("textarea"));
  input.className = "empty-script-input"; input.rows = 2; input.placeholder = "Start writing";
  input.setAttribute("aria-label", "Start writing"); input.dataset.undoOwner = "document";
  ports.host.before(area);
  let release: (() => void) | null = null, composing = false, pending = false, committing = false, beforeInput = "", beforeComposition = "", disposed = false;
  const current = () => ports.lifetime.epoch() === epoch;
  const empty = () => ports.document.current()?.rows.length === 0;
  const notify = (reason: string) => { ports.report({ kind: "rejected", reason }); };
  function paint(): void {
    area.hidden = !current() || !empty() && !pending && !composing && !input.value;
    input.disabled = !current() || !ports.edits.allowed();
  }
  function end(): void { const held = release; release = null; held?.(); }
  function begin(event: Event): boolean {
    if (!current() || !ports.edits.allowed() || !empty() && !pending && !input.value) { event.preventDefault(); return false; }
    if (!release) {
      const held = ports.hold();
      if (!held.ok) { event.preventDefault(); notify(held.reason); return false; }
      release = held.release;
    }
    beforeInput = input.value; pending = true;
    return true;
  }
  function finish(): boolean {
    if (committing) return true;
    if (composing) { notify("buffer-composition"); return false; }
    if (!current() && (input.value || pending)) { notify("empty-script-stale"); return false; }
    if (pending) { notify("buffer-pending"); return false; }
    if (!input.value) { end(); paint(); return true; }
    committing = true;
    try {
      const text = input.value, result = ports.create(text);
      if (!result.ok) { notify(result.reason); return false; }
      input.value = ""; end(); paint();
      if (!ports.place(result.rowId, text.length) && empty()) input.focus();
      return true;
    } finally { committing = false; }
  }
  const before = (event: Event): void => { begin(event); };
  const typed = (event: Event): void => {
    if (!current() || !ports.edits.allowed() || !release && !empty()) {
      event.preventDefault();
      if (!release) { input.value = ""; paint(); }
      return;
    }
    if (!release && !begin(event)) return;
    pending = false;
    if (!composing && !(event as InputEvent).isComposing) finish();
  };
  const start = (event: Event): void => { if (begin(event)) { beforeComposition = input.value; composing = true; } };
  const stop = (event: Event): void => {
    if (!composing) return;
    composing = false; pending = false;
    if (!(event as CompositionEvent).data) input.value = beforeComposition;
    finish();
  };
  const released = (): void => {
    if (!composing && pending && input.value === beforeInput) {
      pending = false;
      if (!input.value) end();
      paint();
    }
  };
  const blur = (): void => { if (!composing) finish(); };
  const listeners: readonly (readonly [string, EventListener])[] = [["beforeinput", before], ["input", typed], ["compositionstart", start], ["compositionend", stop], ["keyup", released], ["blur", blur]];
  for (const [name, listener] of listeners) input.addEventListener(name, listener);
  const off = ports.document.onChange(paint), admission = ports.lifetime.beforeCommand(finish);
  paint();
  return { finish, dispose: () => {
    if (disposed) return true;
    if (!finish()) return false;
    disposed = true; end(); off(); admission();
    for (const [name, listener] of listeners) input.removeEventListener(name, listener);
    area.remove(); return true;
  } };
}
