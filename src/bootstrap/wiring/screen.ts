import { onRefresh, onSessionChange, onStamped } from "../../legacy/session-bridge.ts";
import { documentLocation } from "../../legacy/location-bridge.ts";
import { onPreferenceChange, preferences, viewFlags } from "../../legacy/preferences-bridge.ts";
import { shotHiding } from "../../legacy/shot-hiding-bridge.ts";
import { presence } from "../../legacy/presence-bridge.ts";
import { screenListeners } from "../../js/05-render.js";

let stopScreen: (() => void) | null = null;

export function mountScreenFeature(): void {
  stopScreenFeature();
  const screen = screenListeners();
  const stops: (() => void)[] = [
    onPreferenceChange((change) => {
      const name = preferences().nameOf(change.key);
      if (name) screen.preference(name);
    }),
    onSessionChange(screen.session),
    onRefresh(screen.refresh),
    onStamped(screen.stamped),
    shotHiding().onHiding(screen.hiding),
    presence().onRecolor(screen.colours),
    documentLocation().onChange(screen.location),
    viewFlags().onChange(screen.flag)
  ];
  stopScreen = () => {
    while (stops.length) stops.pop()?.();
  };
}

export function stopScreenFeature(): void {
  const stop = stopScreen;
  stopScreen = null;
  stop?.();
}
