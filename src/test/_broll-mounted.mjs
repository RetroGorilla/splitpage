import { mountBrollFeature, mountBrollPanelStateFeature } from "../bootstrap/wiring/broll.ts";

export const broll = mountBrollFeature();

mountBrollPanelStateFeature();
