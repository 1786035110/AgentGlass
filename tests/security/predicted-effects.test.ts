import { expect, test } from "vitest";
import type { RiskAssessment } from "../../src/core/domain.js";
import { predictEffects } from "../../src/core/predicted-effects.js";
import { assessRisk } from "../../src/core/risk-engine.js";
import { classifyShellCommand } from "../../src/core/shell-classification.js";
import { actionFacts } from "../fixtures/action-facts.js";

test("INV-002/009/020: unknown and outside targets stay blocked, unknown, and unverifiable", () => {
  const fixtures = [
    actionFacts(
      {
        kind: "write",
        mutatesState: "yes",
        outsideWorkspace: "yes",
        impactFacts: { effect: "unknown", createsParentDirectories: "unknown" },
      },
      {
        workspaceScope: "outside",
        state: "unknown",
        linked: "unknown",
        supportedPath: "no",
      },
    ),
    actionFacts(
      {
        kind: "unknown",
        mutatesState: "unknown",
        outsideWorkspace: "unknown",
        sensitive: "unknown",
        impactFacts: {
          effect: "unknown",
          createsParentDirectories: "unknown",
        },
        evidenceCodes: ["TOOL_IDENTITY_UNVERIFIED"],
      },
      {
        workspaceScope: "unknown",
        state: "unknown",
        linked: "unknown",
        supportedPath: "unknown",
      },
    ),
  ];

  for (const action of fixtures) {
    const risk = assessRisk(action);
    expect(risk.decision).toBe("hard_block");
    expect(predictEffects(action, risk)[0]).toMatchObject({
      kind: "unknown",
      certainty: "unknown",
      scope: "unknown",
      applicationOutcome: "unverifiable",
    });
  }
});

test("INV-001/002: classifier-local install facts cannot widen a non-blocking product decision", () => {
  const action = actionFacts({
    kind: "unknown",
    mutatesState: "unknown",
    outsideWorkspace: "unknown",
    sensitive: "unknown",
    impactFacts: { effect: "unknown", createsParentDirectories: "unknown" },
    evidenceCodes: ["TOOL_IDENTITY_UNVERIFIED"],
  });
  const inconsistentRisk: RiskAssessment = {
    level: "info",
    decision: "ask",
    reasonCodes: [],
  };
  const install = classifyShellCommand("npm install", {
    shell: "bash",
    nonInteractive: "yes",
    environment: "verified",
    pathLookup: "verified",
    alias: "absent",
    function: "absent",
    commandResolution: {
      status: "verified",
      name: "npm",
      kind: "executable",
      resolvedPath: "/usr/bin/npm",
      supportedSemantics: "verified",
    },
  });

  expect(predictEffects(action, inconsistentRisk, install)[0]).toMatchObject({
    kind: "unknown",
    certainty: "unknown",
    scope: "unknown",
  });
});

test("INV-003/009: contradictory file facts cannot become a known bounded effect", () => {
  const action = actionFacts(
    {
      kind: "read",
      mutatesState: "no",
      impactFacts: { effect: "read", createsParentDirectories: "no" },
    },
    { state: "new_file" },
  );
  const inconsistentRisk: RiskAssessment = {
    level: "info",
    decision: "auto_allow",
    reasonCodes: ["KNOWN_READ_ONLY"],
  };

  expect(predictEffects(action, inconsistentRisk)[0]).toMatchObject({
    kind: "unknown",
    certainty: "unknown",
    scope: "unknown",
    applicationOutcome: "unverifiable",
  });
});

test("INV-003/020: missing targets stay blocked and receive stable non-colliding identities", () => {
  const first = { ...actionFacts(), targets: [] };
  const second = {
    ...first,
    fingerprint: { ...first.fingerprint, value: "b".repeat(64) },
  };
  const firstRisk = assessRisk(first);
  const firstEffects = predictEffects(first, firstRisk);

  expect(firstRisk).toEqual({
    level: "critical",
    decision: "hard_block",
    reasonCodes: ["INPUT_INVALID"],
  });
  expect(firstEffects[0]).toMatchObject({
    kind: "unknown",
    certainty: "unknown",
    scope: "unknown",
  });
  expect(firstEffects[0]?.targetId).toMatch(/^[a-f\d]{64}$/);
  expect(predictEffects(first, firstRisk)[0]?.targetId).toBe(
    firstEffects[0]?.targetId,
  );
  expect(predictEffects(second, assessRisk(second))[0]?.targetId).not.toBe(
    firstEffects[0]?.targetId,
  );
});
