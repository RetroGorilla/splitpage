import { escapeHtml } from "../../core/document/text-policy.ts";

const LINK_POPOVER_HTML =
  '<div class="link-popover" hidden>' +
    '<input type="url" aria-label="Link address" placeholder="https://example.com" data-role="link-input">' +
    '<button type="button" data-action="link-confirm">Add</button>' +
    '<button type="button" data-action="link-cancel">Cancel</button>' +
  '</div>';

function tbIcon(id: string) { return '<svg class="tb-icon" aria-hidden="true"><use href="#' + id + '"/></svg>'; }

const COMMENT_BUTTON_HTML = '<button type="button" data-cmd="comment" title="Comment on selected text" aria-label="Comment">' + tbIcon("i-comment") + '</button>';

const SCRIPT_TOOLBAR_BUTTONS =
  '<button type="button" data-cmd="bold" title="Bold (Ctrl+B)" aria-label="Bold"><span class="tb-letter tb-b">B</span></button>' +
  '<button type="button" data-cmd="italic" title="Italic (Ctrl+I)" aria-label="Italic"><span class="tb-letter tb-i">I</span></button>' +
  '<button type="button" data-cmd="underline" title="Underline (Ctrl+U)" aria-label="Underline"><span class="tb-letter tb-u">U</span></button>' +
  '<button type="button" data-cmd="strikeThrough" title="Strikethrough" aria-label="Strikethrough"><span class="tb-letter tb-s">S</span></button>' +
  '<span class="tb-sep"></span>' +
  '<button type="button" data-cmd="highlight" title="Highlight" aria-label="Highlight">' + tbIcon("i-highlight") + '</button>' +
  '<button type="button" data-cmd="link" title="Add link" aria-label="Link">' + tbIcon("i-link") + '</button>' +
  COMMENT_BUTTON_HTML +
  '<span class="tb-sep"></span>' +
  '<button type="button" data-cmd="tag" class="tb-tag" title="Label as a prop, location, cast member or effect" aria-label="Tag as…">' +
    tbIcon("i-tag") + '<svg class="tb-chevron" aria-hidden="true"><use href="#i-chevron-down"/></svg></button>';

export const DIRECTION_BUTTON_TITLE = "Stage direction — shown in the teleprompter, not read aloud. Or type ((…))";
const DIRECTION_BUTTON_HTML = '<button type="button" data-cmd="direction" title="' + DIRECTION_BUTTON_TITLE +
  '" aria-label="Stage direction"><span class="tb-letter tb-dir">( )</span></button>';

const CELL_TOOLBARS: Record<string, { label: string; buttons: string } | undefined> = {
  script: { label: "Text formatting", buttons: SCRIPT_TOOLBAR_BUTTONS },
  scriptAudio: { label: "Text formatting", buttons: SCRIPT_TOOLBAR_BUTTONS + DIRECTION_BUTTON_HTML },
  reply: {
    label: "Reply formatting",
    buttons:
      '<button type="button" data-cmd="bold" title="Bold">B</button>' +
      '<button type="button" data-cmd="italic" title="Italic"><i>I</i></button>' +
      '<button type="button" data-cmd="underline" title="Underline"><u>U</u></button>' +
      '<button type="button" data-cmd="link" title="Add link">Link</button>'
  }
};

interface EditableCellOptions {
  className?: string;
  readOnly?: boolean;
  rowId?: string | number | null;
  field?: string;
  placeholder?: string;
  value?: string | null | undefined;
  toolbar?: string;
  wrapStyle?: string;
}

export function editableCellHtml(o: EditableCellOptions) {
  const cell =
    '<div class="' + (o.className ? o.className + ' ' : '') + 'cell-editable" contenteditable="' +
      (o.readOnly ? 'false" tabindex="0' : 'true') + '"' +
      (o.rowId != null ? ' data-id="' + escapeHtml(o.rowId) + '" data-field="' + escapeHtml(o.field) + '"' : '') +
      ' data-placeholder="' + escapeHtml(o.placeholder || "") + '">' + (o.value || "") +
    '</div>';
  const toolbar = o.toolbar ? CELL_TOOLBARS[o.toolbar] : null;
  if (!toolbar) return cell;
  return (
    '<div class="field-wrap"' + (o.wrapStyle ? ' style="' + o.wrapStyle + '"' : '') + '>' +
      '<div class="mini-toolbar" role="toolbar" aria-label="' + toolbar.label + '">' + toolbar.buttons + '</div>' +
      cell +
      LINK_POPOVER_HTML +
    '</div>'
  );
}
