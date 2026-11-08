import type { TagPanelPorts } from "./ports.ts";
import type { PresentedProductionEntry } from "../../core/production/index.ts";
import { escapeHtml, safeHref } from "../../core/document/text-policy.ts";
import { projection } from "../../core/text/runs.ts";
import { TAG_STATUSES } from "../../core/production/looks.ts";
import { tagStatusLampHtml } from "../common/tag-status.ts";

type PrepDetailHtml = (item: PresentedProductionEntry, id: string) => string;

function button(action: string, id: string, label: string, attrs = ""): string {
  return (
    '<button type="button" data-prep="' +
    action +
    '" data-id="' +
    escapeHtml(id) +
    '" ' +
    attrs +
    ">" +
    label +
    "</button>"
  );
}

export function prepContext(container: string, key: string): string {
  return JSON.stringify([container, key]);
}

export function prepSceneKey(id: string | null): string {
  return id === null ? "automatic" : "scene:" + id;
}

export function renderProductionOutline(
  ports: TagPanelPorts,
  entries: readonly PresentedProductionEntry[],
  detail: PrepDetailHtml,
): string {
  const doc = ports.document.current();
  if (!doc) return "";
  const numbering = ports.document.numbering();
  const focused = ports.focus.lastRow();
  const initial =
    numbering.beats[focused ?? ""] ??
    numbering.beats[doc.rows.find((row) => row.status !== "shot")?.id ?? doc.rows[0]?.id ?? ""];
  const initialKey = initial ? prepSceneKey(initial.scene.id) : null;
  const initialRow = initial ? (doc.rows[initial.scene.start + initial.number - 1]?.id ?? null) : null;
  const initialPosition = initial
    ? doc.rows
        .slice(initial.scene.start, initial.scene.end)
        .filter((row) => row.status !== "shot" || row.id === initialRow)
        .findIndex((row) => row.id === initialRow)
    : 0;
  ports.view.prep().initialize(ports.lifetime.epoch(), initialKey, initialRow, initialPosition,
    entries.filter(item => item.status === "have").map(item => item.key));
  const state = ports.view.prep().current();
  const byRow = new Map<string, Map<string, PresentedProductionEntry>>();
  entries.forEach((item) =>
    item.mentions.forEach((mention) => {
      const items = byRow.get(mention.rowId) ?? new Map<string, PresentedProductionEntry>();
      items.set(item.key, item);
      byRow.set(mention.rowId, items);
    }),
  );
  function resources(items: readonly PresentedProductionEntry[], container: string): string {
    if (!items.length) return '<p class="prep-empty">No requirements tagged here.</p>';
    const ready = items.filter(item => state.initialReady.has(item.key) && item.status === "have");
    const active = items.filter(item => !state.initialReady.has(item.key) || item.status !== "have");
    const open = state.ready.has(container);
    return (active.length ? resourceRows(active, container) : '') + (ready.length ?
      button('ready-fold', container, (open ? '⌄ ' : '› ') + ready.length + (ready.length === 1 ? ' item ready' : ' items ready'),
        'class="prep-ready-fold" aria-expanded="' + open + '"') + (open ? resourceRows(ready, container) : '') : '');
  }
  function resourceRows(items: readonly PresentedProductionEntry[], container: string): string {
    return (
      '<div class="prep-resource-labels prep-resource-grid" aria-hidden="true"><span></span><span>Requirements</span><span>Status</span><span>Owner</span></div><ul class="prep-resources">' +
      items
        .map((item) => {
          const key = escapeHtml(item.key);
          const context = prepContext(container, item.key);
          const open = state.notes === context;
          const owner = doc?.people?.find((person) => person.id === item.owner);
          const url = item.notes.match(/https?:\/\/[^\s<>"']+/i)?.[0];
          const reference = url && safeHref(url);
          const selected = ports.selection.selected(item.key);
          return (
            '<li class="tag-entity prep-resource' +
            (selected ? " is-selected" : "") +
            '" data-key="' +
            key +
            '" data-prep-context="' +
            escapeHtml(context) +
            '">' +
            '<div class="prep-resource-grid tag-entity-row">' +
            (state.selecting
              ? button(
                  "select",
                  item.key,
                  selected ? "✓" : "",
                  'class="prep-check" aria-label="Select ' +
                    escapeHtml(item.name) +
                    '" aria-pressed="' +
                    selected +
                    '"',
                )
              : button(
                  "ready",
                  item.key,
                  tagStatusLampHtml(item.status),
                  'class="prep-ready" aria-label="Mark ' +
                    escapeHtml(item.name) +
                    ' as Have it"' +
                    (item.status === "have" ? " disabled" : ""),
                )) +
            '<span class="prep-resource-name">' +
            button(
              "notes",
              context,
              escapeHtml(item.name) +
                (item.notes ? '<span class="prep-note-mark" aria-label="Has notes"> ·</span>' : ""),
              'aria-expanded="' + open + '"',
            ) +
            (reference
              ? '<a class="prep-reference" href="' +
                escapeHtml(reference) +
                '" target="_blank" rel="noopener noreferrer" aria-label="Open reference for ' +
                escapeHtml(item.name) +
                '">↗</a>'
              : "") +
            "</span>" +
            '<span class="prep-status is-' +
            escapeHtml(item.status) +
            '">' +
            tagStatusLampHtml(item.status) +
            '<select class="prep-status-select" data-key="' +
            key +
            '" aria-label="Status of ' +
            escapeHtml(item.name) +
            '">' +
            TAG_STATUSES.map(
              (status) =>
                '<option value="' +
                status.id +
                '"' +
                (status.id === item.status ? " selected" : "") +
                ">" +
                escapeHtml(status.label) +
                "</option>",
            ).join("") +
            "</select></span>" +
            '<span class="prep-owner" data-initial="' +
            escapeHtml(owner?.name.slice(0, 1).toUpperCase() ?? "+") +
            '"><select class="tag-owner-select" data-key="' +
            key +
            '" aria-label="Owner of ' +
            escapeHtml(item.name) +
            '"><option value="">Assign</option>' +
            (doc?.people ?? [])
              .map(
                (person) =>
                  '<option value="' +
                  escapeHtml(person.id) +
                  '"' +
                  (person.id === item.owner ? " selected" : "") +
                  ">" +
                  escapeHtml(person.name) +
                  "</option>",
              )
              .join("") +
            "</select></span></div>" +
            (open
              ? '<div class="prep-resource-detail">' +
                detail(item, "prep-detail-" + encodeURIComponent(context)) +
                "</div>"
              : "") +
            "</li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }
  const filmed = doc.rows.filter((row) => row.status === "shot").length;
  const expandedScene = numbering.beats[state.beat ?? ""]?.scene;
  const shots = state.beat && expandedScene && state.scenes.has(prepSceneKey(expandedScene.id))
    ? ports.footage.entries().filter((shot) => shot.rowId === state.beat && !shot.orphaned)
    : [];
  const summary =
    '<div class="prep-overview"><span>' +
    numbering.scenes.length +
    " scene" +
    (numbering.scenes.length === 1 ? "" : "s") +
    " · " +
    doc.rows.length +
    " beats</span><span>" +
    filmed +
    "/" +
    doc.rows.length +
    " filmed</span></div>";
  return (
    '<div class="production-outline">' +
    summary +
    '<div class="prep-tools"><span>Script outline</span>' +
    button(
      "selection",
      "",
      state.selecting ? "Done selecting" : "Select items",
      'class="btn-outline is-small" aria-pressed="' + state.selecting + '"',
    ) +
    "</div>" +
    (numbering.scenes.length
      ? numbering.scenes
          .map((scene) => {
            const id = prepSceneKey(scene.id);
            const rows = doc.rows.slice(scene.start, scene.end);
            const requirements = new Map<string, PresentedProductionEntry>();
            rows.forEach((row) => byRow.get(row.id)?.forEach((item, key) => requirements.set(key, item)));
            const items = [...requirements.values()];
            const needed = items.filter(
              (item) => item.status !== "have" && item.status !== "returned",
            ).length;
            const completed = rows.filter((row) => row.status === "shot");
            const open = state.scenes.has(id);
            const showFilmed = state.filmed.has(id);
            const beats = rows.filter((row) => row.status !== "shot" || showFilmed || row.id === state.beat);
            const shown = state.shown.get(id) ?? 8;
            const focusedIndex = beats.findIndex((row) => row.id === state.beat);
            const offset = Math.min(
              state.offsets.get(id) ?? 0,
              Math.max(0, focusedIndex >= 0 ? focusedIndex : beats.length - 1),
            );
            const visible = beats.slice(offset, offset + shown);
            const remaining = Math.max(0, beats.length - offset - visible.length);
            return (
              '<section class="prep-scene' +
              (open ? " is-open" : "") +
              '">' +
              button(
                "scene",
                id,
                '<span class="prep-chevron" aria-hidden="true">' +
                  (open ? "⌄" : "›") +
                  '</span><span class="prep-letter">' +
                  scene.letter +
                  '</span><span class="prep-scene-name">' +
                  escapeHtml(scene.name || "Scene " + scene.letter) +
                  '</span><span class="prep-scene-counts"><span>' +
                  completed.length +
                  "/" +
                  rows.length +
                  " filmed</span><span>" +
                  needed +
                  " to prep</span></span>",
                'class="prep-scene-head" aria-expanded="' + open + '"',
              ) +
              (open
                ? '<div class="prep-scene-body">' +
                  button(
                    "requirements",
                    id,
                    "Scene requirements · " +
                      items.length +
                      (items.length === 1 ? ' item' : ' items') + ' <span aria-hidden="true">' +
                      (state.requirements.has(id) ? "⌄" : "›") +
                      "</span>",
                    'class="prep-requirements-toggle" aria-expanded="' + state.requirements.has(id) + '"',
                  ) +
                  (state.requirements.has(id) ? resources(items, "scene:" + id) : "") +
                  '<div class="prep-list-head"><strong>Beats</strong><span>Filmed</span></div>' +
                  (completed.length
                    ? button(
                        "filmed",
                        id,
                        (showFilmed ? "Hide" : "Show") + " " + completed.length + " filmed",
                        'class="prep-filmed-fold" aria-pressed="' + showFilmed + '"',
                      )
                    : "") +
                  (offset
                    ? button(
                        "earlier",
                        id,
                        "Show " + Math.min(8, offset) + " earlier · " + offset + " earlier beats",
                        'class="prep-more"',
                      )
                    : "") +
                  visible
                    .map((row) => {
                      const expanded = state.beat === row.id;
                      const title =
                        projection(ports.text.cellOf(row.visualText)).split(/\r?\n/)[0]?.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim() ||
                        projection(ports.text.cellOf(row.audioText)).split(/\r?\n/)[0]?.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim() ||
                        "Untitled beat";
                      return (
                        '<article class="prep-beat' +
                        (expanded ? " is-open" : "") +
                        '" data-beat="' +
                        escapeHtml(row.id) +
                        '"><div class="prep-beat-head">' +
                        button(
                          "jump",
                          row.id,
                          escapeHtml(numbering.beats[row.id]?.full ?? ""),
                          'class="prep-beat-ref" aria-label="Show beat ' +
                            escapeHtml(numbering.beats[row.id]?.full ?? "") +
                            ' in script"',
                        ) +
                        button(
                          "beat",
                          row.id,
                          "<span>" +
                            escapeHtml(title.slice(0, 160)) +
                            '</span><span class="prep-chevron" aria-hidden="true">' +
                            (expanded ? "⌄" : "›") +
                            "</span>",
                          'class="prep-beat-title" aria-expanded="' + expanded + '"',
                        ) +
                        '<label class="prep-film"><input type="checkbox" class="prep-film-input" data-row="' +
                        escapeHtml(row.id) +
                        '"' +
                        (row.status === "shot" ? " checked" : "") +
                        ' aria-label="Beat ' +
                        escapeHtml(numbering.beats[row.id]?.full ?? "") +
                        ' filmed"><span class="sr-only">Filmed</span></label></div>' +
                        (expanded
                          ? '<div class="prep-beat-detail">' +
                            resources([...(byRow.get(row.id)?.values() ?? [])], "beat:" + row.id) +
                            (shots.length
                              ? '<div class="prep-footage"><span>Footage</span>' +
                                shots
                                  .map((shot) =>
                                    button(
                                      "shot",
                                      shot.id,
                                      '<span class="prep-shot-ref">' +
                                        escapeHtml(shot.shotNumber ?? "") +
                                        "</span> " +
                                        escapeHtml(shot.name),
                                      'class="prep-shot"',
                                    ),
                                  )
                                  .join("") +
                                "</div>"
                              : "") +
                            "</div>"
                          : "") +
                        "</article>"
                      );
                    })
                    .join("") +
                  (remaining
                    ? button(
                        "more",
                        id,
                        "Show " + Math.min(8, remaining) + " more <span>· " + remaining + " remaining</span>",
                        'class="prep-more"',
                      )
                    : "") +
                  (!visible.length ? '<p class="prep-empty">All beats filmed.</p>' : "") +
                  "</div>"
                : "") +
              "</section>"
            );
          })
          .join("")
      : '<p class="prep-empty">Add a beat to start planning your shoot. Tag props, locations and gear in the script to track what you need.</p>') +
    (entries.some((item) => item.orphaned)
      ? '<p class="prep-empty">Some items are not in the script. Use Category view to manage them.</p>'
      : "") +
    "</div>"
  );
}
