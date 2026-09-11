import type {
  ActionFacts,
  HostCapabilities,
  OutcomeCard,
  OutcomeCardUpdate,
  PredictedEffect,
  PreImageSnapshotEvidence,
  RiskAssessment,
  RiskReasonCode,
  VerificationReport,
} from "./domain.js";
import { redactDisplayString } from "./input-boundary.js";
import { assessRisk } from "./risk-engine.js";

const MAX_LABEL_CHARACTERS = 120;
const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const CONTROL_SEQUENCE = new RegExp(
  `(?:${ESCAPE}\\[|${String.fromCharCode(155)})[0-?]*[ -/]*[@-~]`,
  "gu",
);
const OPERATING_SYSTEM_COMMAND = new RegExp(
  `${ESCAPE}\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\)`,
  "gu",
);
const decisionPriority = { auto_allow: 0, ask: 1, hard_block: 2 } as const;
const levelPriority = { info: 0, high: 1, critical: 2 } as const;

const riskExplanations: Readonly<Record<RiskReasonCode, string>> = {
  INPUT_INVALID: "输入内容无法可靠解析，这一步已停止。",
  INTEGRITY_FAILURE: "动作完整性检查失败，这一步已停止。",
  PREFLIGHT_FAILED: "执行前的必要检查没有完成，这一步已停止。",
  SAFETY_CONTROL_MUTATION:
    "这一步可能改动 AgentGlass 的安全控制，当前版本不允许。",
  BATCH_MUTATION_BLOCKED:
    "这次包含多个会改变内容或影响未知的操作，必须改为一次只提出一个变更。",
  BATCH_CONTEXT_UNKNOWN:
    "无法确认同时提出的操作是否完整，必须改为一次只提出一个变更。",
  BACKUP_UNAVAILABLE:
    "未能取得这次修改所需的修改前证据，或这一步还会隐式创建上级文件夹；当前版本已停止这一步。请明确选择已有文件夹中的一份普通文件后重试。",
  UNSUPPORTED_TOOL:
    "当前版本不支持这类操作。你可以返回对话，选择一个普通项目文件任务。",
  SENSITIVE_TARGET:
    "目标可能包含敏感信息，当前版本已阻止这一步。你可以返回对话，选择不涉及敏感信息的普通项目文件。",
  OUTSIDE_WORKSPACE:
    "目标位于当前项目之外，当前版本已阻止这一步。请返回对话，选择当前项目内的普通文件。",
  PATH_UNCERTAIN:
    "无法可靠确认目标位置或文件类型，当前版本已阻止这一步。请返回对话，明确指定一份普通项目文件。",
  FILE_MODIFY: "原内容可能丢失；请只在你接受这个结果时继续。",
  FILE_CREATE: "这一步会新增文件；请确认这正是你想创建的文件。",
  KNOWN_READ_ONLY: "这一步只查看已确认的普通项目文件，不会修改它。",
};

function safeLabel(value: string): string {
  // 终端转义必须按完整序列先移除，再过滤残余控制字符；安全事实文案使用固定文本，绝不参与限长。
  const withoutTerminalSequences = redactDisplayString(
    value.slice(0, MAX_LABEL_CHARACTERS * 4),
  )
    .replace(OPERATING_SYSTEM_COMMAND, "")
    .replace(CONTROL_SEQUENCE, "")
    .replace(/\p{Cc}/gu, "");
  // 再脱敏一次，防止攻击者用控制序列拆开凭据形状后在过滤阶段重新拼出秘密。
  const redactedText = redactDisplayString(withoutTerminalSequences);
  const characters = [...redactedText];
  const bounded =
    characters.length > MAX_LABEL_CHARACTERS
      ? `${characters.slice(0, MAX_LABEL_CHARACTERS - 1).join("")}…`
      : redactedText;
  return bounded.trim() || "未知文件";
}

function addUnique(lines: string[], value: string): void {
  if (!lines.includes(value)) lines.push(value);
}

function plannedOutcome(effect: PredictedEffect, label: string): string {
  switch (effect.kind) {
    case "read":
      return `预计结果：会尝试查看 ${label}，不会修改它。`;
    case "create":
      return `预计结果：会尝试在当前项目中创建 ${label}。`;
    case "modify":
      return `预计结果：${label} 中选定的内容会被替换。`;
    case "overwrite":
      return `预计结果：${label} 的原内容会被新内容覆盖。`;
    case "install":
      return "原计划：会尝试安装软件，但当前版本不支持执行这类操作。";
    case "network":
      return "原计划：会尝试访问网络，但当前版本不支持执行这类操作。";
    case "process":
      return "原计划：会尝试改变程序运行状态，但当前版本不支持执行这类操作。";
    case "unsupported_shell":
    case "unknown_command":
    case "unknown":
      return "原计划：无法可靠说明这一步会改变什么。";
  }
}

function cardTitle(
  effect: PredictedEffect,
  label: string,
  blocked: boolean,
): string {
  if (blocked) return "已停止：这一步没有获得执行许可";
  switch (effect.kind) {
    case "read":
      return `正在查看：${label}`;
    case "create":
      return `下一步：创建 ${label}`;
    case "modify":
      return `下一步：修改 ${label}`;
    case "overwrite":
      return `下一步：覆盖 ${label}`;
    default:
      return "已停止：当前版本无法可靠说明这一步";
  }
}

function recoveryText(
  action: ActionFacts,
  snapshot: PreImageSnapshotEvidence,
  blocked: boolean,
): string {
  if (snapshot.status === "saved") {
    return "恢复：已保存修改前证据，但有备份不等于当前可恢复；当前不能自动恢复这次修改。";
  }
  if (snapshot.status === "unavailable") {
    return "恢复：未能保存修改前证据；当前不能自动恢复这次修改。";
  }
  if (action.mutatesState === "no") {
    return "恢复：这一步不会修改文件，因此没有生成修改前快照。";
  }
  if (blocked) {
    return "恢复：这一步已被阻止，没有生成可用于恢复的修改前快照。";
  }
  // 对变更动作而言，not_applicable 只代表没有观察到快照证据，不能翻译成“确认没有风险”或“可恢复”。
  return "恢复：没有观察到可用的修改前快照；当前不能自动恢复这次修改。";
}

function locationDetail(action: ActionFacts, label: string): string {
  const target = action.targets[0];
  if (target?.workspaceScope === "inside")
    return `位置：当前项目内的 ${label}。`;
  if (target?.workspaceScope === "outside")
    return `位置：${label} 位于当前项目之外。`;
  return `位置：无法确认 ${label} 是否位于当前项目内。`;
}

function snapshotDetail(snapshot: PreImageSnapshotEvidence): string {
  if (snapshot.status === "saved") {
    const permissions =
      snapshot.permissionMetadata === "captured"
        ? "已记录原权限。"
        : snapshot.permissionMetadata === "not_applicable"
          ? "原权限记录不适用。"
          : "无法确认原权限信息。";
    if (snapshot.targetExisted === "yes")
      return `修改前证据：已保存；执行前目标文件存在；${permissions}`;
    if (snapshot.targetExisted === "no")
      return `修改前证据：已保存；执行前目标文件不存在；${permissions}`;
    return `修改前证据：已保存；无法确认执行前目标是否存在；${permissions}`;
  }
  if (snapshot.status === "unavailable")
    return "修改前证据：保存失败；没有可用的快照证据。";
  return "修改前证据：未观察到适用的快照。";
}

export function renderOutcomeCard(
  action: ActionFacts,
  risk: RiskAssessment,
  effect: PredictedEffect,
  snapshot: PreImageSnapshotEvidence,
  capabilities?: HostCapabilities,
): OutcomeCard {
  const target = action.targets[0];
  // 展示层重新验证确定性基线，只用于防止错误调用者用较弱 RiskAssessment 生成误导文案；
  // Risk Engine 仍只读取 ActionFacts，任何标题或提示文字都不会回流安全决策。
  const baselineRisk = assessRisk(action);
  const riskWeakened =
    decisionPriority[risk.decision] < decisionPriority[baselineRisk.decision] ||
    levelPriority[risk.level] < levelPriority[baselineRisk.level] ||
    baselineRisk.reasonCodes.some((code) => !risk.reasonCodes.includes(code));
  const consistentTarget = Boolean(
    target &&
      target.targetId === effect.targetId &&
      target.label === effect.targetLabel,
  );
  const invalidRisk =
    riskWeakened ||
    (risk.level === "critical" && risk.decision !== "hard_block") ||
    (risk.decision === "auto_allow" && risk.level !== "info");
  const unexplainedRisk =
    risk.reasonCodes.length === 0 &&
    (risk.level !== "info" || risk.decision !== "auto_allow");
  const missingApprovalUI =
    risk.decision === "ask" && capabilities?.canPromptForApproval !== "yes";
  const blocked =
    risk.decision === "hard_block" ||
    missingApprovalUI ||
    !consistentTarget ||
    invalidRisk ||
    unexplainedRisk;
  const label = safeLabel(consistentTarget ? effect.targetLabel : "未知文件");
  const attention: string[] = [];

  // High/Critical 说明和所有命中的安全原因都放在主卡片，不进入详情，也不受标签限长影响。
  for (const code of new Set([
    ...baselineRisk.reasonCodes,
    ...risk.reasonCodes,
  ]))
    addUnique(
      attention,
      riskExplanations[code] ?? "无法解释一个安全检查结果，这一步已停止。",
    );
  if (!consistentTarget || invalidRisk)
    addUnique(
      attention,
      "结构化事实彼此不一致，无法安全生成批准说明，这一步已停止。",
    );
  if (unexplainedRisk)
    addUnique(
      attention,
      "安全检查结果缺少可解释原因，无法安全生成批准说明，这一步已停止。",
    );
  if (missingApprovalUI)
    addUnique(
      attention,
      "这一步需要你的明确确认，但当前模式无法显示审批界面。请回到有交互按钮的 Pi 窗口再试。",
    );
  if (effect.certainty === "unknown")
    addUnique(attention, "无法确认这一步具体会产生什么变化。");
  if (effect.scope === "limited")
    addUnique(attention, "只能确认部分影响范围，仍可能有未列出的变化。");
  if (effect.scope === "unknown")
    addUnique(attention, "无法确认这一步会影响哪些位置或内容。");
  if (action.sensitive === "unknown")
    addUnique(attention, "无法确认目标是否涉及敏感信息。");
  if (action.impactFacts.createsParentDirectories === "yes")
    addUnique(attention, "还会创建缺少的上级文件夹。");
  if (action.impactFacts.createsParentDirectories === "unknown")
    addUnique(attention, "无法确认是否还会创建上级文件夹。");
  if (effect.applicationOutcome === "unverifiable")
    addUnique(
      attention,
      "AgentGlass 只能说明计划中的文件动作，无法确认它是否能完成你的实际目标。",
    );

  const details = [
    locationDetail(action, label),
    "用途：无法确认这份目标在项目中的具体用途。",
    snapshotDetail(snapshot),
  ];
  Object.freeze(details);
  return Object.freeze({
    actionId: action.actionId,
    title: cardTitle(effect, label, blocked),
    expectedOutcome: plannedOutcome(effect, label),
    attention: `需要注意：${attention.join(" ")}`,
    recovery: recoveryText(action, snapshot, blocked),
    details,
  });
}

export function renderReadNotice(
  action: ActionFacts,
  risk: RiskAssessment,
  effect: PredictedEffect,
): string {
  // 普通读取提示可以由 Adapter 合并展示，但每次动作仍须独立完成风险检查后才能调用这里。
  const target = action.targets[0];
  const baselineRisk = assessRisk(action);
  if (
    baselineRisk.decision !== "auto_allow" ||
    !baselineRisk.reasonCodes.includes("KNOWN_READ_ONLY") ||
    risk.decision !== "auto_allow" ||
    !risk.reasonCodes.includes("KNOWN_READ_ONLY") ||
    action.kind !== "read" ||
    action.mutatesState !== "no" ||
    effect.kind !== "read" ||
    effect.certainty !== "known" ||
    effect.scope !== "bounded" ||
    !target ||
    target.targetId !== effect.targetId ||
    target.label !== effect.targetLabel
  ) {
    return "无法显示只读提示：无法确认这一步不会修改文件。";
  }
  const label = safeLabel(effect.targetLabel);
  return `正在查看：${label}，不会修改它。`;
}

export function renderOutcomeCardUpdate(
  action: ActionFacts,
  effect: PredictedEffect,
  report?: VerificationReport,
): OutcomeCardUpdate {
  const target = action.targets[0];
  const consistent = Boolean(
    target &&
      target.targetId === effect.targetId &&
      (!report ||
        (report.actionId === action.actionId &&
          report.effectId === effect.effectId &&
          report.targetId === target.targetId)),
  );
  const label = safeLabel(consistent ? effect.targetLabel : "未知文件");
  if (!report) {
    return Object.freeze({
      actionId: action.actionId,
      state: "executing",
      lines: Object.freeze([
        `执行中：正在处理 ${label}。`,
        "已确认：这次只会核对卡片中列出的这一份文件。",
        "还不能确认：实际文件结果、实际目标是否达成及程序功能。",
        "检查范围：仅这份明确文件，不扫描项目。",
        "恢复：当前不能自动恢复这次修改。",
      ]),
    });
  }

  const state = consistent ? report.status : "unknown";
  const heading =
    state === "matched"
      ? `已确认：${label} 与这次卡片列明的文件结果一致。`
      : state === "mismatch"
        ? `不符：${label} 与这次卡片列明的文件结果不一致。`
        : `无法确认：${label} 的实际文件结果。`;
  const toolFact =
    report.toolOutcome === "failed"
      ? "工具报告失败；文件结论仍来自独立读取，不来自工具返回文本。"
      : report.toolOutcome === "succeeded"
        ? "工具报告完成；文件结论仍来自独立读取，不来自工具返回文本。"
        : "无法确认工具是否完成；不能据此写成“没有执行”。";
  const reason = new Set(report.reasonCodes);
  const fileFact =
    state === "matched"
      ? "独立读取的内容与全部列明后置条件匹配。"
      : state === "mismatch"
        ? reason.has("TARGET_MISSING")
          ? "列明的目标文件没有出现。"
          : "独立读取发现了与列明后置条件的明确矛盾。"
        : reason.has("TARGET_TOO_LARGE") || reason.has("TARGET_GREW_OVER_LIMIT")
          ? "文件超过本次 10 MiB 观察上限，未继续读取。"
          : reason.has("RESULT_MISSING") ||
              reason.has("RESULT_IDENTITY_MISMATCH")
            ? "没有收到可安全关联到这张卡的完整结果。"
            : reason.has("POSTCONDITION_INSUFFICIENT")
              ? "现有编辑语义不足以证明精确结果。"
              : "无法稳定读取并确认这份文件。";
  return Object.freeze({
    actionId: action.actionId,
    state,
    lines: Object.freeze([
      heading,
      `${report.toolOutcome === "unknown" ? "未确认" : "已知"}：${toolFact}`,
      `${state === "unknown" ? "未确认" : "已知"}：${fileFact}`,
      "仍未知：这份文件是否满足你的实际需求，以及程序功能是否正确。",
      "检查范围：仅独立读取这份明确文件，不扫描项目。",
      "恢复：当前不能自动恢复这次修改。",
      state === "matched"
        ? "下一步：你可以返回 Pi 继续后续文件任务。"
        : "下一步：请返回 Pi 检查这份文件，再明确提出下一步。",
    ]),
  });
}
