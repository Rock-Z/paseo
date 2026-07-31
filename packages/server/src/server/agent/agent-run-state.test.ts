import { describe, expect, it } from "vitest";

import { AgentRunState } from "./agent-run-state.js";

describe("AgentRunState", () => {
  it("attaches a later provider turn ID to the existing autonomous run", () => {
    const state = new AgentRunState();
    const pendingIdentity = state.trackAutonomousRun("agent-1", null);
    const identified = state.trackAutonomousRun("agent-1", "native-restored");

    expect(identified).toBe(pendingIdentity);
    expect(state.getRun("agent-1")).toMatchObject({
      kind: "autonomous",
      turnId: "native-restored",
    });
  });
});
