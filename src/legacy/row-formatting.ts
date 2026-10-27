interface RowFormattingHandOff {
  readonly cellFormatState: (cell: Element) => object | null;
  readonly toggleCellDirection: (cell: Element) => Element | null;
  readonly toggleCellFormat: (cell: Element, command: string) => Element | null;
}

export let cellFormatState: RowFormattingHandOff["cellFormatState"];
export let toggleCellDirection: RowFormattingHandOff["toggleCellDirection"];
export let toggleCellFormat: RowFormattingHandOff["toggleCellFormat"];

export function handRowFormattingTo(control: RowFormattingHandOff | null): void {
  cellFormatState = control?.cellFormatState as RowFormattingHandOff["cellFormatState"];
  toggleCellDirection = control?.toggleCellDirection as RowFormattingHandOff["toggleCellDirection"];
  toggleCellFormat = control?.toggleCellFormat as RowFormattingHandOff["toggleCellFormat"];
}
