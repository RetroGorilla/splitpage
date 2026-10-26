export type TagEntityContainerFactory = (id: string, rootClick: (event: MouseEvent) => void) => () => void;

let factory: TagEntityContainerFactory | null = null;

export function installTagEntityContainerFactory(next: TagEntityContainerFactory): () => void {
  factory = next;
  return () => { if (factory === next) factory = null; };
}

export function createTagEntityContainer(id: string, rootClick: (event: MouseEvent) => void): () => void {
  if (!factory) throw new Error("The tag entity container factory is not installed yet");
  return factory(id, rootClick);
}
