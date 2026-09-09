import { createHash } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  HostCapabilities,
  HostExecutionFacts,
  HostToolIdentity,
  ObservableUserGoal,
  SiblingExecutionReference,
  TransientHostExecutionInput,
} from "../../core/domain.js";
import {
  projectHostExecutionInput,
  projectObservableUserGoal,
} from "../../core/execution-input.js";
import { assessSiblingMutationRisk } from "../../core/risk-engine.js";

type AdapterObserver = (facts: HostExecutionFacts) => Promise<void> | void;

const BLOCK_REASON =
  "AgentGlass could not verify this tool call's runtime identity, so it was stopped.";
const MULTIPLE_MUTATIONS_REASON =
  "已停止：这次包含多个会改变内容或影响未知的操作。请让 Pi 一次只提出一个变更。";
const BATCH_CONTEXT_REASON =
  "已停止：无法确认这次同时提出的操作是否完整。请让 Pi 一次只提出一个变更后重试。";
const APPROVAL_UNAVAILABLE_REASON =
  "已停止：这一步需要明确确认，但当前阶段尚未提供审批界面。";
const SAFETY_BLOCK_REASON =
  "已停止：当前版本无法可靠说明或支持这一步。请改为普通项目文件的查看或单个修改。";

// 仅区分“批次无法证明”和其他宿主身份失败，以选择真实且脱敏的固定原因；异常文本从不返回 Pi。
class SiblingContextError extends Error {}

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
  activeExecutions: ReadonlyMap<string, string>,
  userGoal: ObservableUserGoal,
): readonly TransientHostExecutionInput[] {
  if (!nonEmptyString(event.toolCallId)) {
    throw new Error();
  }
  if (activeExecutions.has(event.toolCallId)) {
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

export function registerPiAdapter(
  pi: ExtensionAPI,
  observe: AdapterObserver = () => {},
): void {
  let sessionId: string | undefined;
  let userGoal: ObservableUserGoal = Object.freeze({ status: "unknown" });
  // pending 只保存不透明身份字符串；raw input、goal 原文和 Pi event/ctx 都不会进入此 Map。
  const activeExecutions = new Map<string, string>();

  const clearRun = (): void => {
    activeExecutions.clear();
    userGoal = Object.freeze({ status: "unknown" });
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
  pi.on("tool_call", (event, ctx) => {
    let batch: readonly TransientHostExecutionInput[];
    try {
      batch = mapToolCall(
        pi,
        event,
        ctx,
        sessionId,
        activeExecutions,
        userGoal,
      );
      const current = batch.find(
        (item) => item.toolCallId === event.toolCallId,
      );
      if (!current) throw new Error();
      activeExecutions.set(event.toolCallId, current.hostExecutionId);
    } catch (error) {
      return {
        block: true,
        reason:
          error instanceof SiblingContextError
            ? BATCH_CONTEXT_REASON
            : BLOCK_REASON,
      };
    }

    const toolCallId = event.toolCallId;
    // 整批路径检查并行完成；raw input 只活到本 Promise，observer 仍只接收当前动作的脱敏 facts。
    return Promise.all(batch.map(projectHostExecutionInput))
      .then(async (facts) => {
        const current = facts.find((item) => item.toolCallId === toolCallId);
        if (!current) throw new Error();
        await observe(current);
        const risk = assessSiblingMutationRisk(
          current.action,
          facts.map((item) => item.action),
        );
        if (risk.reasonCodes.includes("BATCH_MUTATION_BLOCKED")) {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: MULTIPLE_MUTATIONS_REASON };
        }
        if (risk.reasonCodes.includes("BATCH_CONTEXT_UNKNOWN")) {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: BATCH_CONTEXT_REASON };
        }
        // A-008 不提前实现审批 UI；在 A-011/A-012 闭环前，只有完整检查后的 auto_allow 可以交回 Pi 执行。
        if (risk.decision === "auto_allow") return undefined;
        activeExecutions.delete(toolCallId);
        return {
          block: true as const,
          reason:
            risk.decision === "ask"
              ? APPROVAL_UNAVAILABLE_REASON
              : SAFETY_BLOCK_REASON,
        };
      })
      .then(
        (result) => result,
        () => {
          activeExecutions.delete(toolCallId);
          return { block: true as const, reason: BLOCK_REASON };
        },
      );
  });
  pi.on("tool_execution_end", (event) => {
    activeExecutions.delete(event.toolCallId);
  });
  pi.on("agent_end", () => clearRun());
  pi.on("session_shutdown", () => {
    clearRun();
    sessionId = undefined;
  });
}
