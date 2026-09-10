import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type {
  ActionFacts,
  RiskDecision,
  RiskReasonCode,
} from "../../src/core/domain.js";
import { classifyFileAction } from "../../src/core/file-classification.js";
import {
  assessRisk,
  assessSiblingMutationRisk,
} from "../../src/core/risk-engine.js";
import { actionFacts } from "../fixtures/action-facts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const ordinaryRead = actionFacts();
const modify = actionFacts({
  kind: "edit",
  mutatesState: "yes",
  impactFacts: { effect: "edit", createsParentDirectories: "no" },
});
const create = actionFacts(
  {
    kind: "write",
    mutatesState: "yes",
    impactFacts: { effect: "create", createsParentDirectories: "no" },
  },
  { state: "new_file" },
);

// A-013 让每条规则拥有可反查的独立测试名；fixture 仍复用既有 ActionFacts，
// 不把测试映射变成运行时 registry，也不靠复制输入增加覆盖数字。
const ruleCases: readonly {
  reasonCode: RiskReasonCode;
  hit: ActionFacts;
  neighbor: ActionFacts;
  decision: RiskDecision;
}[] = [
  {
    reasonCode: "INPUT_INVALID",
    hit: {} as ActionFacts,
    neighbor: ordinaryRead,
    decision: "hard_block",
  },
  {
    reasonCode: "INTEGRITY_FAILURE",
    hit: actionFacts({ evidenceCodes: ["INTEGRITY_FAILURE"] }),
    neighbor: ordinaryRead,
    decision: "hard_block",
  },
  {
    reasonCode: "PREFLIGHT_FAILED",
    hit: actionFacts({ evidenceCodes: ["PREFLIGHT_FAILED"] }),
    neighbor: ordinaryRead,
    decision: "hard_block",
  },
  {
    reasonCode: "SAFETY_CONTROL_MUTATION",
    hit: actionFacts({
      kind: "edit",
      mutatesState: "yes",
      impactFacts: { effect: "edit", createsParentDirectories: "no" },
      evidenceCodes: ["SAFETY_CONTROL_MUTATION"],
    }),
    neighbor: modify,
    decision: "hard_block",
  },
  {
    reasonCode: "UNSUPPORTED_TOOL",
    hit: actionFacts({ kind: "unsupported" }),
    neighbor: ordinaryRead,
    decision: "hard_block",
  },
  {
    reasonCode: "SENSITIVE_TARGET",
    hit: actionFacts({ sensitive: "yes" }),
    neighbor: ordinaryRead,
    decision: "hard_block",
  },
  {
    reasonCode: "OUTSIDE_WORKSPACE",
    hit: actionFacts(
      { outsideWorkspace: "yes" },
      { workspaceScope: "outside" },
    ),
    neighbor: ordinaryRead,
    decision: "hard_block",
  },
  {
    reasonCode: "PATH_UNCERTAIN",
    hit: actionFacts({}, { linked: "unknown", supportedPath: "unknown" }),
    neighbor: ordinaryRead,
    decision: "hard_block",
  },
  {
    reasonCode: "FILE_MODIFY",
    hit: modify,
    neighbor: create,
    decision: "ask",
  },
  {
    reasonCode: "FILE_CREATE",
    hit: create,
    neighbor: modify,
    decision: "ask",
  },
  {
    reasonCode: "KNOWN_READ_ONLY",
    hit: ordinaryRead,
    neighbor: actionFacts({ sensitive: "yes" }),
    decision: "auto_allow",
  },
];

test.each(ruleCases)(
  "A-013 $reasonCode has a hit and neighboring non-hit",
  ({ reasonCode, hit, neighbor, decision }) => {
    const matched = assessRisk(hit);
    expect(matched.reasonCodes, reasonCode).toContain(reasonCode);
    expect(matched.decision, reasonCode).toBe(decision);
    expect(assessRisk(neighbor).reasonCodes, reasonCode).not.toContain(
      reasonCode,
    );
  },
);

test("A-013 product decisions stay separate from shell dispositions", () => {
  const distribution: Record<RiskDecision, number> = {
    auto_allow: 0,
    ask: 0,
    hard_block: 0,
  };
  for (const fixture of ruleCases) {
    distribution[assessRisk(fixture.hit).decision] += 1;
  }

  expect(distribution).toEqual({ auto_allow: 1, ask: 2, hard_block: 8 });
  console.info(
    `A-013 product fixtures=${ruleCases.length} decisions=${JSON.stringify(distribution)}`,
  );
});

test("A-007 consumes real file-classifier facts without widening support", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "agentglass-risk-corpus-"),
  );
  temporaryDirectories.push(workspace);
  await writeFile(path.join(workspace, "note.txt"), "before", "utf8");
  await writeFile(path.join(workspace, ".env"), "TOKEN=value", "utf8");

  async function classify(
    name: string,
    rawInput: unknown,
    status: "verified_builtin" | "external" | "unknown" = "verified_builtin",
  ) {
    return (
      await classifyFileAction({
        actionId: `action-${name}`,
        cwd: workspace,
        tool: { name, status },
        rawInput,
      })
    ).action;
  }

  const decisions = [
    assessRisk(await classify("read", { path: "note.txt" })).decision,
    assessRisk(await classify("write", { path: "new.txt", content: "new" }))
      .decision,
    assessRisk(
      await classify("edit", {
        path: "note.txt",
        edits: [{ oldText: "before", newText: "after" }],
      }),
    ).decision,
    assessRisk(await classify("read", { path: ".env" })).decision,
    assessRisk(await classify("read", { path: "missing.txt" })).decision,
    assessRisk(
      await classify("read", {
        path: path.join(workspace, "..", "outside.txt"),
      }),
    ).decision,
    assessRisk(await classify("read", { path: "note.txt" }, "external"))
      .decision,
    assessRisk(await classify("custom-read", {}, "unknown")).decision,
  ];

  expect(decisions).toEqual([
    "auto_allow",
    "ask",
    "ask",
    "hard_block",
    "hard_block",
    "hard_block",
    "hard_block",
    "hard_block",
  ]);
});

test("A-008 batch rules each have a hit and neighboring non-hit", () => {
  const read = actionFacts({ actionId: "read" });
  const write = actionFacts({
    actionId: "write",
    kind: "write",
    mutatesState: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  });
  const otherWrite = actionFacts({
    actionId: "other-write",
    kind: "write",
    mutatesState: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  });

  expect(
    assessSiblingMutationRisk(write, [read, write]).reasonCodes,
  ).not.toContain("BATCH_MUTATION_BLOCKED");
  expect(
    assessSiblingMutationRisk(write, [write, otherWrite]).reasonCodes,
  ).toContain("BATCH_MUTATION_BLOCKED");
  expect(assessSiblingMutationRisk(write, [write]).reasonCodes).not.toContain(
    "BATCH_CONTEXT_UNKNOWN",
  );
  expect(assessSiblingMutationRisk(write, undefined)).toEqual({
    level: "critical",
    decision: "hard_block",
    reasonCodes: ["PREFLIGHT_FAILED", "BATCH_CONTEXT_UNKNOWN", "FILE_MODIFY"],
  });
});
