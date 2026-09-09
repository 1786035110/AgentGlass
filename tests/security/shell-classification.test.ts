import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  classifyShellCommand,
  type ShellRuntimeEvidence,
} from "../../src/core/shell-classification.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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
      kind: command === "pwd" ? "builtin" : "executable",
      resolvedPath: command === "pwd" ? null : `/usr/bin/${command}`,
      supportedSemantics: "verified",
    },
  };
}

test("INV-001/003: dangerous fixtures are pure analysis and never execute", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agentglass-shell-pure-"),
  );
  temporaryDirectories.push(directory);
  const sentinel = path.join(directory, "must-remain.txt");
  await writeFile(sentinel, "unchanged", "utf8");

  const destructive = [
    "rm must-remain.txt",
    "find . -delete",
    "git reset --hard HEAD",
    "sed -i s/a/b/ must-remain.txt",
  ];
  for (const command of destructive) {
    const executable = command.split(" ", 1)[0] ?? "";
    expect(classifyShellCommand(command, runtime(executable))).toMatchObject({
      decision: "block",
      family: "destructive",
      reasonCodes: ["DESTRUCTIVE_FILE_OPERATION"],
      mutatesState: "yes",
    });
  }

  await access(sentinel);
  expect(await readFile(sentinel, "utf8")).toBe("unchanged");
});

test("INV-003/020: every missing fast-path runtime fact fails closed", () => {
  const base = runtime("cat");
  const cases: ShellRuntimeEvidence[] = [
    { ...base, shell: "unknown" },
    { ...base, nonInteractive: "unknown" },
    { ...base, environment: "unknown" },
    { ...base, pathLookup: "unknown" },
    { ...base, alias: "unknown" },
    { ...base, function: "unknown" },
    { ...base, commandResolution: { status: "unknown" } },
    {
      ...base,
      commandResolution: {
        status: "verified",
        name: "cat",
        kind: "executable",
        resolvedPath: "/usr/bin/cat",
        supportedSemantics: "unknown",
      },
    },
  ];

  for (const evidence of cases) {
    const classified = classifyShellCommand("cat note.txt", evidence);
    expect(classified.decision).toBe("block");
    expect(classified.reasonCodes).toContain("PREFLIGHT_FAILED");
    expect(classified.shellAssumption).toBe("none");
  }

  const hostileRuntime = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error("synthetic preflight failure");
      },
    },
  );
  expect(classifyShellCommand("cat note.txt", null)).toMatchObject({
    decision: "block",
    reasonCodes: ["PREFLIGHT_FAILED"],
  });
  expect(classifyShellCommand("cat note.txt", hostileRuntime)).toMatchObject({
    decision: "block",
    reasonCodes: ["PREFLIGHT_FAILED"],
  });
});

test("INV-002/016: unsupported and PowerShell inputs cannot become fast-path candidates or leak arguments", () => {
  const secret = "synthetic-shell-secret-value";
  const unsupported = classifyShellCommand(
    `mystery-command ${secret}`,
    runtime("mystery-command"),
  );
  const powershell = classifyShellCommand(`Get-Content ${secret}`, {
    ...runtime("Get-Content"),
    shell: "powershell",
  });
  const unsupportedGit = classifyShellCommand(`git ${secret}`, runtime("git"));
  const neighbor = classifyShellCommand("echo rm note.txt", runtime("echo"));

  expect(unsupported).toMatchObject({
    decision: "ask",
    reasonCodes: ["UNSUPPORTED_COMMAND"],
  });
  expect(powershell).toMatchObject({
    decision: "ask",
    reasonCodes: ["POWERSHELL_UNSUPPORTED"],
  });
  expect(neighbor.reasonCodes).not.toContain("DESTRUCTIVE_FILE_OPERATION");
  expect(unsupportedGit).toMatchObject({
    decision: "ask",
    evidenceCodes: ["GIT_SUBCOMMAND_UNSUPPORTED"],
  });
  expect(
    JSON.stringify({ unsupported, powershell, unsupportedGit }),
  ).not.toContain(secret);
});
