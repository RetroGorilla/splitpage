import { startEffects } from "../legacy/effects-bridge.ts";
import { createShareClipboard } from "../features/clipboard/share-text.ts";
import { createMenuItemText } from "../features/file-menu/item-text.ts";
import { createToasts } from "../features/notices/toasts.ts";

export function startPageEffects(window: Window): () => void {
  return startEffects({
    notices: createToasts(window),
    menuItems: createMenuItemText(),
    clipboard: createShareClipboard(window)
  });
}
