import { FORMAT_MARKS, tagStack } from "../../../../src/core/text/runs.ts";
import type { Run } from "../../../../src/core/text/runs.ts";
import type { TagName } from "../../../../src/core/document/tags.ts";

function text(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;");
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\u00a0/g, "&nbsp;");
}

interface ProjectionWrapper { identity: string; start: string; end: string }

export function storedRunsToHtml(runs: readonly Run[], tagOf: (id: string) => TagName | null): string {
  const formats = { hl: "mark", b: "strong", i: "em", u: "u", s: "s" };
  let open: ProjectionWrapper[] = [];
  let html = "";
  for (const run of runs) {
    const keys: ProjectionWrapper[] = [];
    function span(identity: string, attrs: string): void {
      keys.push({ identity, start: `<span ${attrs}>`, end: "</span>" });
    }
    if (!run.atom && run.marks.cue) span("cue", 'class="audio-cue"');
    for (const id of run.marks.cmt ?? []) span(`cmt:${id}`, `class="cmt-anchor" data-cmt="${attribute(id)}"`);
    if (!run.atom && run.marks.dir) span("dir", 'class="stage-dir"');
    if (run.marks.href) keys.push({ identity: `href:${run.marks.href}`,
      start: `<a href="${attribute(run.marks.href)}" target="_blank" rel="noopener">`, end: "</a>" });
    if (!run.atom) for (const id of tagStack(run.marks)) {
      const tag = tagOf(id);
      if (tag) span(`tag:${id}`, `class="tag-anchor" data-tag-cat="${attribute(tag.cat)}" data-tag-name="${attribute(tag.name)}" contenteditable="false"`);
    }
    for (const mark of FORMAT_MARKS) if (run.marks[mark]) keys.push({ identity: mark, start: `<${formats[mark]}>`, end: `</${formats[mark]}>` });
    let common = 0;
    while (common < open.length && common < keys.length && open[common]?.identity === keys[common]?.identity) common++;
    html += open.slice(common).reverse().map(key => key.end).join("");
    html += keys.slice(common).map(key => key.start).join("");
    open = keys;
    if (!run.atom) html += text(run.text).replace(/\n/g, "<br>");
    else if (run.atom === "who") html += `<span class="who-anchor" data-who="${attribute(run.name)}" contenteditable="false">${text(run.text)}</span>`;
    else if (run.atom === "broll") html += `<span class="broll-key" data-broll-id="${attribute(run.id)}" contenteditable="false">${text(run.text)}</span>`;
    else throw new Error(`Unsupported projection atom: ${run.atom}`);
  }
  return html + open.reverse().map(key => key.end).join("");
}
