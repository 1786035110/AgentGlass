import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  EditToolInput,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  consumeApprovalToken,
  executionBinding,
  invalidateApprovalToken,
  issueApprovalToken,
  sameExecutionBinding,
} from "../../core/approval.js";
import type {
  ApprovalToken,
  ExecutionBinding,
  ExpectedFilePostcondition,
  HostCapabilities,
  HostExecutionFacts,
  HostToolIdentity,
  ObservableUserGoal,
  OutcomeCard,
  PredictedEffect,
  PreImageSnapshotEvidence,
  RiskAssessment,
  SiblingExecutionReference,
  TransientHostExecutionInput,
} from "../../core/domain.js";
import {
  projectHostExecutionInput,
  projectObservableUserGoal,
} from "../../core/execution-input.js";
import { resolveSensitiveSnapshotTarget } from "../../core/file-classification.js";
import {
  FILE_OBSERVATION_LIMIT_BYTES,
  hashFileBytes,
  unverifiableResult,
  verifyFilePostcondition,
} from "../../core/file-verification.js";
import {
  fingerprintTransientActionInput,
  redactDisplayString,
} from "../../core/input-boundary.js";
import {
  renderOutcomeCard,
  renderOutcomeCardUpdate,
  renderReadNotice,
} from "../../core/outcome-card.js";
import {
  capturePreImageSnapshot,
  cleanSnapshotSet,
  finalizeRecoverySnapshot,
  inspectCleanupSet,
  markRecoveryState,
  type RecoveryEntry,
  recoveryEntryIsCurrent,
  restoreRecoveryEntry,
  unavailablePreImageSnapshot,
  verifyPreImageSnapshotBaseline,
} from "../../core/pre-image-snapshot.js";
import { predictEffects } from "../../core/predicted-effects.js";
import {
  assessSiblingMutationRisk,
  requireMutationBackup,
} from "../../core/risk-engine.js";
import { readStableFile } from "../../core/stable-file.js";

type AdapterObserver = (facts: HostExecutionFacts) => Promise<void> | void;

const BLOCK_REASON =
  "AgentGlass could not verify this tool call's runtime identity, so it was stopped.";
const MULTIPLE_MUTATIONS_REASON =
  "已停止：这次包含多个会改变内容或影响未知的操作。请让 Pi 一次只提出一个变更。";
const BATCH_CONTEXT_REASON =
  "已停止：无法确认这次同时提出的操作是否完整。请让 Pi 一次只提出一个变更后重试。";
const APPROVAL_UNAVAILABLE_REASON =
  "已停止：这一步需要你的明确确认，但当前模式没有可用的本地审批界面。请回到 Pi 交互窗口再试。";
const APPROVAL_STOPPED_REASON =
  "已停止：你没有批准这一步，因此这次修改没有获得执行许可。";
const APPROVAL_CHANGED_REASON =
  "已停止：审批期间动作或运行环境发生变化。旧批准已失效，请重新提出当前这一步。";
const SAFETY_BLOCK_REASON =
  "已停止：当前版本无法可靠说明或支持这一步。请改为普通项目文件的查看或单个修改。";
const BACKUP_BLOCK_REASON =
  "已停止：未能取得这次修改所需的修改前证据，或这一步会创建缺少的上级文件夹。请明确选择已有文件夹中的一份普通文件后重试。";
const READ_STATUS_KEY = "agentglass-read";
const ACTION_CARD_KEY = "agentglass-action";
const WELCOME_WIDGET_KEY = "agentglass-welcome";
const EXAMPLE_DIRECTORY_NAME = "agentglass-example";
const EXAMPLE_FILE_NAME = "活动说明.txt";
const EXAMPLE_RELATIVE_FILE = `${EXAMPLE_DIRECTORY_NAME}/${EXAMPLE_FILE_NAME}`;
const EXAMPLE_GOAL = "帮我修改这份活动说明";
// 这段内容是随扩展发布的固定无秘密示例；只用于明确的示例准备，不从用户输入读取，也不覆盖已有路径。
const EXAMPLE_ACTIVITY_TEXT =
  "活动说明\n\n活动名称：社区旧物交换日\n时间：周六 10:00—15:00\n地点：社区活动室\n安排：带来闲置物品，现场登记后交换。\n报名：现场登记。\n";

// 仅区分“批次无法证明”和其他宿主身份失败，以选择真实且脱敏的固定原因；异常文本从不返回 Pi。
class SiblingContextError extends Error {}

interface PendingVerification {
  binding: Readonly<ExecutionBinding>;
  action: HostExecutionFacts["action"];
  effect: PredictedEffect;
  targetPath: string;
  expected: ExpectedFilePostcondition;
  preImage: PreImageSnapshotEvidence;
  inFlight: boolean;
}

interface SessionRecoveryEntry extends RecoveryEntry {
  sessionId: string;
  cwd: string;
  targetLabel: string;
}

interface ExamplePlan {
  cwd: string;
  realCwd: string;
  cwdIdentity: { dev: string; ino: string };
  directory: string;
  file: string;
}

const knownBuiltinNames = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
]);
const protectedBuiltinNames = new Set(["read", "write", "edit"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hostExecutionId(sessionId: string, toolCallId: string): string {
  // JSON tuple keeps the two identity fields unambiguous; the digest is only a correlation ID, not a signature.
  return createHash("sha256")
    .update(JSON.stringify([sessionId, toolCallId]), "utf8")
    .digest("hex");
}

function wrapLine(line: string, width: number): string[] {
  return line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""];
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function safeDirectoryLabel(cwd: string): string {
  try {
    const base = path.basename(path.resolve(cwd));
    const visible = redactDisplayString(base)
      .replace(/\p{Cc}/gu, "")
      .trim();
    const bounded = [...(visible || "当前工作文件夹")];
    return bounded.length > 80
      ? `${bounded.slice(0, 79).join("")}…`
      : bounded.join("");
  } catch {
    return "当前工作文件夹（位置无法确认）";
  }
}

function setWelcomePanel(
  ctx: ExtensionContext,
  lines: readonly string[],
): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  try {
    // 欢迎/帮助是同一入口的非审批信息面板；不创建第二套 UI，也不把面板文字送回风险层。
    ctx.ui.setWidget(WELCOME_WIDGET_KEY, [...lines]);
  } catch {
    // UI 失败只影响说明展示，不改变文件或恢复状态。
  }
}

function welcomeLines(cwd: string): readonly string[] {
  return Object.freeze([
    "AgentGlass 已启用",
    `当前工作文件夹：${safeDirectoryLabel(cwd)}（完整路径不显示）`,
    "支持：查看、创建或修改当前项目内的普通文本文件。",
    "变更会先说明预期影响；需要修改时，每一步都要单独取得你的明确同意。",
    "输入 /agentglass 查看帮助、准备安全示例，或使用最近一次恢复。",
    "需要已配置模型的 Pi；AgentGlass 不提供安装器、账号或密钥。",
  ]);
}

function helpLines(
  cwd: string,
  latestResult: readonly string[] | undefined,
  recovery: SessionRecoveryEntry | undefined,
): readonly string[] {
  const lines = [
    "AgentGlass 帮助",
    `当前工作文件夹：${safeDirectoryLabel(cwd)}（完整路径不显示）`,
    "",
    "支持范围：只处理已验证的普通项目文件查看、创建和修改；只独立核对卡片列出的文件。",
    "不支持：shell、安装软件、启动或部署项目、联网、批量删除、自定义或覆盖工具。",
    "审批：停止是默认选择；查看详情不会同意，只有明确选择“继续这次修改”才会执行。",
    recovery
      ? `恢复：当前会话可恢复最近一次“${recovery.targetLabel}”；输入 /agentglass restore。`
      : "恢复：当前没有可用的最近恢复入口。",
    "清理：只清理已验证归属的 AgentGlass 私有恢复数据；会单独说明数量和能力损失并再次征求同意。",
    "冲突、损坏、未知或切换会话后不会强行恢复；当前文件会被保留。",
    "查看文件：请在对话中请求 Pi 查看当前项目内的文件；本入口不会启动 shell 或额外程序。",
    "切换目录：本入口没有可靠的目录切换能力；请用 Pi 已有方式打开/切换目标项目，确认当前文件夹后再输入 /agentglass。",
    `安全示例：当前工作文件夹下新建 ${EXAMPLE_RELATIVE_FILE}，不会覆盖已有同名目录或文件。`,
    `示例目标：${EXAMPLE_GOAL}`,
    "准备示例目录本身不提供目录恢复；部分失败会保留已创建内容并如实说明，不自动删除。",
    "上手前提：Pi 需要已经配置模型；空白电脑安装、模型账号和安装器不属于 AgentGlass。",
  ];
  if (latestResult) {
    lines.push("", "最近结果：", ...latestResult);
  } else {
    lines.push("", "最近结果：本次会话还没有 AgentGlass 文件结果。");
  }
  return Object.freeze(lines);
}

async function inspectExamplePlan(
  cwd: string,
): Promise<ExamplePlan | "conflict" | undefined> {
  // 示例是唯一允许 AgentGlass 自己准备目录的固定路径：先确认当前 cwd 是真实普通目录，
  // 再确认直接子目录不存在。这里不复用普通 write 的隐式父目录逻辑，也不接受用户路径。
  try {
    if (!nonEmptyString(cwd) || !path.isAbsolute(cwd)) return;
    const cwdStats = await lstat(cwd);
    if (cwdStats.isSymbolicLink() || !cwdStats.isDirectory()) return;
    const realCwd = await realpath(cwd);
    const realCwdStats = await lstat(realCwd);
    // Windows runner 可能用 8.3 短路径传入 cwd；文字不同不代表越界，
    // 用真实目录身份确认它仍是同一个普通目录，同时保留直接符号链接拒绝。
    if (
      realCwdStats.isSymbolicLink() ||
      !realCwdStats.isDirectory() ||
      String(realCwdStats.dev) !== String(cwdStats.dev) ||
      String(realCwdStats.ino) !== String(cwdStats.ino)
    )
      return;
    const directory = path.join(realCwd, EXAMPLE_DIRECTORY_NAME);
    const file = path.join(directory, EXAMPLE_FILE_NAME);
    if (!samePath(path.dirname(directory), realCwd)) return;
    try {
      await lstat(directory);
      return "conflict";
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        return;
    }
    return {
      cwd,
      realCwd,
      cwdIdentity: { dev: String(cwdStats.dev), ino: String(cwdStats.ino) },
      directory,
      file,
    };
  } catch {
    return;
  }
}

async function examplePlanIsCurrent(
  plan: ExamplePlan,
  ctx: ExtensionContext,
): Promise<boolean> {
  // 审批等待期间重新核对 cwd 身份和固定目标，避免把批准带到切换后的目录或竞态创建的目录。
  try {
    if (
      !samePath(ctx.cwd, plan.cwd) ||
      !samePath(await realpath(ctx.cwd), plan.realCwd)
    )
      return false;
    const cwdStats = await lstat(ctx.cwd);
    if (
      cwdStats.isSymbolicLink() ||
      !cwdStats.isDirectory() ||
      String(cwdStats.dev) !== plan.cwdIdentity.dev ||
      String(cwdStats.ino) !== plan.cwdIdentity.ino
    )
      return false;
  } catch {
    return false;
  }
  try {
    await lstat(plan.directory);
    return false;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT",
    );
  }
}

async function requestOutcomeApproval(
  ctx: ExtensionContext,
  card: OutcomeCard,
  pendingCancels: Set<() => void>,
): Promise<"continue" | "stop"> {
  const signal = ctx.signal;
  if (ctx.mode !== "tui" || !ctx.hasUI || signal?.aborted) return "stop";

  let cancelPrompt = (): void => {};
  let submitted: "continue" | "stop" | undefined;
  try {
    const result = await ctx.ui.custom<"continue" | "stop" | undefined>(
      (tui, _theme, keybindings, done) => {
        const labels = ["停止这一步", "查看详情", "继续这次修改"] as const;
        let selected = 0;
        let expanded = false;
        let settled = false;
        const settle = (choice: "continue" | "stop"): void => {
          if (settled) return;
          settled = true;
          submitted = choice;
          pendingCancels.delete(cancel);
          signal?.removeEventListener("abort", cancel);
          done(choice);
        };
        const cancel = (): void => settle("stop");
        cancelPrompt = cancel;
        pendingCancels.add(cancel);
        signal?.addEventListener("abort", cancel, { once: true });

        return {
          render(width: number): string[] {
            const content = [
              card.title,
              card.expectedOutcome,
              card.attention,
              card.recovery,
              ...(expanded ? ["详情：", ...card.details] : []),
              "",
              ...labels.map(
                (label, index) =>
                  `${selected === index ? "[当前]" : "[ ]"} ${label}`,
              ),
              "方向键选择，Enter 确认，Esc 停止。查看详情不会批准修改。",
            ];
            return content.flatMap((line) => wrapLine(line, width));
          },
          invalidate(): void {},
          handleInput(data: string): void {
            if (settled) return;
            if (keybindings.matches(data, "tui.select.cancel")) {
              cancel();
              return;
            }
            if (keybindings.matches(data, "tui.select.up")) {
              selected = (selected + labels.length - 1) % labels.length;
              tui.requestRender();
              return;
            }
            if (
              keybindings.matches(data, "tui.select.down") ||
              keybindings.matches(data, "tui.input.tab")
            ) {
              selected = (selected + 1) % labels.length;
              tui.requestRender();
              return;
            }
            if (!keybindings.matches(data, "tui.select.confirm")) return;
            if (selected === 0) cancel();
            if (selected === 1) {
              expanded = !expanded;
              tui.requestRender();
            }
            if (selected === 2) settle("continue");
          },
          dispose(): void {
            pendingCancels.delete(cancel);
            signal?.removeEventListener("abort", cancel);
            cancel();
          },
        };
      },
    );
    return result === "continue" && submitted === "continue" && !signal?.aborted
      ? result
      : "stop";
  } catch {
    return "stop";
  } finally {
    cancelPrompt();
  }
}

function sameApprovalFacts(
  left: HostExecutionFacts,
  leftRisk: RiskAssessment,
  right: HostExecutionFacts,
  rightRisk: RiskAssessment,
): boolean {
  // 这些对象已脱敏且由 Core 以固定字段顺序生成；比较完整事实避免只盯路径标签或指纹。
  return (
    JSON.stringify(left.action) === JSON.stringify(right.action) &&
    JSON.stringify(leftRisk) === JSON.stringify(rightRisk) &&
    left.tool.status === right.tool.status &&
    left.capabilities.interaction === right.capabilities.interaction &&
    left.capabilities.canPromptForApproval ===
      right.capabilities.canPromptForApproval
  );
}

function transientExecutionBinding(
  transient: TransientHostExecutionInput,
): Readonly<ExecutionBinding> {
  return Object.freeze({
    fingerprint: fingerprintTransientActionInput(
      transient.tool.name,
      transient.rawInput,
    ),
    toolName: transient.tool.name,
    cwd: transient.cwd,
    sessionId: transient.sessionId,
    hostExecutionId: transient.hostExecutionId,
    toolCallId: transient.toolCallId,
  });
}

function sameRuntimeEnvelope(
  transient: TransientHostExecutionInput,
  facts: HostExecutionFacts,
): boolean {
  return (
    transient.tool.status === facts.tool.status &&
    transient.capabilities.interaction === facts.capabilities.interaction &&
    transient.capabilities.canPromptForApproval ===
      facts.capabilities.canPromptForApproval &&
    JSON.stringify(transient.siblings) === JSON.stringify(facts.siblings)
  );
}

function ownDataValue(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

async function prepareExpectedPostcondition(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  facts: HostExecutionFacts,
  effect: PredictedEffect,
  target: NonNullable<
    Awaited<ReturnType<typeof resolveSensitiveSnapshotTarget>>
  >,
): Promise<ExpectedFilePostcondition> {
  const before = target.targetExisted
    ? await readStableFile(target.targetPath, FILE_OBSERVATION_LIMIT_BYTES)
    : undefined;
  const base = {
    actionId: facts.action.actionId,
    effectId: effect.effectId,
    targetId: effect.targetId,
    beforeSha256: before ? hashFileBytes(before.bytes) : null,
    beforeIdentity: before?.identity ?? null,
    targetExisted: target.targetExisted,
  } as const;

  if (facts.action.kind === "write") {
    const content = ownDataValue(event.input, "content");
    if (typeof content !== "string") throw new Error();
    const bytes = Buffer.from(content, "utf8");
    return Object.freeze({
      ...base,
      kind: "exact_bytes",
      expectedSha256: hashFileBytes(bytes),
      expectedByteLength: bytes.length,
    });
  }

  if (facts.action.kind !== "edit" || !before) throw new Error();
  let finalContent: string | undefined;
  try {
    // 直接调用锁定 Pi 0.85.1 的 edit 实现，只把文件操作替换为内存读写；这样匹配、
    // 歧义、NFKC、BOM 与换行语义和真正执行保持一致，又不保存编辑正文用于稍后重放。
    const definition = createEditToolDefinition(ctx.cwd, {
      operations: {
        access: async () => {},
        readFile: async () => before.bytes,
        writeFile: async (_path, content) => {
          finalContent = content;
        },
      },
    });
    await definition.execute(
      "agentglass-expected-postcondition",
      event.input as EditToolInput,
      undefined,
      undefined,
      ctx,
    );
  } catch {
    return Object.freeze({
      ...base,
      kind: "content_changed",
      expectedSha256: null,
      expectedByteLength: null,
    });
  }
  if (finalContent === undefined) throw new Error();
  const bytes = Buffer.from(finalContent, "utf8");
  return Object.freeze({
    ...base,
    kind: "exact_bytes",
    expectedSha256: hashFileBytes(bytes),
    expectedByteLength: bytes.length,
  });
}

function resultBindingMatches(
  pi: ExtensionAPI,
  pending: Pick<PendingVerification, "binding">,
  toolCallId: string,
  toolName: string,
  input: unknown,
  ctx: ExtensionContext,
): boolean {
  try {
    const currentSession = ctx.sessionManager.getSessionId();
    return (
      nonEmptyString(currentSession) &&
      pending.binding.sessionId === currentSession &&
      pending.binding.cwd === ctx.cwd &&
      pending.binding.toolCallId === toolCallId &&
      pending.binding.hostExecutionId ===
        hostExecutionId(currentSession, toolCallId) &&
      pending.binding.toolName === toolName &&
      mapToolIdentity(toolName, configuredTools(pi)).status ===
        "verified_builtin" &&
      fingerprintTransientActionInput(toolName, input).value ===
        pending.binding.fingerprint.value
    );
  } catch {
    return false;
  }
}

function setActionCard(
  ctx: ExtensionContext,
  update: ReturnType<typeof renderOutcomeCardUpdate>,
): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  try {
    // modal 在 Continue 后由 Pi 关闭；稳定 key 让同一逻辑动作卡在原位置区域进入执行/结果态。
    ctx.ui.setWidget(ACTION_CARD_KEY, [...update.lines]);
  } catch {
    // 展示失败不能改写已经完成的文件事实，也不能泄漏宿主异常文本。
  }
}

function setReadStatus(ctx: ExtensionContext, text: string): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  try {
    ctx.ui.setStatus(READ_STATUS_KEY, text);
  } catch {
    // 结果提示失败不能反过来篡改工具结果或泄漏 UI 异常。
  }
}

export function mapPiCapabilities(
  mode: ExtensionContext["mode"],
  hasUI: boolean,
): HostCapabilities {
  if (mode === "tui" && hasUI) {
    return Object.freeze({
      interaction: "local_interactive",
      canPromptForApproval: "yes",
    });
  }
  if (mode === "rpc" && hasUI) {
    // Pi RPC 有 dialog transport，但 Alpha 的安全审批只接受本地 TUI 卡片。
    return Object.freeze({
      interaction: "remote_interactive",
      canPromptForApproval: "no",
    });
  }
  if (mode === "json" && !hasUI) {
    return Object.freeze({
      interaction: "event_stream",
      canPromptForApproval: "no",
    });
  }
  if (mode === "print" && !hasUI) {
    return Object.freeze({
      interaction: "one_shot",
      canPromptForApproval: "no",
    });
  }
  return Object.freeze({
    interaction: "unknown",
    canPromptForApproval: "unknown",
  });
}

function mapToolIdentity(
  name: string,
  tools: readonly ToolInfo[],
): HostToolIdentity {
  const matches = tools.filter((tool) => tool.name === name);
  if (matches.length !== 1) {
    return Object.freeze({ name, status: "unknown" });
  }
  const source = matches[0]?.sourceInfo;
  if (
    !source ||
    !nonEmptyString(source.path) ||
    !nonEmptyString(source.source) ||
    !nonEmptyString(source.scope) ||
    !nonEmptyString(source.origin)
  ) {
    return Object.freeze({ name, status: "unknown" });
  }
  const isLockedBuiltin =
    knownBuiltinNames.has(name) &&
    source?.source === "builtin" &&
    source.path === `<builtin:${name}>` &&
    source.scope === "temporary" &&
    source.origin === "top-level";
  if (isLockedBuiltin) {
    return Object.freeze({ name, status: "verified_builtin" });
  }
  return Object.freeze({
    name,
    status: protectedBuiltinNames.has(name) ? "overridden" : "external",
  });
}

function currentSiblingCalls(ctx: ExtensionContext): Array<{
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}> {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (
    leaf?.type !== "message" ||
    leaf.message.role !== "assistant" ||
    !Array.isArray(leaf.message.content)
  ) {
    throw new SiblingContextError();
  }

  const calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }> = [];
  for (const item of leaf.message.content) {
    if (!item || typeof item !== "object" || item.type !== "toolCall") continue;
    if (
      !nonEmptyString(item.id) ||
      !nonEmptyString(item.name) ||
      !item.arguments ||
      typeof item.arguments !== "object" ||
      Array.isArray(item.arguments)
    ) {
      throw new SiblingContextError();
    }
    calls.push({
      id: item.id,
      name: item.name,
      arguments: item.arguments as Record<string, unknown>,
    });
  }
  if (
    calls.length === 0 ||
    new Set(calls.map((call) => call.id)).size !== calls.length
  ) {
    throw new SiblingContextError();
  }
  return calls;
}

function configuredTools(pi: ExtensionAPI): readonly ToolInfo[] {
  try {
    const tools = pi.getAllTools();
    return Array.isArray(tools) ? tools : [];
  } catch {
    // 工具注册表不可读时保留 unknown，不能靠事件名字猜成内置实现。
    return [];
  }
}

function mapToolCall(
  pi: ExtensionAPI,
  event: ToolCallEvent,
  ctx: ExtensionContext,
  expectedSessionId: string | undefined,
  userGoal: ObservableUserGoal,
): readonly TransientHostExecutionInput[] {
  if (!nonEmptyString(event.toolCallId)) {
    throw new Error();
  }
  if (!nonEmptyString(event.toolName)) {
    throw new Error();
  }

  let sessionId: string;
  try {
    sessionId = ctx.sessionManager.getSessionId();
  } catch {
    throw new Error();
  }
  if (!nonEmptyString(sessionId) || !expectedSessionId) {
    throw new Error();
  }
  if (sessionId !== expectedSessionId) {
    throw new Error();
  }
  if (!nonEmptyString(ctx.cwd)) {
    throw new Error();
  }

  const tools = configuredTools(pi);
  const siblings = currentSiblingCalls(ctx);
  const currentMatches = siblings.filter(
    (call) => call.id === event.toolCallId && call.name === event.toolName,
  );
  if (currentMatches.length !== 1) {
    throw new SiblingContextError();
  }

  const references = Object.freeze(
    siblings.map(
      (call): SiblingExecutionReference =>
        Object.freeze({
          hostExecutionId: hostExecutionId(sessionId, call.id),
          toolCallId: call.id,
          tool: mapToolIdentity(call.name, tools),
        }),
    ),
  );

  // sibling raw input 仅供本次 preflight 分类；当前调用采用事件里的有效 input，避免使用旧消息副本。
  return Object.freeze(
    siblings.map((call) => ({
      hostExecutionId: hostExecutionId(sessionId, call.id),
      toolCallId: call.id,
      sessionId,
      cwd: ctx.cwd,
      tool: mapToolIdentity(call.name, tools),
      capabilities: mapPiCapabilities(ctx.mode, ctx.hasUI),
      siblings: references,
      userGoal,
      rawInput: call.id === event.toolCallId ? event.input : call.arguments,
    })),
  );
}

async function assessMappedBatch(
  batch: readonly TransientHostExecutionInput[],
  toolCallId: string,
): Promise<{ facts: HostExecutionFacts; risk: RiskAssessment }> {
  const facts = await Promise.all(batch.map(projectHostExecutionInput));
  const current = facts.find((item) => item.toolCallId === toolCallId);
  if (!current) throw new Error();
  return {
    facts: current,
    risk: assessSiblingMutationRisk(
      current.action,
      facts.map((item) => item.action),
    ),
  };
}

export function registerPiAdapter(
  pi: ExtensionAPI,
  observe: AdapterObserver = () => {},
  snapshotRoot?: string,
): void {
  let sessionId: string | undefined;
  let userGoal: ObservableUserGoal = Object.freeze({ status: "unknown" });
  // pending 只保存不透明身份字符串；raw input、goal 原文和 Pi event/ctx 都不会进入此 Map。
  const activeExecutions = new Map<
    string,
    { hostExecutionId: string; toolName: string; cwd: string }
  >();
  const pendingVerifications = new Map<string, PendingVerification>();
  const pendingReads = new Map<
    string,
    { binding: Readonly<ExecutionBinding> }
  >();
  const pendingTokens = new Set<ApprovalToken>();
  const pendingApprovalCancels = new Set<() => void>();
  let latestRecovery: SessionRecoveryEntry | undefined;
  let latestResult: readonly string[] | undefined;
  let welcomedCwd: string | undefined;
  let runGeneration = 0;

  const clearRun = (ctx?: ExtensionContext): void => {
    if (ctx) {
      for (const pending of pendingVerifications.values()) {
        setActionCard(
          ctx,
          renderOutcomeCardUpdate(
            pending.action,
            pending.effect,
            unverifiableResult(pending.expected, "unknown", "RESULT_MISSING"),
          ),
        );
      }
    }
    for (const cancel of [...pendingApprovalCancels]) cancel();
    for (const token of pendingTokens) invalidateApprovalToken(token);
    pendingApprovalCancels.clear();
    pendingTokens.clear();
    pendingVerifications.clear();
    pendingReads.clear();
    activeExecutions.clear();
    runGeneration += 1;
    userGoal = Object.freeze({ status: "unknown" });
  };

  const assessCurrent = (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<{ facts: HostExecutionFacts; risk: RiskAssessment }> =>
    assessMappedBatch(
      mapToolCall(pi, event, ctx, sessionId, userGoal),
      event.toolCallId,
    );

  const resolveCurrentSnapshot = async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
    expectedAction: HostExecutionFacts["action"],
  ) => {
    const transient = mapToolCall(pi, event, ctx, sessionId, userGoal).find(
      (item) => item.toolCallId === event.toolCallId,
    );
    return transient
      ? await resolveSensitiveSnapshotTarget({
          cwd: transient.cwd,
          tool: transient.tool,
          rawInput: transient.rawInput,
          expectedAction,
        })
      : undefined;
  };

  const captureCurrentSnapshot = async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
    expectedAction: HostExecutionFacts["action"],
  ) => {
    try {
      const target = await resolveCurrentSnapshot(event, ctx, expectedAction);
      return target
        ? await capturePreImageSnapshot(snapshotRoot, target)
        : unavailablePreImageSnapshot("SNAPSHOT_TARGET_UNSUPPORTED");
    } catch {
      return unavailablePreImageSnapshot("SNAPSHOT_TARGET_CHANGED");
    }
  };

  const snapshotMatchesCurrent = async (
    event: ToolCallEvent,
    ctx: ExtensionContext,
    facts: HostExecutionFacts,
  ): Promise<boolean> => {
    if (facts.preImage.status !== "saved") return true;
    try {
      const target = await resolveCurrentSnapshot(event, ctx, facts.action);
      return Boolean(
        target &&
          (await verifyPreImageSnapshotBaseline(
            snapshotRoot,
            facts.preImage,
            target,
          )),
      );
    } catch {
      return false;
    }
  };

  const internalBinding = (
    toolName:
      | "agentglass.example"
      | "agentglass.restore"
      | "agentglass.cleanup",
    ctx: ExtensionContext,
    toolCallId: string,
    payload: Record<string, unknown>,
  ): Readonly<ExecutionBinding> => {
    const currentSession = ctx.sessionManager.getSessionId();
    if (!nonEmptyString(currentSession) || !nonEmptyString(ctx.cwd))
      throw new Error();
    return Object.freeze({
      fingerprint: fingerprintTransientActionInput(toolName, payload),
      toolName,
      cwd: ctx.cwd,
      sessionId: currentSession,
      hostExecutionId: hostExecutionId(currentSession, toolCallId),
      toolCallId,
    });
  };

  const notify = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ): void => {
    try {
      ctx.ui.notify(message, type);
    } catch {
      // UI 失败不改变恢复或清理状态，也不回显异常。
    }
  };

  const rememberResult = (lines: readonly string[]): void => {
    latestResult = Object.freeze([...lines]);
  };

  const showWelcome = (ctx: ExtensionContext): void => {
    setWelcomePanel(ctx, welcomeLines(ctx.cwd));
  };

  const showHelp = async (ctx: ExtensionContext): Promise<void> => {
    let recovery = latestRecovery;
    if (recovery) {
      try {
        if (!(await recoveryEntryIsCurrent(snapshotRoot, recovery))) {
          if (latestRecovery === recovery) latestRecovery = undefined;
          recovery = undefined;
        }
      } catch {
        recovery = undefined;
      }
    }
    setWelcomePanel(ctx, helpLines(ctx.cwd, latestResult, recovery));
  };

  const prepareExample = async (ctx: ExtensionContext): Promise<void> => {
    const inspected = await inspectExamplePlan(ctx.cwd);
    if (inspected === "conflict") {
      notify(
        ctx,
        `未准备安全示例：当前文件夹下的 ${EXAMPLE_DIRECTORY_NAME} 已存在，AgentGlass 不会覆盖已有目录或文件。请换一个空的当前文件夹后重试。`,
        "warning",
      );
      return;
    }
    if (!inspected) {
      notify(
        ctx,
        "未准备安全示例：无法可靠确认当前工作文件夹的位置或类型。请在普通项目文件夹中重试。",
        "warning",
      );
      return;
    }

    let currentSession: string;
    try {
      currentSession = ctx.sessionManager.getSessionId();
    } catch {
      notify(
        ctx,
        "未准备安全示例：无法确认当前会话。请重新打开项目后重试。",
        "warning",
      );
      return;
    }
    if (!nonEmptyString(currentSession)) {
      notify(
        ctx,
        "未准备安全示例：无法确认当前会话。请重新打开项目后重试。",
        "warning",
      );
      return;
    }

    const callId = randomUUID();
    const payload = {
      cwd: inspected.cwd,
      directory: inspected.directory,
      file: inspected.file,
      contentSha256: createHash("sha256")
        .update(EXAMPLE_ACTIVITY_TEXT, "utf8")
        .digest("hex"),
    };
    let token: ApprovalToken;
    try {
      token = issueApprovalToken(
        callId,
        internalBinding("agentglass.example", ctx, callId, payload),
      );
    } catch {
      notify(
        ctx,
        "未准备安全示例：无法建立这次精确批准。请重新打开项目后重试。",
        "warning",
      );
      return;
    }
    pendingTokens.add(token);
    const choice = await requestOutcomeApproval(
      ctx,
      Object.freeze({
        actionId: callId,
        title: "下一步：准备安全示例",
        expectedOutcome: `预计结果：在当前工作文件夹下创建 ${EXAMPLE_RELATIVE_FILE}。`,
        attention:
          "需要注意：这里只创建这个固定示例目录和文件，不会覆盖已有内容；目录本身不提供自动恢复。",
        recovery:
          "恢复：示例目录准备不是可恢复的文件修改；部分失败会保留已创建内容。",
        details: [
          `位置：当前工作文件夹下的 ${EXAMPLE_RELATIVE_FILE}。`,
          "内容：固定无秘密活动说明，不读取或保存你的私密信息。",
          `下一步目标：${EXAMPLE_GOAL}；之后的修改仍会走普通文件审批和恢复链路。`,
        ],
      }),
      pendingApprovalCancels,
    );
    if (choice !== "continue") {
      invalidateApprovalToken(token);
      pendingTokens.delete(token);
      notify(ctx, "已停止：未批准准备安全示例，没有创建目录或文件。");
      return;
    }
    if (!(await examplePlanIsCurrent(inspected, ctx))) {
      invalidateApprovalToken(token);
      pendingTokens.delete(token);
      notify(
        ctx,
        "已停止：批准期间当前文件夹或示例位置发生变化，没有创建目录或文件。",
        "warning",
      );
      return;
    }
    let finalBinding: Readonly<ExecutionBinding>;
    try {
      finalBinding = internalBinding(
        "agentglass.example",
        ctx,
        callId,
        payload,
      );
    } catch {
      invalidateApprovalToken(token);
      pendingTokens.delete(token);
      notify(
        ctx,
        "已停止：批准期间无法确认当前会话或文件夹，没有创建目录或文件。",
        "warning",
      );
      return;
    }
    if (!consumeApprovalToken(token, callId, finalBinding)) {
      pendingTokens.delete(token);
      notify(ctx, APPROVAL_CHANGED_REASON, "warning");
      return;
    }
    pendingTokens.delete(token);

    let directoryCreated = false;
    try {
      await mkdir(inspected.directory);
      directoryCreated = true;
      await writeFile(inspected.file, EXAMPLE_ACTIVITY_TEXT, {
        encoding: "utf8",
        flag: "wx",
      });
      const result = [
        "安全示例已准备。",
        `已创建：当前工作文件夹下的 ${EXAMPLE_RELATIVE_FILE}。`,
        "内容：固定无秘密活动说明。",
        `下一步目标：${EXAMPLE_GOAL}。`,
        "未覆盖已有内容；示例目录本身不提供自动恢复。",
      ];
      rememberResult(result);
      setActionCard(ctx, {
        actionId: callId,
        state: "matched",
        lines: result,
      });
      setWelcomePanel(ctx, result);
      notify(ctx, `安全示例已准备：可在对话中使用“${EXAMPLE_GOAL}”。`);
    } catch {
      let fileExists = false;
      let directoryExists = false;
      try {
        fileExists = (await lstat(inspected.file)).isFile();
      } catch {
        // 文件不存在或无法读取都不能被写成“没有创建”。
      }
      try {
        await lstat(inspected.directory);
        directoryExists = true;
      } catch {
        // 目录不存在或无法读取都不能被写成“没有创建”。
      }
      const result = [
        "安全示例准备未完成。",
        fileExists
          ? "活动说明文件已经出现，但内容无法确认。"
          : directoryCreated
            ? "已创建示例文件夹，但活动说明文件未完成。"
            : directoryExists
              ? "示例位置已经出现，但无法确认其创建者或内容。"
              : "没有确认创建任何示例内容。",
        "已保留已创建内容，未自动删除；示例目录本身不提供自动恢复。",
      ];
      rememberResult(result);
      setActionCard(ctx, {
        actionId: callId,
        state: "unknown",
        lines: result,
      });
      setWelcomePanel(ctx, result);
      notify(ctx, result.join(" "), "warning");
    }
  };

  pi.registerCommand("agentglass", {
    description:
      "查看 AgentGlass 帮助、准备安全示例、恢复最近修改或清理本地恢复数据",
    handler: async (args, ctx) => {
      let commandSession: string | undefined;
      try {
        const current = ctx.sessionManager.getSessionId();
        commandSession = nonEmptyString(current) ? current : undefined;
      } catch {
        commandSession = undefined;
      }
      // 恢复许可只属于创建它的会话与 cwd；一旦观察到边界切换便立即丢弃内存入口，
      // 防止用户切回旧环境后让已经失效的入口“复活”。磁盘证据仍留给单独审批的清理。
      if (
        latestRecovery &&
        (latestRecovery.sessionId !== commandSession ||
          latestRecovery.cwd !== ctx.cwd)
      ) {
        latestRecovery = undefined;
      }
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        notify(ctx, APPROVAL_UNAVAILABLE_REASON, "warning");
        return;
      }
      let menuHasRecovery = Boolean(latestRecovery);
      if (latestRecovery) {
        try {
          menuHasRecovery = await recoveryEntryIsCurrent(
            snapshotRoot,
            latestRecovery,
          );
        } catch {
          menuHasRecovery = false;
        }
      }
      let action = args.trim().toLowerCase();
      if (!action) {
        const choice = await ctx.ui.select("AgentGlass", [
          "查看欢迎与帮助",
          "准备安全示例",
          ...(menuHasRecovery ? ["恢复最近一次修改"] : []),
          "清理本地恢复数据",
          "关闭",
        ]);
        action =
          choice === "查看欢迎与帮助"
            ? "help"
            : choice === "准备安全示例"
              ? "example"
              : choice === "恢复最近一次修改"
                ? "restore"
                : choice === "清理本地恢复数据"
                  ? "cleanup"
                  : "";
      }
      if (
        action === "help" ||
        action === "welcome" ||
        action === "帮助" ||
        action === "欢迎"
      ) {
        await showHelp(ctx);
        return;
      }
      if (
        action === "example" ||
        action === "示例" ||
        action === "准备示例" ||
        action === "试一个例子"
      ) {
        await prepareExample(ctx);
        return;
      }
      if (action === "restore" || action === "恢复") {
        const entry = latestRecovery;
        if (
          !entry ||
          entry.sessionId !== commandSession ||
          entry.cwd !== ctx.cwd ||
          !(await recoveryEntryIsCurrent(snapshotRoot, entry))
        ) {
          if (entry && latestRecovery === entry) latestRecovery = undefined;
          notify(
            ctx,
            entry
              ? "已停止：当前文件与这次修改完成后的记录不一致，已保留当前内容。"
              : "当前会话没有可用的最近恢复项。",
            "warning",
          );
          return;
        }
        const callId = randomUUID();
        const payload = {
          snapshotId: entry.snapshotId,
          actionId: entry.actionId,
        };
        const binding = internalBinding(
          "agentglass.restore",
          ctx,
          callId,
          payload,
        );
        const token = issueApprovalToken(callId, binding);
        pendingTokens.add(token);
        const card: OutcomeCard = Object.freeze({
          actionId: callId,
          title: entry.targetExisted
            ? `下一步：恢复 ${entry.targetLabel}`
            : `下一步：删除刚才创建的 ${entry.targetLabel}`,
          expectedOutcome: entry.targetExisted
            ? `预计结果：将用修改前副本替换 ${entry.targetLabel} 的当前内容。`
            : `预计结果：将删除这次修改创建的 ${entry.targetLabel}。`,
          attention:
            "需要注意：这是新的单文件变更；继续后本恢复入口会被单次消费，失败也不会自动重试。",
          recovery: "恢复后会独立核对文件内容、存在状态和受支持权限。",
          details: [
            `位置：当前项目内的 ${entry.targetLabel}。`,
            "如果路径、身份、字节或权限已变化，将停止并保留当前文件。",
          ],
        });
        const choice = await requestOutcomeApproval(
          ctx,
          card,
          pendingApprovalCancels,
        );
        if (choice !== "continue") {
          invalidateApprovalToken(token);
          pendingTokens.delete(token);
          notify(ctx, "已停止：未批准恢复，文件和恢复入口均保留。");
          return;
        }
        if (
          latestRecovery !== entry ||
          !(await recoveryEntryIsCurrent(snapshotRoot, entry))
        ) {
          if (latestRecovery === entry) latestRecovery = undefined;
          invalidateApprovalToken(token);
          pendingTokens.delete(token);
          notify(ctx, "已停止：批准期间恢复依据或当前文件已变化。", "warning");
          return;
        }
        const finalBinding = internalBinding(
          "agentglass.restore",
          ctx,
          callId,
          payload,
        );
        if (!consumeApprovalToken(token, callId, finalBinding)) {
          pendingTokens.delete(token);
          notify(ctx, APPROVAL_CHANGED_REASON, "warning");
          return;
        }
        pendingTokens.delete(token);
        latestRecovery = undefined;
        const result = await restoreRecoveryEntry(snapshotRoot, entry);
        const resultLines = Object.freeze([
          result.status === "restored"
            ? `已确认：${entry.targetLabel} 已恢复到这次修改之前。`
            : result.status === "conflict"
              ? `已停止：${entry.targetLabel} 已变化，保留当前文件。`
              : `无法确认：${entry.targetLabel} 的恢复结果。`,
          `内容/存在状态：${result.content === "matched" ? "已匹配修改前副本" : result.content === "missing" ? "已确认文件不存在" : "未确认"}。`,
          `权限：${result.permissions === "matched" ? "已匹配记录" : result.permissions === "not_applicable" ? "不适用" : "未确认"}。`,
          "这次恢复入口已消费；不会自动重试或创建 redo。",
        ]);
        rememberResult(resultLines);
        setActionCard(ctx, {
          actionId: callId,
          state:
            result.status === "restored"
              ? "matched"
              : result.status === "conflict"
                ? "mismatch"
                : "unknown",
          lines: resultLines,
        });
        return;
      }

      if (action === "cleanup" || action === "清理") {
        const cleanup = await inspectCleanupSet(snapshotRoot);
        if (cleanup.fileCount === 0) {
          notify(ctx, "没有可验证归属且可清理的 AgentGlass 恢复数据。");
          return;
        }
        const callId = randomUUID();
        const binding = internalBinding("agentglass.cleanup", ctx, callId, {
          fingerprint: cleanup.fingerprint,
          fileCount: cleanup.fileCount,
          logicalBytes: cleanup.logicalBytes,
        });
        const token = issueApprovalToken(callId, binding);
        pendingTokens.add(token);
        const choice = await requestOutcomeApproval(
          ctx,
          Object.freeze({
            actionId: callId,
            title: "下一步：清理 AgentGlass 本地恢复数据",
            expectedOutcome: `预计结果：删除 ${cleanup.fileCount} 个已验证私有文件，共 ${cleanup.logicalBytes} 字节。`,
            attention: `需要注意：${latestRecovery ? "当前最近一次恢复能力也会丢失。" : "删除后这些副本不能用于恢复。"}`,
            recovery: "清理失败时会保留未删项并报告实际结果。",
            details: [
              "只处理经私有根目录、manifest schema 和引用关系验证的文件。",
              "损坏、未来版本或无法验证归属的数据会保留。",
            ],
          }),
          pendingApprovalCancels,
        );
        if (choice !== "continue") {
          invalidateApprovalToken(token);
          pendingTokens.delete(token);
          notify(ctx, "已停止：未批准清理，本地数据未删除。");
          return;
        }
        const current = await inspectCleanupSet(snapshotRoot);
        const finalBinding = internalBinding(
          "agentglass.cleanup",
          ctx,
          callId,
          {
            fingerprint: cleanup.fingerprint,
            fileCount: cleanup.fileCount,
            logicalBytes: cleanup.logicalBytes,
          },
        );
        if (
          current.fingerprint !== cleanup.fingerprint ||
          !consumeApprovalToken(token, callId, finalBinding)
        ) {
          invalidateApprovalToken(token);
          pendingTokens.delete(token);
          notify(
            ctx,
            "已停止：批准期间待清理集合已变化，未删除任何数据。",
            "warning",
          );
          return;
        }
        pendingTokens.delete(token);
        const result = await cleanSnapshotSet(snapshotRoot, cleanup);
        const activeSnapshotId = latestRecovery?.snapshotId;
        if (
          activeSnapshotId &&
          result.deletedFiles.some((file) =>
            file.startsWith(`${activeSnapshotId}.`),
          )
        ) {
          latestRecovery = undefined;
        }
        const cleanupResult = Object.freeze([
          `清理结果：已删除 ${result.deleted} 个文件，${result.failed} 个失败并已保留。`,
          result.changed
            ? "待清理集合在批准期间发生变化，未继续删除。"
            : "只处理了已验证归属的 AgentGlass 私有数据。",
        ]);
        rememberResult(cleanupResult);
        setWelcomePanel(ctx, cleanupResult);
        notify(
          ctx,
          `清理结果：已删除 ${result.deleted} 个文件，${result.failed} 个失败并已保留。`,
          result.failed > 0 || result.changed ? "warning" : "info",
        );
        return;
      }
      if (action)
        notify(
          ctx,
          "可用操作：/agentglass help、/agentglass example、/agentglass restore 或 /agentglass cleanup。",
        );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    clearRun();
    latestRecovery = undefined;
    latestResult = undefined;
    try {
      const current = ctx.sessionManager.getSessionId();
      sessionId = nonEmptyString(current) ? current : undefined;
    } catch {
      sessionId = undefined;
    }
    if (
      ctx.mode === "tui" &&
      ctx.hasUI &&
      nonEmptyString(ctx.cwd) &&
      welcomedCwd !== ctx.cwd
    ) {
      welcomedCwd = ctx.cwd;
      showWelcome(ctx);
    }
  });
  pi.on("before_agent_start", (event) => {
    try {
      userGoal = nonEmptyString(event.prompt)
        ? projectObservableUserGoal(event.prompt)
        : Object.freeze({ status: "unknown" });
    } catch {
      // 目标原文无法安全投影时只保留 unknown，异常消息和原文都不会跨事件存活。
      userGoal = Object.freeze({ status: "unknown" });
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    let batch: readonly TransientHostExecutionInput[];
    let currentToken: ApprovalToken | undefined;
    const toolCallId = event.toolCallId;
    try {
      if (activeExecutions.has(toolCallId)) throw new Error();
      batch = mapToolCall(pi, event, ctx, sessionId, userGoal);
      const current = batch.find((item) => item.toolCallId === toolCallId);
      if (!current) throw new Error();
      if (
        latestRecovery &&
        (latestRecovery.sessionId !== current.sessionId ||
          latestRecovery.cwd !== current.cwd)
      ) {
        latestRecovery = undefined;
      }
      // 在第一个 await 前同步占位；同一调用的并发重入只能看到已占用状态并失败关闭。
      activeExecutions.set(toolCallId, {
        hostExecutionId: current.hostExecutionId,
        toolName: current.tool.name,
        cwd: current.cwd,
      });
    } catch (error) {
      return {
        block: true,
        reason:
          error instanceof SiblingContextError
            ? BATCH_CONTEXT_REASON
            : BLOCK_REASON,
      };
    }

    try {
      let prepared = await assessMappedBatch(batch, toolCallId);
      batch = Object.freeze([]);
      // 结果卡重新生成时才重新读取 event.input；token、pending 集合和 observer 都不保存 raw input。
      for (;;) {
        let observed = prepared.facts;
        let currentRisk = prepared.risk;
        let verificationTarget:
          | NonNullable<
              Awaited<ReturnType<typeof resolveSensitiveSnapshotTarget>>
            >
          | undefined;
        let expected: ExpectedFilePostcondition | undefined;
        if (prepared.risk.decision === "ask") {
          observed = Object.freeze({
            ...prepared.facts,
            preImage: await captureCurrentSnapshot(
              event,
              ctx,
              prepared.facts.action,
            ),
          });
          const beforeCard = await assessCurrent(event, ctx);
          const snapshotStillCurrent = await snapshotMatchesCurrent(
            event,
            ctx,
            observed,
          );
          if (
            !sameApprovalFacts(
              observed,
              prepared.risk,
              beforeCard.facts,
              beforeCard.risk,
            ) ||
            !snapshotStillCurrent
          ) {
            prepared = beforeCard;
            continue;
          }
          currentRisk = requireMutationBackup(
            observed.action,
            prepared.risk,
            observed.preImage,
          );
        }
        await observe(observed);

        if (prepared.risk.reasonCodes.includes("BATCH_MUTATION_BLOCKED")) {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: MULTIPLE_MUTATIONS_REASON };
        }
        if (prepared.risk.reasonCodes.includes("BATCH_CONTEXT_UNKNOWN")) {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: BATCH_CONTEXT_REASON };
        }
        const effect = predictEffects(observed.action, currentRisk)[0];
        if (!effect) throw new Error();
        if (currentRisk.decision === "auto_allow") {
          setReadStatus(
            ctx,
            renderReadNotice(observed.action, prepared.risk, effect),
          );
          pendingReads.set(toolCallId, {
            binding: executionBinding(observed),
          });
          return undefined;
        }
        if (currentRisk.decision === "hard_block") {
          activeExecutions.delete(toolCallId);
          return {
            block: true as const,
            reason: currentRisk.reasonCodes.includes("BACKUP_UNAVAILABLE")
              ? BACKUP_BLOCK_REASON
              : SAFETY_BLOCK_REASON,
          };
        }
        if (
          ctx.mode !== "tui" ||
          !ctx.hasUI ||
          observed.capabilities.canPromptForApproval !== "yes"
        ) {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: APPROVAL_UNAVAILABLE_REASON };
        }

        verificationTarget = await resolveCurrentSnapshot(
          event,
          ctx,
          observed.action,
        );
        if (!verificationTarget) {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: SAFETY_BLOCK_REASON };
        }
        try {
          expected = await prepareExpectedPostcondition(
            event,
            ctx,
            observed,
            effect,
            verificationTarget,
          );
        } catch {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: SAFETY_BLOCK_REASON };
        }

        const card = renderOutcomeCard(
          observed.action,
          currentRisk,
          effect,
          observed.preImage,
          observed.capabilities,
          latestRecovery !== undefined,
        );
        const token = issueApprovalToken(
          observed.action.actionId,
          executionBinding(observed),
        );
        currentToken = token;
        pendingTokens.add(token);
        const choice = await requestOutcomeApproval(
          ctx,
          card,
          pendingApprovalCancels,
        );
        if (choice !== "continue") {
          invalidateApprovalToken(token);
          pendingTokens.delete(token);
          currentToken = undefined;
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: APPROVAL_STOPPED_REASON };
        }

        const current = await assessCurrent(event, ctx);
        const snapshotStillCurrent = await snapshotMatchesCurrent(
          event,
          ctx,
          observed,
        );
        if (
          !sameApprovalFacts(
            observed,
            prepared.risk,
            current.facts,
            current.risk,
          ) ||
          !snapshotStillCurrent
        ) {
          invalidateApprovalToken(token);
          pendingTokens.delete(token);
          currentToken = undefined;
          prepared = current;
          continue;
        }

        // 所有异步路径/前像检查之后，再同步读取一次 Pi 当前事件与宿主 envelope。
        // 这样最后一个 await 后可检测的输入、绑定、工具身份、能力或 sibling 变化，
        // 会先撤销旧 token 并生成新卡，而不是带着较早的 facts 交还执行。
        const finalBatch = mapToolCall(pi, event, ctx, sessionId, userGoal);
        const finalTransient = finalBatch.find(
          (item) => item.toolCallId === toolCallId,
        );
        if (!finalTransient) throw new Error();
        const currentBinding = transientExecutionBinding(finalTransient);
        if (
          !sameExecutionBinding(token.binding, currentBinding) ||
          !sameRuntimeEnvelope(finalTransient, current.facts)
        ) {
          invalidateApprovalToken(token);
          pendingTokens.delete(token);
          currentToken = undefined;
          prepared = await assessMappedBatch(finalBatch, toolCallId);
          continue;
        }

        // 所有异步复核结束后，在交还 Pi 前同步消费；此后任何 replay 都只能失败。
        const consumed = consumeApprovalToken(
          token,
          current.facts.action.actionId,
          currentBinding,
        );
        pendingTokens.delete(token);
        currentToken = undefined;
        if (consumed && verificationTarget && expected) {
          pendingVerifications.set(toolCallId, {
            binding: token.binding,
            action: observed.action,
            effect,
            targetPath: verificationTarget.targetPath,
            expected,
            preImage: observed.preImage,
            inFlight: false,
          });
          setActionCard(ctx, renderOutcomeCardUpdate(observed.action, effect));
          return undefined;
        }
        activeExecutions.delete(toolCallId);
        return { block: true as const, reason: APPROVAL_CHANGED_REASON };
      }
    } catch {
      // 任一异常都必须立即撤销本次尚未消费的授权，不能等到会话清理才失效。
      if (currentToken) {
        invalidateApprovalToken(currentToken);
        pendingTokens.delete(currentToken);
      }
      activeExecutions.delete(toolCallId);
      return { block: true as const, reason: BLOCK_REASON };
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    const read = pendingReads.get(event.toolCallId);
    if (read) {
      pendingReads.delete(event.toolCallId);
      const matched = resultBindingMatches(
        pi,
        read,
        event.toolCallId,
        event.toolName,
        event.input,
        ctx,
      );
      setReadStatus(
        ctx,
        matched && !event.isError
          ? "已完成这次文件查看；文件内容由 Pi 显示。"
          : "无法确认这次文件查看是否完成。",
      );
      return;
    }

    const pending = pendingVerifications.get(event.toolCallId);
    if (!pending || pending.inFlight) return;
    pending.inFlight = true;
    const generation = runGeneration;
    const matches = resultBindingMatches(
      pi,
      pending,
      event.toolCallId,
      event.toolName,
      event.input,
      ctx,
    );
    const outcome = event.isError ? "failed" : "succeeded";
    const observed = await verifyFilePostcondition(
      pending.targetPath,
      pending.expected,
      outcome,
    );
    if (
      runGeneration !== generation ||
      pendingVerifications.get(event.toolCallId) !== pending
    ) {
      return;
    }
    const report = matches
      ? observed
      : unverifiableResult(
          pending.expected,
          outcome,
          "RESULT_IDENTITY_MISMATCH",
        );
    let recoveryAvailable = false;
    if (
      report.status === "matched" &&
      pending.expected.kind === "exact_bytes"
    ) {
      const ready = await finalizeRecoverySnapshot(
        snapshotRoot,
        pending.preImage,
        pending.effect.effectId,
        pending.expected.expectedSha256,
        pending.expected.expectedByteLength,
      );
      if (ready && runGeneration === generation) {
        const previous = latestRecovery;
        const replacementRecorded =
          !previous ||
          (await markRecoveryState(snapshotRoot, previous, "superseded"));
        if (replacementRecorded) {
          latestRecovery = Object.freeze({
            ...ready,
            sessionId: pending.binding.sessionId,
            cwd: pending.binding.cwd,
            targetLabel: pending.effect.targetLabel,
          });
          recoveryAvailable = true;
        }
      }
    }
    if (
      runGeneration !== generation ||
      pendingVerifications.get(event.toolCallId) !== pending
    ) {
      return;
    }
    const resultUpdate = renderOutcomeCardUpdate(
      pending.action,
      pending.effect,
      report,
      recoveryAvailable,
    );
    rememberResult(resultUpdate.lines);
    setActionCard(ctx, resultUpdate);
    pendingVerifications.delete(event.toolCallId);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    let endMatches = false;
    try {
      const currentSession = ctx.sessionManager.getSessionId();
      const active = activeExecutions.get(event.toolCallId);
      endMatches = Boolean(
        active &&
          nonEmptyString(currentSession) &&
          currentSession === sessionId &&
          ctx.cwd === active.cwd &&
          active.hostExecutionId ===
            hostExecutionId(currentSession, event.toolCallId) &&
          active.toolName === event.toolName,
      );
    } catch {
      endMatches = false;
    }
    if (!endMatches) return;
    const pending = pendingVerifications.get(event.toolCallId);
    if (pending && !pending.inFlight) {
      const resultUpdate = renderOutcomeCardUpdate(
        pending.action,
        pending.effect,
        unverifiableResult(
          pending.expected,
          event.isError ? "failed" : "unknown",
          "RESULT_MISSING",
        ),
      );
      rememberResult(resultUpdate.lines);
      setActionCard(ctx, resultUpdate);
      pendingVerifications.delete(event.toolCallId);
    }
    if (pendingReads.delete(event.toolCallId))
      setReadStatus(ctx, "无法确认这次文件查看是否完成。");
    activeExecutions.delete(event.toolCallId);
  });
  pi.on("agent_end", (_event, ctx) => clearRun(ctx));
  pi.on("session_shutdown", () => {
    clearRun();
    latestRecovery = undefined;
    sessionId = undefined;
  });
}
