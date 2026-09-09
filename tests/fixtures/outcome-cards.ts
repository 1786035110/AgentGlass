import type {
  ActionFacts,
  HostCapabilities,
  PredictedEffect,
  PreImageSnapshotEvidence,
  RiskAssessment,
  RiskReasonCode,
} from "../../src/core/domain.js";
import { noPreImageSnapshot } from "../../src/core/pre-image-snapshot.js";
import { predictEffects } from "../../src/core/predicted-effects.js";
import { assessRisk } from "../../src/core/risk-engine.js";
import { actionFacts } from "./action-facts.js";

export interface OutcomeCardFixture {
  name: string;
  action: ActionFacts;
  risk: RiskAssessment;
  effect: PredictedEffect;
  snapshot: PreImageSnapshotEvidence;
  capabilities?: HostCapabilities;
}

const interactive: HostCapabilities = Object.freeze({
  interaction: "local_interactive",
  canPromptForApproval: "yes",
});
const noUi: HostCapabilities = Object.freeze({
  interaction: "one_shot",
  canPromptForApproval: "no",
});
const savedExisting: PreImageSnapshotEvidence = Object.freeze({
  status: "saved",
  snapshotId: "snapshot-private-id",
  targetExisted: "yes",
  permissionMetadata: "captured",
  failureCode: null,
  canRestoreNow: false,
  recoveryGrade: "unknown",
});
const savedNew: PreImageSnapshotEvidence = Object.freeze({
  ...savedExisting,
  targetExisted: "no",
  permissionMetadata: "not_applicable",
});
const unavailable: PreImageSnapshotEvidence = Object.freeze({
  status: "unavailable",
  snapshotId: null,
  targetExisted: "yes",
  permissionMetadata: "unknown",
  failureCode: "SNAPSHOT_PUBLISH_FAILED",
  canRestoreNow: false,
  recoveryGrade: "unknown",
});

function fixture(
  name: string,
  action: ActionFacts,
  snapshot: PreImageSnapshotEvidence = noPreImageSnapshot(),
  capabilities?: HostCapabilities,
  risk = assessRisk(action),
): OutcomeCardFixture {
  const effect = predictEffects(action, risk)[0];
  if (!effect) throw new Error("fixture effect missing");
  return capabilities
    ? { name, action, risk, effect, snapshot, capabilities }
    : { name, action, risk, effect, snapshot };
}

const create = actionFacts(
  {
    actionId: "action-create",
    kind: "write",
    targetLabel: "活动说明.txt",
    mutatesState: "yes",
    impactFacts: { effect: "create", createsParentDirectories: "no" },
  },
  {
    targetId: "target-create",
    label: "活动说明.txt",
    state: "new_file",
  },
);
const modify = actionFacts(
  {
    actionId: "action-modify",
    kind: "edit",
    targetLabel: "活动说明.txt",
    mutatesState: "yes",
    impactFacts: { effect: "edit", createsParentDirectories: "no" },
  },
  { targetId: "target-modify", label: "活动说明.txt" },
);
const overwrite = actionFacts(
  {
    actionId: "action-overwrite",
    kind: "write",
    targetLabel: "活动说明.txt",
    mutatesState: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  },
  { targetId: "target-overwrite", label: "活动说明.txt" },
);
const unknown = actionFacts(
  {
    actionId: "technical-action-id-must-not-render",
    kind: "unknown",
    targetLabel: "未知目标",
    mutatesState: "unknown",
    outsideWorkspace: "unknown",
    sensitive: "unknown",
    impactFacts: { effect: "unknown", createsParentDirectories: "unknown" },
    evidenceCodes: ["TOOL_IDENTITY_UNVERIFIED"],
  },
  {
    targetId: "technical-target-id-must-not-render",
    label: "未知目标",
    workspaceScope: "unknown",
    state: "unknown",
    linked: "unknown",
    supportedPath: "no",
    evidenceCodes: ["PATH_UNCERTAIN"],
  },
);
const sensitive = actionFacts(
  {
    actionId: "action-sensitive",
    kind: "write",
    targetLabel: ".env",
    mutatesState: "yes",
    sensitive: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
    evidenceCodes: [
      "TOOL_IDENTITY_VERIFIED",
      "TOOL_SCHEMA_VERIFIED",
      "SENSITIVE_TARGET",
    ],
  },
  { targetId: "target-sensitive", label: ".env", supportedPath: "no" },
);
const outside = actionFacts(
  {
    actionId: "action-outside",
    kind: "write",
    targetLabel: "outside.txt",
    mutatesState: "yes",
    outsideWorkspace: "yes",
    impactFacts: { effect: "overwrite", createsParentDirectories: "no" },
  },
  {
    targetId: "target-outside",
    label: "outside.txt",
    workspaceScope: "outside",
    supportedPath: "no",
  },
);
const batchAction = actionFacts(
  {
    actionId: "action-batch",
    kind: "edit",
    targetLabel: "批次.txt",
    mutatesState: "yes",
    impactFacts: { effect: "edit", createsParentDirectories: "no" },
  },
  { targetId: "target-batch", label: "批次.txt" },
);
const batchBase = assessRisk(batchAction);
const batchRisk: RiskAssessment = Object.freeze({
  level: "high",
  decision: "hard_block",
  reasonCodes: Object.freeze<RiskReasonCode[]>([
    "BATCH_MUTATION_BLOCKED",
    ...batchBase.reasonCodes,
  ]),
});
const batchUnknownRisk: RiskAssessment = Object.freeze({
  level: "critical",
  decision: "hard_block",
  reasonCodes: Object.freeze<RiskReasonCode[]>([
    "PREFLIGHT_FAILED",
    "BATCH_CONTEXT_UNKNOWN",
    ...batchBase.reasonCodes,
  ]),
});
const critical = actionFacts(
  {
    actionId: "action-critical",
    kind: "unknown",
    targetLabel: "critical.txt",
    mutatesState: "unknown",
    outsideWorkspace: "yes",
    sensitive: "yes",
    impactFacts: { effect: "unknown", createsParentDirectories: "unknown" },
    evidenceCodes: [
      "INPUT_INVALID",
      "INTEGRITY_FAILURE",
      "PREFLIGHT_FAILED",
      "SAFETY_CONTROL_MUTATION",
      "TOOL_IDENTITY_UNVERIFIED",
    ],
  },
  {
    targetId: "target-critical",
    label: "critical.txt",
    workspaceScope: "outside",
    state: "unknown",
    linked: "unknown",
    supportedPath: "no",
  },
);

export const outcomeCardFixtures: readonly OutcomeCardFixture[] = Object.freeze(
  [
    fixture(
      "ordinary read",
      actionFacts(
        { actionId: "action-read", targetLabel: "活动说明.txt" },
        { targetId: "target-read", label: "活动说明.txt" },
      ),
    ),
    fixture(
      "new file with saved absence evidence",
      create,
      savedNew,
      interactive,
    ),
    fixture("modify with saved pre-image", modify, savedExisting, interactive),
    fixture(
      "overwrite with unavailable snapshot",
      overwrite,
      unavailable,
      interactive,
    ),
    fixture("unsupported or unknown action", unknown),
    fixture("sensitive target", sensitive),
    fixture("outside-workspace target", outside),
    fixture(
      "multiple simultaneous mutations",
      batchAction,
      noPreImageSnapshot(),
      interactive,
      batchRisk,
    ),
    fixture(
      "incomplete sibling context",
      batchAction,
      noPreImageSnapshot(),
      interactive,
      batchUnknownRisk,
    ),
    fixture("approval UI unavailable", modify, savedExisting, noUi),
    fixture(
      "parent-directory side effect",
      actionFacts(
        {
          actionId: "action-parent",
          kind: "write",
          targetLabel: "活动说明.txt",
          mutatesState: "yes",
          impactFacts: { effect: "create", createsParentDirectories: "yes" },
        },
        {
          targetId: "target-parent",
          label: "活动说明.txt",
          state: "new_file",
        },
      ),
      savedNew,
      interactive,
    ),
    fixture("all critical explanations remain visible", critical),
    fixture(
      "terminal control sequence in label",
      actionFacts(
        {
          actionId: "action-control",
          targetLabel: "\u001b[31m报告\u001b[0m.txt",
        },
        { targetId: "target-control", label: "\u001b[31m报告\u001b[0m.txt" },
      ),
    ),
    fixture(
      "huge label",
      actionFacts(
        { actionId: "action-huge", targetLabel: `${"很长".repeat(100)}.txt` },
        { targetId: "target-huge", label: `${"很长".repeat(100)}.txt` },
      ),
    ),
    fixture(
      "synthetic secret in label",
      actionFacts(
        {
          actionId: "action-secret",
          targetLabel: "token=synthetic-secret-value.txt",
        },
        {
          targetId: "target-secret",
          label: "token=synthetic-secret-value.txt",
        },
      ),
    ),
    fixture(
      "control-obscured synthetic secret",
      actionFacts(
        {
          actionId: "action-obscured-secret",
          targetLabel: "token=\u001b[31msynthetic-secret-value.txt",
        },
        {
          targetId: "target-obscured-secret",
          label: "token=\u001b[31msynthetic-secret-value.txt",
        },
      ),
    ),
  ],
);
