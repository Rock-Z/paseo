import { describe, expect, it } from "vitest";
import { assertValidWorkflowSpec, assertWorkflowSupport } from "./index.js";

describe("workflow CLI feature gate", () => {
  it("requires the host to advertise native workflows", () => {
    expect(() =>
      assertWorkflowSupport({
        getLastServerInfoMessage: () => ({ features: {} }),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to use native workflows.",
      }),
    );
  });

  it("accepts a host that advertises native workflows", () => {
    expect(() =>
      assertWorkflowSupport({
        getLastServerInfoMessage: () => ({ features: { workflows: true } }),
      }),
    ).not.toThrow();
  });
});

describe("workflow CLI validation", () => {
  it("allows a valid workflow result to be rendered", () => {
    expect(() =>
      assertValidWorkflowSpec({
        valid: true,
        issues: [],
        parameters: [],
      }),
    ).not.toThrow();
  });

  it("rejects an invalid workflow result with actionable issue details", () => {
    expect(() =>
      assertValidWorkflowSpec({
        valid: false,
        issues: [
          { path: "flows.main.states.work", message: "must declare exactly one action" },
          { path: "agents.worker", message: "is required" },
        ],
        parameters: [],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_WORKFLOW_SPEC",
        message: "Workflow spec is invalid.",
        details:
          "flows.main.states.work: must declare exactly one action\nagents.worker: is required",
      }),
    );
  });
});
