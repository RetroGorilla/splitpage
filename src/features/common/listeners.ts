export function addListener<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions
): () => void;
export function addListener<T extends EventTarget>(
  target: T,
  type: T extends HTMLElement ? never : string,
  handler: EventListener,
  options?: boolean | AddEventListenerOptions
): () => void;
export function addListener(
  target: EventTarget,
  type: string,
  handler: EventListener,
  options?: boolean | AddEventListenerOptions
): () => void {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}
