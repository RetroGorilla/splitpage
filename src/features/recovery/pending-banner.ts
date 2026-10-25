export interface PendingBanner {
  readonly show: (text: string, onCopy: () => void) => boolean;
  readonly hide: () => void;
}

const wired = new WeakSet<Element>();

export function createPendingBanner(page: Document): PendingBanner {
  return {
    show: (text, onCopy) => {
      const banner = page.getElementById("draft-pending-banner");
      const message = page.getElementById("draft-pending-text");
      const button = page.getElementById("draft-pending-copy");
      if (!banner || !message) return false;
      message.textContent = text;
      banner.hidden = false;
      if (button && !wired.has(button)) {
        wired.add(button);
        button.addEventListener("click", function () { onCopy(); });
      }
      return true;
    },
    hide: () => {
      const banner = page.getElementById("draft-pending-banner");
      if (banner) banner.hidden = true;
    }
  };
}
