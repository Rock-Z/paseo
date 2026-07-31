import type { JsonObject, WorkflowCallerContext } from "./spec.js";
import type { WorkflowWorkspace } from "./state.js";

export interface WorkflowTurnRequest {
  runId: string;
  workflowTurnId: string;
  clientMessageId: string;
  instanceId: string;
  agentId: string;
  prompt: string;
  labels: Record<string, string>;
}

export interface WorkflowTurnResult {
  agentId: string;
  nativeTurnId: string | null;
  status: "completed" | "failed" | "canceled";
  lastMessage: string;
  lastError: string | null;
}

export interface WorkflowStartedTurn {
  nativeTurnId: string | null;
  result: Promise<WorkflowTurnResult>;
}

export type WorkflowTurnReconciliation =
  | {
      state: "active";
      nativeTurnId: string;
      result: Promise<WorkflowTurnResult>;
    }
  | {
      state: "completed";
      result: WorkflowTurnResult;
    }
  | {
      state: "missing";
    };

export interface WorkflowRuntimeAdapter {
  resolveCallerContext(input: {
    workspaceId?: string;
    agentId?: string;
  }): Promise<WorkflowCallerContext>;
  validateMaterializedSpec(spec: JsonObject, context: WorkflowCallerContext): Promise<void>;
  ensureWorkspace(input: {
    runId: string;
    instanceId: string;
    create: JsonObject;
  }): Promise<WorkflowWorkspace>;
  resolveBoundWorkspace(input: {
    workspaceId: string;
    worktreePath: string;
  }): Promise<WorkflowWorkspace>;
  ensureAgent(input: {
    runId: string;
    workflowName: string;
    instanceId: string;
    flow: string;
    role: string;
    agentKey: string;
    create: JsonObject;
    workspace: WorkflowWorkspace;
    existingAgentId: string | null;
  }): Promise<string>;
  waitUntilAgentIdle(agentId: string): Promise<void>;
  beginTurn(request: WorkflowTurnRequest): Promise<WorkflowStartedTurn>;
  reconcileTurn(request: {
    agentId: string;
    nativeTurnId: string | null;
    clientMessageId: string;
  }): Promise<WorkflowTurnReconciliation>;
  getActiveTurnId(agentId: string): string | null;
}
