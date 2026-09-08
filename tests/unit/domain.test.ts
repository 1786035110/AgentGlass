import { expect, expectTypeOf, test } from "vitest";
import type {
  ActionFacts,
  ApprovalToken,
  NormalizedAction,
  OutcomeCard,
  PredictedEffect,
  RedactedPersistableInput,
  RiskAssessment,
  TransientRawInput,
  VerificationCorrelation,
} from "../../src/core/domain.js";

test("the Alpha schema preserves unknown safety facts and exact identities", () => {
  const fingerprint = {
    algorithm: "sha256",
    canonicalizationVersion: 1,
    value: "digest",
  } as const;
  const action: NormalizedAction = {
    actionId: "action-1",
    kind: "unknown",
    targetLabel: "配置文件",
    mutatesState: "unknown",
    outsideWorkspace: "unknown",
    sensitive: "unknown",
    evidenceCodes: ["ACTION_UNKNOWN"],
    fingerprint,
  };
  const risk: RiskAssessment = {
    level: "critical",
    decision: "hard_block",
    reasonCodes: ["ACTION_UNKNOWN"],
  };
  const effect: PredictedEffect = {
    effectId: "effect-1",
    targetId: "target-1",
    kind: "unknown",
    targetLabel: action.targetLabel,
    descriptionKey: "effect.unknown",
  };
  const card: OutcomeCard = {
    actionId: action.actionId,
    title: "无法确认这项操作",
    expectedOutcome: "结果未知",
    attention: "已阻止",
    recovery: "不能自动恢复",
    details: [],
  };
  const approval: ApprovalToken = {
    actionId: action.actionId,
    binding: {
      fingerprint,
      toolName: "unknown-tool",
      cwd: "C:/project",
      sessionId: "session-1",
      toolCallId: "call-1",
    },
    state: "invalidated",
  };
  const correlation: VerificationCorrelation = {
    actionId: action.actionId,
    effectId: effect.effectId,
    targetId: effect.targetId,
  };

  expect({ risk, card, approval, correlation }).toMatchObject({
    risk: { decision: "hard_block" },
    approval: { binding: { toolCallId: "call-1" } },
    correlation: { targetId: "target-1" },
  });
  expectTypeOf<NormalizedAction>().toEqualTypeOf<ActionFacts>();
  expectTypeOf<ActionFacts>().not.toHaveProperty("safe");
  expectTypeOf<ActionFacts>().not.toHaveProperty("rawInput");
  expectTypeOf<VerificationCorrelation>().not.toHaveProperty("targetLabel");
});

test("raw input is not assignable to the redacted persistable boundary", () => {
  const raw: TransientRawInput = { password: "secret" };
  // @ts-expect-error 原始输入必须经过未来的 A-003 脱敏器。
  const persisted: RedactedPersistableInput = raw;
  expect(persisted).toBe(raw);
});
