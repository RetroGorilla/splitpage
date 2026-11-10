export function eventHistory(record?: (line: string) => void): string[] {
  const history: string[] = [];
  const append = history.push.bind(history);
  history.push = (...lines: string[]): number => {
    for (const line of lines) record?.(line);
    return append(...lines);
  };
  return history;
}
