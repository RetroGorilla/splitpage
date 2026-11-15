export const PART_SEAMS = Object.freeze({
  validation: Object.freeze(["trial"]),
  apply: Object.freeze(["live-apply"]),
  projection: Object.freeze(["mirror-apply", "assembly", "projection-listeners", "session-receive", "document-entry"]),
  rendering: Object.freeze(["render"]),
  input: Object.freeze(["input-handler", "input-command", "input-write"])
});

const MARK = /^measure:([a-z-]+):(start|end)$/;

export function markParts(entries) {
  const stack = [], exclusive = {};
  let outer = 0;
  for (const { name, startTime } of entries) {
    const mark = MARK.exec(name);
    if (!mark) continue;
    const [, seam, edge] = mark;
    if (edge === "start") { stack.push({ seam, start: startTime, nested: 0 }); continue; }
    const span = stack.pop();
    if (!span || span.seam !== seam) throw new Error("Unpaired timing mark: " + name);
    const duration = startTime - span.start;
    exclusive[seam] = (exclusive[seam] ?? 0) + duration - span.nested;
    const parent = stack.at(-1);
    if (parent) parent.nested += duration; else outer += duration;
  }
  const open = stack.at(-1);
  if (open) throw new Error("Unclosed timing mark: " + open.seam);
  const unknown = Object.keys(exclusive).filter(seam => !Object.values(PART_SEAMS).some(seams => seams.includes(seam)));
  if (unknown.length) throw new Error("Timing marks outside every part: " + unknown.join(", "));
  const parts = Object.fromEntries(Object.entries(PART_SEAMS).map(([part, seams]) => [part, seams.reduce((sum, seam) => sum + (exclusive[seam] ?? 0), 0)]));
  return { ...parts, exclusive, outer };
}
