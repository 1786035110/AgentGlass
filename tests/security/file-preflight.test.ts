import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { classifyFileAction } from "../../src/core/file-classification.js";
import { REDACTION_MARKER } from "../../src/core/input-boundary.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function readAction(cwd: string, filePath: string) {
  return classifyFileAction({
    actionId: "security-read",
    cwd,
    tool: { name: "read", status: "verified_builtin" },
    rawInput: { path: filePath },
  });
}

test("INV-016/020: real-path evidence uses raw path before redaction", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "agentglass-raw-path-"));
  temporaryDirectories.push(workspace);
  const secretName = "token=synthetic-path-credential.txt";
  await writeFile(path.join(workspace, secretName), "safe", "utf8");

  const { action, input } = await readAction(workspace, secretName);
  expect((input.redactedInput as unknown as { path: string }).path).toBe(
    REDACTION_MARKER,
  );
  expect(action).toMatchObject({ sensitive: "yes", outsideWorkspace: "no" });
  expect(action.targets[0]).toMatchObject({
    label: REDACTION_MARKER,
    state: "existing_file",
    supportedPath: "no",
  });
});

test("INV-020: prefix neighbors, symlinks, hard links, and non-files cannot enter the ordinary path", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "agentglass-path-boundary-"));
  temporaryDirectories.push(base);
  const workspace = path.join(base, "app");
  const neighbor = path.join(base, "app2");
  await mkdir(workspace);
  await mkdir(neighbor);
  const original = path.join(workspace, "original.txt");
  const hardLink = path.join(workspace, "hard-link.txt");
  await writeFile(original, "content", "utf8");
  await link(original, hardLink);
  await symlink(
    neighbor,
    path.join(workspace, "junction"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const outside = (await readAction(workspace, path.join(neighbor, "file.txt")))
    .action;
  const linked = (await readAction(workspace, "junction/file.txt")).action;
  const hardLinked = (await readAction(workspace, "hard-link.txt")).action;
  const directory = (await readAction(workspace, ".")).action;

  expect(outside.targets[0]).toMatchObject({
    workspaceScope: "outside",
    supportedPath: "no",
  });
  expect(linked.targets[0]).toMatchObject({
    linked: "yes",
    supportedPath: "no",
  });
  expect(hardLinked.targets[0]).toMatchObject({
    linked: "yes",
    supportedPath: "no",
  });
  expect(directory.targets[0]).toMatchObject({
    state: "directory",
    supportedPath: "no",
  });
});

test("INV-003/020: missing workspace and malformed target remain unknown", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "agentglass-path-failure-"));
  temporaryDirectories.push(base);

  const missingWorkspace = (
    await readAction(path.join(base, "missing"), "note.txt")
  ).action;
  const malformed = (await readAction(base, "bad\0path")).action;
  expect(missingWorkspace).toMatchObject({ outsideWorkspace: "unknown" });
  expect(missingWorkspace.targets[0]).toMatchObject({
    supportedPath: "unknown",
  });
  expect(malformed).toMatchObject({ outsideWorkspace: "unknown" });
  expect(malformed.targets[0]).toMatchObject({ supportedPath: "no" });
});
