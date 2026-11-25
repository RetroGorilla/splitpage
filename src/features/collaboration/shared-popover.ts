import type { SharedPopoverPorts } from "./ports.ts";
import type { PresencePeer } from "../../application/collaboration/presence.ts";
import { mountPasswordDialog } from "./password-dialog.ts";
import { handleDialogKey, restoreDialogFocus } from "../common/dialog-focus.ts";

function avatar(person: PresencePeer): HTMLElement {
  const element = document.createElement("span");
  element.className = "person-avatar";
  element.style.setProperty("--size", "18px");
  element.style.setProperty("--presence", person.color);
  element.setAttribute("aria-hidden", "true");
  element.title = person.name;
  element.textContent = person.name.trim().split(/\s+/u).slice(0, 2)
    .map(word => Array.from(word)[0]).join("").toUpperCase();
  return element;
}

export function mountSharedPopover(ports: SharedPopoverPorts) {
  const pill = document.createElement("button");
  pill.id = "shared-pill";
  pill.type = "button";
  pill.className = "btn shared-trigger";
  pill.setAttribute("aria-haspopup", "dialog");
  pill.setAttribute("aria-expanded", "false");
  pill.setAttribute("aria-controls", "shared-popover");
  pill.innerHTML = '<span class="tally-dot" aria-hidden="true"></span> Shared';
  const dot = pill.firstElementChild as HTMLElement;
  const avatars = document.createElement("span");
  avatars.setAttribute("aria-hidden", "true");
  avatars.className = "shared-avatars";
  avatars.hidden = true;
  pill.append(avatars);

  const panel = document.createElement("section");
  panel.id = "shared-popover";
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "shared-popover-title");
  panel.className = "modal-panel sharing-details";
  panel.innerHTML = `
    <div class="modal-header"><h2 id="shared-popover-title">Shared</h2><button type="button" class="btn" data-sharing="close">Close</button></div>
    <p class="modal-hint" data-connection></p>
    <section aria-labelledby="shared-here-title">
      <h3 id="shared-here-title">Here now</h3>
      <div data-here-now></div>
    </section>
    <div class="menu-group">
      <button type="button" class="mi" data-sharing="copy" aria-describedby="shared-copy-hint">Copy link</button>
      <p class="modal-hint" id="shared-copy-hint" hidden>Use Reset link to create a copyable link on this computer.</p>
      <button type="button" class="mi" data-sharing="reset">Reset link</button>
      <button type="button" class="mi" data-sharing="password">Require a password</button>
      <button type="button" class="mi" data-sharing="promote" hidden>Manage sharing on this computer</button>
      <button type="button" class="mi" data-sharing="save">Save a copy…</button>
      <button type="button" class="mi" data-sharing="leave">Leave</button>
      <button type="button" class="mi" data-sharing="stop" aria-describedby="shared-stop-hint">Stop sharing</button>
      <p class="modal-hint" id="shared-stop-hint" hidden>Connect to the relay to stop sharing.</p>
    </div>
    <p class="modal-hint" role="status"></p>`;
  function part(selector: string): HTMLElement {
    const element = panel.querySelector<HTMLElement>(selector);
    if (!element) throw new Error("Missing shared popover element " + selector);
    return element;
  }
  const button = (action: string) => part(`[data-sharing="${action}"]`) as HTMLButtonElement;
  const connection = part("[data-connection]");
  const status = part("[role=status]");
  const copyHint = part("#shared-copy-hint");
  const stopHint = part("#shared-stop-hint");
  const here = part("[data-here-now]");
  const hereSection = part('section[aria-labelledby="shared-here-title"]');
  hereSection.hidden = true;
  Object.assign(here.style, { maxHeight: "11rem", overflow: "auto" });
  const empty = document.createElement("p");
  empty.className = "modal-hint";
  empty.textContent = "No other people are here.";
  here.append(empty);
  const people = new Map<number, { button: HTMLButtonElement; person: PresencePeer }>();
  let lastPeers: readonly PresencePeer[] | undefined;
  let disposed = false;
  let busy = false;
  let promotionAvailable = false;
  let opening = 0;
  let trigger: Element | null = null;
  const blocked = new Set<Element>();
  let passwordDialog: ReturnType<typeof mountPasswordDialog> | undefined;

  function setModal(modal: boolean): void {
    if (modal) {
      panel.setAttribute("aria-modal", "true");
      for (const sibling of document.body.children) {
        if (sibling === panel || sibling.hasAttribute("inert")) continue;
        sibling.setAttribute("inert", "");
        blocked.add(sibling);
      }
    } else {
      panel.removeAttribute("aria-modal");
      for (const sibling of blocked) sibling.removeAttribute("inert");
      blocked.clear();
    }
  }

  function close(): void {
    if (!panel.matches(":popover-open")) return;
    panel.hidePopover();
    setModal(false);
    pill.setAttribute("aria-expanded", "false");
    restoreDialogFocus(document, trigger);
    trigger = null;
  }

  function syncPillLabel(): void {
    const count = lastPeers?.length ?? 0;
    const label = "Shared · " + connection.textContent + (count ? " · " + count + " here now" : "");
    if (pill.getAttribute("aria-label") !== label) pill.setAttribute("aria-label", label);
  }

  function syncPeople(online: boolean): void {
    const peers = online ? ports.presence.peers() : undefined;
    if (lastPeers === peers) return;
    const previous = lastPeers ?? [];
    lastPeers = peers;
    const hidden = !online;
    if (hereSection.hidden !== hidden) hereSection.hidden = hidden;
    const current = peers ?? [];
    const focused = here.contains(document.activeElement) ? document.activeElement : null;
    const shown = current.slice(0, 3);
    if (previous.length !== current.length || shown.some((person, i) => {
      const old = previous[i];
      return old?.clientId !== person.clientId || old.name !== person.name || old.color !== person.color;
    })) {
      avatars.replaceChildren(...shown.map(avatar));
      if (current.length > 3) avatars.append("+" + (current.length - 3));
      avatars.hidden = current.length === 0;
      empty.hidden = current.length > 0;
      syncPillLabel();
    }
    for (const [id, entry] of people) {
      if (current.some(person => person.clientId === id)) continue;
      entry.button.remove();
      people.delete(id);
    }
    for (const person of current) {
      let entry = people.get(person.clientId);
      if (!entry) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mi";
        button.onclick = () => {
          const target = people.get(person.clientId)?.person;
          if (!target?.beat || !target.side) return;
          close();
          ports.revealBeat(target.beat, target.side);
        };
        entry = { button, person };
        people.set(person.clientId, entry);
        here.append(button);
      }
      if (entry.person.name !== person.name || entry.person.color !== person.color || !entry.button.firstChild) {
        entry.button.replaceChildren(avatar(person), person.name);
      }
      entry.person = person;
      const disabled = !person.beat || !person.side;
      if (entry.button.disabled !== disabled) entry.button.disabled = disabled;
    }
    if (focused && (hidden || !focused.isConnected || focused.matches(":disabled")) && panel.matches(":popover-open")) {
      const next = here.querySelector<HTMLButtonElement>("button:not(:disabled)");
      (hidden ? button("close") : next ?? button("close")).focus();
    }
  }

  function sync(): void {
    if (disposed) return;
    const snapshot = ports.collaboration.snapshot();
    if (!snapshot.active) {
      const hadFocus = pill === document.activeElement || panel.contains(document.activeElement);
      syncPeople(false);
      opening++;
      passwordDialog?.dispose();
      close();
      panel.remove();
      pill.remove();
      if (hadFocus && (document.activeElement === pill || document.activeElement === document.body)) {
        restoreDialogFocus(document, null);
      }
      return;
    }
    const anchor = document.getElementById("present-split");
    if (!pill.isConnected && anchor) {
      anchor.before(pill);
      document.body.append(panel);
    }
    const online = snapshot.relay.connected && snapshot.relay.firstSyncDone;
    const summary = snapshot.refusal ? "Access removed · local work kept" : online ? "Connected" : "Offline";
    dot.style.backgroundColor = online ? "var(--ok)" : "currentColor";
    connection.textContent = summary;
    syncPeople(online && !snapshot.refusal && !snapshot.mergeTooLarge);
    syncPillLabel();
    const membership = ports.membership();
    const focused = panel.contains(document.activeElement) ? document.activeElement : null;
    const owner = membership?.role === "owner" && !snapshot.refusal;
    if (!owner) passwordDialog?.dispose();
    for (const action of ["copy", "reset", "password", "stop"]) button(action).hidden = !owner;
    button("password").textContent = membership?.passwordRequired ? "Change password…" : "Require a password";
    button("promote").hidden = membership?.role !== "guest" || !promotionAvailable || !!snapshot.refusal;
    copyHint.hidden = !owner || !!membership?.link;
    stopHint.hidden = !owner || online;
    button("copy").disabled = busy || !membership?.link || !!snapshot.refusal;
    button("reset").disabled = busy || !online;
    button("password").disabled = busy || !online;
    button("stop").disabled = busy || !online;
    button("promote").disabled = busy;
    button("leave").disabled = busy;
    button("save").disabled = busy;
    if (focused?.closest("[hidden], :disabled") && panel.matches(":popover-open")) button("close").focus();
  }

  async function run(work: () => Promise<void>, failure: string): Promise<void> {
    if (busy) return;
    busy = true;
    status.textContent = "";
    sync();
    try { await work(); }
    catch { status.textContent = failure; }
    finally { busy = false; sync(); }
  }

  function position(): void {
    setModal(window.innerWidth <= 760);
    const anchor = pill.getBoundingClientRect();
    panel.style.setProperty("--sharing-left", Math.max(8, Math.min(anchor.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8)) + "px");
    panel.style.setProperty("--sharing-top", Math.min(anchor.bottom + 8, Math.max(8, window.innerHeight - panel.offsetHeight - 8)) + "px");
  }

  function open(): void {
    sync();
    if (!panel.isConnected || panel.matches(":popover-open")) return;
    const generation = ++opening;
    promotionAvailable = false;
    status.textContent = "";
    trigger = document.activeElement;
    panel.showPopover(trigger === pill ? { source: pill } : undefined);
    pill.setAttribute("aria-expanded", "true");
    position();
    button("close").focus();
    sync();
    if (ports.membership()?.role === "owner" && ports.collaboration.snapshot().relay.connected) {
      void run(() => ports.manage("check-link"), "Could not check the guest link.");
    } else {
      void ports.canManage().then(available => {
        if (generation !== opening) return;
        promotionAvailable = available;
        sync();
      }, () => {});
    }
  }

  panel.addEventListener("beforetoggle", event => {
    const open = (event as ToggleEvent).newState === "open";
    pill.setAttribute("aria-expanded", String(open));
    if (!open) setModal(false);
  });
  panel.addEventListener("keydown", event => handleDialogKey(event, panel, close));
  const resize = () => { if (panel.matches(":popover-open")) position(); };
  window.addEventListener("resize", resize);
  pill.onclick = () => {
    if (panel.matches(":popover-open")) close();
    else {
      pill.focus();
      ports.open();
    }
  };
  button("close").onclick = close;
  button("save").onclick = () => { close(); ports.saveCopy(); };
  button("leave").onclick = () => {
    if (busy) return;
    close();
    void run(ports.leave, "Could not leave the shared script.");
  };
  button("copy").onclick = () => {
    void run(async () => {
      if (ports.collaboration.snapshot().relay.connected) await ports.manage("check-link");
      const link = ports.membership()?.link;
      if (!link) return;
      await ports.copy(link);
      status.textContent = "Link copied.";
    }, "Could not copy the link.");
  };
  button("reset").onclick = () => {
    void run(async () => {
      await ports.manage("reset");
      status.textContent = "Guest link reset.";
    }, "Could not reset the guest link.");
  };
  button("password").onclick = () => {
    if (button("password").disabled) return;
    const required = ports.membership()?.passwordRequired;
    close();
    passwordDialog?.dispose();
    const title = required ? "Change password" : "Require a password";
    passwordDialog = mountPasswordDialog({
      title, submit: required ? "Save password" : "Require password",
      async save(password) { await ports.manage("set-password", password); return null; },
      ...(required && { async remove() { await ports.manage("remove-password"); return null; } })
    });
  };
  button("promote").onclick = () => {
    void run(() => ports.manage("promote"), "Could not manage sharing on this computer. Check the relay setup and try again.");
  };
  button("stop").onclick = () => {
    if (button("stop").disabled || !ports.confirm("This will end sharing for everyone. Your work will stay on this device. Stop sharing?")) return;
    void run(() => ports.manage("stop"), "Could not stop sharing. Check the relay connection and try again.");
  };
  const unsubscribe = ports.collaboration.onChange(sync);
  const unsubscribePeople = ports.presence.onChange(() => {
    const { active, relay, refusal, mergeTooLarge } = ports.collaboration.snapshot();
    syncPeople(active && relay.connected && relay.firstSyncDone && !refusal && !mergeTooLarge);
  });
  sync();
  return {
    open,
    dispose() {
      disposed = true;
      unsubscribe();
      unsubscribePeople();
      window.removeEventListener("resize", resize);
      passwordDialog?.dispose();
      close();
      panel.remove();
      pill.remove();
    }
  };
}
