import { expect, test } from "vitest";
import {
  consumeApprovalToken,
  invalidateApprovalToken,
  issueApprovalToken,
  sameExecutionBinding,
} from "../../src/core/approval.js";
import type { ApprovalToken, ExecutionBinding } from "../../src/core/domain.js";

function binding(): ExecutionBinding {
  return {
    fingerprint: {
      algorithm: "sha256",
      canonicalizationVersion: 1,
      value: "a".repeat(64),
    },
    toolName: "write",
    cwd: "C:/project",
    sessionId: "session-1",
    hostExecutionId: "execution-1",
    toolCallId: "call-1",
  };
}

test.each([
  [
    "fingerprint",
    { fingerprint: { ...binding().fingerprint, value: "b".repeat(64) } },
  ],
  ["toolName", { toolName: "edit" }],
  ["cwd", { cwd: "C:/other" }],
  ["sessionId", { sessionId: "session-2" }],
  ["hostExecutionId", { hostExecutionId: "execution-2" }],
] as const)(
  "INV-007/008: changed %s invalidates the exact approval",
  (_name, change) => {
    const approved = binding();
    const token = issueApprovalToken("action-1", approved);
    const current = { ...approved, ...change } as ExecutionBinding;

    expect(sameExecutionBinding(approved, current)).toBe(false);
    expect(consumeApprovalToken(token, "action-1", current)).toBe(false);
    expect(token.state).toBe("invalidated");
    expect(consumeApprovalToken(token, "action-1", approved)).toBe(false);
  },
);

test("INV-007/008: exact current action consumes once and cannot replay", async () => {
  const current = binding();
  const token = issueApprovalToken("action-1", current);
  const results = await Promise.all([
    Promise.resolve().then(() =>
      consumeApprovalToken(token, "action-1", current),
    ),
    Promise.resolve().then(() =>
      consumeApprovalToken(token, "action-1", current),
    ),
  ]);

  expect(results.filter(Boolean)).toHaveLength(1);
  expect(token.state).toBe("consumed");
  expect(consumeApprovalToken(token, "action-1", current)).toBe(false);
});

test("INV-008/019: cancel and reconstructed token cannot restore authorization", () => {
  const current = binding();
  const cancelled = issueApprovalToken("action-1", current);
  invalidateApprovalToken(cancelled);
  expect(consumeApprovalToken(cancelled, "action-1", current)).toBe(false);

  const forged = {
    actionId: "action-1",
    binding: current,
    state: "issued",
  } as ApprovalToken;
  expect(consumeApprovalToken(forged, "action-1", current)).toBe(false);
});
