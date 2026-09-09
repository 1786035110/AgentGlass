import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  capturePreImageSnapshot,
  SNAPSHOT_ENTRY_LIMIT,
  SNAPSHOT_FILE_LIMIT_BYTES,
  SNAPSHOT_TOTAL_LIMIT_BYTES,
  verifyPreImageSnapshotBaseline,
} from "../../src/core/pre-image-snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const workspace = await mkdtemp(path.join(tmpdir(), "agentglass-snapshot-"));
  temporaryDirectories.push(workspace);
  return {
    workspace,
    snapshotRoot: path.join(workspace, "private-snapshots"),
  };
}

async function manifest(snapshotRoot: string, snapshotId: string | null) {
  if (!snapshotId) throw new Error("missing snapshot id");
  return JSON.parse(
    await readFile(
      path.join(snapshotRoot, `${snapshotId}.manifest.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

test("captures an existing regular file, its identity, bytes, and permissions", async () => {
  const { workspace, snapshotRoot } = await setup();
  const targetPath = path.join(workspace, "note.txt");
  await writeFile(targetPath, "before", "utf8");
  if (process.platform !== "win32") await chmod(targetPath, 0o640);

  const result = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "action-existing",
    targetId: "target-existing",
    targetPath,
    targetExisted: true,
  });
  expect(result).toMatchObject({
    status: "saved",
    targetExisted: "yes",
    permissionMetadata: "captured",
    failureCode: null,
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
  const saved = await manifest(snapshotRoot, result.snapshotId);
  expect(saved).toMatchObject({
    schemaVersion: 1,
    kind: "agentglass-pre-image",
    actionId: "action-existing",
    targetId: "target-existing",
    targetPath,
    targetExisted: true,
    fileIdentity: { device: expect.any(String), inode: expect.any(String) },
    permissions: {
      platform: process.platform,
      mode: expect.any(Number),
      uid: expect.any(String),
      gid: expect.any(String),
    },
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
  const permissions = saved.permissions as { acl: unknown };
  expect(permissions.acl).toEqual(
    process.platform === "win32"
      ? { format: "sddl", value: expect.any(String) }
      : null,
  );
  const preImage = saved.preImage as { file: string; byteLength: number };
  expect(preImage.byteLength).toBe(6);
  expect(await readFile(path.join(snapshotRoot, preImage.file), "utf8")).toBe(
    "before",
  );
});

test("records a new file as not existing without inventing permissions", async () => {
  const { workspace, snapshotRoot } = await setup();
  const targetPath = path.join(workspace, "new.txt");
  const result = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "action-new",
    targetId: "target-new",
    targetPath,
    targetExisted: false,
  });

  expect(result).toMatchObject({
    status: "saved",
    targetExisted: "no",
    permissionMetadata: "not_applicable",
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
  expect(await manifest(snapshotRoot, result.snapshotId)).toMatchObject({
    targetExisted: false,
    preImage: null,
    fileIdentity: null,
    permissions: null,
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
});

test("approval baseline rejects a changed existing file or newly appeared file", async () => {
  const existing = await setup();
  const existingPath = path.join(existing.workspace, "existing.txt");
  await writeFile(existingPath, "before", "utf8");
  const existingTarget = {
    actionId: "action-existing-baseline",
    targetId: "target-existing-baseline",
    targetPath: existingPath,
    targetExisted: true,
  };
  const existingSnapshot = await capturePreImageSnapshot(
    existing.snapshotRoot,
    existingTarget,
  );
  expect(
    await verifyPreImageSnapshotBaseline(
      existing.snapshotRoot,
      existingSnapshot,
      existingTarget,
    ),
  ).toBe(true);
  await writeFile(existingPath, "changed", "utf8");
  expect(
    await verifyPreImageSnapshotBaseline(
      existing.snapshotRoot,
      existingSnapshot,
      existingTarget,
    ),
  ).toBe(false);

  const created = await setup();
  const newPath = path.join(created.workspace, "new.txt");
  const absenceTarget = {
    actionId: "action-absence-baseline",
    targetId: "target-absence-baseline",
    targetPath: newPath,
    targetExisted: false,
  };
  const absenceSnapshot = await capturePreImageSnapshot(
    created.snapshotRoot,
    absenceTarget,
  );
  expect(
    await verifyPreImageSnapshotBaseline(
      created.snapshotRoot,
      absenceSnapshot,
      absenceTarget,
    ),
  ).toBe(true);
  await writeFile(newPath, "appeared", "utf8");
  expect(
    await verifyPreImageSnapshotBaseline(
      created.snapshotRoot,
      absenceSnapshot,
      absenceTarget,
    ),
  ).toBe(false);
});

test("approval baseline rejects an oversized manifest through the bounded reader", async () => {
  const fixture = await setup();
  const targetPath = path.join(fixture.workspace, "bounded.txt");
  await writeFile(targetPath, "before", "utf8");
  const target = {
    actionId: "action-bounded-manifest",
    targetId: "target-bounded-manifest",
    targetPath,
    targetExisted: true,
  };
  const snapshot = await capturePreImageSnapshot(fixture.snapshotRoot, target);
  if (!snapshot.snapshotId) throw new Error("snapshot was not saved");
  await writeFile(
    path.join(fixture.snapshotRoot, `${snapshot.snapshotId}.manifest.json`),
    "x".repeat(64 * 1024 + 1),
    "utf8",
  );

  expect(
    await verifyPreImageSnapshotBaseline(
      fixture.snapshotRoot,
      snapshot,
      target,
    ),
  ).toBe(false);
});

test("downgrades per-file and total resource limit failures", async () => {
  const first = await setup();
  const oversized = path.join(first.workspace, "oversized.txt");
  await writeFile(oversized, "", "utf8");
  await truncate(oversized, SNAPSHOT_FILE_LIMIT_BYTES + 1);
  const fileLimit = await capturePreImageSnapshot(first.snapshotRoot, {
    actionId: "action-large",
    targetId: "target-large",
    targetPath: oversized,
    targetExisted: true,
  });

  const second = await setup();
  await mkdir(second.snapshotRoot, { recursive: true });
  await writeFile(
    path.join(
      second.snapshotRoot,
      "00000000-0000-0000-0000-000000000000.preimage",
    ),
    "",
    { flag: "wx" },
  );
  await truncate(
    path.join(
      second.snapshotRoot,
      "00000000-0000-0000-0000-000000000000.preimage",
    ),
    SNAPSHOT_TOTAL_LIMIT_BYTES,
  );
  const totalLimit = await capturePreImageSnapshot(second.snapshotRoot, {
    actionId: "action-total",
    targetId: "target-total",
    targetPath: path.join(second.workspace, "new.txt"),
    targetExisted: false,
  });

  expect(fileLimit).toMatchObject({
    status: "unavailable",
    failureCode: "SNAPSHOT_FILE_TOO_LARGE",
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
  expect(totalLimit).toMatchObject({
    status: "unavailable",
    failureCode: "SNAPSHOT_RESOURCE_LIMIT",
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
});

test("counts the body and manifest before enforcing the entry limit", async () => {
  const { workspace, snapshotRoot } = await setup();
  await mkdir(snapshotRoot, { recursive: true });
  // 使用真实目录条目走完整扫描，避免用 mock 把配额边界测成实现细节。
  for (let start = 0; start < SNAPSHOT_ENTRY_LIMIT - 1; start += 128) {
    await Promise.all(
      Array.from(
        {
          length: Math.min(128, SNAPSHOT_ENTRY_LIMIT - 1 - start),
        },
        (_value, offset) =>
          writeFile(
            path.join(
              snapshotRoot,
              `${(start + offset).toString(16).padStart(8, "0")}-0000-0000-0000-000000000000.preimage`,
            ),
            "",
            { flag: "wx" },
          ),
      ),
    );
  }
  const targetPath = path.join(workspace, "existing.txt");
  await writeFile(targetPath, "before", "utf8");

  const result = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "action-entry-limit",
    targetId: "target-entry-limit",
    targetPath,
    targetExisted: true,
  });

  expect(result).toMatchObject({
    status: "unavailable",
    snapshotId: null,
    failureCode: "SNAPSHOT_RESOURCE_LIMIT",
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
  expect(await readdir(snapshotRoot)).toHaveLength(SNAPSHOT_ENTRY_LIMIT - 1);
});

test.each([
  ["permission_error", "SNAPSHOT_PERMISSION_DENIED"],
  ["disk_full", "SNAPSHOT_RESOURCE_LIMIT"],
] as const)(
  "downgrades injected %s without a recovery claim",
  async (fault, code) => {
    const { workspace, snapshotRoot } = await setup();
    const result = await capturePreImageSnapshot(
      snapshotRoot,
      {
        actionId: `action-${fault}`,
        targetId: `target-${fault}`,
        targetPath: path.join(workspace, "new.txt"),
        targetExisted: false,
      },
      fault,
    );
    expect(result).toMatchObject({
      status: "unavailable",
      snapshotId: null,
      failureCode: code,
      canRestoreNow: false,
      recoveryGrade: "unknown",
    });
  },
);

test("an interrupted publish leaves no manifest or recoverable evidence", async () => {
  const { workspace, snapshotRoot } = await setup();
  const targetPath = path.join(workspace, "note.txt");
  await writeFile(targetPath, "before", "utf8");
  const result = await capturePreImageSnapshot(
    snapshotRoot,
    {
      actionId: "action-interrupted",
      targetId: "target-interrupted",
      targetPath,
      targetExisted: true,
    },
    "interrupted_publish",
  );

  expect(result).toMatchObject({
    status: "unavailable",
    failureCode: "SNAPSHOT_PUBLISH_FAILED",
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
  expect(await readdir(snapshotRoot)).toEqual([]);
});
