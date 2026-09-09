import { expect, test } from "vitest";
import type { ActionFacts } from "../../src/core/domain.js";
import { assessRisk } from "../../src/core/risk-engine.js";
import { actionFacts } from "../fixtures/action-facts.js";

test("A-007 applies the three terminal file decisions", () => {
  const read = assessRisk(actionFacts());
  const create = assessRisk(
    actionFacts(
      {
        kind: "write",
        mutatesState: "yes",
        impactFacts: { effect: "create", createsParentDirectories: "no" },
      },
      { state: "new_file" },
    ),
  );
  const modify = assessRisk(
    actionFacts({
      kind: "edit",
      mutatesState: "yes",
      impactFacts: { effect: "edit", createsParentDirectories: "no" },
    }),
  );

  expect(read).toEqual({
    level: "info",
    decision: "auto_allow",
    reasonCodes: ["KNOWN_READ_ONLY"],
  });
  expect(create).toEqual({
    level: "info",
    decision: "ask",
    reasonCodes: ["FILE_CREATE"],
  });
  expect(modify).toEqual({
    level: "high",
    decision: "ask",
    reasonCodes: ["FILE_MODIFY"],
  });
});

test("A-007 aggregates every match in fixed rule order and keeps the strictest result", () => {
  const result = assessRisk(
    actionFacts(
      {
        kind: "unknown",
        mutatesState: "unknown",
        outsideWorkspace: "yes",
        sensitive: "yes",
        impactFacts: {
          effect: "unknown",
          createsParentDirectories: "unknown",
        },
        evidenceCodes: [
          "TOOL_IDENTITY_UNVERIFIED",
          "SAFETY_CONTROL_MUTATION",
          "INPUT_INVALID",
          "SAFETY_CONTROL_MUTATION",
        ],
      },
      { workspaceScope: "outside", linked: "unknown", supportedPath: "no" },
    ),
  );

  expect(result).toEqual({
    level: "critical",
    decision: "hard_block",
    reasonCodes: [
      "INPUT_INVALID",
      "SAFETY_CONTROL_MUTATION",
      "UNSUPPORTED_TOOL",
      "SENSITIVE_TARGET",
      "OUTSIDE_WORKSPACE",
      "PATH_UNCERTAIN",
    ],
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.reasonCodes)).toBe(true);
});

test("A-007 rejects malformed structured facts before rules run", () => {
  expect(assessRisk({} as ActionFacts)).toEqual({
    level: "critical",
    decision: "hard_block",
    reasonCodes: ["INPUT_INVALID"],
  });
});

test("A-007 fails closed when classifier facts explicitly contradict each other", () => {
  expect(
    assessRisk(
      actionFacts({
        kind: "read",
        mutatesState: "yes",
        impactFacts: { effect: "read", createsParentDirectories: "no" },
      }),
    ),
  ).toEqual({
    level: "critical",
    decision: "hard_block",
    reasonCodes: ["PREFLIGHT_FAILED", "FILE_MODIFY"],
  });
});
