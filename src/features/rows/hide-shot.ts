import type { NoticePort } from "../../application/effects/ports.ts";
import type { ShotHiding, ShotRow } from "../../application/shot-hiding.ts";
import { escapeHtml } from "../../core/document/text-policy.ts";

interface HideShotPorts {
  readonly shots: Pick<ShotHiding, "on" | "set" | "expand" | "groups">;
  readonly notices: Pick<NoticePort, "show">;
  readonly switchButton: () => Element | null;
}

export interface HideShotControls {
  readonly updateSwitch: () => void;
  readonly set: (on: boolean) => void;
  readonly toggle: () => void;
  readonly expand: (idsAttr: string | null | undefined) => void;
  readonly renderGroups: <R extends ShotRow>(rows: readonly R[], rowRenderer: (row: R, index: number) => string) => string;
}

export function hiddenShotStripHtml(ids: readonly string[]): string {
  const count = ids.length;
  const label = count + " filmed beat" + (count === 1 ? "" : "s") + " hidden";
  return '<button type="button" class="hidden-shot-strip" data-action="expand-hidden-shot" data-ids="' +
    escapeHtml(ids.join(",")) + '" title="Click to show">' +
      '<span class="hidden-shot-label">' + escapeHtml(label) + '</span>' +
      '<span class="hidden-shot-hint">Click to show</span>' +
    '</button>';
}

export function mountHideShotSwitch(button: Element | null, toggle: () => void): () => void {
  if (!button) return () => {};
  const onClick = (): void => { toggle(); };
  button.addEventListener("click", onClick);
  return () => { button.removeEventListener("click", onClick); };
}

export function createHideShot(ports: HideShotPorts): HideShotControls {
  function updateSwitch(): void {
    const button = ports.switchButton();
    if (!button) return;
    button.setAttribute("aria-checked", ports.shots.on() ? "true" : "false");
  }

  function set(on: boolean): void {
    if (ports.shots.set(on)) updateSwitch();
  }

  return {
    updateSwitch,
    set,
    toggle: function () {
      set(!ports.shots.on());
      ports.notices.show(ports.shots.on()
        ? "Hiding filmed beats — collapsed into strips you can click open."
        : "Showing every beat again.", "ok");
    },
    expand: function (idsAttr) {
      if (!idsAttr) return;
      ports.shots.expand(idsAttr.split(","));
    },
    renderGroups: function (rows, rowRenderer) {
      return ports.shots.groups(rows).map(function (item) {
        return "strip" in item ? hiddenShotStripHtml(item.strip) : rowRenderer(item.row, item.index);
      }).join("");
    }
  };
}
