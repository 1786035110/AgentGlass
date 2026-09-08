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

export type WorkspaceScope = "inside" | "outside" | "unknown";
export type FileTargetState =
  | "existing_file"
  | "new_file"
  | "missing"
  | "directory"
  | "special"
  | "unknown";

// 路径事实只保留不透明身份、脱敏标签和确定性证据；真实路径仍只存在于一次预检调用栈中。
export interface FileTargetFacts {
  targetId: string;
  label: string;
  workspaceScope: WorkspaceScope;
  state: FileTargetState;
  linked: TriState;
  supportedPath: TriState;
  evidenceCodes: readonly string[];
}

export interface FileImpactFacts {
  effect: "read" | "create" | "overwrite" | "edit" | "unknown";
  createsParentDirectories: TriState;
}

// ActionFacts 是脱离 Pi 宿主后的安全事实集合，不包含原始输入或“安全”布尔捷径。
export interface ActionFacts {
  actionId: string;
  kind: "read" | "write" | "edit" | "unsupported" | "unknown";
  targetLabel: string;
  mutatesState: TriState;
  outsideWorkspace: TriState;
  sensitive: TriState;
  targets: readonly FileTargetFacts[];
  impactFacts: FileImpactFacts;
  evidenceCodes: readonly string[];
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

// A-004 只表达宿主已经观察到的交互能力，不把具体宿主的 mode/ctx 形状带入 Core。
export type HostInteractionKind =
  | "local_interactive"
  | "remote_interactive"
  | "event_stream"
  | "one_shot"
  | "unknown";

export interface HostCapabilities {
  interaction: HostInteractionKind;
  canPromptForApproval: TriState;
}

// 工具来源是安全事实：同名覆盖不能因为名字相同就冒充已验证内置工具。
export type HostToolIdentityStatus =
  | "verified_builtin"
  | "external"
  | "overridden"
  | "unknown";

export interface HostToolIdentity {
  name: string;
  status: HostToolIdentityStatus;
}

export interface SiblingExecutionReference {
  hostExecutionId: string;
  toolCallId: string;
  tool: HostToolIdentity;
}

export type ObservableUserGoal =
  | { status: "observed"; redactedText: RedactedPersistableInput }
  | { status: "unknown" };

// 只有 rawInput 可在一次同步预检调用中短暂存在；用户目标在 Adapter 捕获时已完成脱敏。
export interface TransientHostExecutionInput {
  hostExecutionId: string;
  toolCallId: string;
  sessionId: string;
  cwd: string;
  tool: HostToolIdentity;
  capabilities: HostCapabilities;
  siblings: readonly SiblingExecutionReference[];
  userGoal: ObservableUserGoal;
  rawInput: TransientRawInput;
}

export interface ProjectedActionInput {
  readonly fingerprint: ActionFingerprint;
  readonly redactedInput: RedactedPersistableInput;
  readonly secretDetected: boolean;
}

// 可观察结果已经越过 raw 边界，可由后续 Alpha 任务消费；仍不包含风险或批准结论。
export interface HostExecutionFacts {
  hostExecutionId: string;
  toolCallId: string;
  sessionId: string;
  cwd: string;
  tool: HostToolIdentity;
  capabilities: HostCapabilities;
  siblings: readonly SiblingExecutionReference[];
  userGoal: ObservableUserGoal;
  input: ProjectedActionInput;
  action: ActionFacts;
  evidenceCodes: readonly string[];
}

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
