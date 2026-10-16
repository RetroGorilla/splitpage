import { appCss, cssInputs } from "./css-inputs.mjs";

export const repoUrl = new URL("../", import.meta.url);

export function readBuiltCss({ inputs = cssInputs, read } = {}) {
  return { paths: [...inputs], css: appCss(inputs, read) };
}

function delimiter(text, start, stops) {
  let quote = "", depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") { i++; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unclosed CSS comment");
      i = end + 1;
      continue;
    }
    if (!depth && stops.includes(ch)) return i;
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
  }
  return text.length;
}

export function cssRules(css) {
  const rules = [];
  function block(start, context) {
    let at = start;
    while (at < css.length) {
      const end = delimiter(css, at, "{};");
      const head = css.slice(at, end).trim();
      if (css[end] === "}") return end + 1;
      if (css[end] === ";") { at = end + 1; continue; }
      if (end === css.length) {
        if (head) throw new Error("Unparsed CSS: " + head);
        return end;
      }
      if (head.startsWith("@")) {
        at = block(end + 1, [...context, head]);
        continue;
      }
      const declarations = [];
      at = end + 1;
      while (at < css.length) {
        const stop = delimiter(css, at, ";}");
        const declaration = css.slice(at, stop).trim();
        if (declaration) {
          const colon = delimiter(declaration, 0, ":");
          if (colon === declaration.length) throw new Error("Invalid declaration: " + declaration);
          declarations.push({ property: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() });
        }
        at = stop + 1;
        if (css[stop] === "}") break;
        if (stop === css.length) throw new Error("Unclosed CSS rule: " + head);
      }
      rules.push({ selector: head, context, declarations });
    }
    return at;
  }
  block(0, []);
  return rules;
}

export function colourLiterals(value) {
  return [...value.matchAll(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi)].map((m) => m[0]);
}

export function resolveTokens(value, definitions, stack = []) {
  let result = "", at = 0;
  const pattern = /var\(/g;
  for (let match; (match = pattern.exec(value));) {
    result += value.slice(at, match.index);
    const start = pattern.lastIndex;
    let depth = 1, end = start;
    for (; end < value.length && depth; end++) {
      if (value[end] === "(") depth++;
      if (value[end] === ")") depth--;
    }
    if (depth) throw new Error("Unclosed var(): " + value);
    const args = value.slice(start, end - 1);
    const comma = delimiter(args, 0, ",");
    const name = args.slice(0, comma).trim();
    if (stack.includes(name)) throw new Error("Cyclic token: " + [...stack, name].join(" -> "));
    if (definitions.has(name)) result += resolveTokens(definitions.get(name), definitions, [...stack, name]);
    else if (comma < args.length) result += resolveTokens(args.slice(comma + 1).trim(), definitions, stack);
    else result += `var(${name})`;
    at = end;
    pattern.lastIndex = end;
  }
  return result + value.slice(at);
}

const definitionsOf = (rule) => rule.declarations.filter((d) => d.property.startsWith("--")).map((d) => [d.property, d.value]);
const normalise = (value) => value.replace(/\s+/g, "").toLowerCase().replace(/#([\da-f]{3})\b/g, (_, hex) => "#" + [...hex].map((c) => c + c).join(""));

function selectors(text) {
  const parts = [];
  for (let at = 0; at < text.length;) {
    const end = delimiter(text, at, ",");
    parts.push(text.slice(at, end).trim());
    at = end + 1;
  }
  return parts;
}

function activeContext(context, theme, matchedContext) {
  return context.every((part) => {
    if (/^@media\s*\(prefers-color-scheme:\s*dark\)$/.test(part)) return theme === "system-dark";
    if (/^@media\s*\(prefers-color-scheme:\s*light\)$/.test(part)) return theme === "light" || theme === "prompter";
    return matchedContext.includes(part);
  });
}

function activeSelector(selector, theme) {
  if (selector.includes(':root[data-theme="dark"]')) return theme === "dark";
  if (selector.includes(':root[data-theme="light"]')) return theme === "light" || theme === "prompter";
  if (selector.includes(':root:not([data-theme="light"])')) return theme === "system-dark";
  return true;
}

function palette(rules, theme, selector, context) {
  const definitions = new Map();
  const line = /\.prompter-line(?![\w-])/.test(selector);
  const prompter = line || /\.prompter(?![\w-])/.test(selector);
  const scopes = [":root", ...(prompter ? [".prompter"] : []), ...(line ? [".prompter-line"] : [])];
  for (const scope of scopes) {
    for (const rule of rules) {
      if (!activeContext(rule.context, theme, context)) continue;
      const matches = selectors(rule.selector).some((part) => activeSelector(part, theme) &&
        (scope === ":root" ? [":root", ':root[data-theme="dark"]', ':root:not([data-theme="light"])'].includes(part) : part === scope));
      if (matches) for (const [name, value] of definitionsOf(rule)) definitions.set(name, value);
    }
  }
  return definitions;
}

export function compareCssColours(before, after) {
  const oldRules = cssRules(before), newRules = cssRules(after);
  const differences = [];
  if (oldRules.length !== newRules.length) return ["CSS rule count changed"];
  const themes = ["light", "dark", "system-dark", "prompter"];
  for (const theme of themes) {
    for (let i = 0; i < oldRules.length; i++) {
      const a = oldRules[i], b = newRules[i];
      const label = `${theme} | ${a.context.join(" | ")} | ${a.selector}`;
      if (a.selector !== b.selector || JSON.stringify(a.context) !== JSON.stringify(b.context)) {
        differences.push(label + ": selector or media context changed");
        continue;
      }
      for (const selector of selectors(a.selector)) {
        if (!activeSelector(selector, theme) || !activeContext(a.context, theme, a.context)) continue;
        const oldDefinitions = new Map([...palette(oldRules, theme, selector, a.context), ...definitionsOf(a)]);
        const newDefinitions = new Map([...palette(newRules, theme, selector, b.context), ...definitionsOf(b)]);
        const oldDeclarations = a.declarations;
        const newDeclarations = b.declarations.filter((d) => !d.property.startsWith("--") || oldDefinitions.has(d.property));
        if (oldDeclarations.length !== newDeclarations.length) {
          differences.push(label + ": declaration count changed");
          continue;
        }
        for (let j = 0; j < oldDeclarations.length; j++) {
          const x = oldDeclarations[j], y = newDeclarations[j];
          const oldValue = resolveTokens(x.value, oldDefinitions);
          const newValue = resolveTokens(y.value, newDefinitions);
          if (x.property !== y.property || normalise(oldValue) !== normalise(newValue)) {
            differences.push(`${label} | ${selector} | ${x.property}: ${oldValue} -> ${newValue}`);
          }
        }
      }
    }
  }
  return differences;
}
