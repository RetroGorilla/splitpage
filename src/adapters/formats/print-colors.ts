export const TAG_PRINT_COLORS: Readonly<Record<string, string>> = {
  prop: "764AA2",
  location: "2A7449",
  cast: "A53C75",
  vfx: "5E6C00",
  sound: "AB413E",
  gear: "44693C"
};

export function tagPrintColor(catId: string): string | null {
  return Object.prototype.hasOwnProperty.call(TAG_PRINT_COLORS, catId) ? (TAG_PRINT_COLORS[catId] ?? null) : null;
}
