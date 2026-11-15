export const PART_SEAMS = Object.freeze({
  validation: Object.freeze(["trial", "rebuild"]),
  apply: Object.freeze(["live-apply", "queue"]),
  projection: Object.freeze(["mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry"]),
  rendering: Object.freeze(["render", "cell-refresh"]),
  input: Object.freeze(["input-handler", "input-command", "input-write"])
});

export const OUTER_SEAMS = Object.freeze(["event", "receive", "drain"]);

const MARK = /^measure:([a-z-]+):(start|end)$/;

export function markParts(entries) {
  const stack = [], exclusive = {};
  let outer = 0, opened = 0;
  for (const { name, startTime } of entries) {
    const mark = MARK.exec(name);
    if (!mark) continue;
    const [, seam, edge] = mark, bounding = OUTER_SEAMS.includes(seam);
    if (edge === "start") {
      if (!bounding && !opened) throw new Error("Timing mark outside every outer span: " + name);
      if (bounding) opened++;
      stack.push({ seam, start: startTime, nested: 0 });
      continue;
    }
    const span = stack.pop();
    if (!span || span.seam !== seam) throw new Error("Unpaired timing mark: " + name);
    const duration = startTime - span.start, parent = stack.at(-1);
    if (bounding) {
      opened--;
      if (!opened) outer += duration;
      if (parent) parent.nested += span.nested;
      continue;
    }
    exclusive[seam] = (exclusive[seam] ?? 0) + duration - span.nested;
    if (parent) parent.nested += duration;
  }
  const open = stack.at(-1);
  if (open) throw new Error("Unclosed timing mark: " + open.seam);
  const unknown = Object.keys(exclusive).filter(seam => !Object.values(PART_SEAMS).some(seams => seams.includes(seam)));
  if (unknown.length) throw new Error("Timing marks outside every part: " + unknown.join(", "));
  const parts = Object.fromEntries(Object.entries(PART_SEAMS).map(([part, seams]) => [part, seams.reduce((sum, seam) => sum + (exclusive[seam] ?? 0), 0)]));
  const attributed = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return { ...parts, unattributed: outer - attributed, exclusive, outer };
}
