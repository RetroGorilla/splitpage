import type { OfflineBeatReading, OfflineClashEntry } from "../../application/collaboration/offline-clashes.ts";
import { normalizeBeatLength } from "../../core/document/timing.ts";
import { rowStatus } from "../../core/production/looks.ts";
import { formatDuration } from "../../core/production/timing.ts";
import { toHtml } from "../../core/text/html.ts";
import { createViewLifetime } from "../common/view-lifetime.ts";
import { handleDialogKey, restoreDialogFocus } from "../common/dialog-focus.ts";
import type { OfflineReviewPorts } from "./ports.ts";

interface ReviewCard {
  readonly entry: OfflineClashEntry;
  readonly heading: HTMLElement;
  readonly live: HTMLElement;
  readonly jump: HTMLButtonElement;
}

export function createOfflineReview(window: Window, ports: OfflineReviewPorts): { readonly dispose: () => void } {
  const doc = window.document;
  const life = createViewLifetime(window);
  const banner = doc.getElementById("collab-offline-banner");
  const summary = doc.getElementById("collab-offline-summary");
  const review = doc.getElementById("collab-offline-review");
  const dismiss = doc.getElementById("collab-offline-dismiss");
  const dialog = doc.getElementById("offline-review");
  const close = doc.getElementById("offline-review-close");
  const list = doc.getElementById("offline-review-list");
  const feedback = doc.getElementById("offline-review-feedback");
  const panel = dialog?.querySelector<HTMLElement>('[role="dialog"]');
  if (!banner || !summary || !review || !dismiss || !dialog || !close || !list || !feedback || !panel) return life;

  let entries = ports.collaboration.snapshot().offlineClashes;
  let cards: readonly ReviewCard[] = [];

  function element(tag: string, className: string, text = ""): HTMLElement {
    const el = doc.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  }

  function button(className: string, text: string): HTMLButtonElement {
    const el = doc.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = text;
    return el;
  }

  function paintReading(body: HTMLElement, beat: OfflineBeatReading | null, missing: string): void {
    body.replaceChildren();
    if (!beat) {
      body.append(element("em", "diff-empty", missing));
      return;
    }
    const narration = element("div", "offline-review-cell");
    narration.innerHTML = toHtml(beat.narration);
    const visual = element("div", "offline-review-cell");
    visual.innerHTML = toHtml(beat.visual);
    body.append(element("strong", "merge-side-head", "Narration"), narration,
      element("strong", "merge-side-head", "Visual"), visual);
    const status = rowStatus(beat.fields.status);
    if (status) body.append(element("div", "merge-side-head", status.label));
    const length = normalizeBeatLength(beat.fields.lengthSeconds);
    if (length !== undefined) body.append(element("div", "merge-side-head", "Duration " + formatDuration(length)));
    if (beat.joined) body.append(element("div", "merge-side-head", "Joined to the beat above"));
  }

  function side(label: string): { panel: HTMLElement; body: HTMLElement } {
    const panel = element("section", "merge-side");
    const body = element("div", "merge-side-body");
    panel.append(element("h3", "merge-side-head", label), body);
    return { panel, body };
  }

  function readLive(entry: OfflineClashEntry): OfflineBeatReading | null {
    return ports.readBeat(entry.mine ? entry.id : entry.near ?? entry.id);
  }

  function paintLive(): void {
    if (!dialog || dialog.hidden) return;
    const numbers = ports.document.numbering();
    for (const { entry, heading, live, jump } of cards) {
      const beat = readLive(entry);
      const number = beat && numbers.beats[beat.row]?.full;
      heading.textContent = number ? "Beat " + number : "Removed beat";
      paintReading(live, beat, entry.mine ? "Removed while you were offline" : "Beat removed");
      jump.hidden = !beat;
      if (jump.hidden && doc.activeElement === jump) close?.focus({ preventScroll: true });
    }
  }

  function closeReview(): void {
    if (dialog && !dialog.hidden) {
      dialog.hidden = true;
      review?.setAttribute("aria-expanded", "false");
      restoreDialogFocus(doc, review);
    }
    list?.replaceChildren();
    cards = [];
    if (feedback) feedback.textContent = "";
  }

  function paintCards(): void {
    if (!dialog || dialog.hidden || !list || !feedback) return;
    const focused = list.contains(doc.activeElement);
    list.replaceChildren();
    cards = entries.map(entry => {
      const card = element("article", "merge-entry");
      const head = element("div", "merge-entry-head");
      const heading = element("h3", "offline-review-beat");
      const jump = button("jump-link", "Show beat");
      jump.onclick = () => {
        const beat = readLive(entry);
        if (!beat) { paintLive(); return; }
        closeReview();
        ports.revealBeat(beat.row);
      };
      const mine = side("Your offline copy");
      paintReading(mine.body, entry.mine, "Beat removed");
      const live = side(entry.mine ? "Current copy" : "Nearby beat");
      const sides = element("div", "merge-sides");
      sides.append(mine.panel, live.panel);
      head.append(heading, jump);
      card.append(head, sides);
      if (entry.mine) {
        const putBack = button("btn offline-review-restore", entry.restored ? "Put back" : "Put it back");
        putBack.disabled = entry.restored;
        putBack.onclick = () => {
          feedback.textContent = "";
          if (ports.putBack(entry)) {
            if (doc.activeElement === putBack) close?.focus({ preventScroll: true });
            putBack.disabled = true;
            feedback.textContent = "Beat put back.";
          }
          else feedback.textContent = "Could not put the beat back — check that the script is editable and try again.";
        };
        card.append(putBack);
      }
      list.append(card);
      return { entry, heading, live: live.body, jump };
    });
    paintLive();
    if (focused) close?.focus({ preventScroll: true });
  }

  function paintNotice(): void {
    if (!banner || !summary) return;
    banner.hidden = !entries.length;
    const remaining = entries.filter(entry => !entry.restored).length;
    summary.textContent = remaining === 1 ? "1 beat to review" : remaining ? remaining + " beats to review"
      : entries.length ? "All changes reviewed" : "";
    if (entries.length) paintCards();
    else closeReview();
  }

  life.listen(review, "click", () => {
    if (!entries.length || !dialog.hidden) return;
    dialog.hidden = false;
    review.setAttribute("aria-expanded", "true");
    paintCards();
    close.focus({ preventScroll: true });
  });
  life.listen(dismiss, "click", ports.collaboration.dismissOfflineClashes);
  life.listen(close, "click", closeReview);
  life.listen(dialog, "click", event => { if (event.target === dialog) closeReview(); });
  life.listen(window, "keydown", event => {
    if (dialog.hidden) return;
    if (event.key === "Escape") event.stopImmediatePropagation();
    handleDialogKey(event, panel, closeReview);
  }, true);
  life.release(ports.collaboration.onChange(snapshot => {
    if (entries === snapshot.offlineClashes) return;
    entries = snapshot.offlineClashes;
    paintNotice();
  }));
  life.release(ports.document.onChange(paintLive));
  life.release(() => { banner.hidden = true; closeReview(); });
  paintNotice();
  return life;
}
