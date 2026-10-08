const FORMATTING_START = /<(a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)(?=[\t\n\f\r />])/iy;

const FORMATTING_TAG = /<\/?(?:a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)(?=[\t\n\f\r />])/gi;

const FORMATTING_NAME = /^(?:a|b|big|code|em|font|i|nobr|s|small|strike|strong|tt|u)$/;

const UNKEPT_NAME = /^(?:big|code|font|nobr|small|tt)$/;

const STYLED_NAME = /^(?:b|strong)$/;

const KEPT_LINK_ATTRIBUTE = /^(?:class|href)$/;

const FOREIGN_NAME = /^(?:math|svg)$/;

const RAW_TEXT_NAME = /^(?:iframe|noembed|noframes|style|textarea|title|xmp)$/;

const RAW_TEXT_END = /<\/(iframe|noembed|noframes|style|textarea|title|xmp)[\t\n\f\r />]/iy;

const SCRIPT_TAG = /<(\/?)script[\t\n\f\r />]/iy;

const WEIGHT_PROPERTY = /font|all/i;

const CHARACTER_REFERENCE = /&(?:(quot|amp|apos|lt|gt|nbsp|#34|#39);)?/g;

const DECODED: Readonly<Record<string, string>> = {
  quot: "\"", amp: "&", apos: "'", lt: "<", gt: ">", nbsp: String.fromCharCode(0xa0), "#34": "\"", "#39": "'"
};

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

const SCRIPT_DATA = 0;
const ESCAPED = 1;
const DOUBLE_ESCAPED = 2;

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}

function isAsciiAlpha(c: number): boolean {
  const lower = c | 32;
  return lower >= 97 && lower <= 122;
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

interface Tag {
  readonly at: number;
  readonly nameEnd: number;
  readonly end: number;
  readonly attributes: readonly Attribute[];
  readonly selfClosing: boolean;
}

interface Token extends Tag {
  readonly name: string;
  readonly closing: boolean;
}

type Edit = readonly [from: number, to: number, text: string];

function readTag(html: string, at: number, from: number, stop: number): Tag | null {
  const attributes: Attribute[] = [];
  let nameEnd = -1;
  let state = NAME;
  let i = from;
  for (; i < html.length; i++) {
    if (i >= stop) return null;
    const c = html.charCodeAt(i);
    if (c === 62 && state !== DOUBLE_QUOTED && state !== SINGLE_QUOTED) break;
    const next = step(state, c);
    const current = attributes[attributes.length - 1] as Attribute;
    if (state === NAME && next !== NAME) nameEnd = i;
    if (next === ATTR_NAME && state !== ATTR_NAME) attributes.push([i, -1, -1]);
    else if (state === ATTR_NAME && next !== ATTR_NAME) { current[1] = i; current[2] = i; }
    else if (state === UNQUOTED && next !== UNQUOTED) current[2] = i;
    else if ((state === DOUBLE_QUOTED || state === SINGLE_QUOTED) && next === AFTER_QUOTED) current[2] = i + 1;
    state = next;
  }
  const last = attributes[attributes.length - 1];
  if (last && state === ATTR_NAME) { last[1] = i; last[2] = i; }
  else if (last && state === UNQUOTED) last[2] = i;
  return { at: at, nameEnd: nameEnd < 0 ? i : nameEnd, end: i, attributes: attributes, selfClosing: state === SELF_CLOSING };
}

function lowerName(html: string, from: number, to: number): string {
  return html.slice(from, to).replace(/[A-Z]+/g, function (s) { return s.toLowerCase(); });
}

interface Key {
  readonly count: number;
  readonly weight: number;
}

function reopenWork(html: string, limit: number): number {
  const keys = new Map<string, Key>();
  let link = 0;
  let tags = 0;
  let left = limit;
  for (let at = html.indexOf("<"); at >= 0; at = html.indexOf("<", at + 1)) {
    tags++;
    FORMATTING_START.lastIndex = at;
    const name = FORMATTING_START.exec(html);
    if (!name) continue;
    const tag = readTag(html, at, at + 1, at + left);
    if (!tag) return Infinity;
    left -= tag.end + 1 - at;
    const weight = 1 + tag.attributes.length;
    if (name[1] === "a" || name[1] === "A") link = Math.max(link, weight);
    else {
      const key = html.slice(at, tag.end + 1);
      const seen = keys.get(key);
      keys.set(key, { count: seen ? seen.count + 1 : 1, weight: weight });
    }
  }
  let entries = link;
  keys.forEach(function (key) { entries += Math.min(SAME_TAG_ENTRIES, key.count) * key.weight; });
  return entries * REOPENS_PER_TAG * (tags + 1);
}

function commentEnd(html: string, at: number, found: Map<string, number>): number {
  const from = at + 4;
  if (html.charCodeAt(from) === 62) return from + 1;
  if (html.startsWith("->", from)) return from + 2;
  let end = html.length;
  ["-->", "--!>"].forEach(function (close) {
    let next = found.get(close);
    if (next === undefined || (next >= 0 && next < from)) {
      next = html.indexOf(close, from);
      found.set(close, next);
    }
    if (next >= 0) end = Math.min(end, next + close.length);
  });
  return end;
}

function bogusEnd(html: string, at: number): number {
  const close = html.indexOf(">", at + 2);
  return close < 0 ? html.length : close + 1;
}

function scriptEnd(html: string, from: number): number {
  let state = SCRIPT_DATA;
  let dashes = 0;
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (c === 45) { dashes++; continue; }
    if (c === 62 && dashes >= 2) state = SCRIPT_DATA;
    dashes = 0;
    if (c !== 60) continue;
    SCRIPT_TAG.lastIndex = i;
    const tag = SCRIPT_TAG.exec(html);
    if (tag && tag[1] && state !== DOUBLE_ESCAPED) return i;
    if (tag && tag[1]) state = ESCAPED;
    else if (tag && state === ESCAPED) state = DOUBLE_ESCAPED;
    else if (state === SCRIPT_DATA && html.startsWith("<!--", i)) state = ESCAPED;
  }
  return html.length;
}

function rawTextEnd(html: string, from: number, name: string): number {
  if (name === "script") return scriptEnd(html, from);
  if (name === "plaintext") return html.length;
  if (!RAW_TEXT_NAME.test(name)) return from;
  for (let at = html.indexOf("</", from); at >= 0; at = html.indexOf("</", at + 1)) {
    RAW_TEXT_END.lastIndex = at;
    const end = RAW_TEXT_END.exec(html);
    if (end && (end[1] as string).toLowerCase() === name) return at;
  }
  return html.length;
}

function modelTags(html: string): Token[] {
  const tokens: Token[] = [];
  const found = new Map<string, number>();
  let foreign = 0;
  for (let at = html.indexOf("<"); at >= 0;) {
    const c = html.charCodeAt(at + 1);
    const closing = c === 47;
    let next = at + 1;
    if (c === 33 && html.startsWith("<!--", at)) next = commentEnd(html, at, found);
    else if (isAsciiAlpha(closing ? html.charCodeAt(at + 2) : c)) {
      const from = at + (closing ? 2 : 1);
      const tag = readTag(html, at, from, Infinity) as Tag;
      const name = lowerName(html, from, tag.nameEnd);
      next = tag.end + 1;
      if (tag.end < html.length && FORMATTING_NAME.test(name)) tokens.push({ ...tag, name: name, closing: closing });
      if (FOREIGN_NAME.test(name)) foreign = closing ? Math.max(0, foreign - 1) : foreign + (tag.selfClosing ? 0 : 1);
      else if (!closing && !foreign) next = rawTextEnd(html, next, name);
    } else if (c === 33 || c === 47 || c === 63) next = bogusEnd(html, at);
    at = html.indexOf("<", next);
  }
  return tokens;
}

function valueOf(html: string, attribute: Attribute): string {
  const text = html.slice(attribute[1], attribute[2]).replace(/^[\t\n\f\r ]*=[\t\n\f\r ]*/, "");
  const quote = text.charAt(0);
  return quote === "\"" || quote === "'" ? text.slice(1, -1) : text;
}

function stringEnd(css: string, from: number, quote: number): number {
  for (let i = from + 1; i < css.length; i++) {
    const c = css.charCodeAt(i);
    if (c === quote) return i;
    if (c === 10 || c === 12 || c === 13) return i - 1;
  }
  return css.length;
}

function declarations(css: string): string[] {
  const found: string[] = [];
  const closers: number[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css.charCodeAt(i);
    if (c === 34 || c === 39) i = stringEnd(css, i, c);
    else if (c === 47 && css.charCodeAt(i + 1) === 42) {
      const close = css.indexOf("*/", i + 2);
      i = close < 0 ? css.length : close + 1;
    } else if (c === 40) closers.push(41);
    else if (c === 91) closers.push(93);
    else if (c === 123) closers.push(125);
    else if (closers.length && c === closers[closers.length - 1]) closers.pop();
    else if (c === 59 && !closers.length) { found.push(css.slice(start, i)); start = i + 1; }
  }
  found.push(css.slice(start));
  return found;
}

function weightStyle(value: string): string | null {
  if (value.indexOf("\\") >= 0) return null;
  let unknown = false;
  const decoded = value.replace(CHARACTER_REFERENCE, function (_, name?: string) {
    if (!name) unknown = true;
    return name ? DECODED[name] as string : "&";
  });
  if (unknown) return null;
  return declarations(decoded).filter(function (d) { return WEIGHT_PROPERTY.test(d); }).join(";");
}

function attributeNamed(html: string, tag: Tag, name: string): Attribute | undefined {
  return tag.attributes.find(function (a) { return lowerName(html, a[0], a[1]) === name; });
}

function plainStart(html: string, token: Token): string {
  const style = STYLED_NAME.test(token.name) ? attributeNamed(html, token, "style") : undefined;
  if (!style) return "<" + token.name + ">";
  const kept = weightStyle(valueOf(html, style));
  if (kept === null) return "<" + token.name + " " + html.slice(style[0], style[2]) + ">";
  if (!kept) return "<" + token.name + ">";
  return "<" + token.name + " style=\"" + kept.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + "\">";
}

function linkEdit(html: string, token: Token): Edit {
  const seen = new Set<string>();
  let text = "<a";
  token.attributes.forEach(function (a) {
    const name = lowerName(html, a[0], a[1]);
    if (!KEPT_LINK_ATTRIBUTE.test(name) || seen.has(name)) return;
    seen.add(name);
    text += " " + html.slice(a[0], a[2]);
  });
  return [token.at, token.end + 1, text + ">"];
}

function renameEdit(token: Token): Edit {
  return [token.nameEnd, token.nameEnd, "-"];
}

function plainEdits(html: string, tokens: readonly Token[]): Edit[] {
  const edits: Edit[] = [];
  tokens.forEach(function (token) {
    if (UNKEPT_NAME.test(token.name)) edits.push(renameEdit(token));
    else if (token.closing) return;
    else if (token.name === "a") edits.push(linkEdit(html, token));
    else edits.push([token.at, token.end + 1, plainStart(html, token)]);
  });
  return edits;
}

function renameEdits(html: string, tokens: readonly Token[]): Edit[] {
  const edits: Edit[] = [];
  tokens.forEach(function (token) {
    if (token.name !== "a") edits.push(renameEdit(token));
    else if (!token.closing) edits.push(linkEdit(html, token));
  });
  return edits;
}

function strayEdits(html: string): Edit[] {
  const links = new Set<number>();
  modelTags(html).forEach(function (token) { if (token.name === "a") links.add(token.at); });
  const edits: Edit[] = [];
  FORMATTING_TAG.lastIndex = 0;
  for (let tag = FORMATTING_TAG.exec(html); tag; tag = FORMATTING_TAG.exec(html)) {
    const end = tag.index + tag[0].length;
    if (!links.has(tag.index)) edits.push([end, end, "-"]);
  }
  return edits;
}

function applied(html: string, edits: readonly Edit[]): string {
  let out = "";
  let pos = 0;
  edits.forEach(function (edit) {
    out += html.slice(pos, edit[0]) + edit[2];
    pos = edit[1];
  });
  return out + html.slice(pos);
}

function reopenLimit(inputLength: number): number {
  return REOPENED_PER_INPUT_UNIT * inputLength + FREE_REOPENED;
}

export function boundedMarkup(html: string): string {
  const limit = reopenLimit(html.length);
  if (reopenWork(html, limit) <= limit) return html;
  const tokens = modelTags(html);
  const plain = applied(html, plainEdits(html, tokens));
  if (reopenWork(plain, limit) <= limit) return plain;
  const renamed = applied(html, renameEdits(html, tokens));
  if (reopenWork(renamed, limit) <= limit) return renamed;
  return applied(renamed, strayEdits(renamed));
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
