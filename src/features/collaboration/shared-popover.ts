import type { SharedPopoverPorts } from "./ports.ts";
import type { PresencePeer } from "../../application/collaboration/presence.ts";

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
  pill.className = "btn";
  pill.setAttribute("aria-haspopup", "dialog");
  pill.setAttribute("aria-expanded", "false");
  pill.setAttribute("aria-controls", "shared-popover");
  pill.innerHTML = '<span class="tally-dot" aria-hidden="true"></span> Shared';
  const dot = pill.firstElementChild as HTMLElement;
  Object.assign(dot.style, { flex: "none", width: "7px", height: "7px", borderRadius: "50%" });
  const avatars = document.createElement("span");
  avatars.setAttribute("aria-hidden", "true");
  Object.assign(avatars.style, { display: "inline-flex", alignItems: "center", gap: "3px" });
  pill.append(avatars);

  const panel = document.createElement("section");
  panel.id = "shared-popover";
  panel.setAttribute("popover", "auto");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "shared-popover-title");
  panel.className = "modal-panel";
  Object.assign(panel.style, { position: "fixed", inset: "auto", margin: "0", width: "min(19rem, calc(100vw - 16px))" });
  panel.innerHTML = `
    <div class="modal-header"><h2 id="shared-popover-title">Shared</h2><button type="button" class="btn" data-sharing="close" autofocus>Close</button></div>
    <p class="modal-hint" data-connection></p>
    <section aria-labelledby="shared-here-title">
      <h3 id="shared-here-title">Here now</h3>
      <div data-here-now></div>
    </section>
    <div class="menu-group">
      <button type="button" class="mi" data-sharing="copy" aria-describedby="shared-copy-hint">Copy link</button>
      <p class="modal-hint" id="shared-copy-hint" hidden>Use Reset link to create a copyable link on this computer.</p>
      <button type="button" class="mi" data-sharing="reset">Reset link</button>
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

  function close(): void {
    if (panel.matches(":popover-open")) panel.hidePopover();
  }

  function syncPeople(online: boolean): void {
    const peers = online ? ports.presence.peers() : undefined;
    if (lastPeers === peers) return;
    lastPeers = peers;
    hereSection.hidden = !online;
    const current = peers ?? [];
    avatars.replaceChildren(...current.slice(0, 3).map(avatar));
    if (current.length > 3) avatars.append("+" + (current.length - 3));
    avatars.hidden = current.length === 0;
    empty.hidden = current.length > 0;
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
      entry.button.disabled = !person.beat;
    }
  }

  function sync(): void {
    if (disposed) return;
    const snapshot = ports.collaboration.snapshot();
    if (!snapshot.active) {
      syncPeople(false);
      opening++;
      close();
      panel.remove();
      pill.remove();
      return;
    }
    const anchor = document.getElementById("present-split");
    if (!pill.isConnected && anchor) {
      anchor.before(pill);
      document.body.append(panel);
    }
    const online = snapshot.relay.connected && snapshot.relay.firstSyncDone;
    syncPeople(online && !snapshot.refusal && !snapshot.mergeTooLarge);
    const summary = snapshot.refusal ? "Access removed · local work kept" : online ? "Connected" : "Offline";
    dot.style.backgroundColor = online ? "var(--ok)" : "currentColor";
    const count = lastPeers?.length ?? 0;
    pill.setAttribute("aria-label", "Shared · " + summary + (count ? " · " + count + " here now" : ""));
    connection.textContent = summary;
    const membership = ports.membership();
    const owner = membership?.role === "owner" && !snapshot.refusal;
    for (const action of ["copy", "reset", "stop"]) button(action).hidden = !owner;
    button("promote").hidden = membership?.role !== "guest" || !promotionAvailable || !!snapshot.refusal;
    copyHint.hidden = !owner || !!membership?.link;
    stopHint.hidden = !owner || online;
    button("copy").disabled = busy || !membership?.link || !!snapshot.refusal;
    button("reset").disabled = busy || !online;
    button("stop").disabled = busy || !online;
    button("promote").disabled = busy;
    button("leave").disabled = busy;
    button("save").disabled = busy;
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

  function open(): void {
    sync();
    if (!panel.isConnected || panel.matches(":popover-open")) return;
    const generation = ++opening;
    promotionAvailable = false;
    status.textContent = "";
    panel.showPopover();
    const anchor = pill.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(anchor.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8)) + "px";
    panel.style.top = Math.min(anchor.bottom + 8, Math.max(8, window.innerHeight - panel.offsetHeight - 8)) + "px";
    sync();
    if (ports.membership()?.role === "owner" && ports.membership()?.link && ports.collaboration.snapshot().relay.connected) {
      void run(() => ports.manage("check-link"), "Could not check the guest link.");
    } else {
      void ports.canManage().then(available => {
        if (generation !== opening) return;
        promotionAvailable = available;
        sync();
      }, () => {});
    }
  }

  panel.addEventListener("toggle", () => {
    pill.setAttribute("aria-expanded", String(panel.matches(":popover-open")));
  });
  pill.onclick = () => { if (panel.matches(":popover-open")) close(); else ports.open(); };
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
  button("promote").onclick = () => {
    void run(() => ports.manage("promote"), "Could not manage sharing on this computer. Check the relay setup and try again.");
  };
  button("stop").onclick = () => {
    if (button("stop").disabled || !ports.confirm("This will end sharing for everyone. Your work will stay on this device. Stop sharing?")) return;
    void run(() => ports.manage("stop"), "Could not stop sharing. Check the relay connection and try again.");
  };
  const unsubscribe = ports.collaboration.onChange(sync);
  const unsubscribePeople = ports.presence.onChange(sync);
  sync();
  return { open, dispose() { disposed = true; unsubscribe(); unsubscribePeople(); close(); panel.remove(); pill.remove(); } };
}
