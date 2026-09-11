import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  capturePreImageSnapshot,
  cleanSnapshotSet,
  finalizeRecoverySnapshot,
  inspectCleanupSet,
  recoveryEntryIsCurrent,
  restoreRecoveryEntry,
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
    schemaVersion: 2,
    kind: "agentglass-single-file-recovery",
    state: "prepared",
    actionId: "action-existing",
    targetId: "target-existing",
    targetPath,
    targetExisted: true,
    preIdentity: { device: expect.any(String), inode: expect.any(String) },
    prePermissions: {
      platform: process.platform,
      mode: expect.any(Number),
      uid: expect.any(String),
      gid: expect.any(String),
    },
    postImage: null,
  });
  const permissions = saved.prePermissions as { acl: unknown };
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
    preIdentity: null,
    prePermissions: null,
    postImage: null,
  });
});

test("B-002 restores an overwritten file only while its post-image is unchanged", async () => {
  const { workspace, snapshotRoot } = await setup();
  const targetPath = path.join(workspace, "restore.txt");
  await writeFile(targetPath, "before", "utf8");
  if (process.platform !== "win32") await chmod(targetPath, 0o640);
  const snapshot = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "restore-action",
    targetId: "restore-target",
    targetPath,
    targetExisted: true,
  });
  await writeFile(targetPath, "after", "utf8");
  const ready = await finalizeRecoverySnapshot(
    snapshotRoot,
    snapshot,
    "restore-effect",
    "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
    5,
  );
  expect(ready).toBeDefined();
  if (!ready) throw new Error("recovery was not finalized");
  expect(await recoveryEntryIsCurrent(snapshotRoot, ready)).toBe(true);
  expect(await restoreRecoveryEntry(snapshotRoot, ready)).toEqual({
    status: "restored",
    content: "matched",
    permissions: "matched",
  });
  expect(await readFile(targetPath, "utf8")).toBe("before");
  expect(await recoveryEntryIsCurrent(snapshotRoot, ready)).toBe(false);
});

test("B-002 deletes only the proven newly created file and preserves drift", async () => {
  const first = await setup();
  const createdPath = path.join(first.workspace, "created.txt");
  const createdSnapshot = await capturePreImageSnapshot(first.snapshotRoot, {
    actionId: "create-action",
    targetId: "create-target",
    targetPath: createdPath,
    targetExisted: false,
  });
  await writeFile(createdPath, "created", "utf8");
  const created = await finalizeRecoverySnapshot(
    first.snapshotRoot,
    createdSnapshot,
    "create-effect",
    "406effb1e9c59672c66a598c2b21e331b23b16c54024e96d6df3e7c173549791",
    7,
  );
  if (!created) throw new Error("creation recovery missing");
  expect(await restoreRecoveryEntry(first.snapshotRoot, created)).toEqual({
    status: "restored",
    content: "missing",
    permissions: "not_applicable",
  });
  await expect(readFile(createdPath)).rejects.toMatchObject({ code: "ENOENT" });

  const second = await setup();
  const driftPath = path.join(second.workspace, "drift.txt");
  await writeFile(driftPath, "before", "utf8");
  const driftSnapshot = await capturePreImageSnapshot(second.snapshotRoot, {
    actionId: "drift-action",
    targetId: "drift-target",
    targetPath: driftPath,
    targetExisted: true,
  });
  await writeFile(driftPath, "after", "utf8");
  const drift = await finalizeRecoverySnapshot(
    second.snapshotRoot,
    driftSnapshot,
    "drift-effect",
    "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
    5,
  );
  if (!drift) throw new Error("drift recovery missing");
  await writeFile(driftPath, "later edit", "utf8");
  expect(await restoreRecoveryEntry(second.snapshotRoot, drift)).toMatchObject({
    status: "conflict",
  });
  expect(await readFile(driftPath, "utf8")).toBe("later edit");
});

test("B-002 cleanup binds the verified set and preserves corrupt/future data", async () => {
  const { workspace, snapshotRoot } = await setup();
  const targetPath = path.join(workspace, "clean.txt");
  await writeFile(targetPath, "before", "utf8");
  const legacySnapshot = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "clean-action",
    targetId: "clean-target",
    targetPath,
    targetExisted: true,
  });
  if (!legacySnapshot.snapshotId) throw new Error("legacy snapshot missing");
  const legacyPath = path.join(
    snapshotRoot,
    `${legacySnapshot.snapshotId}.manifest.json`,
  );
  const versionTwo = JSON.parse(await readFile(legacyPath, "utf8"));
  await writeFile(
    legacyPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "agentglass-pre-image",
      snapshotId: versionTwo.snapshotId,
      actionId: versionTwo.actionId,
      targetId: versionTwo.targetId,
      targetPath: versionTwo.targetPath,
      targetExisted: versionTwo.targetExisted,
      preImage: versionTwo.preImage,
      fileIdentity: versionTwo.preIdentity,
      permissions: versionTwo.prePermissions,
      canRestoreNow: false,
      recoveryGrade: "unknown",
    }),
    "utf8",
  );
  const interrupted = path.join(
    snapshotRoot,
    ".00000000-0000-4000-8000-000000000002.manifest.json.tmp",
  );
  await writeFile(interrupted, "incomplete", "utf8");
  const corrupt = path.join(
    snapshotRoot,
    "00000000-0000-4000-8000-000000000000.manifest.json",
  );
  await writeFile(corrupt, "{broken", "utf8");
  const approved = await inspectCleanupSet(snapshotRoot);
  expect(approved.fileCount).toBe(2);
  await capturePreImageSnapshot(snapshotRoot, {
    actionId: "changed-clean-action",
    targetId: "changed-clean-target",
    targetPath: path.join(workspace, "not-created.txt"),
    targetExisted: false,
  });
  expect(await cleanSnapshotSet(snapshotRoot, approved)).toEqual({
    deleted: 0,
    failed: 0,
    changed: true,
    deletedFiles: [],
  });
  const current = await inspectCleanupSet(snapshotRoot);
  expect(current.fileCount).toBe(3);
  await writeFile(
    path.join(
      snapshotRoot,
      "00000000-0000-4000-8000-000000000001.manifest.json",
    ),
    JSON.stringify({ schemaVersion: 99 }),
    "utf8",
  );
  expect(await cleanSnapshotSet(snapshotRoot, current)).toMatchObject({
    deleted: 3,
    failed: 0,
    changed: false,
  });
  expect(await readFile(corrupt, "utf8")).toBe("{broken");
  expect(await readFile(interrupted, "utf8")).toBe("incomplete");
});

test("B-002 refuses schema v1, future, corrupt, and prepared-only data as recovery authorization", async () => {
  for (const replacement of [
    { schemaVersion: 1, kind: "agentglass-pre-image" },
    { schemaVersion: 99, kind: "agentglass-single-file-recovery" },
    "{broken",
  ]) {
    const { workspace, snapshotRoot } = await setup();
    const targetPath = path.join(workspace, "versioned.txt");
    await writeFile(targetPath, "before", "utf8");
    const snapshot = await capturePreImageSnapshot(snapshotRoot, {
      actionId: "version-action",
      targetId: "version-target",
      targetPath,
      targetExisted: true,
    });
    if (!snapshot.snapshotId) throw new Error("snapshot missing");
    const manifestPath = path.join(
      snapshotRoot,
      `${snapshot.snapshotId}.manifest.json`,
    );
    if (typeof replacement === "string") {
      await writeFile(manifestPath, replacement, "utf8");
    } else {
      const original = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(
        manifestPath,
        JSON.stringify({ ...original, ...replacement }),
        "utf8",
      );
    }
    await writeFile(targetPath, "after", "utf8");
    expect(
      await finalizeRecoverySnapshot(
        snapshotRoot,
        snapshot,
        "version-effect",
        "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
        5,
      ),
    ).toBeUndefined();
  }
});

test("B-002 cleanup reports partial deletion and retains the failed item", async () => {
  const { workspace, snapshotRoot } = await setup();
  const targetPath = path.join(workspace, "partial.txt");
  await writeFile(targetPath, "before", "utf8");
  await capturePreImageSnapshot(snapshotRoot, {
    actionId: "partial-action",
    targetId: "partial-target",
    targetPath,
    targetExisted: true,
  });
  const approved = await inspectCleanupSet(snapshotRoot);
  let attempt = 0;
  const result = await cleanSnapshotSet(
    snapshotRoot,
    approved,
    async (filePath) => {
      attempt += 1;
      if (attempt === 2) throw new Error("synthetic deletion failure");
      await unlink(filePath);
    },
  );
  expect(result).toMatchObject({ deleted: 1, failed: 1, changed: false });
  expect(await readdir(snapshotRoot)).toHaveLength(1);
});

test("B-002 consumes a failed restore without retrying or recreating authorization", async () => {
  const { workspace, snapshotRoot } = await setup();
  const targetPath = path.join(workspace, "failed-restore.txt");
  await writeFile(targetPath, "before", "utf8");
  const snapshot = await capturePreImageSnapshot(snapshotRoot, {
    actionId: "failed-restore-action",
    targetId: "failed-restore-target",
    targetPath,
    targetExisted: true,
  });
  await writeFile(targetPath, "after", "utf8");
  const ready = await finalizeRecoverySnapshot(
    snapshotRoot,
    snapshot,
    "failed-restore-effect",
    "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
    5,
  );
  if (!ready) throw new Error("ready recovery missing");
  await unlink(path.join(snapshotRoot, `${ready.snapshotId}.preimage`));
  expect(await restoreRecoveryEntry(snapshotRoot, ready)).toMatchObject({
    status: "failed",
    content: "unknown",
  });
  expect(await readFile(targetPath, "utf8")).toBe("after");
  expect(await recoveryEntryIsCurrent(snapshotRoot, ready)).toBe(false);
});

test("B-002 rejects identity, link, and permission drift before restore", async () => {
  const makeReady = async (name: string) => {
    const fixture = await setup();
    const targetPath = path.join(fixture.workspace, `${name}.txt`);
    await writeFile(targetPath, "before", "utf8");
    const snapshot = await capturePreImageSnapshot(fixture.snapshotRoot, {
      actionId: `${name}-action`,
      targetId: `${name}-target`,
      targetPath,
      targetExisted: true,
    });
    await writeFile(targetPath, "after", "utf8");
    const ready = await finalizeRecoverySnapshot(
      fixture.snapshotRoot,
      snapshot,
      `${name}-effect`,
      "f39592393ef0859cb196a52693d2cea00fb2df784b3c04ae54aa7cadb8e562f8",
      5,
    );
    if (!ready) throw new Error("ready recovery missing");
    return { ...fixture, targetPath, ready };
  };

  const identity = await makeReady("identity");
  await unlink(identity.targetPath);
  await writeFile(identity.targetPath, "after", "utf8");
  expect(
    await recoveryEntryIsCurrent(identity.snapshotRoot, identity.ready),
  ).toBe(false);

  const linked = await makeReady("linked");
  await link(linked.targetPath, path.join(linked.workspace, "alias.txt"));
  expect(await recoveryEntryIsCurrent(linked.snapshotRoot, linked.ready)).toBe(
    false,
  );

  const permissions = await makeReady("permissions");
  await chmod(permissions.targetPath, 0o444);
  expect(
    await recoveryEntryIsCurrent(permissions.snapshotRoot, permissions.ready),
  ).toBe(false);
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
