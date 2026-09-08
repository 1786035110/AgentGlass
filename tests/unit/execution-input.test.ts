import { expect, expectTypeOf, test } from "vitest";
import type {
  HostExecutionFacts,
  TransientHostExecutionInput,
} from "../../src/core/domain.js";
import {
  projectHostExecutionInput,
  projectObservableUserGoal,
} from "../../src/core/execution-input.js";

test("host execution projection removes raw input and keeps only the redacted observable goal", async () => {
  const transient: TransientHostExecutionInput = {
    hostExecutionId: "execution-1",
    toolCallId: "call-1",
    sessionId: "session-1",
    cwd: "C:/project",
    tool: { name: "write", status: "verified_builtin" },
    capabilities: {
      interaction: "local_interactive",
      canPromptForApproval: "yes",
    },
    siblings: [],
    userGoal: projectObservableUserGoal("保存 token=synthetic-goal-credential"),
    rawInput: {
      path: "note.txt",
      token: "synthetic-tool-credential",
    },
  };

  const facts = await projectHostExecutionInput(transient);
  const serialized = JSON.stringify(facts);
  expect(serialized).not.toContain("synthetic-goal-credential");
  expect(serialized).not.toContain("synthetic-tool-credential");
  expect(facts).not.toHaveProperty("rawInput");
  expect(facts.input.fingerprint.value).toMatch(/^[a-f\d]{64}$/);
  expectTypeOf<HostExecutionFacts>().not.toHaveProperty("rawInput");
});
