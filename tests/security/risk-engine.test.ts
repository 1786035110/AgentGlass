import { expect, test } from "vitest";
import type { ActionFacts } from "../../src/core/domain.js";
import {
  assessRisk,
  assessSiblingMutationRisk,
} from "../../src/core/risk-engine.js";
import { actionFacts } from "../fixtures/action-facts.js";

test("INV-002/003: unknown mutation or effect has zero auto-allow", () => {
  const unknowns = [
    actionFacts({ mutatesState: "unknown" }),
    actionFacts({
      impactFacts: { effect: "unknown", createsParentDirectories: "no" },
    }),
    actionFacts({ sensitive: "unknown" }),
    actionFacts({ outsideWorkspace: "unknown" }),
  ].map(assessRisk);

  expect(
    unknowns.filter((risk) => risk.decision === "auto_allow"),
  ).toHaveLength(0);
  expect(unknowns.every((risk) => risk.decision === "hard_block")).toBe(true);
});

test("INV-003: critical evidence is hard-blocked in every conflict", () => {
  const critical = [
    "INPUT_INVALID",
    "INTEGRITY_FAILURE",
    "PREFLIGHT_FAILED",
    "SAFETY_CONTROL_MUTATION",
  ].map((code) =>
    assessRisk(
      actionFacts({
        kind: "unknown",
        mutatesState: "unknown",
        impactFacts: {
          effect: "unknown",
          createsParentDirectories: "unknown",
        },
        evidenceCodes: [code],
      }),
    ),
  );

  expect(critical.every((risk) => risk.level === "critical")).toBe(true);
  expect(critical.every((risk) => risk.decision === "hard_block")).toBe(true);
});

test("INV-002/020: known danger plus unknown, and read-only secret choose the stricter result", () => {
  const dangerousUnknown = assessRisk(
    actionFacts({
      kind: "unknown",
      mutatesState: "unknown",
      sensitive: "yes",
      impactFacts: {
        effect: "unknown",
        createsParentDirectories: "unknown",
      },
      evidenceCodes: ["SAFETY_CONTROL_MUTATION"],
    }),
  );
  const secretRead = assessRisk(actionFacts({ sensitive: "yes" }));

  expect(dangerousUnknown).toMatchObject({
    level: "critical",
    decision: "hard_block",
  });
  expect(dangerousUnknown.reasonCodes).toEqual(
    expect.arrayContaining([
      "SAFETY_CONTROL_MUTATION",
      "UNSUPPORTED_TOOL",
      "SENSITIVE_TARGET",
      "PATH_UNCERTAIN",
    ]),
  );
  expect(secretRead).toEqual({
    level: "high",
    decision: "hard_block",
    reasonCodes: ["SENSITIVE_TARGET"],
  });
});

test("INV-002: every explicit mutation has zero auto-allow", () => {
  const mutations = [
    actionFacts(
      {
        kind: "write",
        mutatesState: "yes",
        impactFacts: { effect: "create", createsParentDirectories: "no" },
      },
      { state: "new_file" },
    ),
    actionFacts({
      kind: "write",
      mutatesState: "yes",
      impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
    }),
    actionFacts({
      kind: "edit",
      mutatesState: "yes",
      impactFacts: { effect: "edit", createsParentDirectories: "no" },
    }),
  ].map(assessRisk);

  expect(
    mutations.filter((risk) => risk.decision === "auto_allow"),
  ).toHaveLength(0);
  expect(mutations.every((risk) => risk.decision === "ask")).toBe(true);
});

test("INV-003/020: missing verified identity or schema evidence cannot ask or auto-allow", () => {
  const incompleteEvidence = [
    [],
    ["TOOL_IDENTITY_VERIFIED"],
    ["TOOL_SCHEMA_VERIFIED"],
  ].map((evidenceCodes) =>
    assessRisk(
      actionFacts({
        evidenceCodes,
      }),
    ),
  );

  expect(
    incompleteEvidence.every(
      (risk) =>
        risk.decision === "hard_block" &&
        risk.reasonCodes.includes("UNSUPPORTED_TOOL"),
    ),
  ).toBe(true);
});

test("INV-001/019: UI, learning, LLM, and prior approval fields cannot lower current risk", () => {
  const untrustedExtras = {
    ...actionFacts({ sensitive: "yes" }),
    uiDecision: "auto_allow",
    learningDecision: "auto_allow",
    llmDecision: "auto_allow",
    previousApproval: "approved",
  } as ActionFacts;

  expect(assessRisk(untrustedExtras).decision).toBe("hard_block");
});

test("INV-003: an internal property failure fails closed without exposing the exception", () => {
  const hostile = new Proxy(actionFacts(), {
    get() {
      throw new Error("synthetic secret exception text");
    },
  });

  expect(assessRisk(hostile)).toEqual({
    level: "critical",
    decision: "hard_block",
    reasonCodes: ["PREFLIGHT_FAILED"],
  });
});

test("INV-013/020: sibling mutation guard treats yes and unknown as changes without attribution exceptions", () => {
  const read = actionFacts({ actionId: "read" });
  const write = actionFacts({
    actionId: "write",
    kind: "write",
    mutatesState: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  });
  const writeElsewhere = actionFacts({
    actionId: "write-elsewhere",
    kind: "write",
    targetLabel: "other.txt",
    mutatesState: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  });
  const unknown = actionFacts({
    actionId: "unknown",
    kind: "unknown",
    mutatesState: "unknown",
    impactFacts: { effect: "unknown", createsParentDirectories: "unknown" },
  });

  expect(assessSiblingMutationRisk(read, [read, write]).decision).toBe(
    "auto_allow",
  );
  expect(assessSiblingMutationRisk(write, [read, write]).decision).toBe("ask");
  for (const batch of [
    [write, writeElsewhere],
    [write, unknown],
    [unknown, write],
    [unknown, actionFacts({ actionId: "unknown-2", mutatesState: "unknown" })],
    [read, write, writeElsewhere],
  ]) {
    for (const current of batch.filter(
      (action) => action.mutatesState !== "no",
    )) {
      expect(assessSiblingMutationRisk(current, batch)).toMatchObject({
        decision: "hard_block",
        reasonCodes: expect.arrayContaining(["BATCH_MUTATION_BLOCKED"]),
      });
    }
  }
});

test("INV-003/013/020: incomplete, duplicate, stale, and invalid sibling facts fail closed for a mutation", () => {
  const write = actionFacts({
    actionId: "write",
    kind: "write",
    mutatesState: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  });
  const incomplete = [
    undefined,
    [],
    [write, write],
    [actionFacts({ actionId: "old-turn" })],
    [write, {} as ActionFacts],
  ] as const;

  for (const siblings of incomplete) {
    expect(assessSiblingMutationRisk(write, siblings)).toMatchObject({
      level: "critical",
      decision: "hard_block",
      reasonCodes: expect.arrayContaining([
        "PREFLIGHT_FAILED",
        "BATCH_CONTEXT_UNKNOWN",
      ]),
    });
  }
});
