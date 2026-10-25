export type MenuCommandRunner = (command: string) => boolean;

let menuCommandRunner: MenuCommandRunner | null = null;

export function runMenuCommandsWith(runner: MenuCommandRunner): () => void {
  menuCommandRunner = runner;
  return function () {
    if (menuCommandRunner === runner) menuCommandRunner = null;
  };
}

export function runMenuCommand(command: string): boolean {
  return !!menuCommandRunner && menuCommandRunner(command);
}
