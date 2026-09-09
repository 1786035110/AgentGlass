import { createHash } from "node:crypto";
import type {
  NormalizedAction,
  PredictedEffect,
  PredictedEffectKind,
  RiskAssessment,
} from "./domain.js";
import type { ShellClassification } from "./shell-classification.js";

type PredictionShape = Pick<
  PredictedEffect,
  "kind" | "certainty" | "scope" | "descriptionKey"
>;

const uncertainRiskCodes = new Set([
  "INPUT_INVALID",
  "INTEGRITY_FAILURE",
  "PREFLIGHT_FAILED",
  "UNSUPPORTED_TOOL",
  "OUTSIDE_WORKSPACE",
  "PATH_UNCERTAIN",
]);

function knownFileKind(
  action: NormalizedAction,
): PredictedEffectKind | undefined {
  const targetState = action.targets[0]?.state;
  if (
    action.kind === "read" &&
    action.mutatesState === "no" &&
    action.impactFacts.effect === "read" &&
    targetState === "existing_file"
  )
    return "read";
  if (action.kind === "write" && action.mutatesState === "yes") {
    if (action.impactFacts.effect === "create" && targetState === "new_file")
      return "create";
    if (
      action.impactFacts.effect === "overwrite" &&
      targetState === "existing_file"
    )
      return "overwrite";
  }
  if (
    action.kind === "edit" &&
    action.mutatesState === "yes" &&
    action.impactFacts.effect === "edit" &&
    targetState === "existing_file"
  )
    return "modify";
  return undefined;
}

function filePrediction(
  action: NormalizedAction,
  risk: RiskAssessment,
): PredictionShape | undefined {
  const target = action.targets[0];
  const kind = knownFileKind(action);
  const factsAreBounded =
    kind !== undefined &&
    target?.workspaceScope === "inside" &&
    target.linked === "no" &&
    target.supportedPath === "yes" &&
    action.impactFacts.createsParentDirectories !== "unknown" &&
    !risk.reasonCodes.some((code) => uncertainRiskCodes.has(code));
  if (!factsAreBounded) return undefined;

  // write 可以确定将创建目标文件，但缺失父目录意味着这个单目标模型没有穷尽目录副作用。
  const scope =
    action.impactFacts.createsParentDirectories === "yes"
      ? "limited"
      : "bounded";
  return {
    kind,
    certainty: "known",
    scope,
    descriptionKey: `effect.file.${kind}`,
  };
}

function shellPrediction(
  risk: RiskAssessment,
  shell: ShellClassification | undefined,
): PredictionShape | undefined {
  // ShellClassification 的 ask/candidate_fast_path 不是产品授权。只有产品风险层已经 hard-block
  // 该不支持工具时，才能把 classifier 的窄类别作为说明事实，绝不能借预测重新放宽执行范围。
  if (
    !shell ||
    risk.decision !== "hard_block" ||
    !risk.reasonCodes.includes("UNSUPPORTED_TOOL")
  ) {
    return undefined;
  }
  const supportedBroadFamily =
    (shell.family === "install" &&
      shell.reasonCodes.includes("INSTALL_COMMAND")) ||
    (shell.family === "network" &&
      shell.reasonCodes.includes("NETWORK_COMMAND")) ||
    (shell.family === "process" &&
      shell.reasonCodes.includes("PROCESS_STATE_CHANGE"));
  if (supportedBroadFamily) {
    return {
      kind: shell.family as "install" | "network" | "process",
      certainty: "known",
      scope: "limited",
      descriptionKey: `effect.shell.${shell.family}`,
    };
  }
  if (shell.reasonCodes.includes("UNSUPPORTED_COMMAND")) {
    return {
      kind: "unknown_command",
      certainty: "unknown",
      scope: "unknown",
      descriptionKey: "effect.shell.unknown_command",
    };
  }
  if (
    shell.family === "unsupported" ||
    shell.reasonCodes.some((code) =>
      [
        "POWERSHELL_UNSUPPORTED",
        "SHELL_UNSUPPORTED",
        "UNSUPPORTED_SHELL_SYNTAX",
      ].includes(code),
    )
  ) {
    return {
      kind: "unsupported_shell",
      certainty: "unknown",
      scope: "unknown",
      descriptionKey: "effect.shell.unsupported",
    };
  }
  return undefined;
}

function effectId(
  action: NormalizedAction,
  targetId: string,
  prediction: PredictionShape,
  evidenceCodes: readonly string[],
): string {
  // effectId 绑定脱敏前动作指纹、稳定 targetId 和实际支撑预测的语义事实；同一输入稳定，
  // 任一会改变用户所批准结果的事实变化都会得到新 ID，且展示标签从不充当身份键。
  return createHash("sha256")
    .update(
      JSON.stringify([
        "agentglass-predicted-effect-v1",
        action.fingerprint.value,
        targetId,
        prediction.kind,
        prediction.certainty,
        prediction.scope,
        evidenceCodes,
      ]),
      "utf8",
    )
    .digest("hex");
}

export function predictEffects(
  action: NormalizedAction,
  risk: RiskAssessment,
  shell?: ShellClassification,
): readonly PredictedEffect[] {
  const target = action.targets[0];
  const prediction = filePrediction(action, risk) ??
    shellPrediction(risk, shell) ?? {
      kind: "unknown" as const,
      certainty: "unknown" as const,
      scope: "unknown" as const,
      descriptionKey: "effect.unknown",
    };
  const evidenceCodes = Object.freeze([
    ...new Set([
      ...action.evidenceCodes,
      ...(target?.evidenceCodes ?? []),
      ...(shell?.evidenceCodes ?? []),
      ...(shell?.reasonCodes ?? []),
      `EFFECT_${prediction.kind.toUpperCase()}`,
      `EFFECT_CERTAINTY_${prediction.certainty.toUpperCase()}`,
      `EFFECT_SCOPE_${prediction.scope.toUpperCase()}`,
      "TARGET_PURPOSE_UNKNOWN",
      "APPLICATION_OUTCOME_UNVERIFIABLE",
    ]),
  ]);
  // 缺失目标本身会由风险层 hard-block；预测仍需为该未知目标保留动作级稳定身份，
  // 不能让所有故障动作共享一个 targetId，造成后续关联碰撞。
  const targetId =
    target?.targetId ??
    createHash("sha256")
      .update(
        JSON.stringify([
          "agentglass-unknown-target-v1",
          action.fingerprint.value,
        ]),
        "utf8",
      )
      .digest("hex");

  // A-009 只建立执行前预测关联。没有 tool_result、文件回读或应用级验证时，
  // applicationOutcome 必须固定为 unverifiable，不能从文件名或写入内容猜测功能成功。
  return Object.freeze([
    Object.freeze({
      effectId: effectId(action, targetId, prediction, evidenceCodes),
      targetId,
      kind: prediction.kind,
      targetLabel: target?.label ?? action.targetLabel,
      certainty: prediction.certainty,
      scope: prediction.scope,
      purpose: "unknown",
      applicationOutcome: "unverifiable",
      evidenceCodes,
      descriptionKey: prediction.descriptionKey,
    }),
  ]);
}
