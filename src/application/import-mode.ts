let touched = false;

export const importModeTouched = (): boolean => touched;
export const touchImportMode = (): void => { touched = true; };
export const resetImportMode = (): void => { touched = false; };
