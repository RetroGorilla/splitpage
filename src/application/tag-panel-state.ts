export interface TagPanelState {
  readonly tagRenamingKey: () => string | null;
  readonly setTagRenaming: (key: string | null) => void;
  readonly tagExpandedKey: () => string | null;
  readonly setTagExpanded: (key: string | null) => void;
  readonly tagAddingPersonKey: () => string | null;
  readonly setTagAddingPerson: (key: string | null) => void;
  readonly productionGroupBy: () => string;
  readonly setProductionGroupBy: (group: string) => void;
  readonly gearGroupBy: () => string;
  readonly setGearGroupBy: (group: string) => void;
  readonly resetTagPanel: () => void;
}

export function createTagPanelState(): TagPanelState {
  let renaming: string | null = null;
  let expanded: string | null = null;
  let addingPersonFor: string | null = null;
  let productionGroup: string = "cat";
  let gearGroup: string = "flat";
  return Object.freeze({
    tagRenamingKey: (): string | null => renaming,
    setTagRenaming: (key: string | null): void => { renaming = key; },
    tagExpandedKey: (): string | null => expanded,
    setTagExpanded: (key: string | null): void => { expanded = key; },
    tagAddingPersonKey: (): string | null => addingPersonFor,
    setTagAddingPerson: (key: string | null): void => { addingPersonFor = key; },
    productionGroupBy: (): string => productionGroup,
    setProductionGroupBy: (group: string): void => { productionGroup = group; },
    gearGroupBy: (): string => gearGroup,
    setGearGroupBy: (group: string): void => { gearGroup = group; },
    resetTagPanel: (): void => {
      renaming = null;
      expanded = null;
      addingPersonFor = null;
      productionGroup = "cat";
    }
  });
}
