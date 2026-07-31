import type { PaseoToolCatalog, PaseoToolExecutionContext, PaseoToolResult } from "./types.js";

export const WORKFLOW_EVENT_TOOL_NAMES = ["emit_event"] as const;

export function selectPaseoTools(
  catalog: PaseoToolCatalog,
  allowedNames: readonly string[],
): PaseoToolCatalog {
  const tools = new Map(
    allowedNames.flatMap((name) => {
      const tool = catalog.getTool(name);
      return tool ? [[name, tool] as const] : [];
    }),
  );

  return {
    tools,
    getTool(name) {
      return tools.get(name);
    },
    async executeTool(
      name: string,
      input: unknown,
      context?: PaseoToolExecutionContext,
    ): Promise<PaseoToolResult> {
      if (!tools.has(name)) {
        throw new Error(`Paseo tool not found: ${name}`);
      }
      return catalog.executeTool(name, input, context);
    },
  };
}
