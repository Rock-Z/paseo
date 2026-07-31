import { describe, expect, it } from "vitest";
import { renderPrompt, renderValue } from "./render.js";

const context = {
  event: { event: "revise", message: "Tighten the proof", data: { branches: ["a", "b"] } },
  inputs: { objective: "Verify behavior" },
  task: { index: 2 },
};

describe("workflow rendering", () => {
  it("preserves native values for exact placeholders and renders inline JSON canonically", () => {
    expect(renderValue("{{ event.data.branches }}", context)).toEqual(["a", "b"]);
    expect(renderValue("branches={{ event.data.branches }}", context)).toBe('branches=["a","b"]');
    expect(
      renderValue("{{ inputs.objective | trim }}", { inputs: { objective: "  done  " } }),
    ).toBe("done");
    expect(
      renderPrompt("result={{ inputs.objective | trim }}", {
        inputs: { objective: "  done  " },
      }),
    ).toBe("result=done");
  });

  it("renders the conditional form used by built-in workflows", () => {
    expect(
      renderPrompt(
        [
          "Review {{ inputs.objective }}.",
          '{% if event.event == "revise" %}',
          "Prior feedback: {{ event.message }}",
          "{% endif %}",
        ].join("\n"),
        context,
      ),
    ).toContain("Prior feedback: Tighten the proof");
  });

  it("preserves literal JSON closing braces outside interpolation", () => {
    const prompt =
      'PASEO_WORKFLOW_TEST_SCRIPT: {"delayMs":15000,"rules":{"done":[{"event":"done"}]}}';
    expect(renderPrompt(prompt, context)).toBe(prompt);
  });

  it("fails closed on missing values and unsupported expressions", () => {
    expect(() => renderPrompt("{{ event.data.missing }}", context)).toThrow(
      "undefined workflow value",
    );
    expect(() => renderPrompt("{{ inputs.constructor }}", { inputs: {} })).toThrow(
      "undefined workflow value",
    );
    expect(() => renderPrompt("{{ inputs.__proto__ }}", { inputs: {} })).toThrow(
      "undefined workflow value",
    );
    expect(() => renderPrompt("{% for item in inputs %}x{% endfor %}", context)).toThrow(
      "unsupported workflow template tag",
    );
    expect(() => renderPrompt("{{ inputs.objective | uppercase }}", context)).toThrow(
      "unsupported workflow template",
    );
    expect(() => renderPrompt("{{ inputs.objective", context)).toThrow(
      "has an unbalanced interpolation",
    );
  });
});
