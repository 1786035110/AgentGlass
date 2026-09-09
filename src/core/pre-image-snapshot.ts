import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  PreImageSnapshotEvidence,
  SnapshotFailureCode,
} from "./domain.js";

export const SNAPSHOT_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
export const SNAPSHOT_TOTAL_LIMIT_BYTES = 100 * 1024 * 1024;
export const SNAPSHOT_ENTRY_LIMIT = 4096;
const MANIFEST_LIMIT_BYTES = 64 * 1024;
const LOCK_NAME = ".snapshot.lock";
const execFileAsync = promisify(execFile);

export interface SensitiveSnapshotTarget {
  actionId: string;
  targetId: string;
  targetPath: string;
  targetExisted: boolean;
}

export type SnapshotFailureInjection =
  | "permission_error"
  | "disk_full"
  | "interrupted_publish";

interface SnapshotManifestV1 {
  schemaVersion: 1;
  kind: "agentglass-pre-image";
  snapshotId: string;
  actionId: string;
  targetId: string;
  targetPath: string;
  targetExisted: boolean;
  preImage: null | {
    file: string;
    byteLength: number;
    sha256: string;
  };
  fileIdentity: null | {
    device: string;
    inode: string;
  };
  permissions: null | {
    platform: NodeJS.Platform;
    mode: number;
    uid: string;
    gid: string;
    acl: null | { format: "sddl"; value: string };
  };
  canRestoreNow: false;
  recoveryGrade: "unknown";
}

class SnapshotError extends Error {
  constructor(readonly code: SnapshotFailureCode) {
    super(code);
  }
}

const WINDOWS_PRIVATE_DIRECTORY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:AGENTGLASS_SNAPSHOT_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
(New-Object System.IO.DirectoryInfo($p)).SetAccessControl($acl)
`;

const WINDOWS_VERIFY_PRIVATE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:AGENTGLASS_SNAPSHOT_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$item = if ([System.IO.Directory]::Exists($p)) { New-Object System.IO.DirectoryInfo($p) } elseif ([System.IO.File]::Exists($p)) { New-Object System.IO.FileInfo($p) } else { exit 1 }
$acl = $item.GetAccessControl()
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$allows = @($rules | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
if ($owner -ne $sid -or $allows.Count -lt 1 -or @($allows | Where-Object { $_.IdentityReference.Value -ne $sid }).Count -ne 0) { exit 1 }
`;

const WINDOWS_PRIVATE_FILE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:AGENTGLASS_SNAPSHOT_ACL_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
(New-Object System.IO.FileInfo($p)).SetAccessControl($acl)
`;

const WINDOWS_READ_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:AGENTGLASS_SNAPSHOT_ACL_PATH
$item = if ([System.IO.File]::Exists($p)) { New-Object System.IO.FileInfo($p) } else { exit 1 }
$sddl = $item.GetAccessControl().GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)
[Console]::Out.Write($sddl)
`;

function evidence(
  values: Partial<PreImageSnapshotEvidence> = {},
): PreImageSnapshotEvidence {
  return Object.freeze({
    status: "not_applicable",
    snapshotId: null,
    targetExisted: "unknown",
    permissionMetadata: "unknown",
    failureCode: null,
    canRestoreNow: false,
    recoveryGrade: "unknown",
    ...values,
  });
}

export function noPreImageSnapshot(): PreImageSnapshotEvidence {
  return evidence();
}

export function unavailablePreImageSnapshot(
  failureCode: SnapshotFailureCode,
  targetExisted: PreImageSnapshotEvidence["targetExisted"] = "unknown",
): PreImageSnapshotEvidence {
  return evidence({ status: "unavailable", failureCode, targetExisted });
}

function fail(code: SnapshotFailureCode): never {
  throw new SnapshotError(code);
}

function mapFailure(error: unknown): SnapshotFailureCode {
  if (error instanceof SnapshotError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "EACCES" || error.code === "EPERM")
      return "SNAPSHOT_PERMISSION_DENIED";
    if (error.code === "ENOSPC" || error.code === "EDQUOT")
      return "SNAPSHOT_RESOURCE_LIMIT";
    if (error.code === "EEXIST") return "SNAPSHOT_STORAGE_BUSY";
  }
  return "SNAPSHOT_PUBLISH_FAILED";
}

async function runPowerShell(script: string, target: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const windowsRoot = path.parse(process.env.SystemRoot ?? "C:\\Windows").root;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        SystemDrive: windowsRoot.slice(0, 2),
        ProgramData: path.join(windowsRoot, "ProgramData"),
        AGENTGLASS_SNAPSHOT_ACL_PATH: target,
      },
    },
  );
  return stdout;
}

async function readWindowsTargetAcl(target: string): Promise<string> {
  const acl = await runPowerShell(WINDOWS_READ_ACL_SCRIPT, target);
  if (acl.length === 0 || Buffer.byteLength(acl, "utf8") > 32 * 1024)
    fail("SNAPSHOT_PERMISSION_DENIED");
  return acl;
}

async function secureStorageRoot(snapshotRoot: string): Promise<void> {
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const root = await lstat(snapshotRoot);
  if (root.isSymbolicLink() || !root.isDirectory())
    fail("SNAPSHOT_STORAGE_UNSAFE");

  if (process.platform === "win32") {
    try {
      // Node 的 mode 位在 Windows 上不能证明 ACL 私有；发布前用系统 ACL API 固定并复核。
      await runPowerShell(
        WINDOWS_PRIVATE_DIRECTORY_SCRIPT + WINDOWS_VERIFY_PRIVATE_ACL_SCRIPT,
        snapshotRoot,
      );
    } catch {
      fail("SNAPSHOT_STORAGE_UNSAFE");
    }
    return;
  }

  await chmod(snapshotRoot, 0o700);
  if (((await stat(snapshotRoot)).mode & 0o777) !== 0o700)
    fail("SNAPSHOT_STORAGE_UNSAFE");
}

function validStorageEntry(name: string): boolean {
  return (
    name === LOCK_NAME ||
    /^[0-9a-f-]{36}\.(?:preimage|manifest\.json)$/.test(name) ||
    /^\.[0-9a-f-]{36}\.(?:preimage|manifest\.json)\.tmp$/.test(name)
  );
}

async function storageUsage(snapshotRoot: string): Promise<{
  bytes: number;
  publishedEntries: number;
}> {
  const entries = await readdir(snapshotRoot, { withFileTypes: true });
  if (entries.length > SNAPSHOT_ENTRY_LIMIT) fail("SNAPSHOT_RESOURCE_LIMIT");
  let total = 0;
  let publishedEntries = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !validStorageEntry(entry.name))
      fail("SNAPSHOT_STORAGE_UNSAFE");
    if (entry.name !== LOCK_NAME) publishedEntries += 1;
    total += (await lstat(path.join(snapshotRoot, entry.name))).size;
    if (total > SNAPSHOT_TOTAL_LIMIT_BYTES) fail("SNAPSHOT_RESOURCE_LIMIT");
  }
  return { bytes: total, publishedEntries };
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBounded(
  targetPath: string,
  limit = SNAPSHOT_FILE_LIMIT_BYTES,
): Promise<{
  bytes: Buffer;
  stats: Awaited<ReturnType<typeof lstat>>;
}> {
  const before = await lstat(targetPath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
    fail("SNAPSHOT_TARGET_UNSUPPORTED");
  if (before.size > limit) fail("SNAPSHOT_FILE_TOO_LARGE");

  const flags =
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(targetPath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFile(before, opened))
      fail("SNAPSHOT_TARGET_CHANGED");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) fail("SNAPSHOT_FILE_TOO_LARGE");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    if (
      !sameFile(opened, after) ||
      after.size !== total ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.mode !== opened.mode
    ) {
      fail("SNAPSHOT_TARGET_CHANGED");
    }
    return { bytes: Buffer.concat(chunks, total), stats: after };
  } finally {
    await handle.close();
  }
}

async function targetStillMatches(
  target: SensitiveSnapshotTarget,
  expected?: Awaited<ReturnType<typeof lstat>>,
): Promise<boolean> {
  try {
    const current = await lstat(target.targetPath);
    return Boolean(
      target.targetExisted &&
        expected &&
        current.isFile() &&
        current.nlink === 1 &&
        sameFile(current, expected) &&
        current.size === expected.size &&
        current.mtimeMs === expected.mtimeMs &&
        current.ctimeMs === expected.ctimeMs &&
        current.mode === expected.mode,
    );
  } catch (error) {
    return (
      !target.targetExisted &&
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT",
      )
    );
  }
}

async function writePrivateFile(filePath: string, bytes: string | Buffer) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    if (process.platform === "win32") {
      await runPowerShell(
        WINDOWS_PRIVATE_FILE_SCRIPT + WINDOWS_VERIFY_PRIVATE_ACL_SCRIPT,
        filePath,
      );
    } else {
      await chmod(filePath, 0o600);
      if (((await stat(filePath)).mode & 0o777) !== 0o600)
        fail("SNAPSHOT_STORAGE_UNSAFE");
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await removePrivateFile(filePath);
    throw error;
  }
}

async function removePrivateFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // 仅清理本次随机 ID 对应的私有临时/未发布文件；失败时保留并计入后续总配额。
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function capturePreImageSnapshot(
  snapshotRoot: string | undefined,
  target: SensitiveSnapshotTarget,
  injectFailure?: SnapshotFailureInjection,
): Promise<PreImageSnapshotEvidence> {
  const existed = target.targetExisted ? "yes" : "no";
  if (!snapshotRoot)
    return unavailablePreImageSnapshot("SNAPSHOT_STORAGE_UNAVAILABLE", existed);

  const snapshotId = randomUUID();
  const bodyName = `${snapshotId}.preimage`;
  const manifestName = `${snapshotId}.manifest.json`;
  const bodyPath = path.join(snapshotRoot, bodyName);
  const bodyTemp = path.join(snapshotRoot, `.${bodyName}.tmp`);
  const manifestPath = path.join(snapshotRoot, manifestName);
  const manifestTemp = path.join(snapshotRoot, `.${manifestName}.tmp`);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let bodyTempCreated = false;
  let bodyPublished = false;
  let manifestTempCreated = false;
  let manifestPublished = false;

  try {
    if (injectFailure === "permission_error")
      fail("SNAPSHOT_PERMISSION_DENIED");
    await secureStorageRoot(snapshotRoot);
    lock = await open(path.join(snapshotRoot, LOCK_NAME), "wx", 0o600);
    const used = await storageUsage(snapshotRoot);

    const captured = target.targetExisted
      ? await readBounded(target.targetPath)
      : undefined;
    if (!target.targetExisted && !(await targetStillMatches(target)))
      fail("SNAPSHOT_TARGET_CHANGED");
    if (injectFailure === "disk_full") fail("SNAPSHOT_RESOURCE_LIMIT");

    const sha256 = captured
      ? createHash("sha256").update(captured.bytes).digest("hex")
      : undefined;
    const windowsAcl =
      captured && process.platform === "win32"
        ? await readWindowsTargetAcl(target.targetPath)
        : undefined;
    const manifest: SnapshotManifestV1 = {
      schemaVersion: 1,
      kind: "agentglass-pre-image",
      snapshotId,
      actionId: target.actionId,
      targetId: target.targetId,
      targetPath: target.targetPath,
      targetExisted: target.targetExisted,
      preImage: captured
        ? {
            file: bodyName,
            byteLength: captured.bytes.length,
            sha256: sha256 ?? "",
          }
        : null,
      fileIdentity: captured
        ? {
            device: String(captured.stats.dev),
            inode: String(captured.stats.ino),
          }
        : null,
      permissions: captured
        ? {
            platform: process.platform,
            mode: Number(captured.stats.mode) & 0o7777,
            uid: String(captured.stats.uid),
            gid: String(captured.stats.gid),
            acl:
              windowsAcl !== undefined
                ? { format: "sddl", value: windowsAcl }
                : null,
          }
        : null,
      canRestoreNow: false,
      recoveryGrade: "unknown",
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    if (manifestBytes.length > MANIFEST_LIMIT_BYTES)
      fail("SNAPSHOT_RESOURCE_LIMIT");
    // 条目上限必须计算本次最终发布物；锁会在 finally 删除，不属于持久条目。
    // 既有文件需要 body + manifest，新文件不存在事实只需要 manifest。
    if (used.publishedEntries + (captured ? 2 : 1) > SNAPSHOT_ENTRY_LIMIT)
      fail("SNAPSHOT_RESOURCE_LIMIT");
    if (
      used.bytes + (captured?.bytes.length ?? 0) + manifestBytes.length >
      SNAPSHOT_TOTAL_LIMIT_BYTES
    ) {
      fail("SNAPSHOT_RESOURCE_LIMIT");
    }

    if (captured) {
      await writePrivateFile(bodyTemp, captured.bytes);
      bodyTempCreated = true;
      await rename(bodyTemp, bodyPath);
      bodyTempCreated = false;
      bodyPublished = true;
      if (
        createHash("sha256")
          .update(await readFile(bodyPath))
          .digest("hex") !== sha256
      ) {
        fail("SNAPSHOT_PUBLISH_FAILED");
      }
    }
    if (injectFailure === "interrupted_publish")
      fail("SNAPSHOT_PUBLISH_FAILED");
    if (!(await targetStillMatches(target, captured?.stats)))
      fail("SNAPSHOT_TARGET_CHANGED");
    if (
      windowsAcl !== undefined &&
      (await readWindowsTargetAcl(target.targetPath)) !== windowsAcl
    ) {
      fail("SNAPSHOT_TARGET_CHANGED");
    }

    // manifest 是唯一发布标记：前像先完整写入、flush、校验，manifest 最后同目录 rename。
    await writePrivateFile(manifestTemp, manifestBytes);
    manifestTempCreated = true;
    if (!(await readFile(manifestTemp)).equals(manifestBytes))
      fail("SNAPSHOT_PUBLISH_FAILED");
    await rename(manifestTemp, manifestPath);
    manifestTempCreated = false;
    manifestPublished = true;
    await syncDirectory(snapshotRoot);
    return evidence({
      status: "saved",
      snapshotId,
      targetExisted: existed,
      permissionMetadata: captured ? "captured" : "not_applicable",
    });
  } catch (error) {
    await Promise.all([
      ...(bodyTempCreated ? [removePrivateFile(bodyTemp)] : []),
      ...(bodyPublished ? [removePrivateFile(bodyPath)] : []),
      ...(manifestTempCreated ? [removePrivateFile(manifestTemp)] : []),
      ...(manifestPublished ? [removePrivateFile(manifestPath)] : []),
    ]);
    return unavailablePreImageSnapshot(mapFailure(error), existed);
  } finally {
    if (lock) {
      await lock.close().catch(() => {});
      await removePrivateFile(path.join(snapshotRoot, LOCK_NAME));
    }
  }
}

export async function verifyPreImageSnapshotBaseline(
  snapshotRoot: string | undefined,
  snapshot: PreImageSnapshotEvidence,
  expectedTarget: SensitiveSnapshotTarget,
): Promise<boolean> {
  if (
    !snapshotRoot ||
    snapshot.status !== "saved" ||
    !snapshot.snapshotId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      snapshot.snapshotId,
    )
  ) {
    return false;
  }

  try {
    const manifestPath = path.join(
      snapshotRoot,
      `${snapshot.snapshotId}.manifest.json`,
    );
    // manifest 也必须通过同一个 no-follow、身份稳定且有界的读取路径；不能在 lstat
    // 与 readFile 之间给替换后的链接或超大文件留下无界读取窗口。
    const { bytes } = await readBounded(manifestPath, MANIFEST_LIMIT_BYTES);
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return false;
    const manifest = parsed as SnapshotManifestV1;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.kind !== "agentglass-pre-image" ||
      manifest.snapshotId !== snapshot.snapshotId ||
      manifest.actionId !== expectedTarget.actionId ||
      manifest.targetId !== expectedTarget.targetId ||
      manifest.targetPath !== expectedTarget.targetPath ||
      manifest.targetExisted !== expectedTarget.targetExisted ||
      manifest.canRestoreNow !== false ||
      manifest.recoveryGrade !== "unknown" ||
      typeof manifest.targetExisted !== "boolean" ||
      !path.isAbsolute(manifest.targetPath) ||
      snapshot.targetExisted !== (manifest.targetExisted ? "yes" : "no")
    ) {
      return false;
    }

    if (!manifest.targetExisted) {
      if (
        manifest.preImage !== null ||
        manifest.fileIdentity !== null ||
        manifest.permissions !== null
      ) {
        return false;
      }
      return await targetStillMatches(expectedTarget);
    }

    if (
      !manifest.preImage ||
      !manifest.fileIdentity ||
      !manifest.permissions ||
      manifest.preImage.file !== `${snapshot.snapshotId}.preimage` ||
      !Number.isSafeInteger(manifest.preImage.byteLength) ||
      manifest.preImage.byteLength < 0 ||
      manifest.preImage.byteLength > SNAPSHOT_FILE_LIMIT_BYTES ||
      !/^[0-9a-f]{64}$/u.test(manifest.preImage.sha256) ||
      typeof manifest.fileIdentity.device !== "string" ||
      typeof manifest.fileIdentity.inode !== "string" ||
      manifest.permissions.platform !== process.platform ||
      !Number.isSafeInteger(manifest.permissions.mode) ||
      typeof manifest.permissions.uid !== "string" ||
      typeof manifest.permissions.gid !== "string" ||
      (manifest.permissions.acl !== null &&
        (manifest.permissions.acl.format !== "sddl" ||
          typeof manifest.permissions.acl.value !== "string")) ||
      (process.platform === "win32") !== (manifest.permissions.acl !== null)
    ) {
      return false;
    }

    const captured = await readBounded(expectedTarget.targetPath);
    const saved = await readBounded(
      path.join(snapshotRoot, manifest.preImage.file),
    );
    const currentHash = createHash("sha256")
      .update(captured.bytes)
      .digest("hex");
    const savedHash = createHash("sha256").update(saved.bytes).digest("hex");
    const currentAcl =
      manifest.permissions.acl?.format === "sddl" &&
      process.platform === "win32"
        ? await readWindowsTargetAcl(manifest.targetPath)
        : null;
    return (
      captured.stats.isFile() &&
      captured.stats.nlink === 1 &&
      saved.stats.isFile() &&
      saved.stats.nlink === 1 &&
      captured.bytes.length === manifest.preImage.byteLength &&
      saved.bytes.length === manifest.preImage.byteLength &&
      String(captured.stats.dev) === manifest.fileIdentity.device &&
      String(captured.stats.ino) === manifest.fileIdentity.inode &&
      (Number(captured.stats.mode) & 0o7777) === manifest.permissions.mode &&
      String(captured.stats.uid) === manifest.permissions.uid &&
      String(captured.stats.gid) === manifest.permissions.gid &&
      currentHash === manifest.preImage.sha256 &&
      savedHash === manifest.preImage.sha256 &&
      (manifest.permissions.acl === null ||
        currentAcl === manifest.permissions.acl.value)
    );
  } catch {
    // 快照域缺失、损坏、未来版本或读取失败都不能维持旧卡片的前像事实。
    return false;
  }
}
