export type TriState = "yes" | "no" | "unknown";
export type RiskLevel = "info" | "high" | "critical";
export type RiskDecision = "auto_allow" | "ask" | "hard_block";

export interface ActionFingerprint {
  algorithm: "sha256";
  canonicalizationVersion: 1;
  value: string;
}

export interface ExecutionBinding {
  fingerprint: ActionFingerprint;
  toolName: string;
  cwd: string;
  sessionId: string;
  toolCallId: string;
}

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

// 只有 A-003 的脱敏边界可以生成这种可持久化的载荷类型。
export type RedactedPersistableInput = JsonValue & {
  readonly [redacted]: true;
};
