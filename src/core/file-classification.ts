import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ActionFacts,
  FileImpactFacts,
  FileTargetFacts,
  FileTargetState,
  HostToolIdentity,
  ProjectedActionInput,
  RedactedPersistableInput,
  TriState,
  WorkspaceScope,
} from "./domain.js";
import {
  fingerprintTransientActionInput,
  InputBoundaryError,
  projectTransientActionInput,
} from "./input-boundary.js";
import type { SensitiveSnapshotTarget } from "./pre-image-snapshot.js";

const supportedTools = new Set(["read", "write", "edit"]);

// A-005 只完成事实层：先以 A-004 的真实来源身份和锁定 schema 解析输入，再用 raw path
// 做 cwd/realpath/lstat 检查，最后才生成脱敏 ActionFacts。任何异常都保留 unknown/no 证据，
// 不在这里提前实现 A-006 的 unsupported 策略或 A-007 的统一风险决策。

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

interface ParsedInput {
  path: string;
  kind: "read" | "write" | "edit";
}

interface PathFacts {
  canonicalTarget?: string;
  scope: WorkspaceScope;
  state: FileTargetState;
  linked: TriState;
  supported: TriState;
  createsParentDirectories: TriState;
  evidenceCodes: string[];
}

function hasOwnData(
  descriptors: Record<PropertyKey, PropertyDescriptor>,
  key: string,
  type: "string" | "number",
): boolean {
  const descriptor = descriptors[key];
  return Boolean(
    descriptor && "value" in descriptor && typeof descriptor.value === type,
  );
}

function parseVerifiedInput(
  tool: HostToolIdentity,
  input: unknown,
): ParsedInput | undefined {
  // A-004 的来源身份是语义开关；同名 external/overridden/unknown 工具绝不借用内置工具规则。
  if (tool.status !== "verified_builtin" || !supportedTools.has(tool.name)) {
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;

  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (!hasOwnData(descriptors, "path", "string")) return undefined;
  if (tool.name === "read") {
    for (const key of ["offset", "limit"]) {
      if (key in descriptors && !hasOwnData(descriptors, key, "number"))
        return undefined;
    }
    return { path: descriptors.path?.value as string, kind: "read" };
  }
  if (tool.name === "write") {
    return hasOwnData(descriptors, "content", "string")
      ? { path: descriptors.path?.value as string, kind: "write" }
      : undefined;
  }

  const edits = descriptors.edits?.value;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || Array.isArray(edit))
      return undefined;
    const fields = Object.getOwnPropertyDescriptors(edit);
    if (
      !hasOwnData(fields, "oldText", "string") ||
      !hasOwnData(fields, "newText", "string")
    ) {
      return undefined;
    }
  }
  return { path: descriptors.path?.value as string, kind: "edit" };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isInside(root: string, candidate: string): boolean {
  // path.relative 按路径分段处理，避免把 C:\app2 或 /app2 误判成 C:\app 或 /app 的子目录。
  const value = path.relative(root, candidate);
  return (
    value === "" ||
    (!path.isAbsolute(value) &&
      value !== ".." &&
      !value.startsWith(`..${path.sep}`))
  );
}

function containsTraversal(value: string): boolean {
  const separator = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  return value.split(separator).includes("..");
}

function pathSyntax(
  value: string,
  cwd: string,
): "ok" | "malformed" | "foreign" | "workspace_unc" {
  if (value.length === 0 || [...value].some(isControlCharacter)) {
    return "malformed";
  }

  if (process.platform === "win32") {
    if (/^[A-Za-z]:[^\\/]/.test(value)) return "malformed";
    if (/^(?:\\\\|\/\/)/.test(cwd)) return "workspace_unc";
    if (/^(?:\\\\|\/\/)/.test(value)) {
      // UNC 需要独立的共享根与网络错误模型；Alpha 确定性阻止，不触碰网络路径。
      return "foreign";
    }
    const withoutDrive = value.replace(/^[A-Za-z]:[\\/]/, "");
    if (/[<>"|?*:]/.test(withoutDrive)) return "malformed";
    const segments = withoutDrive.split(/[\\/]+/);
    if (
      segments.some((segment) => {
        if (segment === "." || segment === "..") return false;
        const stem = segment.split(".", 1)[0] ?? "";
        return (
          /[ .]$/.test(segment) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)
        );
      })
    ) {
      // Windows 会把这些名字解析为设备或别名，不能把它们预测成普通新文件。
      return "malformed";
    }
    return "ok";
  }

  // 在 POSIX 上不能把 Windows drive/UNC 字符串当成普通相对文件名。
  if (
    (!path.posix.isAbsolute(value) && path.win32.isAbsolute(value)) ||
    /^[A-Za-z]:/.test(value) ||
    /^\\\\/.test(value)
  ) {
    return "foreign";
  }
  return "ok";
}

function sensitivePath(filePath: string): boolean {
  const segments = filePath
    .split(/[\\/]+/)
    .map((segment) => segment.toLowerCase());
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) =>
      [".agentglass", ".aws", ".azure", ".gnupg", ".ssh"].includes(segment),
    ) ||
    /^\.env(?:\.|$)/.test(name) ||
    /^(?:auth|credentials?)(?:\.[^.]+)?$/.test(name) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.git-credentials|\.netrc|\.npmrc|\.pypirc)$/.test(
      name,
    ) ||
    /\.(?:key|pem|p12|pfx|cer|crt)$/i.test(name)
  );
}

function opaqueTargetId(value: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["agentglass-file-target-v1", value]), "utf8")
    .digest("hex");
}

function outsidePath(canonicalTarget: string, evidenceCode: string): PathFacts {
  return {
    canonicalTarget,
    scope: "outside",
    state: "unknown",
    linked: "unknown",
    supported: "no",
    createsParentDirectories: "unknown",
    evidenceCodes: [evidenceCode, "OUTSIDE_WORKSPACE"],
  };
}

async function inspectPath(cwd: string, filePath: string): Promise<PathFacts> {
  const syntax = pathSyntax(filePath, cwd);
  if (syntax !== "ok") {
    const workspaceUncertain = syntax === "workspace_unc";
    return {
      scope: syntax === "foreign" ? "outside" : "unknown",
      state: "unknown",
      linked: "unknown",
      supported: workspaceUncertain ? "unknown" : "no",
      createsParentDirectories: "unknown",
      evidenceCodes:
        syntax === "foreign"
          ? ["PATH_FOREIGN_ROOT", "OUTSIDE_WORKSPACE"]
          : workspaceUncertain
            ? ["WORKSPACE_PATH_UNCERTAIN", "PATH_UNCERTAIN"]
            : ["PATH_MALFORMED", "PATH_UNCERTAIN"],
    };
  }

  let workspaceReal: string;
  try {
    const workspace = await lstat(cwd);
    if (workspace.isSymbolicLink() || !workspace.isDirectory())
      throw new Error();
    workspaceReal = await realpath(cwd);
  } catch {
    return {
      scope: "unknown",
      state: "unknown",
      linked: "unknown",
      supported: "unknown",
      createsParentDirectories: "unknown",
      evidenceCodes: ["WORKSPACE_PATH_UNCERTAIN", "PATH_UNCERTAIN"],
    };
  }

  const cwdAbsolute = path.resolve(cwd);
  const lexicalTarget = path.resolve(cwdAbsolute, filePath);
  if (!isInside(cwdAbsolute, lexicalTarget)) {
    return outsidePath(lexicalTarget, "TARGET_LEXICALLY_OUTSIDE");
  }

  const relativeTarget = path.relative(cwdAbsolute, lexicalTarget);
  const target = path.resolve(workspaceReal, relativeTarget);

  const segments = relativeTarget === "" ? [] : relativeTarget.split(path.sep);
  let current = workspaceReal;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (!isMissing(error)) {
        return {
          canonicalTarget: target,
          scope: "unknown",
          state: "unknown",
          linked: "unknown",
          supported: "unknown",
          createsParentDirectories: "unknown",
          evidenceCodes: ["PATH_INSPECTION_FAILED", "PATH_UNCERTAIN"],
        };
      }
      const missingParentCount = Math.max(0, segments.length - index - 1);
      return {
        canonicalTarget: target,
        scope: "inside",
        state: "missing",
        linked: "no",
        supported: "yes",
        createsParentDirectories: missingParentCount > 0 ? "yes" : "no",
        evidenceCodes: [
          "WORKSPACE_REALPATH_VERIFIED",
          "NEAREST_EXISTING_PARENT_VERIFIED",
          "WORKSPACE_SCOPE_INSIDE",
          "TARGET_MISSING",
        ],
      };
    }

    if (stats.isSymbolicLink()) {
      let linkedTarget: string;
      try {
        linkedTarget = await realpath(current);
      } catch {
        return {
          canonicalTarget: target,
          scope: "unknown",
          state: "unknown",
          linked: "yes",
          supported: "no",
          createsParentDirectories: "unknown",
          evidenceCodes: ["SYMLINK_TARGET_UNCERTAIN", "PATH_UNCERTAIN"],
        };
      }
      const remainder = segments.slice(index + 1);
      const resolvedTarget = path.resolve(linkedTarget, ...remainder);
      return {
        canonicalTarget: resolvedTarget,
        scope: isInside(workspaceReal, resolvedTarget) ? "inside" : "outside",
        state: "unknown",
        linked: "yes",
        supported: "no",
        createsParentDirectories: "unknown",
        evidenceCodes: [
          "SYMLINK_DETECTED",
          "PATH_UNCERTAIN",
          ...(isInside(workspaceReal, resolvedTarget)
            ? []
            : ["OUTSIDE_WORKSPACE"]),
        ],
      };
    }

    const isTarget = index === segments.length - 1;
    if (!isTarget && !stats.isDirectory()) {
      return {
        canonicalTarget: target,
        scope: "inside",
        state: "special",
        linked: "no",
        supported: "no",
        createsParentDirectories: "unknown",
        evidenceCodes: ["NON_DIRECTORY_PARENT", "PATH_UNCERTAIN"],
      };
    }
    if (!isTarget) continue;

    let targetReal: string;
    try {
      targetReal = await realpath(current);
    } catch {
      return {
        canonicalTarget: target,
        scope: "unknown",
        state: "unknown",
        linked: "unknown",
        supported: "unknown",
        createsParentDirectories: "unknown",
        evidenceCodes: ["TARGET_REALPATH_FAILED", "PATH_UNCERTAIN"],
      };
    }
    if (!isInside(workspaceReal, targetReal))
      return outsidePath(targetReal, "TARGET_REALPATH_OUTSIDE");
    if (stats.isFile() && stats.nlink > 1) {
      return {
        canonicalTarget: targetReal,
        scope: "inside",
        state: "existing_file",
        linked: "yes",
        supported: "no",
        createsParentDirectories: "no",
        evidenceCodes: ["HARD_LINK_DETECTED", "PATH_UNCERTAIN"],
      };
    }
    const state: FileTargetState = stats.isFile()
      ? "existing_file"
      : stats.isDirectory()
        ? "directory"
        : "special";
    return {
      canonicalTarget: targetReal,
      scope: "inside",
      state,
      linked: "no",
      supported: state === "existing_file" ? "yes" : "no",
      createsParentDirectories: "no",
      evidenceCodes: [
        "WORKSPACE_REALPATH_VERIFIED",
        "TARGET_REALPATH_VERIFIED",
        "WORKSPACE_SCOPE_INSIDE",
        state === "existing_file"
          ? "TARGET_REGULAR_FILE"
          : state === "directory"
            ? "TARGET_DIRECTORY"
            : "TARGET_SPECIAL_FILE",
        ...(state === "existing_file" ? [] : ["PATH_UNCERTAIN"]),
      ],
    };
  }

  // 目标正好是 workspace 根目录，只能作为目录事实，不能进入普通文件路径。
  return {
    canonicalTarget: workspaceReal,
    scope: "inside",
    state: "directory",
    linked: "no",
    supported: "no",
    createsParentDirectories: "no",
    evidenceCodes: [
      "WORKSPACE_SCOPE_INSIDE",
      "TARGET_DIRECTORY",
      "PATH_UNCERTAIN",
    ],
  };
}

function projectedPathLabel(input: RedactedPersistableInput): string {
  const value = (input as unknown as { path?: unknown }).path;
  if (typeof value !== "string") return "未知文件";
  const label = [...path.basename(value)]
    .filter((character) => !isControlCharacter(character))
    .join("")
    .slice(0, 120);
  return label || "未知文件";
}

function impactFacts(
  kind: ParsedInput["kind"] | undefined,
  pathFacts: PathFacts,
): FileImpactFacts {
  let effect: FileImpactFacts["effect"] = "unknown";
  if (kind === "read" && pathFacts.state === "existing_file") effect = "read";
  if (kind === "edit" && pathFacts.state === "existing_file") effect = "edit";
  if (kind === "write" && pathFacts.state === "existing_file")
    effect = "overwrite";
  if (kind === "write" && pathFacts.state === "missing") effect = "create";
  return Object.freeze({
    effect,
    createsParentDirectories:
      kind === "write" ? pathFacts.createsParentDirectories : "no",
  });
}

export async function classifyFileAction(options: {
  actionId: string;
  cwd: string;
  tool: HostToolIdentity;
  rawInput: unknown;
}): Promise<{ action: ActionFacts; input: ProjectedActionInput }> {
  // 完整 raw 输入先生成审批指纹；路径检查仍读取 raw path，完成后才进入脱敏投影。
  const initialFingerprint = fingerprintTransientActionInput(
    options.tool.name,
    options.rawInput,
  );
  const parsed = parseVerifiedInput(options.tool, options.rawInput);
  const verifiedIdentity =
    options.tool.status === "verified_builtin" &&
    supportedTools.has(options.tool.name);
  const pathFacts = parsed
    ? await inspectPath(options.cwd, parsed.path)
    : {
        scope: "unknown" as const,
        state: "unknown" as const,
        linked: "unknown" as const,
        supported: "no" as const,
        createsParentDirectories: "unknown" as const,
        evidenceCodes: [
          verifiedIdentity ? "INPUT_INVALID" : "TOOL_IDENTITY_UNVERIFIED",
        ],
      };
  const pathEvidenceCodes = [
    ...(parsed
      ? [path.isAbsolute(parsed.path) ? "PATH_ABSOLUTE" : "PATH_CWD_RELATIVE"]
      : []),
    ...(parsed && containsTraversal(parsed.path) && pathFacts.scope === "inside"
      ? ["PATH_TRAVERSAL_RESOLVED_INSIDE"]
      : []),
    ...pathFacts.evidenceCodes,
  ];
  const projected = projectTransientActionInput(
    options.tool.name,
    options.rawInput,
  );
  if (projected.fingerprint.value !== initialFingerprint.value) {
    // 异步 realpath/lstat 期间 raw 对象发生变化时，不允许拼接旧路径事实与新输入。
    throw new InputBoundaryError("INPUT_INVALID");
  }
  const pathIsSensitive = parsed ? sensitivePath(parsed.path) : false;
  const sensitive: TriState =
    pathIsSensitive || projected.secretDetected
      ? "yes"
      : parsed
        ? "no"
        : "unknown";
  const targetLabel = projectedPathLabel(projected.redactedInput);
  const redactedPath = (
    projected.redactedInput as unknown as { path?: unknown }
  ).path;
  const targetPathIsSensitive =
    pathIsSensitive || (parsed !== undefined && redactedPath !== parsed.path);
  const supportedPath: TriState =
    pathFacts.supported !== "yes"
      ? pathFacts.supported
      : targetPathIsSensitive ||
          (parsed?.kind !== "write" && pathFacts.state !== "existing_file")
        ? "no"
        : "yes";
  const target: FileTargetFacts = Object.freeze({
    targetId: opaqueTargetId(
      pathFacts.canonicalTarget ?? `${projected.fingerprint.value}:unknown`,
    ),
    label: targetLabel,
    workspaceScope: pathFacts.scope,
    state:
      parsed?.kind === "write" && pathFacts.state === "missing"
        ? "new_file"
        : pathFacts.state,
    linked: pathFacts.linked,
    supportedPath,
    evidenceCodes: Object.freeze(pathEvidenceCodes),
  });
  const evidenceCodes = [
    verifiedIdentity ? "TOOL_IDENTITY_VERIFIED" : "TOOL_IDENTITY_UNVERIFIED",
    ...(parsed
      ? ["TOOL_SCHEMA_VERIFIED"]
      : verifiedIdentity
        ? ["INPUT_INVALID"]
        : []),
    ...pathEvidenceCodes,
    ...(pathIsSensitive ? ["SENSITIVE_TARGET"] : []),
    ...(projected.secretDetected ? ["SECRET_CANDIDATE_DETECTED"] : []),
  ];

  return Object.freeze({
    action: Object.freeze({
      actionId: options.actionId,
      kind: parsed?.kind ?? "unknown",
      targetLabel,
      mutatesState: parsed
        ? parsed.kind === "read"
          ? "no"
          : "yes"
        : "unknown",
      outsideWorkspace:
        pathFacts.scope === "outside"
          ? "yes"
          : pathFacts.scope === "inside"
            ? "no"
            : "unknown",
      sensitive,
      targets: Object.freeze([target]),
      impactFacts: impactFacts(parsed?.kind, pathFacts),
      evidenceCodes: Object.freeze([...new Set(evidenceCodes)]),
      fingerprint: projected.fingerprint,
    }),
    input: projected,
  });
}

export async function resolveSensitiveSnapshotTarget(options: {
  cwd: string;
  tool: HostToolIdentity;
  rawInput: unknown;
  expectedAction: ActionFacts;
}): Promise<SensitiveSnapshotTarget | undefined> {
  // snapshot 在 sibling/risk 检查后才调用，因此这里重新绑定 raw input 与路径事实；异步检查期间
  // 任一输入、存在状态、目标身份或支持性变化都会降级，不能把旧分类与新前像拼接。
  const before = fingerprintTransientActionInput(
    options.tool.name,
    options.rawInput,
  );
  if (before.value !== options.expectedAction.fingerprint.value)
    return undefined;
  const parsed = parseVerifiedInput(options.tool, options.rawInput);
  if (!parsed || (parsed.kind !== "write" && parsed.kind !== "edit"))
    return undefined;
  const pathFacts = await inspectPath(options.cwd, parsed.path);
  const after = fingerprintTransientActionInput(
    options.tool.name,
    options.rawInput,
  );
  const target = options.expectedAction.targets[0];
  const state =
    parsed.kind === "write" && pathFacts.state === "missing"
      ? "new_file"
      : pathFacts.state;
  const eligible =
    before.value === after.value &&
    options.expectedAction.kind === parsed.kind &&
    options.expectedAction.sensitive === "no" &&
    options.expectedAction.mutatesState === "yes" &&
    options.expectedAction.impactFacts.createsParentDirectories === "no" &&
    pathFacts.canonicalTarget !== undefined &&
    pathFacts.scope === "inside" &&
    pathFacts.linked === "no" &&
    pathFacts.supported === "yes" &&
    target?.targetId === opaqueTargetId(pathFacts.canonicalTarget) &&
    target.state === state &&
    target.supportedPath === "yes" &&
    ((parsed.kind === "edit" && state === "existing_file") ||
      (parsed.kind === "write" &&
        (state === "existing_file" || state === "new_file")));
  if (!eligible || !pathFacts.canonicalTarget) return undefined;

  return Object.freeze({
    actionId: options.expectedAction.actionId,
    targetId: target.targetId,
    targetPath: pathFacts.canonicalTarget,
    targetExisted: state === "existing_file",
  });
}
