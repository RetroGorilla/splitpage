import { createViewLifetime } from "../common/view-lifetime.ts";

export interface NoticesPorts {
  readonly loadUpdateStatus: () => () => void;
  readonly dismissUpdateNotice: () => void;
  readonly renderDesktopAppNotice: () => () => void;
  readonly dismissDesktopAppNotice: () => void;
}

export function mountNotices(mount: { window: Window; ports: NoticesPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.release(ports.loadUpdateStatus());
  const updateDismiss = element("update-bar-dismiss");
  if (updateDismiss) life.listen(updateDismiss, "click", ports.dismissUpdateNotice);

  life.release(ports.renderDesktopAppNotice());
  const desktopAppDismiss = element("desktop-app-bar-dismiss");
  if (desktopAppDismiss) life.listen(desktopAppDismiss, "click", ports.dismissDesktopAppNotice);
  return { dispose: life.dispose };
}
