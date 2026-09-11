// 三态值用于区分“明确是”“明确否”和“目前无法判断”，避免把未知误当成安全。
export type TriState = "yes" | "no" | "unknown";
export type RiskLevel = "info" | "high" | "critical";
export type RiskDecision = "auto_allow" | "ask" | "hard_block";
// Alpha 风险原因码是稳定领域值；展示层只能翻译，不能增删它们来改变决策。
export type RiskReasonCode =
  | "INPUT_INVALID"
  | "INTEGRITY_FAILURE"
  | "PREFLIGHT_FAILED"
  | "SAFETY_CONTROL_MUTATION"
  | "BATCH_MUTATION_BLOCKED"
  | "BATCH_CONTEXT_UNKNOWN"
  | "BACKUP_UNAVAILABLE"
  | "UNSUPPORTED_TOOL"
  | "SENSITIVE_TARGET"
  | "OUTSIDE_WORKSPACE"
  | "PATH_UNCERTAIN"
  | "FILE_MODIFY"
  | "FILE_CREATE"
  | "KNOWN_READ_ONLY";

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
  hostExecutionId: string;
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
  reasonCodes: readonly RiskReasonCode[];
}

export type PredictedEffectKind =
  | "read"
  | "create"
  | "modify"
  | "overwrite"
  | "install"
  | "network"
  | "process"
  | "unsupported_shell"
  | "unknown_command"
  | "unknown";

// 预测只描述确定性事实能够支持的工具意图；它不表示动作已经执行，也不证明应用功能正确。
export interface PredictedEffect {
  effectId: string;
  targetId: string;
  kind: PredictedEffectKind;
  targetLabel: string;
  certainty: "known" | "unknown";
  scope: "bounded" | "limited" | "unknown";
  purpose: "unknown";
  applicationOutcome: "unverifiable";
  evidenceCodes: readonly string[];
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
  readonly actionId: string;
  readonly binding: Readonly<ExecutionBinding>;
  readonly state: "issued" | "consumed" | "invalidated";
}

export type SnapshotFailureCode =
  | "SNAPSHOT_STORAGE_UNAVAILABLE"
  | "SNAPSHOT_STORAGE_UNSAFE"
  | "SNAPSHOT_STORAGE_BUSY"
  | "SNAPSHOT_TARGET_UNSUPPORTED"
  | "SNAPSHOT_TARGET_CHANGED"
  | "SNAPSHOT_FILE_TOO_LARGE"
  | "SNAPSHOT_RESOURCE_LIMIT"
  | "SNAPSHOT_PERMISSION_DENIED"
  | "SNAPSHOT_PUBLISH_FAILED";

// 普通 preflight 只接收不透明快照身份和降级事实。真实路径、原字节、权限值与 manifest
// 始终留在敏感快照域；Alpha 即使成功保存前像也没有执行后基线或 restore 实现。
export type PreImageSnapshotEvidence = Readonly<{
  status: "not_applicable" | "saved" | "unavailable";
  snapshotId: string | null;
  targetExisted: TriState;
  permissionMetadata: "captured" | "not_applicable" | "unknown";
  failureCode: SnapshotFailureCode | null;
  canRestoreNow: false;
  recoveryGrade: "unknown";
}>;

// Alpha 阶段只保留后续验证器进行关联所需的标识符。
export type VerificationCorrelation = Readonly<
  Pick<ActionFacts, "actionId"> & Pick<PredictedEffect, "effectId" | "targetId">
>;

export type FileVerificationStatus = "matched" | "mismatch" | "unknown";
export type ToolOutcomeStatus = "succeeded" | "failed" | "unknown";

// B-001 只保留核验所需的摘要与不透明关联。正文、raw 参数和完整工具结果不会进入该对象。
export interface ExpectedFilePostcondition extends VerificationCorrelation {
  kind: "exact_bytes" | "content_changed";
  expectedSha256: string | null;
  expectedByteLength: number | null;
  beforeSha256: string | null;
  beforeIdentity: Readonly<{ device: string; inode: string }> | null;
  targetExisted: boolean;
}

export type VerificationReasonCode =
  | "POSTCONDITION_MATCHED"
  | "POSTCONDITION_MISMATCH"
  | "POSTCONDITION_INSUFFICIENT"
  | "RESULT_MISSING"
  | "RESULT_IDENTITY_MISMATCH"
  | "TARGET_IDENTITY_CHANGED"
  | "TARGET_MISSING"
  | "TARGET_UNSUPPORTED"
  | "TARGET_TOO_LARGE"
  | "TARGET_GREW_OVER_LIMIT"
  | "TARGET_CHANGED_DURING_READ"
  | "TARGET_READ_FAILED";

export interface VerificationReport extends VerificationCorrelation {
  status: FileVerificationStatus;
  toolOutcome: ToolOutcomeStatus;
  reasonCodes: readonly VerificationReasonCode[];
  checkScope: "single_file";
  applicationOutcome: "unverifiable";
}

export interface OutcomeCardUpdate {
  actionId: string;
  state: "executing" | "matched" | "mismatch" | "unknown";
  lines: readonly string[];
}

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
  preImage: PreImageSnapshotEvidence;
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
