import type { EffectPorts } from "../../../application/effects/ports.ts";
import { copyShareText, setMenuItemLabel, setMenuItemReason, showActionToast, showToast } from "../../../legacy/effects-bridge.ts";

export const notices: EffectPorts<Element>["notices"] = { show: showToast, showAction: showActionToast };

export const menuItems: EffectPorts<Element>["menuItems"] = { setLabel: setMenuItemLabel, setReason: setMenuItemReason };

export const clipboard: EffectPorts<Element>["clipboard"] = { copyText: copyShareText };
