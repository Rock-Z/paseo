import { describe, expect, it } from "vitest";
import { assertWorkflowSupport } from "./index.js";

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
