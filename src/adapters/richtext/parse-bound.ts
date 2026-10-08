const FORMATTING_START = /<(a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)(?=[\t\n\f\r />])/iy;

const UNKEPT_NAME = /^(?:big|code|font|nobr|small|tt)$/i;

const STYLED_NAME = /^(?:b|strong)$/i;

const UNKEPT_END = /<\/(?:big|code|font|nobr|small|tt)(?=[\t\n\f\r />])/gi;

const REOPENABLE_TAG = /<\/?(?:b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)(?=[\t\n\f\r />])/gi;

const SAME_TAG_ENTRIES = 3;

const REOPENS_PER_TAG = 2;

const REOPENED_PER_INPUT_UNIT = 8;

const FREE_REOPENED = 4096;

const PARSED_UNITS_PER_INPUT_UNIT = 8;

const FREE_PARSED_UNITS = 4096;

const NAME = 0;
const BEFORE_NAME = 1;
const ATTR_NAME = 2;
const AFTER_NAME = 3;
const BEFORE_VALUE = 4;
const DOUBLE_QUOTED = 5;
const SINGLE_QUOTED = 6;
const UNQUOTED = 7;
const AFTER_QUOTED = 8;
const SELF_CLOSING = 9;

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function startOfAttribute(c: number): number {
  if (isSpace(c)) return BEFORE_NAME;
  if (c === 47) return SELF_CLOSING;
  return ATTR_NAME;
}

function inAttributeName(c: number, otherwise: number): number {
  if (isSpace(c)) return otherwise;
  if (c === 47) return SELF_CLOSING;
  if (c === 61) return BEFORE_VALUE;
  return ATTR_NAME;
}

function step(state: number, c: number): number {
  switch (state) {
    case NAME: return isSpace(c) ? BEFORE_NAME : c === 47 ? SELF_CLOSING : NAME;
    case ATTR_NAME: return inAttributeName(c, AFTER_NAME);
    case AFTER_NAME: return inAttributeName(c, AFTER_NAME);
    case BEFORE_VALUE: return isSpace(c) ? BEFORE_VALUE : c === 34 ? DOUBLE_QUOTED : c === 39 ? SINGLE_QUOTED : UNQUOTED;
    case DOUBLE_QUOTED: return c === 34 ? AFTER_QUOTED : DOUBLE_QUOTED;
    case SINGLE_QUOTED: return c === 39 ? AFTER_QUOTED : SINGLE_QUOTED;
    case UNQUOTED: return isSpace(c) ? BEFORE_NAME : UNQUOTED;
    default: return startOfAttribute(c);
  }
}

type Attribute = [start: number, nameEnd: number, end: number];

function attributesOf(tag: string): Attribute[] {
  const found: Attribute[] = [];
  const last = tag.length - 1;
  let state = NAME;
  for (let i = 1; i <= last; i++) {
    const next = i === last ? -1 : step(state, tag.charCodeAt(i));
    const current = found[found.length - 1] as Attribute;
    if (next === ATTR_NAME && state !== ATTR_NAME) found.push([i, -1, -1]);
    else if (state === ATTR_NAME && next !== ATTR_NAME) { current[1] = i; current[2] = i; }
    else if (state === UNQUOTED && next !== UNQUOTED) current[2] = i;
    else if ((state === DOUBLE_QUOTED || state === SINGLE_QUOTED) && next === AFTER_QUOTED) current[2] = i + 1;
    else if (state === BEFORE_VALUE && next === -1) current[2] = i;
    state = next;
  }
  return found;
}

interface Formatting {
  readonly at: number;
  readonly name: string;
  readonly tag: string | null;
}

interface Scan {
  readonly tags: number;
  readonly link: boolean;
  readonly found: readonly Formatting[];
}

function endsAtLastChar(tag: string): boolean {
  let state = NAME;
  for (let i = 1; i < tag.length - 1; i++) state = step(state, tag.charCodeAt(i));
  return state !== DOUBLE_QUOTED && state !== SINGLE_QUOTED;
}

function scan(html: string): Scan {
  const found: Formatting[] = [];
  let tags = 0;
  let link = false;
  let end = -1;
  for (let at = html.indexOf("<"); at >= 0;) {
    tags++;
    const next = html.indexOf("<", at + 1);
    FORMATTING_START.lastIndex = at;
    const name = FORMATTING_START.exec(html);
    if (name) {
      const tagName = name[1] as string;
      if (tagName === "a" || tagName === "A") link = true;
      else {
        if (end < at) {
          const close = html.indexOf(">", at);
          end = close < 0 ? Infinity : close;
        }
        const tag = end < html.length && (next < 0 || end < next) ? html.slice(at, end + 1) : null;
        found.push({ at: at, name: tagName, tag: tag !== null && endsAtLastChar(tag) ? tag : null });
      }
    }
    at = next;
  }
  return { tags: tags, link: link, found: found };
}

function entriesOf(keys: readonly (string | null)[], link: boolean): number {
  const counts = new Map<string, number>();
  let entries = link ? 1 : 0;
  keys.forEach(function (key) {
    if (key === null) entries++;
    else counts.set(key, (counts.get(key) || 0) + 1);
  });
  counts.forEach(function (count) { entries += Math.min(SAME_TAG_ENTRIES, count); });
  return entries;
}

function plainTag(name: string, tag: string): string {
  const lower = name.toLowerCase();
  if (!STYLED_NAME.test(name)) return "<" + lower + ">";
  const style = attributesOf(tag).find(function (a) { return /^style$/i.test(tag.slice(a[0], a[1])); });
  return style ? "<" + lower + " " + tag.slice(style[0], style[2]) + ">" : "<" + lower + ">";
}

function rewritten(html: string, found: readonly Formatting[], plain: readonly (string | null)[]): string {
  let out = "";
  let pos = 0;
  found.forEach(function (f, i) {
    const replacement = plain[i];
    out += html.slice(pos, f.at);
    if (replacement == null) {
      pos = f.at + 1 + f.name.length;
      out += html.slice(f.at, pos) + "-";
    } else {
      out += replacement;
      pos = f.at + (f.tag as string).length;
    }
  });
  return out + html.slice(pos);
}

function reopenLimit(inputLength: number): number {
  return REOPENED_PER_INPUT_UNIT * inputLength + FREE_REOPENED;
}

export function boundedMarkup(html: string): string {
  const limit = reopenLimit(html.length);
  const seen = scan(html);
  const reopens = REOPENS_PER_TAG * (seen.tags + 1);
  if (entriesOf(seen.found.map(function (f) { return f.tag; }), seen.link) * reopens <= limit) return html;
  const plain = seen.found.map(function (f) { return f.tag !== null && !UNKEPT_NAME.test(f.name) ? plainTag(f.name, f.tag) : null; });
  const kept = plain.filter(function (p): p is string { return p !== null; });
  if (entriesOf(kept, seen.link) * reopens <= limit) return rewritten(html, seen.found, plain).replace(UNKEPT_END, "$&-");
  return html.replace(REOPENABLE_TAG, "$&-");
}

function parsedLimit(inputLength: number): number {
  return PARSED_UNITS_PER_INPUT_UNIT * inputLength + FREE_PARSED_UNITS;
}

function shellSize(el: Element): number {
  let n = 2 * el.localName.length + 5;
  if (!el.hasAttributes()) return n;
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i] as Attr;
    n += a.name.length + a.value.length + 4;
  }
  return n;
}

function isTemplate(el: Element): el is HTMLTemplateElement {
  return el.localName === "template" && "content" in el;
}

const MEASURED = 0x1 | 0x4 | 0x80;

function parsedPast(root: Node, limit: number): boolean {
  const roots: Node[] = [root];
  let size = 0;
  while (roots.length) {
    const top = roots.pop() as Node;
    const walker = (top.ownerDocument as Document).createTreeWalker(top, MEASURED);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1) {
        const el = node as Element;
        size += shellSize(el);
        if (isTemplate(el)) roots.push(el.content);
      } else {
        size += (node as CharacterData).length;
      }
      if (size > limit) return true;
    }
  }
  return false;
}

function isBlock(node: Node): boolean {
  const tag = (node as Element).tagName;
  return node.nodeType === 1 && (tag === "DIV" || tag === "P");
}

function isBlankBlock(node: Node): boolean {
  const first = node.firstChild;
  return node.childNodes.length === 1 && !!first && first.nodeType === 1 && (first as Element).tagName === "BR";
}

function flattenBody(body: HTMLElement): void {
  const doc = body.ownerDocument;
  const kept: Node[] = [];
  const lineBreak = function (): void { kept.push(doc.createElement("br")); };
  let node: Node | null = body.firstChild;
  while (node) {
    let enter = false;
    if (node.nodeType === 3) kept.push(doc.createTextNode((node as Text).data));
    else if (node.nodeType === 1) {
      if ((node as Element).tagName === "BR") lineBreak();
      else if (isBlock(node) && isBlankBlock(node)) lineBreak();
      else enter = !!node.firstChild || isBlock(node);
    }
    if (enter && node.firstChild) { node = node.firstChild; continue; }
    if (enter) lineBreak();
    while (node && node !== body && !node.nextSibling) {
      node = node.parentNode;
      if (node && node !== body && isBlock(node)) lineBreak();
    }
    node = node && node !== body ? node.nextSibling : null;
  }
  body.textContent = "";
  kept.forEach(function (n) { body.appendChild(n); });
}

export function boundedBody(body: HTMLElement, inputLength: number): HTMLElement {
  if (parsedPast(body, parsedLimit(inputLength))) flattenBody(body);
  return body;
}
