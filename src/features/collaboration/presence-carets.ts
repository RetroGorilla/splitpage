import type { PresencePeer } from "../../application/collaboration/presence.ts";
import type { CellEnds } from "../../core/text/selection.ts";
import { posToDom } from "../common/cell-dom.ts";
import type { PresenceCaretsPorts } from "./ports.ts";
import { selectionEnds } from "./presence.ts";

type ShownView = "split" | "writer";

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PeerCaretMark {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
  readonly caret: Box;
  readonly selection: readonly Box[];
}

const PAINTED = "#rows, #writer";
const MEASURED = "#rows, #writer-doc, #writer .wr-flow-visual-text";
const SHOWN_TEXT = { split: "#rows", writer: "#writer-doc, .wr-flow-visual-box" } as const;

function paintsShownText(document: Document, records: readonly MutationRecord[]): boolean {
  const view = shownView(document);
  if (!view) return false;
  return records.some(record => {
    const node = record.target;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    return !!element?.closest(SHOWN_TEXT[view]);
  });
}
const VIEWS = ["writer", "prompter"];

export function shownView(document: Document): ShownView | null {
  if (document.querySelector("#prompter:not([hidden])")) return null;
  return document.querySelector("#writer:not([hidden])") ? "writer" : "split";
}

export function peerCell(document: Document, view: ShownView, peer: PresencePeer): HTMLElement | null {
  if (!peer.beat || !peer.side || peer.view === "present") return null;
  const id = '[data-id="' + CSS.escape(peer.beat) + '"]';
  const selector = view === "split" ? '#rows .cell-editable[data-field="' + peer.side + '"]' + id
    : peer.side === "audioText" ? "#writer-doc .wr-beat" + id : '.wr-flow-visual-text[data-field="visualText"]' + id;
  const cell = document.querySelector<HTMLElement>(selector);
  return cell && !cell.closest("[hidden]") ? cell : null;
}

function box(rect: DOMRect, x = rect.left, width = rect.width): Box {
  return { x, y: rect.top, width, height: rect.height };
}

function measure(document: Document, node: Node, from: number, to: number): DOMRect[] {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  return [...range.getClientRects()];
}

function textPoint(cell: HTMLElement, offset: number): { node: Node; offset: number } {
  const point = posToDom(cell, offset), previous = point.node.childNodes[point.offset - 1];
  return point.node.nodeType === 1 && previous?.nodeType === 3 ? { node: previous, offset: previous.nodeValue?.length ?? 0 } : point;
}

function caretBox(document: Document, cell: HTMLElement, offset: number): Box | null {
  const { node, offset: at } = textPoint(cell, offset);
  const here = measure(document, node, at, at)[0];
  if (here) return box(here, here.left, 0);
  if (node.nodeType === 3) {
    const length = node.nodeValue?.length ?? 0;
    const before = at > 0 ? measure(document, node, at - 1, at).at(-1) : undefined;
    if (before) return box(before, before.right, 0);
    const after = at < length ? measure(document, node, at, at + 1)[0] : undefined;
    if (after) return box(after, after.left, 0);
  } else {
    const next = node.childNodes[at], previous = node.childNodes[at - 1];
    const following = next && measure(document, node, at, at + 1)[0];
    if (following) return box(following, following.left, 0);
    const preceding = previous && measure(document, node, at - 1, at).at(-1);
    if (preceding && previous?.nodeName !== "BR") return box(preceding, preceding.right, 0);
  }
  const shell = cell.getBoundingClientRect();
  if (!shell.width && !shell.height) return null;
  const style = document.defaultView?.getComputedStyle(cell);
  const line = Number.parseFloat(style?.lineHeight ?? "") || (Number.parseFloat(style?.fontSize ?? "") || 16) * 1.3;
  return {
    x: shell.left + (Number.parseFloat(style?.paddingLeft ?? "") || 0),
    y: shell.top + (Number.parseFloat(style?.paddingTop ?? "") || 0),
    width: 0, height: Math.min(line, shell.height || line)
  };
}

function selectionBoxes(document: Document, cell: HTMLElement, ends: CellEnds): Box[] {
  if (ends.anchor === ends.head) return [];
  const from = posToDom(cell, Math.min(ends.anchor, ends.head)), to = posToDom(cell, Math.max(ends.anchor, ends.head));
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => box(rect));
}

function visible(target: Box, clip: Box): boolean {
  return target.x <= clip.x + clip.width && target.x + target.width >= clip.x &&
    target.y + target.height >= clip.y && target.y <= clip.y + clip.height;
}

export function viewClip(document: Document, view: ShownView): Box {
  const scroller = view === "writer" ? document.getElementById("writer-scroll") : null;
  if (scroller) return box(scroller.getBoundingClientRect());
  const window = document.defaultView;
  return { x: 0, y: 0, width: window?.innerWidth ?? 0, height: window?.innerHeight ?? 0 };
}

export function peerMarks(document: Document, view: ShownView, peers: readonly PresencePeer[],
  resolve: PresenceCaretsPorts["resolve"], clip: Box): PeerCaretMark[] {
  const marks: PeerCaretMark[] = [];
  for (const peer of peers) {
    if (!peer.caret) continue;
    const cell = peerCell(document, view, peer);
    const ends = cell && resolve(peer, cell, selectionEnds(document, cell)?.head ?? null);
    if (!cell || !ends) continue;
    const caret = caretBox(document, cell, ends.head);
    if (!caret) continue;
    const selection = selectionBoxes(document, cell, ends).filter(part => visible(part, clip));
    if (!visible(caret, clip) && !selection.length) continue;
    marks.push({ clientId: peer.clientId, name: peer.name, color: peer.color, caret, selection });
  }
  return marks;
}

function place(element: HTMLElement, { x, y, width, height }: Box): void {
  element.style.left = x + "px";
  element.style.top = y + "px";
  element.style.height = height + "px";
  if (width) element.style.width = width + "px";
}

function drawMark(document: Document, mark: PeerCaretMark): HTMLElement[] {
  const parts = mark.selection.map(part => {
    const element = document.createElement("div");
    element.className = "presence-selection";
    place(element, part);
    return element;
  });
  const caret = document.createElement("div");
  caret.className = "presence-caret";
  place(caret, mark.caret);
  const flag = document.createElement("span");
  flag.className = "presence-caret-flag";
  flag.textContent = mark.name;
  caret.append(flag);
  parts.push(caret);
  for (const part of parts) {
    part.dataset.client = String(mark.clientId);
    part.style.setProperty("--presence-caret-color", mark.color);
  }
  return parts;
}

export function mountPresenceCarets(ports: PresenceCaretsPorts): () => void {
  let layer: HTMLElement | undefined;
  let tracking: AbortController | undefined;
  let views: MutationObserver | undefined;
  let painted: MutationObserver | undefined;
  let resized: ResizeObserver | undefined;
  let sized = new WeakSet<Element>();
  let frame: number | undefined;
  let drawn = "";
  let showing = false;

  function clear(): void {
    drawn = "";
    layer?.replaceChildren();
  }

  function watchSizes(): void {
    if (!resized) return;
    for (const root of document.querySelectorAll(MEASURED)) {
      if (sized.has(root)) continue;
      sized.add(root);
      resized.observe(root);
    }
  }

  function draw(): void {
    frame = undefined;
    watchSizes();
    const view = shownView(document);
    const peers = ports.presence.peers();
    if (!view || !peers.some(peer => peer.caret)) { clear(); return; }
    const clip = viewClip(document, view);
    const marks = peerMarks(document, view, peers, ports.resolve, clip);
    const signature = JSON.stringify([clip, marks]);
    if (signature === drawn) return;
    drawn = signature;
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "presence-carets";
      layer.setAttribute("aria-hidden", "true");
      document.body.append(layer);
    }
    const right = Math.max(0, (document.defaultView?.innerWidth ?? 0) - clip.x - clip.width);
    const bottom = Math.max(0, (document.defaultView?.innerHeight ?? 0) - clip.y - clip.height);
    layer.style.clipPath = "inset(" + Math.max(0, clip.y) + "px " + right + "px " + bottom + "px " + Math.max(0, clip.x) + "px)";
    layer.replaceChildren(...marks.flatMap(mark => drawMark(document, mark)));
  }

  function schedule(): void {
    frame ??= window.requestAnimationFrame(draw);
  }

  function watchPaint(): void {
    const wanted = showing && ports.presence.peers().some(peer => peer.caret);
    if (wanted === !!painted) return;
    painted?.disconnect();
    painted = undefined;
    resized?.disconnect();
    resized = undefined;
    if (!wanted) return;
    painted = new window.MutationObserver(records => { if (paintsShownText(document, records)) schedule(); });
    resized = new window.ResizeObserver(schedule);
    for (const root of document.querySelectorAll(PAINTED)) {
      painted.observe(root, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    }
    sized = new WeakSet();
    watchSizes();
  }

  function track(): void {
    tracking = new window.AbortController();
    const { signal } = tracking;
    window.addEventListener("scroll", schedule, { signal, capture: true, passive: true });
    window.addEventListener("resize", schedule, { signal, passive: true });
    document.addEventListener("focusin", schedule, { signal });
    views = new window.MutationObserver(schedule);
    for (const id of VIEWS) {
      const view = document.getElementById(id);
      if (view) views.observe(view, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  function stop(): void {
    tracking?.abort();
    tracking = undefined;
    views?.disconnect();
    views = undefined;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    watchPaint();
    layer?.remove();
    layer = undefined;
    drawn = "";
  }

  function peersChanged(): void {
    if (!showing) return;
    watchPaint();
    schedule();
  }

  function sync(): void {
    const { active, relay, refusal, mergeTooLarge } = ports.collaboration.snapshot();
    const online = active && relay.connected && relay.firstSyncDone && !refusal && !mergeTooLarge;
    if (showing === online) return;
    showing = online;
    if (online) {
      track();
      peersChanged();
    } else stop();
  }

  const unlisten = ports.collaboration.onChange(sync);
  const unpeers = ports.presence.onChange(peersChanged);
  sync();
  return () => { unlisten(); unpeers(); showing = false; stop(); };
}
