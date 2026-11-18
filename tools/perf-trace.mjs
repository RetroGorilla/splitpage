import { markParts } from "../tests/collab/measure/mark-parts.mjs";

export const TRACE_CATEGORIES = Object.freeze(["devtools.timeline", "blink.user_timing", "toplevel", "v8.execute"]);
export const SCRIPT_RECORDS = Object.freeze(["EventDispatch", "FunctionCall", "RunMicrotasks", "EvaluateScript", "TimerFire", "FireAnimationFrame", "FireIdleCallback"]);
export const TASK_RECORD = "ThreadControllerImpl::RunTask";
export const RENDER_RECORDS = Object.freeze({ style: Object.freeze(["UpdateLayoutTree"]), layout: Object.freeze(["Layout"]), paint: Object.freeze(["PrePaint", "Paint"]) });
const KEY_EVENTS = new Set(["keydown", "keypress", "keyup", "beforeinput", "input", "textInput"]);
const PARTS = ["validation", "apply", "projection", "rendering", "input"];
const OWN_FIGURES = [["rebuild", "rebuild"], ["route", "input-handler"], ["plan", "input-command"], ["write", "input-write"]];

const ms = (us) => us / 1000;
const round = (value) => Math.round(value * 1000) / 1000;
const end = (event) => event.ts + (event.dur ?? 0);
const within = (inner, outer) => outer.ts <= inner.ts && end(inner) <= end(outer);
const isMark = (event) => typeof event.cat === "string" && event.cat.split(",").includes("blink.user_timing") && event.name.startsWith("measure:");

function outermost(records) {
  const kept = [];
  for (const record of [...records].sort((a, b) => a.ts - b.ts || end(b) - end(a))) {
    const last = kept.at(-1);
    if (!last || !within(record, last)) kept.push(record);
  }
  return kept;
}

function spanEntries(spans, marks) {
  const entries = [
    ...spans.flatMap((span) => [{ name: "measure:event:start", time: span.ts, order: 0, index: 0 }, { name: "measure:event:end", time: end(span), order: 2, index: 0 }]),
    ...marks.map((mark, index) => ({ name: mark.name, time: mark.ts, order: 1, index }))
  ];
  entries.sort((a, b) => a.time - b.time || a.order - b.order || a.index - b.index);
  return entries.map((entry) => ({ name: entry.name, startTime: ms(entry.time) }));
}

function figures(parts) {
  return {
    ...Object.fromEntries(PARTS.map((part) => [part, round(parts[part])])),
    ...Object.fromEntries(OWN_FIGURES.map(([figure, seam]) => [figure, round(parts.exclusive[seam] ?? 0)])),
    unattributed: round(parts.unattributed), outer: round(parts.outer)
  };
}

export function traceRecords(events) {
  const first = events.find(isMark);
  if (!first) throw new Error("The trace holds no measure: mark");
  const main = events.filter((event) => event.pid === first.pid && event.tid === first.tid);
  const complete = main.filter((event) => event.ph === "X");
  const marks = main.filter(isMark).sort((a, b) => a.ts - b.ts);
  const tasks = outermost(complete.filter((event) => event.name === TASK_RECORD));
  const keyDispatches = outermost(complete.filter((event) => event.name === "EventDispatch")).filter((event) => KEY_EVENTS.has(event.args?.data?.type));
  const keydowns = keyDispatches.filter((event) => event.args.data.type === "keydown");
  const taskOf = (event) => tasks.find((task) => within(event, task)) ?? null;
  const scriptIn = (task) => outermost(complete.filter((event) => SCRIPT_RECORDS.includes(event.name) && within(event, task)));
  const measured = new Set([...marks, ...keyDispatches].map(taskOf));
  if (measured.has(null)) throw new Error("A timing mark or key event lies outside every task record");
  const scripted = (mark) => scriptIn(taskOf(mark)).some((span) => span.ts <= mark.ts && mark.ts <= end(span));
  if (!marks.every(scripted)) throw new Error("A timing mark lies outside every script record");
  if (keyDispatches.some((event) => !keydowns.length || event.ts < keydowns[0].ts)) throw new Error("A key event lies before the first keydown");
  const render = (from, to) => Object.fromEntries(Object.entries(RENDER_RECORDS).map(([figure, names]) => [figure,
    round(ms(complete.filter((event) => names.includes(event.name) && event.ts >= from && event.ts < to).reduce((sum, event) => sum + event.dur, 0)))]));
  const keys = keydowns.map((keydown, index) => {
    const next = keydowns[index + 1]?.ts ?? Infinity;
    const own = [...new Set(keyDispatches.filter((event) => event.ts >= keydown.ts && event.ts < next).map(taskOf))].sort((a, b) => a.ts - b.ts);
    const spans = own.flatMap(scriptIn), inside = marks.filter((mark) => own.some((task) => task.ts <= mark.ts && mark.ts <= end(task)));
    return { at: round(ms(keydown.ts - keydowns[0].ts)), tasks: own.length, script: round(ms(spans.reduce((sum, span) => sum + span.dur, 0))),
      ...figures(markParts(spanEntries(spans, inside))), ...render(keydown.ts, next) };
  });
  const whole = markParts(spanEntries([...measured].sort((a, b) => a.ts - b.ts).flatMap(scriptIn), marks));
  return { keys, groups: { ...figures(whole), ...render(-Infinity, Infinity) } };
}
