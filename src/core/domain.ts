// 三态值用于区分“明确是”“明确否”和“目前无法判断”，避免把未知误当成安全。
export type TriState = "yes" | "no" | "unknown";
export type RiskLevel = "info" | "high" | "critical";
export type RiskDecision = "auto_allow" | "ask" | "hard_block";

// 指纹绑定经过版本化的规范化输入，审批时不能用脱敏后的展示数据替代它。
export interface ActionFingerprint {
  algorithm: "sha256";
  canonicalizationVersion: 1;
  value: string;
}

// 执行绑定把一次审批锁定到具体动作、宿主环境和工具调用，防止复用到其他调用。
export interface ExecutionBinding {
  fingerprint: ActionFingerprint;
  toolName: string;
  cwd: string;
  sessionId: string;
  toolCallId: string;
}

// ActionFacts 是脱离 Pi 宿主后的安全事实集合，不包含原始输入或“安全”布尔捷径。
export interface ActionFacts {
  actionId: string;
  kind: "read" | "write" | "edit" | "unsupported" | "unknown";
  targetLabel: string;
  mutatesState: TriState;
  outsideWorkspace: TriState;
  sensitive: TriState;
  evidenceCodes: string[];
  fingerprint: ActionFingerprint;
}

// 架构中的标准化动作是经过清理的 ActionFacts 模型，
// 而不是第二种带有宿主形状的表示。
export type NormalizedAction = ActionFacts;

// 风险决策按 hard_block > ask > auto_allow 的顺序解释，文案不能降低这个结果。
export interface RiskAssessment {
  level: RiskLevel;
  decision: RiskDecision;
  reasonCodes: string[];
}

export interface PredictedEffect {
  effectId: string;
  targetId: string;
  kind: "read" | "create" | "modify" | "unknown";
  targetLabel: string;
  descriptionKey: string;
}

export interface OutcomeCard {
  actionId: string;
  title: string;
  expectedOutcome: string;
  attention: string;
  recovery: string;
  details: string[];
}

export interface ApprovalToken {
  actionId: string;
  binding: ExecutionBinding;
  state: "issued" | "consumed" | "invalidated";
}

// Alpha 阶段只保留后续验证器进行关联所需的标识符。
export type VerificationCorrelation = Readonly<
  Pick<ActionFacts, "actionId"> & Pick<PredictedEffect, "effectId" | "targetId">
>;

export type TransientRawInput = unknown;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

declare const redacted: unique symbol;

// 只有脱敏边界可以生成这种可持久化的载荷类型。
export type RedactedPersistableInput = JsonValue & {
  readonly [redacted]: true;
};
