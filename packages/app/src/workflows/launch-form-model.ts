import type { WorkflowValidationResult } from "@getpaseo/protocol/workflow/types";

export interface WorkflowLaunchForm {
  values: Record<string, string>;
  errors: Record<string, string>;
}

export function openWorkflowLaunchForm(validation: WorkflowValidationResult): WorkflowLaunchForm {
  return {
    values: Object.fromEntries(
      validation.parameters.map((parameter) => [
        parameter.name,
        formatDefaultValue(parameter.defaultValue),
      ]),
    ),
    errors: {},
  };
}

export function updateWorkflowLaunchValue(
  form: WorkflowLaunchForm,
  name: string,
  value: string,
): WorkflowLaunchForm {
  const { [name]: _removed, ...errors } = form.errors;
  return { values: { ...form.values, [name]: value }, errors };
}

export function submitWorkflowLaunchForm(
  form: WorkflowLaunchForm,
  validation: WorkflowValidationResult,
): { ok: true; parameters: Record<string, unknown> } | { ok: false; form: WorkflowLaunchForm } {
  const parameters: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const declaration of validation.parameters) {
    const raw = form.values[declaration.name]?.trim() ?? "";
    if (!raw) {
      if (declaration.required && declaration.defaultFrom === undefined) {
        errors[declaration.name] = "Required";
      }
      continue;
    }
    try {
      parameters[declaration.name] = parseParameterValue(raw, declaration);
    } catch (error) {
      errors[declaration.name] = error instanceof Error ? error.message : String(error);
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, form: { ...form, errors } };
  }
  return { ok: true, parameters };
}

function formatDefaultValue(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseParameterValue(
  raw: string,
  declaration: WorkflowValidationResult["parameters"][number],
) {
  const { type } = declaration;
  if (type === "string" || type === "path" || type === "image") return raw;
  if (type === "enum") return parseEnumValue(raw, declaration.values ?? []);
  if (type === "boolean") return parseBoolean(raw);
  if (type === "integer" || type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
      throw new Error(type === "integer" ? "Enter an integer" : "Enter a number");
    }
    return value;
  }
  const value = JSON.parse(raw) as unknown;
  if (type === "array" && !Array.isArray(value)) throw new Error("Enter a JSON array");
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("Enter a JSON object");
  }
  return value;
}

function parseBoolean(raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error("Enter true or false");
}

function parseEnumValue(raw: string, values: unknown[]): unknown {
  const stringValue = values.find((value) => typeof value === "string" && value === raw);
  if (stringValue !== undefined) return stringValue;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Choose one of ${values.map(formatDefaultValue).join(", ")}`);
  }
  const serialized = JSON.stringify(parsed);
  const match = values.find(
    (value) => typeof value !== "string" && JSON.stringify(value) === serialized,
  );
  if (match === undefined) {
    throw new Error(`Choose one of ${values.map(formatDefaultValue).join(", ")}`);
  }
  return match;
}
