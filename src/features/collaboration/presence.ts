import type { PresenceCaret, PresenceLocation, PresencePeer } from "../../application/collaboration/presence.ts";
import type { CellEnds } from "../../core/text/selection.ts";
import { domKeys, domToPos } from "../common/cell-dom.ts";
import type { PresenceViewPorts } from "./ports.ts";

const EDITABLE = "#rows .cell-editable, #writer-doc, .wr-flow-visual-text";
interface Located {
  readonly location: PresenceLocation;
  readonly cell: HTMLElement | null;
}

function cellLocation(view: PresenceLocation["view"], cell: HTMLElement | null): Located {
  const beat = cell?.dataset.id;
  const side = cell?.dataset.field;
  if (cell && beat && beat.length <= 256 && (side === "audioText" || side === "visualText")) return { location: { view, beat, side }, cell };
  return { location: { view, beat: null, side: null }, cell: null };
}

function locate(document: Document): Located {
  const active = document.activeElement;
  if (document.querySelector("#prompter:not([hidden])")) return cellLocation("present", null);
  if (document.querySelector("#writer:not([hidden])")) {
    if (active?.matches(".wr-flow-visual-text")) return cellLocation("writer", active as HTMLElement);
    const node = active?.id === "writer-doc" ? document.getSelection()?.focusNode : null;
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    return cellLocation("writer", element?.closest<HTMLElement>("#writer-doc .wr-beat") ?? null);
  }
  return cellLocation("split", active?.closest<HTMLElement>("#rows .cell-editable") ?? null);
}

export function location(document: Document): PresenceLocation {
  return locate(document).location;
}

export function selectionEnds(document: Document, cell: Element): CellEnds | null {
  const selection = document.getSelection();
  const focus = selection?.focusNode;
  if (!selection || !focus || !cell.contains(focus)) return null;
  const head = domToPos(cell, focus, selection.focusOffset);
  if (head === null) return null;
  const anchorNode = selection.anchorNode;
  if (!anchorNode) return { anchor: head, head };
  if (!cell.contains(anchorNode)) {
    const start = document.createRange();
    start.setStart(cell, 0);
    const before = start.comparePoint(anchorNode, selection.anchorOffset) < 0;
    return { anchor: before ? 0 : domKeys(cell).length, head };
  }
  return { anchor: domToPos(cell, anchorNode, selection.anchorOffset) ?? head, head };
}

function localCaret(document: Document, ports: Pick<PresenceViewPorts, "caret">, { location, cell }: Located): PresenceCaret | null {
  const ends = cell && selectionEnds(document, cell);
  return cell && ends ? ports.caret(location, cell, ends) : null;
}

type MarkerRule =
  | { readonly selector: string; readonly color: string; readonly kind: "dots"; readonly shadows: string }
  | { readonly selector: string; readonly color: string; readonly kind: "visual" };

export function markRules(peers: readonly PresencePeer[], escapeId: (id: string) => string): readonly MarkerRule[] {
  const beats = new Map<string, PresencePeer[]>();
  for (const peer of peers) {
    if (!peer.beat) continue;
    const group = beats.get(peer.beat);
    if (group) group.push(peer);
    else beats.set(peer.beat, [peer]);
  }

  const rules: MarkerRule[] = [];
  function dots(selector: string, [first, ...others]: readonly PresencePeer[]): void {
    if (!first) return;
    const shadows = others.map((person, i) => ((i + 1) * -8) + "px 0 " + person.color).join(",") || "none";
    rules.push({ selector, kind: "dots", color: first.color, shadows });
  }

  for (const [id, people] of beats) {
    const idValue = escapeId(id);
    const row = '#rows .row[data-id="' + idValue + '"]';
    dots('.rd-block[data-row="' + idValue + '"]', people);
    dots(row + " .audio-cell .field-wrap", people.filter(peer => peer.side === "audioText"));
    const visuals = people.filter(peer => peer.side === "visualText");
    dots(row + " .visual-cell .field-wrap", visuals);
    const visual = visuals[0];
    if (visual) {
      rules.push({ selector: '#writer-doc.is-flow .wr-beat[data-id="' + idValue + '"]', kind: "visual", color: visual.color });
    }
  }
  return rules;
}

function clearMark(element: HTMLElement): void {
  delete element.dataset.presenceDots;
  delete element.dataset.presenceVisual;
  element.style.removeProperty("--presence-mark-color");
  element.style.removeProperty("--presence-mark-shadows");
}

function putMark(element: HTMLElement, rule: MarkerRule): void {
  element.style.setProperty("--presence-mark-color", rule.color);
  if (rule.kind === "dots") {
    element.dataset.presenceDots = "";
    element.style.setProperty("--presence-mark-shadows", rule.shadows);
  } else {
    element.dataset.presenceVisual = "Visual in use";
  }
}

export function mountPresenceView(ports: PresenceViewPorts): () => void {
  let rules: readonly MarkerRule[] = [];
  let marked = new Map<HTMLElement, MarkerRule>();
  let tracking: AbortController | undefined;
  let observer: MutationObserver | undefined;
  let markerObserver: MutationObserver | undefined;
  let stopIdentity: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let showing = false;

  function sample(): void {
    timer ??= setTimeout(() => {
      timer = undefined;
      const located = locate(document);
      ports.setLocal({ ...ports.identity(), ...located.location, caret: localCaret(document, ports, located) });
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
    markerObserver?.disconnect();
    for (const element of marked.keys()) clearMark(element);
    marked.clear();
    rules = [];
  }

  function track(): void {
    tracking = new window.AbortController();
    const { signal } = tracking;
    document.addEventListener("focusin", sample, { signal });
    document.addEventListener("focusout", sample, { signal });
    document.addEventListener("selectionchange", () => {
      if (document.activeElement?.matches(EDITABLE)) sample();
    }, { signal });
    observer = new window.MutationObserver(sample);
    markerObserver = new window.MutationObserver(records => {
      if (records.some(({ target }) => target.nodeType === 1 &&
        (target as Element).matches("#rows, .rundown-blocks, #rows .cell, #writer-doc, .wr-par"))) paint();
    });
    for (const id of ["writer", "prompter"]) {
      const view = document.getElementById(id);
      if (view) observer.observe(view, { attributes: true, attributeFilter: ["hidden"] });
    }
    stopIdentity = ports.onIdentityChange(sample);
    sample();
  }

  function paint(): void {
    const next = new Map<HTMLElement, MarkerRule>();
    const parents = new Set<Element>();
    for (const rule of rules) {
      const element = document.querySelector<HTMLElement>(rule.selector);
      if (!element) continue;
      next.set(element, rule);
      const previous = marked.get(element);
      if (previous?.color !== rule.color || (rule.kind === "dots" && (previous.kind !== "dots" || previous.shadows !== rule.shadows))) {
        putMark(element, rule);
      }
      const parent = element.parentElement;
      if (parent?.matches("#rows .cell")) parents.add(parent);
    }
    for (const element of marked.keys()) {
      if (!next.has(element)) clearMark(element);
    }
    marked = next;
    markerObserver?.disconnect();
    if (!rules.length) return;
    for (const selector of ["#rows", ".rundown-blocks"]) {
      const root = document.querySelector(selector);
      if (root) parents.add(root);
    }
    for (const parent of parents) markerObserver?.observe(parent, { childList: true });
    const writer = document.getElementById("writer-doc");
    if (writer && rules.some(rule => rule.kind === "visual")) markerObserver?.observe(writer, { childList: true, subtree: true });
  }

  function updateMarks(): void {
    if (!showing) return;
    rules = markRules(ports.presence.peers(), id => CSS.escape(id));
    paint();
  }

  function sync(): void {
    const { active, relay, refusal, mergeTooLarge } = ports.collaboration.snapshot();
    const online = active && relay.connected && relay.firstSyncDone && !refusal && !mergeTooLarge;
    if (showing === online) return;
    showing = online;
    if (online) {
      track();
      updateMarks();
    }
    else stop();
  }

  const unlisten = ports.collaboration.onChange(sync);
  const unpaint = ports.presence.onChange(updateMarks);
  sync();
  return () => { unlisten(); unpaint(); stop(); };
}
