import type { ShareDialogPorts } from "./ports.ts";
import type { ShareAttemptResult } from "../../application/collaboration/share.ts";
import { SHARE_SCRIPT_COMMAND } from "./actions.ts";

const MESSAGES: Record<Exclude<ShareAttemptResult["kind"], "shared" | "not-configured" | "cancelled">, string> = {
  "document-changed": "The script changed during upload. Open Share again to share the current script.",
  unreachable: "Could not reach the relay. Try again when it’s available.",
  failed: "Could not share this script. Try again.",
  "already-used": "Someone is already using the earlier upload. Try again to share a new copy.",
  "too-large": "This script exceeds the 15 MB sharing limit."
};

export function mountShareDialog(ports: ShareDialogPorts) {
  const focus = document.activeElement;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "share-script-modal";
  backdrop.innerHTML = `
    <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="share-script-title" tabindex="-1">
      <div class="modal-header"><h2 id="share-script-title">${SHARE_SCRIPT_COMMAND.label}</h2></div>
      <p class="modal-hint">Sharing uploads a copy to your relay. Anyone with the link can edit the shared script. Your original file stays as it is.</p>
      <p class="modal-hint" role="status" id="share-script-status"></p>
      <p class="modal-hint" id="share-script-setup" hidden>Enter a supported relay address in <button type="button" class="btn" data-share="settings">Settings → Collaboration</button>
        or follow the <a href="https://github.com/RetroGorilla/splitpage/blob/main/docs/collaboration/native-adapter-design.md#stage-3-bounded-container-limits-and-status-endpoint" target="_blank" rel="noopener noreferrer">relay setup guide</a>.</p>
      <label class="modal-hint" id="share-script-link" hidden>Guest link <input readonly type="text"></label>
      <div class="modal-footer">
        <button type="button" class="btn" data-share="close">Close</button>
        <div class="modal-footer-actions">
          <button type="button" class="btn btn-accent" data-share="start" hidden>Share script</button>
          <button type="button" class="btn btn-accent" data-share="copy" hidden>Copy link</button>
        </div>
      </div>
    </section>`;
  function part(selector: string): HTMLElement {
    const element = backdrop.querySelector<HTMLElement>(selector);
    if (!element) throw new Error("Missing share dialog element " + selector);
    return element;
  }
  const button = (name: string) => part(`[data-share="${name}"]`) as HTMLButtonElement;
  const start = button("start"), close = button("close"), copy = button("copy");
  const panel = part("[role=dialog]"), status = part("[role=status]");
  const setup = part("#share-script-setup"), link = part("#share-script-link");
  const input = part("input") as HTMLInputElement;
  let address: string | null = null;
  let active: AbortController | undefined;
  let switching = false;

  function dispose(): void {
    active?.abort();
    window.removeEventListener("pagehide", dispose);
    backdrop.remove();
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
  }

  function unset(): void {
    status.textContent = "Sharing needs a relay.";
    setup.hidden = false;
    start.hidden = true;
  }

  function cancelOrClose(): void {
    if (switching) return;
    if (active) {
      active.abort();
      status.textContent = "Cancelling upload…";
      close.disabled = true;
    } else dispose();
  }

  async function share(): Promise<void> {
    if (!address || active) return;
    active = new AbortController();
    const { signal } = active;
    start.hidden = true;
    close.textContent = "Cancel";
    close.focus();
    status.textContent = "Uploading script…";
    let result: ShareAttemptResult;
    try {
      result = await ports.share(address, signal, () => {
        switching = true;
        close.disabled = true;
        panel.focus();
        status.textContent = "Opening shared script…";
      });
    } catch { result = { kind: "failed" }; }
    active = undefined;
    if (!backdrop.isConnected) return;
    switching = false;
    close.disabled = false;
    close.textContent = "Close";
    if (result.kind === "cancelled" || signal.aborted) { dispose(); return; }
    if (result.kind === "shared") {
      status.textContent = "Script shared. Pictures upload in the background.";
      input.value = result.link;
      link.hidden = false;
      copy.hidden = false;
      copy.focus();
    } else if (result.kind === "not-configured") {
      unset();
      button("settings").focus();
    } else {
      status.textContent = MESSAGES[result.kind];
      start.hidden = result.kind === "document-changed" || result.kind === "too-large";
      if (!start.hidden) start.textContent = "Try again";
      (start.hidden ? close : start).focus();
    }
  }

  close.onclick = cancelOrClose;
  start.onclick = () => { void share(); };
  copy.onclick = () => {
    void ports.copy(input.value).then(() => { status.textContent = "Link copied."; }, () => {
      input.focus();
      input.select();
      status.textContent = "Could not copy the link. The link is selected for you to copy.";
    });
  };
  button("settings").onclick = () => { dispose(); ports.settings(); };
  backdrop.onkeydown = event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelOrClose(); }
    if (event.key !== "Tab") return;
    const controls = [...backdrop.querySelectorAll<HTMLElement>("button:not(:disabled), a, input")]
      .filter(control => !control.closest("[hidden]"));
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    const boundary = event.shiftKey ? first : last;
    if (document.activeElement === boundary || !backdrop.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  };
  window.addEventListener("pagehide", dispose);
  document.body.append(backdrop);
  close.focus();
  status.textContent = "Checking relay setup…";
  void ports.address().then(value => {
    if (!backdrop.isConnected) return;
    address = value;
    if (!address) { unset(); return; }
    status.textContent = "";
    start.hidden = false;
  }, () => { status.textContent = MESSAGES.failed; });
  return dispose;
}
