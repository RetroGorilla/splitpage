import { createViewLifetime } from "../common/view-lifetime.ts";

export interface IdentityPorts {
  readonly promptForName: () => void;
}

export function mountIdentity(mount: { window: Window; ports: IdentityPorts }): { dispose: () => void } {
  const { window, ports } = mount;
  const document = window.document;
  const life = createViewLifetime(window);
  const element = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
  life.listen(element("identity-chip"), "click", ports.promptForName);
  return { dispose: life.dispose };
}
