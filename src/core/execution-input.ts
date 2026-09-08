import type {
  HostExecutionFacts,
  ObservableUserGoal,
  TransientHostExecutionInput,
} from "./domain.js";
import { projectTransientActionInput } from "./input-boundary.js";

export function projectObservableUserGoal(prompt: string): ObservableUserGoal {
  // 目标原文不参与后续安全判断，因此在 Pi 生命周期事件到达时立即脱敏，不能跨事件保存原文。
  return Object.freeze({
    status: "observed",
    redactedText: projectTransientActionInput("observable-user-goal", prompt)
      .redactedInput,
  });
}

export function projectHostExecutionInput(
  transient: TransientHostExecutionInput,
): HostExecutionFacts {
  // 工具 raw input 在这里完成 fingerprint-first 投影；返回对象不保留它的引用。
  const input = projectTransientActionInput(
    transient.tool.name,
    transient.rawInput,
  );
  const evidenceCodes = [
    ...(transient.tool.status === "unknown" ? ["TOOL_IDENTITY_UNKNOWN"] : []),
    ...(transient.tool.status === "overridden"
      ? ["TOOL_IDENTITY_OVERRIDDEN"]
      : []),
    ...(transient.tool.status === "external" ? ["TOOL_IDENTITY_EXTERNAL"] : []),
    ...(transient.capabilities.canPromptForApproval === "unknown"
      ? ["CAPABILITY_UNKNOWN"]
      : []),
    ...(transient.userGoal.status === "unknown" ? ["USER_GOAL_UNKNOWN"] : []),
  ];

  return Object.freeze({
    hostExecutionId: transient.hostExecutionId,
    toolCallId: transient.toolCallId,
    sessionId: transient.sessionId,
    cwd: transient.cwd,
    tool: transient.tool,
    capabilities: transient.capabilities,
    siblings: transient.siblings,
    userGoal: transient.userGoal,
    input,
    evidenceCodes: Object.freeze(evidenceCodes),
  });
}
