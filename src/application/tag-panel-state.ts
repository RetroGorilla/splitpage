let renaming: string | null = null;
let expanded: string | null = null;
let addingPersonFor: string | null = null;
let productionGroup: string = "cat";
let gearGroup: string = "flat";

export const tagRenamingKey = (): string | null => renaming;
export const setTagRenaming = (key: string | null): void => { renaming = key; };
export const tagExpandedKey = (): string | null => expanded;
export const setTagExpanded = (key: string | null): void => { expanded = key; };
export const tagAddingPersonKey = (): string | null => addingPersonFor;
export const setTagAddingPerson = (key: string | null): void => { addingPersonFor = key; };
export const productionGroupBy = (): string => productionGroup;
export const setProductionGroupBy = (group: string): void => { productionGroup = group; };
export const gearGroupBy = (): string => gearGroup;
export const setGearGroupBy = (group: string): void => { gearGroup = group; };

export function resetTagPanel(): void {
  renaming = null;
  expanded = null;
  addingPersonFor = null;
  productionGroup = "cat";
}
