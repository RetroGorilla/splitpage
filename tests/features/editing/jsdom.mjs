import { JSDOM } from "jsdom";

export function jsdomWindow() {
  return new JSDOM("<!doctype html><body></body>").window;
}
