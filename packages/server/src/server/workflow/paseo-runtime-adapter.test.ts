import { describe, expect, it, vi } from "vitest";
import { PaseoWorkflowRuntimeAdapter } from "./paseo-runtime-adapter.js";
import type { JsonObject } from "./spec.js";

describe("PaseoWorkflowRuntimeAdapter", () => {
  it("does not adopt an unrelated foreground turn without matching client identity", async () => {
    const agent = {
      id: "agent-shared",
      activeForegroundTurnId: "native-other",
      lifecycle: "running",
    };
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {
        getAgent: vi.fn(() => agent),
        getActiveForegroundClientMessageId: vi.fn(() => "client-other"),
        getTimelineRows: vi.fn(async () => []),
        subscribe: vi.fn(() => () => undefined),
        hasInFlightRun: vi.fn(() => true),
      } as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      workspaceRegistry: {} as never,
      createAgent: (() => undefined) as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });

    await expect(
      adapter.reconcileTurn({
        agentId: agent.id,
        nativeTurnId: null,
        clientMessageId: "client-workflow",
      }),
    ).resolves.toEqual({ state: "missing" });
  });

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

  it("normalizes validated mode and thinking aliases before creating an agent", async () => {
    const createAgent = vi.fn(async () => ({ snapshot: { id: "agent-created" } }));
    const adapter = new PaseoWorkflowRuntimeAdapter({
      agentManager: {} as never,
      agentStorage: { list: vi.fn(async () => []) } as never,
      providerSnapshotManager: {} as never,
      workspaceRegistry: {} as never,
      createAgent: createAgent as never,
      createPaseoWorktree: (() => undefined) as never,
      logger: {} as never,
    });

    await expect(
      adapter.ensureAgent({
        runId: "run-settings",
        workflowName: "settings-workflow",
        instanceId: "root",
        flow: "main",
        role: "worker",
        agentKey: "worker",
        create: {
          title: "Workflow worker",
          provider: "codex",
          settings: { mode: "plan", thinking: "high" },
        },
        workspace: {
          workspaceId: "workspace-1",
          cwd: process.cwd(),
          name: "Workspace",
        },
        existingAgentId: null,
      }),
    ).resolves.toBe("agent-created");
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          modeId: "plan",
          thinkingOptionId: "high",
        }),
      }),
    );
  });
});
