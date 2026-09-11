import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ActionFacts } from "../../src/core/domain.js";
import { classifyFileAction } from "../../src/core/file-classification.js";
import { predictEffects } from "../../src/core/predicted-effects.js";
import { assessRisk } from "../../src/core/risk-engine.js";
import {
  classifyShellCommand,
  type ShellRuntimeEvidence,
} from "../../src/core/shell-classification.js";
import { actionFacts } from "../fixtures/action-facts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function classifyFile(
  cwd: string,
  actionId: string,
  name: "read" | "write" | "edit",
  rawInput: Record<string, unknown>,
) {
  const { action } = await classifyFileAction({
    actionId,
    cwd,
    tool: { name, status: "verified_builtin" },
    rawInput,
  });
  return action;
}

function runtime(command: string): ShellRuntimeEvidence {
  return {
    shell: "bash",
    nonInteractive: "yes",
    environment: "verified",
    pathLookup: "verified",
    alias: "absent",
    function: "absent",
    commandResolution: {
      status: "verified",
      name: command,
      kind: "executable",
      resolvedPath: `/usr/bin/${command}`,
      supportedSemantics: "verified",
    },
  };
}

function unknownAction(label = "未知目标"): ActionFacts {
  return actionFacts(
    {
      kind: "unknown",
      targetLabel: label,
      mutatesState: "unknown",
      outsideWorkspace: "unknown",
      sensitive: "unknown",
      impactFacts: { effect: "unknown", createsParentDirectories: "unknown" },
      evidenceCodes: ["TOOL_IDENTITY_UNVERIFIED"],
    },
    {
      label,
      workspaceScope: "unknown",
      state: "unknown",
      linked: "unknown",
      supportedPath: "no",
      evidenceCodes: ["PATH_UNCERTAIN"],
    },
  );
}

test("A-009 file corpus distinguishes read, new file, modify, and overwrite", () => {
  const fixtures: Array<{
    name: string;
    action: ActionFacts;
    kind: "read" | "create" | "modify" | "overwrite";
    scope?: "bounded" | "limited";
  }> = [
    { name: "read", action: actionFacts(), kind: "read" },
    {
      name: "new file",
      action: actionFacts(
        {
          kind: "write",
          mutatesState: "yes",
          impactFacts: { effect: "create", createsParentDirectories: "no" },
        },
        { state: "new_file" },
      ),
      kind: "create",
    },
    {
      name: "new file with parent creation",
      action: actionFacts(
        {
          kind: "write",
          mutatesState: "yes",
          impactFacts: { effect: "create", createsParentDirectories: "yes" },
        },
        { state: "new_file" },
      ),
      kind: "create",
      scope: "limited",
    },
    {
      name: "modify file",
      action: actionFacts({
        kind: "edit",
        mutatesState: "yes",
        impactFacts: { effect: "edit", createsParentDirectories: "no" },
      }),
      kind: "modify",
    },
    {
      name: "overwrite file",
      action: actionFacts({
        kind: "write",
        mutatesState: "yes",
        impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
      }),
      kind: "overwrite",
    },
  ];

  for (const fixture of fixtures) {
    expect(
      predictEffects(fixture.action, assessRisk(fixture.action))[0],
      fixture.name,
    ).toMatchObject({
      kind: fixture.kind,
      certainty: "known",
      scope: fixture.scope ?? "bounded",
      applicationOutcome: "unverifiable",
    });
  }
});

test("A-009 consumes real file-classifier facts and keeps file target identity stable", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "agentglass-effects-"));
  temporaryDirectories.push(cwd);
  await writeFile(path.join(cwd, "note.txt"), "before", "utf8");
  const actions = await Promise.all([
    classifyFile(cwd, "read", "read", { path: "note.txt" }),
    classifyFile(cwd, "create", "write", {
      path: "new.txt",
      content: "new",
    }),
    classifyFile(cwd, "overwrite-a", "write", {
      path: "note.txt",
      content: "after-a",
    }),
    classifyFile(cwd, "overwrite-b", "write", {
      path: "note.txt",
      content: "after-b",
    }),
    classifyFile(cwd, "modify", "edit", {
      path: "note.txt",
      edits: [{ oldText: "before", newText: "after" }],
    }),
  ]);
  const effects = actions.map(
    (action) => predictEffects(action, assessRisk(action))[0],
  );

  expect(effects.map((effect) => effect?.kind)).toEqual([
    "read",
    "create",
    "overwrite",
    "overwrite",
    "modify",
  ]);
  expect(effects[0]?.targetId).toBe(effects[2]?.targetId);
  expect(effects[2]?.targetId).toBe(effects[3]?.targetId);
  expect(effects[2]?.effectId).not.toBe(effects[3]?.effectId);
});

test("A-009 shell corpus keeps broad deterministic families limited and unsupported effects unknown", () => {
  const action = unknownAction();
  const risk = assessRisk(action);
  const fixtures = [
    {
      name: "package dependency install",
      classification: classifyShellCommand("npm install", runtime("npm")),
      kind: "install",
      certainty: "known",
      scope: "limited",
    },
    {
      name: "network",
      classification: classifyShellCommand(
        "curl https://example.test",
        runtime("curl"),
      ),
      kind: "network",
      certainty: "known",
      scope: "limited",
    },
    {
      name: "process",
      classification: classifyShellCommand("kill 123", runtime("kill")),
      kind: "process",
      certainty: "known",
      scope: "limited",
    },
    {
      name: "unsupported shell",
      classification: classifyShellCommand("Get-Content note.txt", {
        ...runtime("Get-Content"),
        shell: "powershell",
      }),
      kind: "unsupported_shell",
      certainty: "unknown",
      scope: "unknown",
    },
    {
      name: "unknown command",
      classification: classifyShellCommand(
        "mystery-command note.txt",
        runtime("mystery-command"),
      ),
      kind: "unknown_command",
      certainty: "unknown",
      scope: "unknown",
    },
  ] as const;

  for (const fixture of fixtures) {
    expect(
      predictEffects(action, risk, fixture.classification)[0],
      fixture.name,
    ).toMatchObject({
      kind: fixture.kind,
      certainty: fixture.certainty,
      scope: fixture.scope,
      purpose: "unknown",
      applicationOutcome: "unverifiable",
    });
  }
});

test("A-009 never infers project functionality or target purpose from package.json", () => {
  const action = actionFacts(
    {
      kind: "write",
      targetLabel: "package.json",
      mutatesState: "yes",
      impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
    },
    { label: "package.json" },
  );
  const effect = predictEffects(action, assessRisk(action))[0];

  expect(effect).toMatchObject({
    kind: "overwrite",
    targetLabel: "package.json",
    purpose: "unknown",
    applicationOutcome: "unverifiable",
    descriptionKey: "effect.file.overwrite",
  });
  expect(JSON.stringify(effect)).not.toMatch(/run|working|success|正常运行/i);
});
