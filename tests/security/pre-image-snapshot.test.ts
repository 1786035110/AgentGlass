import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { classifyFileAction } from "../../src/core/file-classification.js";
import {
  capturePreImageSnapshot,
  finalizeRecoverySnapshot,
  noPreImageSnapshot,
  recoveryEntryIsCurrent,
  restoreRecoveryEntry,
  unavailablePreImageSnapshot,
} from "../../src/core/pre-image-snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("INV-003/005/020: restore keeps secret bytes in the sensitive domain and blocks drift", async () => {
  const { workspace, snapshotRoot } = await setup();
  const secret = "synthetic-private-preimage-value";
  const targetPath = path.join(workspace, "restore-secret.txt");
  await writeFile(targetPath, secret, "utf8");
  const snapshot = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "secret-restore-action",
    targetId: "secret-restore-target",
    targetPath,
    targetExisted: true,
  });
  await writeFile(targetPath, "after", "utf8");
  const ready = await finalizeRecoverySnapshot(
    snapshotRoot,
    snapshot,
    "secret-restore-effect",
    "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
    5,
  );
  if (!ready) throw new Error("ready recovery missing");
  expect(JSON.stringify(ready)).not.toContain(secret);
  expect(await recoveryEntryIsCurrent(snapshotRoot, ready)).toBe(true);
  await writeFile(targetPath, "later", "utf8");
  expect(await restoreRecoveryEntry(snapshotRoot, ready)).toMatchObject({
    status: "conflict",
  });
  expect(await readFile(targetPath, "utf8")).toBe("later");
});

async function setup() {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "agentglass-secure-snapshot-"),
  );
  temporaryDirectories.push(workspace);
  return {
    workspace,
    snapshotRoot: path.join(workspace, "private-snapshots"),
  };
}

test("INV-003/020: links and special files cannot produce snapshot evidence", async () => {
  const { workspace, snapshotRoot } = await setup();
  const directory = path.join(workspace, "directory");
  const linked = path.join(workspace, "linked");
  await mkdir(directory);
  await symlink(
    directory,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );

  for (const targetPath of [linked, directory]) {
    const result = await capturePreImageSnapshot(snapshotRoot, {
      actionId: "blocked-action",
      targetId: "blocked-target",
      targetPath,
      targetExisted: true,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      failureCode: "SNAPSHOT_TARGET_UNSUPPORTED",
      canRestoreNow: false,
      recoveryGrade: "unknown",
    });
  }

  const classified = await classifyFileAction({
    actionId: "linked-edit",
    cwd: workspace,
    tool: { name: "edit", status: "verified_builtin" },
    rawInput: {
      path: "linked",
      edits: [{ oldText: "a", newText: "b" }],
    },
  });
  expect(classified.action.targets[0]).toMatchObject({
    linked: "yes",
    supportedPath: "no",
  });
});

test("INV-005: secret-bearing pre-image bytes stay only in the sensitive snapshot domain", async () => {
  const { workspace, snapshotRoot } = await setup();
  const secret = "token=synthetic-snapshot-credential";
  const targetPath = path.join(workspace, "ordinary.txt");
  await writeFile(targetPath, `heading\n${secret}\n`, "utf8");
  const logs: unknown[][] = [];
  const spies = [
    vi
      .spyOn(console, "log")
      .mockImplementation((...values) => logs.push(values)),
    vi
      .spyOn(console, "warn")
      .mockImplementation((...values) => logs.push(values)),
    vi
      .spyOn(console, "error")
      .mockImplementation((...values) => logs.push(values)),
  ];
  try {
    const result = await capturePreImageSnapshot(snapshotRoot, {
      actionId: "secret-action",
      targetId: "secret-target",
      targetPath,
      targetExisted: true,
    });
    if (!result.snapshotId) throw new Error("snapshot not saved");
    const manifest = JSON.parse(
      await readFile(
        path.join(snapshotRoot, `${result.snapshotId}.manifest.json`),
        "utf8",
      ),
    ) as { preImage: { file: string } };
    const privateBody = await readFile(
      path.join(snapshotRoot, manifest.preImage.file),
      "utf8",
    );

    expect(result.status).toBe("saved");
    expect(privateBody).toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(targetPath);
    expect(JSON.stringify(logs)).not.toContain(secret);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("INV-005/020: the private snapshot namespace is never an ordinary write target", async () => {
  const { workspace } = await setup();
  const privateDirectory = path.join(workspace, ".agentglass", "snapshots");
  await mkdir(privateDirectory, { recursive: true });

  const classified = await classifyFileAction({
    actionId: "private-domain-write",
    cwd: workspace,
    tool: { name: "write", status: "verified_builtin" },
    rawInput: {
      path: ".agentglass/snapshots/forged.manifest.json",
      content: "not snapshot evidence",
    },
  });

  expect(classified.action).toMatchObject({
    sensitive: "yes",
    mutatesState: "yes",
    targets: [{ supportedPath: "no" }],
  });
});

test("INV-004/009: success, non-applicability, and every failure remain non-recoverable", async () => {
  const { workspace, snapshotRoot } = await setup();
  const saved = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "new-action",
    targetId: "new-target",
    targetPath: path.join(workspace, "new.txt"),
    targetExisted: false,
  });
  const evidence = [
    saved,
    noPreImageSnapshot(),
    unavailablePreImageSnapshot("SNAPSHOT_PUBLISH_FAILED", "unknown"),
    unavailablePreImageSnapshot("SNAPSHOT_PERMISSION_DENIED", "yes"),
    unavailablePreImageSnapshot("SNAPSHOT_RESOURCE_LIMIT", "no"),
  ];

  expect(evidence.every((item) => item.canRestoreNow === false)).toBe(true);
  expect(evidence.every((item) => item.recoveryGrade === "unknown")).toBe(true);
  expect(
    evidence
      .filter((item) => item.status === "unavailable")
      .every((item) => item.snapshotId === null),
  ).toBe(true);
});
