export const formattingLibraryControls = Object.freeze([
  "seeded formatting cleanup: 48 two-writer histories agree in every order and with a late joiner",
  "formatting cleanup literal: deleted italic abc cannot make the untouched suffix italic",
  "cleanup after a local command publishes a separate checked origin",
  "remote formatting cleanup has its own origin and releases the origin scope afterward",
  "T11: live deletes original commented bc, leaving ad unmarked (gc=true)",
  "T11: late joiner deletes original commented bc, leaving ad unmarked (gc=true)",
  "T11: reload deletes original commented bc, leaving ad unmarked (gc=true)",
  "T11: live deletes original commented bc, leaving ad unmarked (gc=false)",
  "T11: late joiner deletes original commented bc, leaving ad unmarked (gc=false)",
  "T11: reload deletes original commented bc, leaving ad unmarked (gc=false)",
  "monitor negative control rejects native formatting items"
]);

export function formattingLibraryControl(name: string): string {
  if (!formattingLibraryControls.includes(name)) throw new Error("Unlisted native-formatting library control: " + name);
  return "library control: " + name;
}
