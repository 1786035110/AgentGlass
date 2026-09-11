import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import {
  renderOutcomeCard,
  renderOutcomeCardUpdate,
  renderReadNotice,
} from "../../src/core/outcome-card.js";
import { outcomeCardFixtures } from "../fixtures/outcome-cards.js";

function visibleCopy(name: string): string {
  const fixture = outcomeCardFixtures.find((item) => item.name === name);
  if (!fixture) throw new Error("fixture missing");
  const card = renderOutcomeCard(
    fixture.action,
    fixture.risk,
    fixture.effect,
    fixture.snapshot,
    fixture.capabilities,
  );
  return [
    card.title,
    card.expectedOutcome,
    card.attention,
    card.recovery,
    ...card.details,
  ].join("\n");
}

test("INV-005/011/017: every card avoids secrets, protection claims, and hidden-reasoning claims", () => {
  const control = visibleCopy("terminal control sequence in label");
  const secret = visibleCopy("synthetic secret in label");
  const obscuredSecret = visibleCopy("control-obscured synthetic secret");
  const unknown = visibleCopy("unsupported or unknown action");
  const allCards = outcomeCardFixtures
    .map((fixture) => visibleCopy(fixture.name))
    .join("\n");
  const prohibitedClaim =
    /fingerprint|session|chain[- ]of[- ]thought|隐藏(?:思维|推理)|(?:受到|由).{0,8}(?:sandbox|沙箱)(?:保护|隔离)|完整(?:的)? shell containment|(?:能够|可以|会)阻止恶意.*扩展/i;

  expect(control).toContain("报告.txt");
  expect(control.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
  expect(secret).toContain("[REDACTED]");
  expect(secret).not.toContain("synthetic-secret-value");
  expect(obscuredSecret).toContain("[REDACTED]");
  expect(obscuredSecret).not.toContain("synthetic-secret-value");
  expect(unknown).not.toContain("technical-action-id-must-not-render");
  expect(unknown).not.toContain("technical-target-id-must-not-render");
  expect(unknown).not.toContain("TOOL_IDENTITY_UNVERIFIED");
  expect(allCards).not.toMatch(prohibitedClaim);
  expect("不能阻止恶意共存 Pi 扩展").not.toMatch(prohibitedClaim);
  expect("可以阻止恶意共存 Pi 扩展").toMatch(prohibitedClaim);
});

test("INV-005: huge untrusted labels are bounded while fixed safety facts remain intact", () => {
  const output = visibleCopy("huge label");
  const title = output.split("\n")[0] ?? "";

  expect(title).toContain("…");
  expect([...title].length).toBeLessThanOrEqual(126);
  expect(output).toContain("不会修改它");
  expect(output).toContain("无法确认它是否能完成你的实际目标");
});

test("INV-004/009: saved snapshot never becomes a recovery claim", () => {
  for (const name of [
    "new file with saved absence evidence",
    "modify with saved pre-image",
  ]) {
    const output = visibleCopy(name);
    expect(output).toContain("已保存修改前证据");
    expect(output).toContain("有备份不等于当前可恢复");
    expect(output).toContain("当前不能自动恢复");
    expect(output).not.toMatch(/可以恢复|可撤销|Undo|回滚/u);
  }

  expect(visibleCopy("overwrite with unavailable snapshot")).toContain(
    "未能保存修改前证据",
  );
});

test("INV-009: unknown and not-observed facts stay explicit", () => {
  const output = visibleCopy("unsupported or unknown action");

  expect(output).toContain("无法确认这一步具体会产生什么变化");
  expect(output).toContain("无法确认这一步会影响哪些位置或内容");
  expect(output).toContain("无法确认目标是否涉及敏感信息");
  expect(output).toContain("未观察到适用的快照");
  expect(output).not.toMatch(/没有风险|确认安全|完全验证/u);
});

test("INV-002/003: unknown effects cannot produce a read-only assurance", () => {
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "unsupported or unknown action",
  );
  if (!fixture) throw new Error("unknown fixture missing");
  const notice = renderReadNotice(fixture.action, fixture.risk, fixture.effect);

  expect(notice).toContain("无法确认");
  expect(notice).not.toContain("不会修改它");
});

test("INV-003/010/019: weaker supplied risk cannot hide deterministic safety facts", () => {
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "sensitive target",
  );
  if (!fixture) throw new Error("sensitive fixture missing");
  const card = renderOutcomeCard(
    fixture.action,
    {
      level: "info",
      decision: "ask",
      reasonCodes: ["FILE_MODIFY"],
    },
    fixture.effect,
    fixture.snapshot,
    { interaction: "local_interactive", canPromptForApproval: "yes" },
  );

  expect(card.title).toContain("已停止");
  expect(card.attention).toContain("目标可能包含敏感信息");
  expect(card.attention).toContain("结构化事实彼此不一致");
});

test("INV-010: every High/Critical explanation remains on the main card", () => {
  const output = visibleCopy("all critical explanations remain visible");
  for (const explanation of [
    "输入内容无法可靠解析",
    "动作完整性检查失败",
    "执行前的必要检查没有完成",
    "可能改动 AgentGlass 的安全控制",
    "当前版本不支持这类操作",
    "目标可能包含敏感信息",
    "目标位于当前项目之外",
    "无法可靠确认目标位置或文件类型",
  ]) {
    expect(output).toContain(explanation);
  }
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "all critical explanations remain visible",
  );
  if (!fixture) throw new Error("fixture missing");
  const card = renderOutcomeCard(
    fixture.action,
    fixture.risk,
    fixture.effect,
    fixture.snapshot,
  );
  expect(card.attention).not.toContain("查看详情");
});

test("INV-012/019: missing UI blocks copy and UI strings cannot feed Risk Engine", async () => {
  const output = visibleCopy("approval UI unavailable");
  expect(output).toContain("已停止");
  expect(output).toContain("当前模式无法显示审批界面");

  const riskSource = await readFile(
    new URL("../../src/core/risk-engine.ts", import.meta.url),
    "utf8",
  );
  expect(riskSource).not.toMatch(
    /outcome-card|OutcomeCard|title|attention|recovery/,
  );
});

test("INV-010/013: batch block keeps sequential-retry and other danger explanations", () => {
  const multiple = visibleCopy("multiple simultaneous mutations");
  const incomplete = visibleCopy("incomplete sibling context");

  expect(multiple).toContain("一次只提出一个变更");
  expect(multiple).toContain("原内容可能丢失");
  expect(incomplete).toContain("无法确认同时提出的操作是否完整");
  expect(incomplete).toContain("执行前的必要检查没有完成");
});

test("INV-005/009: B-001 result feedback redacts labels and never exposes result bodies or recovery claims", () => {
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "synthetic secret in label",
  );
  if (!fixture) throw new Error("fixture missing");
  const update = renderOutcomeCardUpdate(fixture.action, fixture.effect, {
    actionId: fixture.action.actionId,
    effectId: fixture.effect.effectId,
    targetId: fixture.effect.targetId,
    status: "unknown",
    toolOutcome: "unknown",
    reasonCodes: ["RESULT_MISSING"],
    checkScope: "single_file",
    applicationOutcome: "unverifiable",
  });
  const output = update.lines.join("\n");
  expect(output).toContain("[REDACTED]");
  expect(output).not.toContain("synthetic-secret-value");
  expect(output).not.toContain("RESULT_MISSING");
  expect(output).toContain("无法确认工具是否完成");
  expect(output).toContain("当前不能自动恢复");
  expect(output).not.toMatch(/可以恢复|可撤销|Undo|回滚/u);
});
