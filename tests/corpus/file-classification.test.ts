import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { HostToolIdentity } from "../../src/core/domain.js";
import { classifyFileAction } from "../../src/core/file-classification.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function classify(
  cwd: string,
  name: string,
  rawInput: unknown,
  status: HostToolIdentity["status"] = "verified_builtin",
) {
  return (
    await classifyFileAction({
      actionId: `action-${name}`,
      cwd,
      tool: { name, status },
      rawInput,
    })
  ).action;
}

test("A-005 file corpus covers supported classifications and neighboring blocks", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "agentglass-file-corpus-"));
  temporaryDirectories.push(base);
  const workspace = path.join(base, "app");
  const prefixNeighbor = path.join(base, "app2");
  await mkdir(workspace);
  await mkdir(prefixNeighbor);
  await writeFile(path.join(workspace, "note.txt"), "before", "utf8");
  await writeFile(
    path.join(workspace, ".env.example"),
    "EXAMPLE=value",
    "utf8",
  );
  await writeFile(path.join(prefixNeighbor, "outside.txt"), "outside", "utf8");

  const linkedDirectory = path.join(workspace, "linked");
  await symlink(
    prefixNeighbor,
    linkedDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );

  const cases = [
    {
      name: "ordinary project read",
      action: await classify(workspace, "read", { path: "note.txt" }),
      expected: {
        kind: "read",
        mutatesState: "no",
        outsideWorkspace: "no",
        sensitive: "no",
        impactFacts: { effect: "read", createsParentDirectories: "no" },
      },
      target: { state: "existing_file", linked: "no", supportedPath: "yes" },
    },
    {
      name: "sensitive read",
      action: await classify(workspace, "read", { path: ".env.example" }),
      expected: { kind: "read", sensitive: "yes" },
      target: { state: "existing_file", supportedPath: "no" },
    },
    {
      name: "create with new parents",
      action: await classify(workspace, "write", {
        path: "new/deep/file.txt",
        content: "new",
      }),
      expected: {
        kind: "write",
        mutatesState: "yes",
        impactFacts: { effect: "create", createsParentDirectories: "yes" },
      },
      target: { state: "new_file", supportedPath: "yes" },
    },
    {
      name: "missing read is not a supported file target",
      action: await classify(workspace, "read", { path: "missing.txt" }),
      expected: { kind: "read", impactFacts: { effect: "unknown" } },
      target: { state: "missing", supportedPath: "no" },
    },
    {
      name: "edit",
      action: await classify(workspace, "edit", {
        path: "note.txt",
        edits: [{ oldText: "before", newText: "after" }],
      }),
      expected: {
        kind: "edit",
        mutatesState: "yes",
        impactFacts: { effect: "edit", createsParentDirectories: "no" },
      },
      target: { state: "existing_file", supportedPath: "yes" },
    },
    {
      name: "overwrite",
      action: await classify(workspace, "write", {
        path: path.join(workspace, "note.txt"),
        content: "replacement",
      }),
      expected: { kind: "write", impactFacts: { effect: "overwrite" } },
      target: { state: "existing_file", supportedPath: "yes" },
    },
    {
      name: "secret-bearing content",
      action: await classify(workspace, "write", {
        path: "secret-output.txt",
        content: "token=synthetic-corpus-credential",
      }),
      expected: { kind: "write", sensitive: "yes" },
      target: { state: "new_file", supportedPath: "yes" },
    },
    {
      name: "prefix-similar outside workspace",
      action: await classify(workspace, "read", {
        path: path.join(prefixNeighbor, "outside.txt"),
      }),
      expected: { outsideWorkspace: "yes" },
      target: { workspaceScope: "outside", supportedPath: "no" },
    },
    {
      name: "parent traversal",
      action: await classify(workspace, "read", {
        path: "../app2/outside.txt",
      }),
      expected: { outsideWorkspace: "yes" },
      target: { workspaceScope: "outside", supportedPath: "no" },
    },
    {
      name: "resolved traversal remains inside workspace",
      action: await classify(workspace, "read", { path: "new/../note.txt" }),
      expected: { kind: "read", outsideWorkspace: "no" },
      target: { state: "existing_file", supportedPath: "yes" },
    },
    {
      name: "symlink traversal",
      action: await classify(workspace, "read", { path: "linked/outside.txt" }),
      expected: { outsideWorkspace: "yes" },
      target: { linked: "yes", supportedPath: "no" },
    },
    {
      name: "malformed path",
      action: await classify(workspace, "read", { path: "bad\0path" }),
      expected: { kind: "read", outsideWorkspace: "unknown" },
      target: { state: "unknown", supportedPath: "no" },
    },
    {
      name: "directory is not a regular file",
      action: await classify(workspace, "read", { path: "." }),
      expected: { kind: "read" },
      target: { state: "directory", supportedPath: "no" },
    },
    {
      name: "overridden same-name tool",
      action: await classify(
        workspace,
        "read",
        { path: "note.txt" },
        "overridden",
      ),
      expected: { kind: "unknown", mutatesState: "unknown" },
      target: { workspaceScope: "unknown", supportedPath: "no" },
    },
  ] as const;

  const distribution: Record<string, number> = {};
  for (const fixture of cases) {
    expect(fixture.action, fixture.name).toMatchObject(fixture.expected);
    expect(fixture.action.targets[0], fixture.name).toMatchObject(
      fixture.target,
    );
    distribution[fixture.action.kind] =
      (distribution[fixture.action.kind] ?? 0) + 1;
  }
  expect(cases[0].action.targets[0]?.evidenceCodes).toContain(
    "PATH_CWD_RELATIVE",
  );
  expect(cases[2].action.targets[0]?.evidenceCodes).toContain(
    "NEAREST_EXISTING_PARENT_VERIFIED",
  );
  expect(cases[5].action.targets[0]?.evidenceCodes).toContain("PATH_ABSOLUTE");
  expect(distribution).toEqual({ read: 9, write: 3, edit: 1, unknown: 1 });
  console.info(
    `A-005 classification distribution ${JSON.stringify(distribution)}`,
  );
});

test("A-005 validates the locked Pi read/write/edit schemas", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "agentglass-schema-corpus-"),
  );
  temporaryDirectories.push(workspace);
  await writeFile(path.join(workspace, "note.txt"), "before", "utf8");

  const malformed = [
    await classify(workspace, "read", { path: "note.txt", offset: "1" }),
    await classify(workspace, "write", { path: "new.txt" }),
    await classify(workspace, "edit", { path: "note.txt", edits: [] }),
    await classify(workspace, "edit", {
      path: "note.txt",
      edits: [{ oldText: "before" }],
    }),
  ];
  for (const action of malformed) {
    expect(action).toMatchObject({ kind: "unknown", mutatesState: "unknown" });
    expect(action.evidenceCodes).toContain("INPUT_INVALID");
  }
});

test("A-005 handles drive and UNC syntax deterministically", async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "agentglass-root-corpus-"),
  );
  temporaryDirectories.push(workspace);
  const driveRelative = await classify(workspace, "read", {
    path: "C:relative.txt",
  });
  const unc = await classify(workspace, "read", {
    path: "\\\\server\\share\\file.txt",
  });

  expect(driveRelative.targets[0]).toMatchObject({ supportedPath: "no" });
  expect(driveRelative.evidenceCodes).toContain(
    process.platform === "win32" ? "PATH_MALFORMED" : "PATH_FOREIGN_ROOT",
  );
  expect(unc).toMatchObject({ outsideWorkspace: "yes" });
  expect(unc.evidenceCodes).toContain("PATH_FOREIGN_ROOT");

  if (process.platform === "win32") {
    const device = await classify(workspace, "write", {
      path: "NUL.txt",
      content: "not-a-file",
    });
    expect(device.targets[0]).toMatchObject({
      state: "unknown",
      supportedPath: "no",
    });
    expect(device.evidenceCodes).toContain("PATH_MALFORMED");

    const uncWorkspace = await classify("\\\\server\\share\\project", "read", {
      path: "file.txt",
    });
    expect(uncWorkspace).toMatchObject({ outsideWorkspace: "unknown" });
    expect(uncWorkspace.targets[0]).toMatchObject({ supportedPath: "unknown" });
  }
});
