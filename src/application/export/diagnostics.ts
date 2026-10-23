export function imagesLeftOutText(count: number, name: string): string {
  return count + (count === 1 ? " image" : " images") + " could not be included in " + name +
    " — the picture" + (count === 1 ? " was" : "s were") + " not available on this computer.";
}
