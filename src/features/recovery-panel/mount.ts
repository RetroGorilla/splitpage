import type { CommandOutcome } from "../../application/session/document-session.ts";
import { sharedRecoveryDiscardOperation, sharedRecoveryEntryName, sharedRecoveryPersonRestore } from "../../core/collab/recovery.ts";
import type { SharedRecoveryEntry } from "../../core/collab/recovery.ts";
import type { RecoveryPanelControl, RecoveryPanelPorts } from "./ports.ts";
import { recoveryPanelContent } from "./content.ts";

export function createRecoveryPanel(ports: RecoveryPanelPorts): RecoveryPanelControl {
  const document = ports.host.ownerDocument;
  let reader: ReturnType<RecoveryPanelPorts["session"]["current"]> = null, off: (() => void) | null = null;
  let panel: HTMLElement | null = null, opened = false, disposed = false;
  const preview = { id: "recovery-preview", by: "" };
  const close = () => { opened = false; panel?.remove(); panel = null; };
  function report(outcome: CommandOutcome): void {
    if (outcome.kind === "rejected" && !outcome.notified) ports.notices.show("This is not available in a shared session yet.", "warn");
    if (outcome.kind === "failed") ports.notices.show("Could not change recovery.", "warn");
  }
  function button(parent: HTMLElement, label: string, run: () => void): void {
    const button = parent.appendChild(document.createElement("button")); button.type = "button"; button.textContent = label;
    button.addEventListener("click", run);
  }
  function entryRow(parent: HTMLElement, entry: SharedRecoveryEntry): void {
    const row = parent.appendChild(document.createElement("article")); row.className = "history-card"; row.dataset.recoveryKind = entry.kind;
    const content = recoveryPanelContent(entry, ports), name = sharedRecoveryEntryName(entry);
    row.appendChild(document.createElement("h3")).textContent = content.label;
    row.appendChild(document.createElement("p")).textContent = content.by || "No author recorded";
    row.appendChild(document.createElement("pre")).textContent = content.text;
    const actions = row.appendChild(document.createElement("div")); actions.className = "history-card-actions";
    const restore = entry.kind === "deleted-person" ? sharedRecoveryPersonRestore(entry, ports.document.current()?.people ?? [], preview) !== null
      : (entry.kind === "removed-beat" || entry.kind === "removed-heading") && !!entry.removal?.ids.length;
    if (restore) button(actions, "Restore", () => { if (ports.session.current()) report(ports.restore(name)); });
    if (sharedRecoveryDiscardOperation(entry, preview)) button(actions, "Discard", () => { if (ports.session.current()) report(ports.discard(name)); });
  }
  function paint(): void {
    panel?.remove(); panel = null;
    if (!opened || !reader || disposed) return;
    panel = ports.host.appendChild(document.createElement("section")); panel.className = "comments-panel"; panel.id = "shared-recovery-panel";
    panel.setAttribute("aria-label", "Recovery");
    const head = panel.appendChild(document.createElement("div")); head.className = "comments-panel-head";
    head.appendChild(document.createElement("h2")).textContent = "Recovery"; button(head, "Close", close);
    const scroll = panel.appendChild(document.createElement("div")); scroll.className = "history-scroll";
    const list = scroll.appendChild(document.createElement("div")); list.className = "history-list";
    const entries = reader.recovery();
    if (!entries.length) list.appendChild(document.createElement("p")).textContent = "Nothing in recovery.";
    for (const entry of entries) entryRow(list, entry);
  }
  function changed(): void {
    const next = ports.session.current();
    if (reader !== next) { off?.(); reader = next; off = reader?.subscribe(paint) ?? null; }
    if (!reader) close();
    paint();
  }
  const mode = ports.session.onChange(changed); changed();
  return { open: () => { if (!disposed && ports.session.current()) { opened = true; changed(); } },
    dispose: () => { disposed = true; mode(); off?.(); off = null; reader = null; close(); } };
}
