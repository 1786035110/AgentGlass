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
import { assessRisk } from "../../src/core/risk-engine.js";
import { actionFacts } from "../fixtures/action-facts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("A-007 each ordered rule has a hit and a neighboring non-hit fixture", () => {
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
  const cases: readonly {
    reasonCode: RiskReasonCode;
    hit: ActionFacts;
    neighbor: ActionFacts;
  }[] = [
    {
      reasonCode: "INPUT_INVALID",
      hit: {} as ActionFacts,
      neighbor: ordinaryRead,
    },
    {
      reasonCode: "INTEGRITY_FAILURE",
      hit: actionFacts({ evidenceCodes: ["INTEGRITY_FAILURE"] }),
      neighbor: ordinaryRead,
    },
    {
      reasonCode: "PREFLIGHT_FAILED",
      hit: actionFacts({ evidenceCodes: ["PREFLIGHT_FAILED"] }),
      neighbor: ordinaryRead,
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
    },
    {
      reasonCode: "UNSUPPORTED_TOOL",
      hit: actionFacts({ kind: "unsupported" }),
      neighbor: ordinaryRead,
    },
    {
      reasonCode: "SENSITIVE_TARGET",
      hit: actionFacts({ sensitive: "yes" }),
      neighbor: ordinaryRead,
    },
    {
      reasonCode: "OUTSIDE_WORKSPACE",
      hit: actionFacts(
        { outsideWorkspace: "yes" },
        { workspaceScope: "outside" },
      ),
      neighbor: ordinaryRead,
    },
    {
      reasonCode: "PATH_UNCERTAIN",
      hit: actionFacts({}, { linked: "unknown", supportedPath: "unknown" }),
      neighbor: ordinaryRead,
    },
    { reasonCode: "FILE_MODIFY", hit: modify, neighbor: create },
    { reasonCode: "FILE_CREATE", hit: create, neighbor: modify },
    {
      reasonCode: "KNOWN_READ_ONLY",
      hit: ordinaryRead,
      neighbor: actionFacts({ sensitive: "yes" }),
    },
  ];

  const distribution: Record<RiskDecision, number> = {
    auto_allow: 0,
    ask: 0,
    hard_block: 0,
  };
  const delta: Record<
    RiskReasonCode,
    Partial<Record<RiskDecision, number>>
  > = {} as Record<RiskReasonCode, Partial<Record<RiskDecision, number>>>;

  for (const fixture of cases) {
    const hit = assessRisk(fixture.hit);
    const neighbor = assessRisk(fixture.neighbor);
    expect(hit.reasonCodes, fixture.reasonCode).toContain(fixture.reasonCode);
    expect(neighbor.reasonCodes, fixture.reasonCode).not.toContain(
      fixture.reasonCode,
    );
    distribution[hit.decision] += 1;
    delta[fixture.reasonCode] = { [hit.decision]: 1 };
  }

  expect(distribution).toEqual({ auto_allow: 1, ask: 2, hard_block: 8 });
  console.info(
    `A-007 decision distribution ${JSON.stringify(distribution)}; delta from no risk engine ${JSON.stringify(delta)}`,
  );
});

test("A-007 consumes real file-classifier facts without widening support", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "agentglass-risk-corpus-"),
  );
  temporaryDirectories.push(workspace);
  await writeFile(path.join(workspace, "note.txt"), "before", "utf8");
  await writeFile(path.join(workspace, ".env"), "TOKEN=value", "utf8");

  async function classify(name: string, rawInput: unknown) {
    return (
      await classifyFileAction({
        actionId: `action-${name}`,
        cwd: workspace,
        tool: { name, status: "verified_builtin" },
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
  ];

  expect(decisions).toEqual([
    "auto_allow",
    "ask",
    "ask",
    "hard_block",
    "hard_block",
  ]);
});
