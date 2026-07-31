import { describe, expect, it, vi } from "vitest";
import { PaseoWorkflowRuntimeAdapter } from "./paseo-runtime-adapter.js";
import type { JsonObject } from "./spec.js";

describe("PaseoWorkflowRuntimeAdapter", () => {
  it("does not validate unused create-agent fallback data for a bound role", async () => {
    const getProvider = vi.fn(async () => {
      throw new Error("fallback provider is unavailable");
    });
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {} as never,
      agentStorage: {} as never,
      providerSnapshotManager: { getProvider } as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });
    const spec: JsonObject = {
      bindings: {
        worktree: process.cwd(),
        agents: { worker: "agent-existing" },
      },
      workspace: {
        createWorktree: {
          cwd: process.cwd(),
        },
      },
      agents: {
        worker: {
          createAgent: {
            provider: "unavailable-fallback",
          },
        },
      },
    };

    await expect(adapter.validateMaterializedSpec(spec, {})).resolves.toBeUndefined();
    expect(getProvider).not.toHaveBeenCalled();

    (spec.bindings as JsonObject).agents = {};
    await expect(adapter.validateMaterializedSpec(spec, {})).rejects.toThrow(
      "fallback provider is unavailable",
    );
    expect(getProvider).toHaveBeenCalledOnce();
  });
});
