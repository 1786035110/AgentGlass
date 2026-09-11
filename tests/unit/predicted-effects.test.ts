import { expect, test } from "vitest";
import { predictEffects } from "../../src/core/predicted-effects.js";
import { assessRisk } from "../../src/core/risk-engine.js";
import { actionFacts } from "../fixtures/action-facts.js";

test("A-009 emits stable exact identities and immutable deterministic evidence", () => {
  const action = actionFacts({
    kind: "edit",
    mutatesState: "yes",
    impactFacts: { effect: "edit", createsParentDirectories: "no" },
  });
  const risk = assessRisk(action);
  const first = predictEffects(action, risk);
  const second = predictEffects(action, risk);

  expect(first).toEqual(second);
  expect(first[0]).toMatchObject({
    targetId: action.targets[0]?.targetId,
    kind: "modify",
    certainty: "known",
    scope: "bounded",
    purpose: "unknown",
    applicationOutcome: "unverifiable",
  });
  expect(first[0]?.effectId).toMatch(/^[a-f\d]{64}$/);
  expect(first[0]?.evidenceCodes).toEqual(
    expect.arrayContaining([
      "EFFECT_MODIFY",
      "EFFECT_CERTAINTY_KNOWN",
      "EFFECT_SCOPE_BOUNDED",
      "TARGET_PURPOSE_UNKNOWN",
      "APPLICATION_OUTCOME_UNVERIFIABLE",
    ]),
  );
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first[0])).toBe(true);
  expect(Object.isFrozen(first[0]?.evidenceCodes)).toBe(true);
});

test("A-009 changes effectId when exact action or supported effect semantics change", () => {
  const edit = actionFacts({
    kind: "edit",
    mutatesState: "yes",
    impactFacts: { effect: "edit", createsParentDirectories: "no" },
  });
  const changedInput = actionFacts({
    kind: "edit",
    mutatesState: "yes",
    impactFacts: { effect: "edit", createsParentDirectories: "no" },
    fingerprint: { ...edit.fingerprint, value: "b".repeat(64) },
  });
  const overwrite = actionFacts({
    kind: "write",
    mutatesState: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  });

  expect(predictEffects(edit, assessRisk(edit))[0]?.effectId).not.toBe(
    predictEffects(changedInput, assessRisk(changedInput))[0]?.effectId,
  );
  expect(predictEffects(edit, assessRisk(edit))[0]?.effectId).not.toBe(
    predictEffects(overwrite, assessRisk(overwrite))[0]?.effectId,
  );
});
