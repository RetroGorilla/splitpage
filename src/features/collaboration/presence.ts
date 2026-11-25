import type { PresenceLocation, PresencePeer } from "../../application/collaboration/presence.ts";
import type { PresenceViewPorts } from "./ports.ts";

function cellLocation(view: PresenceLocation["view"], cell: HTMLElement | null): PresenceLocation {
  const beat = cell?.dataset.id;
  const side = cell?.dataset.field;
  if (beat && beat.length <= 256 && (side === "audioText" || side === "visualText")) return { view, beat, side };
  return { view, beat: null, side: null };
}

function location(): PresenceLocation {
  const active = document.activeElement;
  if (document.querySelector("#prompter:not([hidden])")) return cellLocation("present", null);
  if (document.querySelector("#writer:not([hidden])")) {
    if (active?.matches(".wr-flow-visual-text")) return cellLocation("writer", active as HTMLElement);
    const node = active?.id === "writer-doc" ? document.getSelection()?.focusNode : null;
    const element = node instanceof Element ? node : node?.parentElement;
    return cellLocation("writer", element?.closest<HTMLElement>("#writer-doc .wr-beat") ?? null);
  }
  return cellLocation("split", active?.closest<HTMLElement>("#rows .cell-editable") ?? null);
}

function markRules(peers: readonly PresencePeer[]): string {
  const beats = new Map<string, PresencePeer[]>();
  for (const peer of peers) {
    if (!peer.beat) continue;
    const group = beats.get(peer.beat);
    if (group) group.push(peer);
    else beats.set(peer.beat, [peer]);
  }

  const rules: string[] = [];
  function dots(selector: string, people: readonly PresencePeer[]): void {
    if (!people.length) return;
    const shadows = people.map((person, i) => (i * -8) + "px 0 " + person.color).join(",");
    rules.push(selector + '::after {content:"";position:absolute;inset:1px 3px auto auto;width:6px;height:6px;' +
      'border-radius:50%;background:' + people[0]?.color + ';box-shadow:' + shadows + ';pointer-events:none;z-index:1}');
  }

  for (const [id, people] of beats) {
    const idValue = CSS.escape(id);
    const row = '#rows .row[data-id="' + idValue + '"]';
    dots('.rd-block[data-row="' + idValue + '"]', people);
    dots(row + " .audio-cell .field-wrap", people.filter(peer => peer.side === "audioText"));
    const visuals = people.filter(peer => peer.side === "visualText");
    dots(row + " .visual-cell .field-wrap", visuals);
    if (visuals.length) {
      rules.push('#writer-doc.is-flow .wr-beat[data-id="' + idValue + '"]::before {' +
        'content:attr(data-num) " · Visual in use";color:var(--text);border-bottom:2px solid ' + visuals[0]?.color + '}');
    }
  }
  return rules.join("\n");
}

export function mountPresenceView(ports: PresenceViewPorts): () => void {
  const markers = document.createElement("style");
  let tracking: AbortController | undefined;
  let observer: MutationObserver | undefined;
  let stopIdentity: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let showing = false;

  function sample(): void {
    timer ??= setTimeout(() => {
      timer = undefined;
      ports.setLocal({ ...ports.identity(), ...location() });
    }, 100);
  }

  function stop(): void {
    tracking?.abort();
    tracking = undefined;
    observer?.disconnect();
    stopIdentity?.();
    stopIdentity = undefined;
    clearTimeout(timer);
    timer = undefined;
    markers.remove();
    markers.textContent = "";
  }

  function track(): void {
    tracking = new window.AbortController();
    const { signal } = tracking;
    document.addEventListener("focusin", sample, { signal });
    document.addEventListener("focusout", sample, { signal });
    document.addEventListener("selectionchange", () => {
      if (document.activeElement?.id === "writer-doc") sample();
    }, { signal });
    observer = new window.MutationObserver(sample);
    for (const id of ["writer", "prompter"]) {
      const view = document.getElementById(id);
      if (view) observer.observe(view, { attributes: true, attributeFilter: ["hidden"] });
    }
    stopIdentity = ports.onIdentityChange(sample);
    sample();
  }

  function paint(): void {
    const css = showing ? markRules(ports.presence.peers()) : "";
    if (markers.textContent === css) return;
    markers.textContent = css;
    if (css && !markers.isConnected) document.head.append(markers);
    if (!css) markers.remove();
  }

  function sync(): void {
    const { active, relay, refusal, mergeTooLarge } = ports.collaboration.snapshot();
    const online = active && relay.connected && relay.firstSyncDone && !refusal && !mergeTooLarge;
    if (showing === online) return;
    showing = online;
    if (online) track();
    else stop();
    paint();
  }

  const unlisten = ports.collaboration.onChange(sync);
  const unpaint = ports.presence.onChange(paint);
  sync();
  return () => { unlisten(); unpaint(); stop(); };
}
