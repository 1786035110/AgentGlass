import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  chown,
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
import { readStableFile, StableFileReadError } from "./stable-file.js";

export const SNAPSHOT_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
export const SNAPSHOT_TOTAL_LIMIT_BYTES = 100 * 1024 * 1024;
export const SNAPSHOT_ENTRY_LIMIT = 4096;
const MANIFEST_LIMIT_BYTES = 64 * 1024;
const LOCK_NAME = ".snapshot.lock";
const WINDOWS_ACL_APPLY_ATTEMPTS = 3;
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

interface RecoveryManifestV3 {
  schemaVersion: 3;
  kind: "agentglass-single-file-recovery";
  state: "prepared" | "ready" | "consumed" | "superseded";
  snapshotId: string;
  actionId: string;
  effectId: string | null;
  targetId: string;
  targetPath: string;
  targetExisted: boolean;
  preImage: null | {
    file: string;
    byteLength: number;
    sha256: string;
  };
  preIdentity: null | {
    device: string;
    inode: string;
  };
  prePermissions: null | FilePermissions;
  postImage: null | {
    byteLength: number;
    sha256: string;
    identity: { device: string; inode: string; changeTimeMs: string };
    permissions: FilePermissions;
  };
}

interface FilePermissions {
  platform: NodeJS.Platform;
  mode: number;
  uid: string;
  gid: string;
  acl: null | { format: "sddl"; value: string };
}

export interface RecoveryEntry {
  snapshotId: string;
  actionId: string;
  effectId: string;
  targetId: string;
  targetPathHash: string;
  targetExisted: boolean;
}

export interface RecoveryResult {
  status: "restored" | "conflict" | "failed";
  content: "matched" | "missing" | "unknown";
  permissions: "matched" | "not_applicable" | "unknown";
}

export interface CleanupSet {
  fingerprint: string;
  files: readonly string[];
  fileCount: number;
  logicalBytes: number;
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
$sddl = $item.GetAccessControl().GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
[Console]::Out.Write($sddl)
`;

const WINDOWS_APPLY_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:AGENTGLASS_SNAPSHOT_ACL_PATH
$sddl = $env:AGENTGLASS_TARGET_SDDL
$access = [System.Security.AccessControl.AccessControlSections]::Access
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetSecurityDescriptorSddlForm($sddl, $access)
(New-Object System.IO.FileInfo($p)).SetAccessControl($acl)
$expectedRules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$actualRules = @((New-Object System.IO.FileInfo($p)).GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
function RuleKey($rule) {
  $parts = @(
    $rule.IdentityReference.Value,
    $rule.AccessControlType.ToString(),
    ([int]$rule.FileSystemRights).ToString(),
    $rule.InheritanceFlags.ToString(),
    $rule.PropagationFlags.ToString()
  )
  return ($parts -join "|")
}
$expectedKeys = @($expectedRules | ForEach-Object { RuleKey $_ } | Sort-Object) -join ";"
$actualKeys = @($actualRules | ForEach-Object { RuleKey $_ } | Sort-Object) -join ";"
if ($expectedKeys -ne $actualKeys) { exit 1 }
exit 0
`;

const WINDOWS_COMPARE_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:AGENTGLASS_SNAPSHOT_ACL_PATH
$sddl = $env:AGENTGLASS_TARGET_SDDL
$access = [System.Security.AccessControl.AccessControlSections]::Access
$expected = New-Object System.Security.AccessControl.FileSecurity
$expected.SetSecurityDescriptorSddlForm($sddl, $access)
$expectedRules = @($expected.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$actualRules = @((New-Object System.IO.FileInfo($p)).GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
function RuleKey($rule) {
  $parts = @(
    $rule.IdentityReference.Value,
    $rule.AccessControlType.ToString(),
    ([int]$rule.FileSystemRights).ToString(),
    $rule.InheritanceFlags.ToString(),
    $rule.PropagationFlags.ToString()
  )
  return ($parts -join "|")
}
$expectedKeys = @($expectedRules | ForEach-Object { RuleKey $_ } | Sort-Object) -join ";"
$actualKeys = @($actualRules | ForEach-Object { RuleKey $_ } | Sort-Object) -join ";"
if ($expectedKeys -ne $actualKeys) { exit 1 }
exit 0
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

async function runPowerShellWithSddl(
  script: string,
  target: string,
  sddl: string,
): Promise<void> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const windowsRoot = path.parse(process.env.SystemRoot ?? "C:\\Windows").root;
  await execFileAsync(
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
        AGENTGLASS_TARGET_SDDL: sddl,
      },
    },
  );
}

async function applyWindowsTargetAcl(
  target: string,
  sddl: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < WINDOWS_ACL_APPLY_ATTEMPTS; attempt += 1) {
    try {
      // 应用后在同一 PowerShell 进程内立即读回并语义比对 DACL：SDDL 字符串往返
      // 并不保证逐字符稳定（继承标记、SACL、owner/group 都可能归一化），
      // 因此只比对访问规则（身份/类型/权限/继承传播），失败则重试。
      await runPowerShellWithSddl(WINDOWS_APPLY_ACL_SCRIPT, target, sddl);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("SNAPSHOT_PERMISSION_DENIED");
}

async function daclMatches(
  target: string,
  expectedSddl: string,
): Promise<boolean> {
  try {
    await runPowerShellWithSddl(
      WINDOWS_COMPARE_ACL_SCRIPT,
      target,
      expectedSddl,
    );
    return true;
  } catch {
    return false;
  }
}

async function readWindowsTargetAcl(target: string): Promise<string> {
  const acl = await runPowerShell(WINDOWS_READ_ACL_SCRIPT, target);
  const normalized = acl.trim();
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > 32 * 1024
  )
    fail("SNAPSHOT_PERMISSION_DENIED");
  return normalized;
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
  try {
    const observed = await readStableFile(targetPath, limit);
    return { bytes: observed.bytes, stats: observed.stats };
  } catch (error) {
    if (error instanceof StableFileReadError) {
      if (error.code === "too_large" || error.code === "grew_over_limit")
        fail("SNAPSHOT_FILE_TOO_LARGE");
      if (error.code === "unsupported") fail("SNAPSHOT_TARGET_UNSUPPORTED");
      if (error.code === "changed") fail("SNAPSHOT_TARGET_CHANGED");
    }
    throw error;
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
    const manifest: RecoveryManifestV3 = {
      // v3 绑定 post-image 的 ctime，避免 POSIX 删除后复用 inode 时误认替换文件。
      // 旧 v2 数据保留但不再作为恢复授权；没有迁移证据时必须安全拒绝。
      schemaVersion: 3,
      kind: "agentglass-single-file-recovery",
      state: "prepared",
      snapshotId,
      actionId: target.actionId,
      effectId: null,
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
      preIdentity: captured
        ? {
            device: String(captured.stats.dev),
            inode: String(captured.stats.ino),
          }
        : null,
      prePermissions: captured
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
      postImage: null,
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
    const manifest = parsed as RecoveryManifestV3;
    if (
      manifest.schemaVersion !== 3 ||
      manifest.kind !== "agentglass-single-file-recovery" ||
      manifest.state !== "prepared" ||
      manifest.snapshotId !== snapshot.snapshotId ||
      manifest.actionId !== expectedTarget.actionId ||
      manifest.effectId !== null ||
      manifest.targetId !== expectedTarget.targetId ||
      manifest.targetPath !== expectedTarget.targetPath ||
      manifest.targetExisted !== expectedTarget.targetExisted ||
      manifest.postImage !== null ||
      typeof manifest.targetExisted !== "boolean" ||
      !path.isAbsolute(manifest.targetPath) ||
      snapshot.targetExisted !== (manifest.targetExisted ? "yes" : "no")
    ) {
      return false;
    }

    if (!manifest.targetExisted) {
      if (
        manifest.preImage !== null ||
        manifest.preIdentity !== null ||
        manifest.prePermissions !== null
      ) {
        return false;
      }
      return await targetStillMatches(expectedTarget);
    }

    if (
      !manifest.preImage ||
      !manifest.preIdentity ||
      !manifest.prePermissions ||
      manifest.preImage.file !== `${snapshot.snapshotId}.preimage` ||
      !Number.isSafeInteger(manifest.preImage.byteLength) ||
      manifest.preImage.byteLength < 0 ||
      manifest.preImage.byteLength > SNAPSHOT_FILE_LIMIT_BYTES ||
      !/^[0-9a-f]{64}$/u.test(manifest.preImage.sha256) ||
      typeof manifest.preIdentity.device !== "string" ||
      typeof manifest.preIdentity.inode !== "string" ||
      manifest.prePermissions.platform !== process.platform ||
      !Number.isSafeInteger(manifest.prePermissions.mode) ||
      typeof manifest.prePermissions.uid !== "string" ||
      typeof manifest.prePermissions.gid !== "string" ||
      (manifest.prePermissions.acl !== null &&
        (manifest.prePermissions.acl.format !== "sddl" ||
          typeof manifest.prePermissions.acl.value !== "string")) ||
      (process.platform === "win32") !== (manifest.prePermissions.acl !== null)
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
      manifest.prePermissions.acl?.format === "sddl" &&
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
      String(captured.stats.dev) === manifest.preIdentity.device &&
      String(captured.stats.ino) === manifest.preIdentity.inode &&
      (Number(captured.stats.mode) & 0o7777) === manifest.prePermissions.mode &&
      String(captured.stats.uid) === manifest.prePermissions.uid &&
      String(captured.stats.gid) === manifest.prePermissions.gid &&
      currentHash === manifest.preImage.sha256 &&
      savedHash === manifest.preImage.sha256 &&
      (manifest.prePermissions.acl === null ||
        currentAcl === manifest.prePermissions.acl.value)
    );
  } catch {
    // 快照域缺失、损坏、未来版本或读取失败都不能维持旧卡片的前像事实。
    return false;
  }
}

const SNAPSHOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validPermissions(value: unknown): value is FilePermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const permissions = value as Partial<FilePermissions>;
  return Boolean(
    permissions.platform === process.platform &&
      Number.isSafeInteger(permissions.mode) &&
      typeof permissions.uid === "string" &&
      /^\d+$/u.test(permissions.uid) &&
      typeof permissions.gid === "string" &&
      /^\d+$/u.test(permissions.gid) &&
      (permissions.acl === null ||
        (permissions.acl?.format === "sddl" &&
          typeof permissions.acl.value === "string")) &&
      (process.platform === "win32") === (permissions.acl !== null),
  );
}

async function readRecoveryManifest(
  snapshotRoot: string,
  snapshotId: string,
): Promise<RecoveryManifestV3> {
  if (!SNAPSHOT_ID.test(snapshotId)) fail("SNAPSHOT_STORAGE_UNSAFE");
  const { bytes } = await readBounded(
    path.join(snapshotRoot, `${snapshotId}.manifest.json`),
    MANIFEST_LIMIT_BYTES,
  );
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("SNAPSHOT_STORAGE_UNSAFE");
  const manifest = parsed as RecoveryManifestV3;
  if (
    manifest.schemaVersion !== 3 ||
    manifest.kind !== "agentglass-single-file-recovery" ||
    !["prepared", "ready", "consumed", "superseded"].includes(manifest.state) ||
    manifest.snapshotId !== snapshotId ||
    !nonEmpty(manifest.actionId) ||
    !(manifest.effectId === null || nonEmpty(manifest.effectId)) ||
    !nonEmpty(manifest.targetId) ||
    !path.isAbsolute(manifest.targetPath) ||
    typeof manifest.targetExisted !== "boolean" ||
    (manifest.targetExisted
      ? !manifest.preImage ||
        manifest.preImage.file !== `${snapshotId}.preimage` ||
        !Number.isSafeInteger(manifest.preImage.byteLength) ||
        manifest.preImage.byteLength < 0 ||
        manifest.preImage.byteLength > SNAPSHOT_FILE_LIMIT_BYTES ||
        !/^[0-9a-f]{64}$/u.test(manifest.preImage.sha256) ||
        !manifest.preIdentity ||
        !nonEmpty(manifest.preIdentity.device) ||
        !nonEmpty(manifest.preIdentity.inode) ||
        !validPermissions(manifest.prePermissions)
      : manifest.preImage !== null ||
        manifest.preIdentity !== null ||
        manifest.prePermissions !== null)
  ) {
    fail("SNAPSHOT_STORAGE_UNSAFE");
  }
  return manifest;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

async function observedPermissions(
  targetPath: string,
  observed: Awaited<ReturnType<typeof readStableFile>>,
): Promise<FilePermissions> {
  return {
    platform: process.platform,
    mode: observed.mode & 0o7777,
    uid: observed.uid,
    gid: observed.gid,
    acl:
      process.platform === "win32"
        ? { format: "sddl", value: await readWindowsTargetAcl(targetPath) }
        : null,
  };
}

async function permissionsMatch(
  targetPath: string,
  observed: Awaited<ReturnType<typeof readStableFile>>,
  expected: FilePermissions,
): Promise<boolean> {
  if ((observed.mode & 0o7777) !== expected.mode) return false;
  if (observed.uid !== expected.uid) return false;
  if (observed.gid !== expected.gid) return false;
  if (expected.acl === null) return true;
  return (
    expected.acl.format === "sddl" &&
    (await daclMatches(targetPath, expected.acl.value))
  );
}

async function publishManifest(
  snapshotRoot: string,
  manifest: RecoveryManifestV3,
  expectedState: RecoveryManifestV3["state"],
): Promise<void> {
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  const manifestPath = path.join(
    snapshotRoot,
    `${manifest.snapshotId}.manifest.json`,
  );
  const tempPath = path.join(
    snapshotRoot,
    `.${manifest.snapshotId}.manifest.json.tmp`,
  );
  try {
    await secureStorageRoot(snapshotRoot);
    lock = await open(path.join(snapshotRoot, LOCK_NAME), "wx", 0o600);
    const current = await readRecoveryManifest(
      snapshotRoot,
      manifest.snapshotId,
    );
    if (
      current.state !== expectedState ||
      current.actionId !== manifest.actionId ||
      current.targetId !== manifest.targetId ||
      current.targetPath !== manifest.targetPath
    )
      fail("SNAPSHOT_TARGET_CHANGED");
    const used = await storageUsage(snapshotRoot);
    const oldBytes = (await lstat(manifestPath)).size;
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    if (
      bytes.length > MANIFEST_LIMIT_BYTES ||
      used.bytes + bytes.length > SNAPSHOT_TOTAL_LIMIT_BYTES ||
      used.bytes - oldBytes + bytes.length > SNAPSHOT_TOTAL_LIMIT_BYTES
    ) {
      fail("SNAPSHOT_RESOURCE_LIMIT");
    }
    await writePrivateFile(tempPath, bytes);
    if (!(await readFile(tempPath)).equals(bytes))
      fail("SNAPSHOT_PUBLISH_FAILED");
    await rename(tempPath, manifestPath);
    await syncDirectory(snapshotRoot);
  } finally {
    await removePrivateFile(tempPath);
    if (lock) {
      await lock.close().catch(() => {});
      await removePrivateFile(path.join(snapshotRoot, LOCK_NAME));
    }
  }
}

export async function finalizeRecoverySnapshot(
  snapshotRoot: string | undefined,
  snapshot: PreImageSnapshotEvidence,
  effectId: string,
  expectedSha256: string | null,
  expectedByteLength: number | null,
): Promise<RecoveryEntry | undefined> {
  if (
    !snapshotRoot ||
    snapshot.status !== "saved" ||
    !snapshot.snapshotId ||
    !nonEmpty(effectId) ||
    !expectedSha256 ||
    expectedByteLength === null
  ) {
    return;
  }
  try {
    const manifest = await readRecoveryManifest(
      snapshotRoot,
      snapshot.snapshotId,
    );
    if (manifest.state !== "prepared" || manifest.effectId !== null) return;
    const observed = await readStableFile(
      manifest.targetPath,
      SNAPSHOT_FILE_LIMIT_BYTES,
    );
    if (
      observed.bytes.length !== expectedByteLength ||
      createHash("sha256").update(observed.bytes).digest("hex") !==
        expectedSha256
    ) {
      return;
    }
    const ready: RecoveryManifestV3 = {
      ...manifest,
      state: "ready",
      effectId,
      postImage: {
        byteLength: observed.bytes.length,
        sha256: expectedSha256,
        // POSIX 可在 unlink/recreate 后复用 inode；ctime 只进入敏感 manifest，
        // 恢复前必须再次精确匹配，不能把同字节替换误认成原文件。
        identity: {
          ...observed.identity,
          changeTimeMs: String(observed.stats.ctimeMs),
        },
        permissions: await observedPermissions(manifest.targetPath, observed),
      },
    };
    await publishManifest(snapshotRoot, ready, "prepared");
    return Object.freeze({
      snapshotId: ready.snapshotId,
      actionId: ready.actionId,
      effectId,
      targetId: ready.targetId,
      targetPathHash: createHash("sha256")
        .update(ready.targetPath, "utf8")
        .digest("hex"),
      targetExisted: ready.targetExisted,
    });
  } catch {
    return;
  }
}

async function readyManifest(
  snapshotRoot: string,
  entry: RecoveryEntry,
): Promise<RecoveryManifestV3 | undefined> {
  try {
    const manifest = await readRecoveryManifest(snapshotRoot, entry.snapshotId);
    if (
      manifest.state !== "ready" ||
      manifest.actionId !== entry.actionId ||
      manifest.effectId !== entry.effectId ||
      manifest.targetId !== entry.targetId ||
      createHash("sha256").update(manifest.targetPath, "utf8").digest("hex") !==
        entry.targetPathHash ||
      manifest.targetExisted !== entry.targetExisted ||
      !manifest.postImage ||
      !Number.isSafeInteger(manifest.postImage.byteLength) ||
      manifest.postImage.byteLength < 0 ||
      manifest.postImage.byteLength > SNAPSHOT_FILE_LIMIT_BYTES ||
      !/^[0-9a-f]{64}$/u.test(manifest.postImage.sha256) ||
      !nonEmpty(manifest.postImage.identity?.device) ||
      !nonEmpty(manifest.postImage.identity?.inode) ||
      !nonEmpty(manifest.postImage.identity?.changeTimeMs) ||
      !validPermissions(manifest.postImage.permissions)
    ) {
      return;
    }
    return manifest;
  } catch {
    return;
  }
}

async function matchesPostImage(
  manifest: RecoveryManifestV3,
): Promise<boolean> {
  if (!manifest.postImage) return false;
  try {
    const current = await readStableFile(
      manifest.targetPath,
      SNAPSHOT_FILE_LIMIT_BYTES,
    );
    const permissions = await observedPermissions(manifest.targetPath, current);
    return (
      current.bytes.length === manifest.postImage.byteLength &&
      createHash("sha256").update(current.bytes).digest("hex") ===
        manifest.postImage.sha256 &&
      current.identity.device === manifest.postImage.identity.device &&
      current.identity.inode === manifest.postImage.identity.inode &&
      String(current.stats.ctimeMs) ===
        manifest.postImage.identity.changeTimeMs &&
      JSON.stringify(permissions) ===
        JSON.stringify(manifest.postImage.permissions)
    );
  } catch {
    return false;
  }
}

export async function recoveryEntryIsCurrent(
  snapshotRoot: string | undefined,
  entry: RecoveryEntry,
): Promise<boolean> {
  if (!snapshotRoot) return false;
  const manifest = await readyManifest(snapshotRoot, entry);
  return Boolean(manifest && (await matchesPostImage(manifest)));
}

export async function markRecoveryState(
  snapshotRoot: string | undefined,
  entry: RecoveryEntry,
  state: "consumed" | "superseded",
): Promise<boolean> {
  if (!snapshotRoot) return false;
  const manifest = await readyManifest(snapshotRoot, entry);
  if (!manifest) return false;
  try {
    await publishManifest(snapshotRoot, { ...manifest, state }, "ready");
    return true;
  } catch {
    return false;
  }
}

async function verifyRestored(
  manifest: RecoveryManifestV3,
): Promise<RecoveryResult> {
  if (!manifest.targetExisted) {
    try {
      await lstat(manifest.targetPath);
      return {
        status: "failed",
        content: "unknown",
        permissions: "not_applicable",
      };
    } catch (error) {
      return error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
        ? {
            status: "restored",
            content: "missing",
            permissions: "not_applicable",
          }
        : {
            status: "failed",
            content: "unknown",
            permissions: "not_applicable",
          };
    }
  }
  if (!manifest.preImage || !manifest.prePermissions)
    return { status: "failed", content: "unknown", permissions: "unknown" };
  try {
    const observed = await readStableFile(
      manifest.targetPath,
      SNAPSHOT_FILE_LIMIT_BYTES,
    );
    const content =
      observed.bytes.length === manifest.preImage.byteLength &&
      createHash("sha256").update(observed.bytes).digest("hex") ===
        manifest.preImage.sha256
        ? "matched"
        : "unknown";
    const permissions = (await permissionsMatch(
      manifest.targetPath,
      observed,
      manifest.prePermissions,
    ))
      ? "matched"
      : "unknown";
    return {
      status:
        content === "matched" && permissions === "matched"
          ? "restored"
          : "failed",
      content,
      permissions,
    };
  } catch {
    return { status: "failed", content: "unknown", permissions: "unknown" };
  }
}

export async function restoreRecoveryEntry(
  snapshotRoot: string | undefined,
  entry: RecoveryEntry,
): Promise<RecoveryResult> {
  if (!snapshotRoot)
    return { status: "failed", content: "unknown", permissions: "unknown" };
  const manifest = await readyManifest(snapshotRoot, entry);
  if (!manifest)
    return { status: "conflict", content: "unknown", permissions: "unknown" };
  if (!(await matchesPostImage(manifest))) {
    await markRecoveryState(snapshotRoot, entry, "consumed");
    return { status: "conflict", content: "unknown", permissions: "unknown" };
  }
  if (!(await markRecoveryState(snapshotRoot, entry, "consumed")))
    return { status: "failed", content: "unknown", permissions: "unknown" };
  try {
    if (!manifest.targetExisted) {
      await unlink(manifest.targetPath);
    } else {
      if (!manifest.preImage || !manifest.prePermissions) throw new Error();
      const saved = await readBounded(
        path.join(snapshotRoot, manifest.preImage.file),
      );
      if (
        saved.bytes.length !== manifest.preImage.byteLength ||
        createHash("sha256").update(saved.bytes).digest("hex") !==
          manifest.preImage.sha256
      ) {
        throw new Error();
      }
      const temp = path.join(
        path.dirname(manifest.targetPath),
        `.agentglass-restore-${randomUUID()}.tmp`,
      );
      try {
        const handle = await open(temp, "wx", manifest.prePermissions.mode);
        try {
          await handle.writeFile(saved.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temp, manifest.prePermissions.mode);
        if (process.platform !== "win32") {
          await chown(
            temp,
            Number(manifest.prePermissions.uid),
            Number(manifest.prePermissions.gid),
          );
        }
        if (
          process.platform === "win32" &&
          manifest.prePermissions.acl?.format === "sddl"
        ) {
          await applyWindowsTargetAcl(temp, manifest.prePermissions.acl.value);
        }
        await rename(temp, manifest.targetPath);
        await syncDirectory(path.dirname(manifest.targetPath));
      } finally {
        await removePrivateFile(temp);
      }
    }
  } catch {
    return await verifyRestored(manifest);
  }
  return await verifyRestored(manifest);
}

export async function inspectCleanupSet(
  snapshotRoot: string | undefined,
): Promise<CleanupSet> {
  if (!snapshotRoot)
    return { fingerprint: "", files: [], fileCount: 0, logicalBytes: 0 };
  try {
    await secureStorageRoot(snapshotRoot);
    const entries = await readdir(snapshotRoot, { withFileTypes: true });
    const files = new Set<string>();
    for (const entry of entries) {
      const match = /^([0-9a-f-]{36})\.manifest\.json$/u.exec(entry.name);
      if (!entry.isFile() || !match?.[1] || !SNAPSHOT_ID.test(match[1]))
        continue;
      try {
        const { bytes } = await readBounded(
          path.join(snapshotRoot, entry.name),
          MANIFEST_LIMIT_BYTES,
        );
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          continue;
        const candidate = parsed as Record<string, unknown>;
        if (
          candidate.schemaVersion === 1 &&
          candidate.kind === "agentglass-pre-image" &&
          candidate.snapshotId === match[1] &&
          candidate.canRestoreNow === false &&
          candidate.recoveryGrade === "unknown" &&
          typeof candidate.actionId === "string" &&
          typeof candidate.targetId === "string" &&
          typeof candidate.targetPath === "string" &&
          path.isAbsolute(candidate.targetPath) &&
          typeof candidate.targetExisted === "boolean"
        ) {
          const preImage = candidate.preImage as {
            file?: unknown;
            byteLength?: unknown;
            sha256?: unknown;
          } | null;
          if (
            candidate.targetExisted &&
            (!preImage ||
              preImage.file !== `${match[1]}.preimage` ||
              !Number.isSafeInteger(preImage.byteLength) ||
              typeof preImage.sha256 !== "string" ||
              !candidate.fileIdentity ||
              typeof candidate.fileIdentity !== "object" ||
              !candidate.permissions ||
              typeof candidate.permissions !== "object")
          ) {
            continue;
          }
          if (
            !candidate.targetExisted &&
            (preImage !== null ||
              candidate.fileIdentity !== null ||
              candidate.permissions !== null)
          )
            continue;
          if (preImage?.file === `${match[1]}.preimage`) {
            const body = await readBounded(
              path.join(snapshotRoot, preImage.file),
            );
            if (
              body.bytes.length !== preImage.byteLength ||
              createHash("sha256").update(body.bytes).digest("hex") !==
                preImage.sha256
            )
              continue;
          }
          files.add(entry.name);
          if (preImage?.file === `${match[1]}.preimage`)
            files.add(preImage.file);
          continue;
        }
        const manifest = await readRecoveryManifest(snapshotRoot, match[1]);
        if (manifest.preImage) {
          const body = await readBounded(
            path.join(snapshotRoot, manifest.preImage.file),
          );
          if (
            body.bytes.length !== manifest.preImage.byteLength ||
            createHash("sha256").update(body.bytes).digest("hex") !==
              manifest.preImage.sha256
          )
            continue;
        }
        files.add(entry.name);
        if (manifest.preImage) files.add(manifest.preImage.file);
      } catch {
        // 损坏、未来版本或归属无法验证的数据保留，不靠文件名猜测删除。
      }
    }
    const sorted = [...files].sort();
    let logicalBytes = 0;
    const fingerprintRows: Array<[string, number, string]> = [];
    for (const file of sorted) {
      const observed = await readBounded(
        path.join(snapshotRoot, file),
        file.endsWith(".manifest.json")
          ? MANIFEST_LIMIT_BYTES
          : SNAPSHOT_FILE_LIMIT_BYTES,
      );
      logicalBytes += observed.bytes.length;
      fingerprintRows.push([
        file,
        observed.bytes.length,
        createHash("sha256").update(observed.bytes).digest("hex"),
      ]);
    }
    return Object.freeze({
      fingerprint: createHash("sha256")
        .update(JSON.stringify(fingerprintRows))
        .digest("hex"),
      files: Object.freeze(sorted),
      fileCount: sorted.length,
      logicalBytes,
    });
  } catch {
    return { fingerprint: "", files: [], fileCount: 0, logicalBytes: 0 };
  }
}

export async function cleanSnapshotSet(
  snapshotRoot: string | undefined,
  approved: CleanupSet,
  deleteFile: (filePath: string) => Promise<void> = unlink,
): Promise<{
  deleted: number;
  failed: number;
  changed: boolean;
  deletedFiles: readonly string[];
}> {
  if (!snapshotRoot || !approved.fingerprint)
    return { deleted: 0, failed: 0, changed: true, deletedFiles: [] };
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await secureStorageRoot(snapshotRoot);
    lock = await open(path.join(snapshotRoot, LOCK_NAME), "wx", 0o600);
    const current = await inspectCleanupSet(snapshotRoot);
    if (current.fingerprint !== approved.fingerprint)
      return { deleted: 0, failed: 0, changed: true, deletedFiles: [] };
    let deleted = 0;
    let failed = 0;
    const deletedFiles: string[] = [];
    // 逐项删除使局部磁盘/权限失败可被如实统计；不回滚已删项，也不扩大到未批准集合。
    for (const file of approved.files) {
      try {
        await deleteFile(path.join(snapshotRoot, file));
        deleted += 1;
        deletedFiles.push(file);
      } catch {
        failed += 1;
      }
    }
    return { deleted, failed, changed: false, deletedFiles };
  } catch {
    return {
      deleted: 0,
      failed: approved.fileCount,
      changed: false,
      deletedFiles: [],
    };
  } finally {
    if (lock) {
      await lock.close().catch(() => {});
      await removePrivateFile(path.join(snapshotRoot, LOCK_NAME));
    }
  }
}
