import { beginBusy, endBusy, withBusyBar } from "../../../features/notices/busy.js";
import type { BusyNotices } from "../../../application/effects/ports.ts";
import type { EffectPorts } from "../../../application/effects/ports.ts";
import { copyShareText, setMenuItemLabel, setMenuItemReason, showActionToast, showToast } from "../../../legacy/effects-bridge.ts";

export const notices: EffectPorts<Element>["notices"] & { readonly busy: BusyNotices } = { show: showToast, showAction: showActionToast, busy: { begin: beginBusy, end: endBusy, withBar: withBusyBar } };

export const menuItems: EffectPorts<Element>["menuItems"] = { setLabel: setMenuItemLabel, setReason: setMenuItemReason };

export const clipboard: EffectPorts<Element>["clipboard"] = { copyText: copyShareText };
