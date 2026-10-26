import { __init as initHosted } from "../../js/13-hosted.js";
import { openPinDialog } from "../../js/20e-connect.js";
import { handPinDialogTo } from "../../legacy/pin-dialog.ts";

export function mountHostedFeature(): void {
  handPinDialogTo(openPinDialog);
  initHosted();
}
