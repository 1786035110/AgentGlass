import type {
  ActionFacts,
  RiskAssessment,
  RiskDecision,
  RiskLevel,
  RiskReasonCode,
  TriState,
} from "./domain.js";

interface RiskRule {
  reasonCode: RiskReasonCode;
  level: RiskLevel;
  decision: RiskDecision;
  matches: (action: ActionFacts) => boolean;
}

const triStates = new Set(["yes", "no", "unknown"]);
const kinds = new Set(["read", "write", "edit", "unsupported", "unknown"]);
const scopes = new Set(["inside", "outside", "unknown"]);
const targetStates = new Set([
  "existing_file",
  "new_file",
  "missing",
  "directory",
  "special",
  "unknown",
]);
const effects = new Set(["read", "create", "overwrite", "edit", "unknown"]);
const blockingEvidence = new Set([
  "INPUT_INVALID",
  "INTEGRITY_FAILURE",
  "PREFLIGHT_FAILED",
  "SAFETY_CONTROL_MUTATION",
  "TOOL_IDENTITY_UNVERIFIED",
  "TOOL_IDENTITY_UNKNOWN",
  "TOOL_IDENTITY_OVERRIDDEN",
  "TOOL_IDENTITY_EXTERNAL",
]);
const decisionPriority: Record<RiskDecision, number> = {
  auto_allow: 0,
  ask: 1,
  hard_block: 2,
};
const levelPriority: Record<RiskLevel, number> = {
  info: 0,
  high: 1,
  critical: 2,
};

function stringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isActionFacts(value: unknown): value is ActionFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const action = value as Partial<ActionFacts>;
  if (
    typeof action.actionId !== "string" ||
    action.actionId.length === 0 ||
    !kinds.has(action.kind ?? "") ||
    typeof action.targetLabel !== "string" ||
    !triStates.has(action.mutatesState ?? "") ||
    !triStates.has(action.outsideWorkspace ?? "") ||
    !triStates.has(action.sensitive ?? "") ||
    !stringArray(action.evidenceCodes) ||
    !Array.isArray(action.targets) ||
    action.targets.length !== 1
  ) {
    return false;
  }

  const target = action.targets[0];
  const impact = action.impactFacts;
  const fingerprint = action.fingerprint;
  return Boolean(
    target &&
      typeof target === "object" &&
      typeof target.targetId === "string" &&
      target.targetId.length > 0 &&
      typeof target.label === "string" &&
      scopes.has(target.workspaceScope) &&
      targetStates.has(target.state) &&
      triStates.has(target.linked) &&
      triStates.has(target.supportedPath) &&
      stringArray(target.evidenceCodes) &&
      impact &&
      typeof impact === "object" &&
      effects.has(impact.effect) &&
      triStates.has(impact.createsParentDirectories) &&
      fingerprint &&
      typeof fingerprint === "object" &&
      fingerprint.algorithm === "sha256" &&
      fingerprint.canonicalizationVersion === 1 &&
      typeof fingerprint.value === "string" &&
      fingerprint.value.length > 0,
  );
}

function hasEvidence(action: ActionFacts, code: string): boolean {
  return action.evidenceCodes.includes(code);
}

function hasVerifiedToolEvidence(action: ActionFacts): boolean {
  return (
    hasEvidence(action, "TOOL_IDENTITY_VERIFIED") &&
    hasEvidence(action, "TOOL_SCHEMA_VERIFIED")
  );
}

function classificationContradictsItself(action: ActionFacts): boolean {
  const effect = action.impactFacts.effect;
  const target = action.targets[0];
  const kindContradicts =
    (action.kind === "read" &&
      (action.mutatesState === "yes" ||
        (effect !== "read" && effect !== "unknown"))) ||
    (action.kind === "write" &&
      (action.mutatesState === "no" ||
        !["create", "overwrite", "unknown"].includes(effect))) ||
    (action.kind === "edit" &&
      (action.mutatesState === "no" ||
        (effect !== "edit" && effect !== "unknown")));
  const scopeContradicts =
    (action.outsideWorkspace === "yes" &&
      target?.workspaceScope === "inside") ||
    (action.outsideWorkspace === "no" && target?.workspaceScope === "outside");

  // 明确互斥的分类事实说明必需检查链已经失效；unknown 仍由 PATH_UNCERTAIN 保留为高风险阻止。
  return kindContradicts || scopeContradicts;
}

function pathIsUncertain(action: ActionFacts): boolean {
  return (
    action.mutatesState === "unknown" ||
    action.outsideWorkspace === "unknown" ||
    action.sensitive === "unknown" ||
    action.impactFacts.effect === "unknown" ||
    action.impactFacts.createsParentDirectories === "unknown" ||
    action.targets.some(
      (target) =>
        target.workspaceScope !== "inside" ||
        target.linked !== "no" ||
        target.supportedPath !== "yes",
    )
  );
}

function knownReadOnly(action: ActionFacts): boolean {
  const target = action.targets[0];
  return Boolean(
    action.kind === "read" &&
      action.mutatesState === "no" &&
      action.outsideWorkspace === "no" &&
      action.sensitive === "no" &&
      action.impactFacts.effect === "read" &&
      action.impactFacts.createsParentDirectories === "no" &&
      target?.workspaceScope === "inside" &&
      target.state === "existing_file" &&
      target.linked === "no" &&
      target.supportedPath === "yes" &&
      hasVerifiedToolEvidence(action) &&
      action.evidenceCodes.every((code) => !blockingEvidence.has(code)),
  );
}

// 顺序就是稳定 reasonCodes 的顺序；所有规则都会求值，不能因先命中低风险规则而短路。
// A-008 的 sibling 策略不在此表中，本任务只把单个 classifier action 转成最终风险。
const rules: readonly RiskRule[] = Object.freeze([
  {
    reasonCode: "INPUT_INVALID",
    level: "critical",
    decision: "hard_block",
    matches: (action) => hasEvidence(action, "INPUT_INVALID"),
  },
  {
    reasonCode: "INTEGRITY_FAILURE",
    level: "critical",
    decision: "hard_block",
    matches: (action) => hasEvidence(action, "INTEGRITY_FAILURE"),
  },
  {
    reasonCode: "PREFLIGHT_FAILED",
    level: "critical",
    decision: "hard_block",
    matches: (action) =>
      hasEvidence(action, "PREFLIGHT_FAILED") ||
      classificationContradictsItself(action),
  },
  {
    reasonCode: "SAFETY_CONTROL_MUTATION",
    level: "critical",
    decision: "hard_block",
    matches: (action) => hasEvidence(action, "SAFETY_CONTROL_MUTATION"),
  },
  {
    reasonCode: "UNSUPPORTED_TOOL",
    level: "high",
    decision: "hard_block",
    matches: (action) =>
      action.kind === "unsupported" ||
      action.kind === "unknown" ||
      !hasVerifiedToolEvidence(action) ||
      [
        "TOOL_IDENTITY_UNVERIFIED",
        "TOOL_IDENTITY_UNKNOWN",
        "TOOL_IDENTITY_OVERRIDDEN",
        "TOOL_IDENTITY_EXTERNAL",
      ].some((code) => hasEvidence(action, code)),
  },
  {
    reasonCode: "SENSITIVE_TARGET",
    level: "high",
    decision: "hard_block",
    matches: (action) => action.sensitive === "yes",
  },
  {
    reasonCode: "OUTSIDE_WORKSPACE",
    level: "high",
    decision: "hard_block",
    matches: (action) =>
      action.outsideWorkspace === "yes" ||
      action.targets.some((target) => target.workspaceScope === "outside"),
  },
  {
    reasonCode: "PATH_UNCERTAIN",
    level: "high",
    decision: "hard_block",
    matches: pathIsUncertain,
  },
  {
    reasonCode: "FILE_MODIFY",
    level: "high",
    decision: "ask",
    matches: (action) =>
      action.mutatesState === "yes" && action.impactFacts.effect !== "create",
  },
  {
    reasonCode: "FILE_CREATE",
    level: "info",
    decision: "ask",
    matches: (action) =>
      action.mutatesState === "yes" && action.impactFacts.effect === "create",
  },
  {
    reasonCode: "KNOWN_READ_ONLY",
    level: "info",
    decision: "auto_allow",
    matches: knownReadOnly,
  },
]);

function failClosed(reasonCode: "INPUT_INVALID" | "PREFLIGHT_FAILED") {
  return Object.freeze({
    level: "critical" as const,
    decision: "hard_block" as const,
    reasonCodes: Object.freeze([reasonCode]),
  });
}

function addBatchBlock(
  risk: RiskAssessment,
  reasonCode: "BATCH_MUTATION_BLOCKED" | "BATCH_CONTEXT_UNKNOWN",
): RiskAssessment {
  // sibling 缺失同时属于必需 preflight 失败；两个原因都保留，不能用 high batch 文案掩盖 critical 事实。
  const reasonCodes = [...risk.reasonCodes];
  if (
    reasonCode === "BATCH_CONTEXT_UNKNOWN" &&
    !reasonCodes.includes("PREFLIGHT_FAILED")
  ) {
    const afterIntegrity = reasonCodes.findIndex(
      (code) => code !== "INPUT_INVALID" && code !== "INTEGRITY_FAILURE",
    );
    reasonCodes.splice(
      afterIntegrity < 0 ? reasonCodes.length : afterIntegrity,
      0,
      "PREFLIGHT_FAILED",
    );
  }
  const before = reasonCodes.findIndex((code) =>
    [
      "UNSUPPORTED_TOOL",
      "SENSITIVE_TARGET",
      "OUTSIDE_WORKSPACE",
      "PATH_UNCERTAIN",
      "FILE_MODIFY",
      "FILE_CREATE",
      "KNOWN_READ_ONLY",
    ].includes(code),
  );
  reasonCodes.splice(before < 0 ? reasonCodes.length : before, 0, reasonCode);
  return Object.freeze({
    level:
      reasonCode === "BATCH_CONTEXT_UNKNOWN"
        ? "critical"
        : levelPriority[risk.level] < levelPriority.high
          ? "high"
          : risk.level,
    decision: "hard_block",
    reasonCodes: Object.freeze(reasonCodes),
  });
}

function mutationFact(action: ActionFacts): TriState {
  const risk = assessRisk(action);
  // 无效或自相矛盾的分类事实无法证明只读，按 unknown 计入 sibling mutation 数量。
  if (
    risk.reasonCodes.includes("INPUT_INVALID") ||
    risk.reasonCodes.includes("PREFLIGHT_FAILED")
  ) {
    return "unknown";
  }
  return action.mutatesState;
}

export function assessRisk(action: ActionFacts): RiskAssessment {
  try {
    if (!isActionFacts(action)) return failClosed("INPUT_INVALID");

    const matched = rules.filter((rule) => rule.matches(action));
    // 完整、受支持且一致的事实必定命中至少一条终局规则；漏配规则本身属于关键失败。
    if (matched.length === 0) return failClosed("PREFLIGHT_FAILED");

    return Object.freeze({
      level: matched.reduce<RiskLevel>(
        (highest, rule) =>
          levelPriority[rule.level] > levelPriority[highest]
            ? rule.level
            : highest,
        "info",
      ),
      decision: matched.reduce<RiskDecision>(
        (strictest, rule) =>
          decisionPriority[rule.decision] > decisionPriority[strictest]
            ? rule.decision
            : strictest,
        "auto_allow",
      ),
      reasonCodes: Object.freeze(matched.map((rule) => rule.reasonCode)),
    });
  } catch {
    // Proxy/getter 或规则执行异常都不能把未完成的判断降成 ask/auto_allow，也不泄漏异常文本。
    return failClosed("PREFLIGHT_FAILED");
  }
}

export function assessSiblingMutationRisk(
  current: ActionFacts,
  siblings: readonly ActionFacts[] | undefined,
): RiskAssessment {
  // 每个 sibling 已在同一瞬时 preflight 中独立分类；这里只按 no / yes-or-unknown 计数。
  // 两个及以上变更时只收紧变更成员，不按目标文件归因，也不排队或重排原调用。
  const currentRisk = assessRisk(current);
  try {
    const currentMutation = mutationFact(current);
    if (
      !Array.isArray(siblings) ||
      siblings.length === 0 ||
      new Set(siblings.map((action) => action.actionId)).size !==
        siblings.length ||
      siblings.some((action) => {
        const reasons = assessRisk(action).reasonCodes;
        return (
          reasons.includes("INPUT_INVALID") ||
          reasons.includes("PREFLIGHT_FAILED")
        );
      })
    ) {
      return currentMutation === "no"
        ? currentRisk
        : addBatchBlock(currentRisk, "BATCH_CONTEXT_UNKNOWN");
    }

    const matches = siblings.filter(
      (action) => action.actionId === current.actionId,
    );
    if (
      matches.length !== 1 ||
      matches[0]?.fingerprint.value !== current.fingerprint.value
    ) {
      return currentMutation === "no"
        ? currentRisk
        : addBatchBlock(currentRisk, "BATCH_CONTEXT_UNKNOWN");
    }

    const mutationCount = siblings.filter(
      (action) => mutationFact(action) !== "no",
    ).length;
    return currentMutation !== "no" && mutationCount >= 2
      ? addBatchBlock(currentRisk, "BATCH_MUTATION_BLOCKED")
      : currentRisk;
  } catch {
    // sibling getter/Proxy 或聚合异常不能把当前变更降为普通 ask。
    return addBatchBlock(currentRisk, "BATCH_CONTEXT_UNKNOWN");
  }
}
