import { JSDOM } from "jsdom";

export function jsdomParser() {
  return new JSDOM("").window.DOMParser;
}
