import { createHash } from "node:crypto";
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
import { fingerprintTransientActionInput } from "../../core/input-boundary.js";
import {
  renderOutcomeCard,
  renderOutcomeCardUpdate,
  renderReadNotice,
} from "../../core/outcome-card.js";
import {
  capturePreImageSnapshot,
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

// 仅区分“批次无法证明”和其他宿主身份失败，以选择真实且脱敏的固定原因；异常文本从不返回 Pi。
class SiblingContextError extends Error {}

interface PendingVerification {
  binding: Readonly<ExecutionBinding>;
  action: HostExecutionFacts["action"];
  effect: PredictedEffect;
  targetPath: string;
  expected: ExpectedFilePostcondition;
  inFlight: boolean;
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

  pi.on("session_start", (_event, ctx) => {
    clearRun();
    try {
      const current = ctx.sessionManager.getSessionId();
      sessionId = nonEmptyString(current) ? current : undefined;
    } catch {
      sessionId = undefined;
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
    setActionCard(
      ctx,
      renderOutcomeCardUpdate(pending.action, pending.effect, report),
    );
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
      setActionCard(
        ctx,
        renderOutcomeCardUpdate(
          pending.action,
          pending.effect,
          unverifiableResult(
            pending.expected,
            event.isError ? "failed" : "unknown",
            "RESULT_MISSING",
          ),
        ),
      );
      pendingVerifications.delete(event.toolCallId);
    }
    if (pendingReads.delete(event.toolCallId))
      setReadStatus(ctx, "无法确认这次文件查看是否完成。");
    activeExecutions.delete(event.toolCallId);
  });
  pi.on("agent_end", (_event, ctx) => clearRun(ctx));
  pi.on("session_shutdown", () => {
    clearRun();
    sessionId = undefined;
  });
}
