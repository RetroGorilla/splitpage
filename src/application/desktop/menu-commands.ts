export type MenuCommandRunner = (command: string) => boolean;

let menuCommandRunner: MenuCommandRunner | null = null;

export function runMenuCommandsWith(runner: MenuCommandRunner): () => void {
  menuCommandRunner = runner;
  return function () {
    if (menuCommandRunner === runner) menuCommandRunner = null;
  };
}

export function runMenuCommand(command: string): boolean {
  if (!menuCommandRunner) throw new Error("The menu command runner is not installed yet");
  return menuCommandRunner(command);
}
