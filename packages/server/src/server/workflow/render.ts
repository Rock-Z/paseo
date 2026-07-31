import { canonicalJson, isJsonObject, type JsonObject } from "./json.js";

const EXACT_VALUE = /^\s*{{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\s*trim\s*)?}}\s*$/;
const INLINE_VALUE = /{{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|\s*trim\s*)?}}/g;
const IF_BLOCK =
  /{%\s*if\s+([A-Za-z_][A-Za-z0-9_.]*)\s*==\s*(["'])(.*?)\2\s*%}([\s\S]*?){%\s*endif\s*%}/g;
const ANY_TAG = /{%\s*([^%]+?)\s*%}/;
const ALL_TAGS = /{%\s*([^%]+?)\s*%}/g;
const IF_TAG = /^if\s+[A-Za-z_][A-Za-z0-9_.]*\s*==\s*(["']).*?\1$/;

export function isExactValueExpression(value: unknown): value is string {
  return typeof value === "string" && EXACT_VALUE.test(value);
}

export function promptTemplateIssue(template: string): string | null {
  let open = false;
  for (const match of template.matchAll(ALL_TAGS)) {
    const tag = match[1].trim();
    if (IF_TAG.test(tag)) {
      if (open) return "has an unsupported nested if block";
      open = true;
      continue;
    }
    if (tag === "endif") {
      if (!open) return "has an unbalanced if block";
      open = false;
      continue;
    }
    return `has unsupported template tag: ${tag}`;
  }
  return open ? "has an unbalanced if block" : null;
}

export function renderPrompt(template: string, context: JsonObject): string {
  let rendered = template;
  let previous: string;
  do {
    previous = rendered;
    rendered = rendered.replace(
      IF_BLOCK,
      (_, path: string, _quote: string, expected: string, content: string) =>
        resolvePath(context, path) === expected ? content : "",
    );
  } while (rendered !== previous);
  const unsupported = rendered.match(ANY_TAG);
  if (unsupported) {
    throw new Error(`unsupported workflow template tag: ${unsupported[1].trim()}`);
  }
  return renderString(rendered, context);
}

export function renderValue(
  value: unknown,
  context: JsonObject,
  options: { preserveUndefined?: boolean } = {},
): unknown {
  if (typeof value === "string") {
    const exact = value.match(EXACT_VALUE);
    if (exact) {
      const resolved = tryResolvePath(context, exact[1]);
      if (resolved.found) return resolved.value;
      if (options.preserveUndefined) return value;
      throw new Error(`undefined workflow value: ${exact[1]}`);
    }
    return renderString(value, context, options);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, context, options));
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, context, options)]),
    );
  }
  return value;
}

function renderString(
  value: string,
  context: JsonObject,
  options: { preserveUndefined?: boolean } = {},
): string {
  return value.replace(INLINE_VALUE, (match, path: string) => {
    const resolved = tryResolvePath(context, path);
    if (resolved.found) return stringify(resolved.value);
    if (options.preserveUndefined) return match;
    throw new Error(`undefined workflow value: ${path}`);
  });
}

function resolvePath(context: JsonObject, expression: string): unknown {
  const resolved = tryResolvePath(context, expression);
  if (!resolved.found) throw new Error(`undefined workflow value: ${expression}`);
  return resolved.value;
}

function tryResolvePath(
  context: JsonObject,
  expression: string,
): { found: true; value: unknown } | { found: false } {
  let current: unknown = context;
  for (const part of expression.split(".")) {
    if (!isJsonObject(current) || !(part in current)) {
      return { found: false };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}
