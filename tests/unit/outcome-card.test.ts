import { expect, test } from "vitest";
import type { PreImageSnapshotEvidence } from "../../src/core/domain.js";
import {
  renderOutcomeCard,
  renderReadNotice,
} from "../../src/core/outcome-card.js";
import { predictEffects } from "../../src/core/predicted-effects.js";
import { assessRisk } from "../../src/core/risk-engine.js";
import { actionFacts } from "../fixtures/action-facts.js";
import { outcomeCardFixtures } from "../fixtures/outcome-cards.js";

test("A-011 local zh-CN templates match every specified fixture", () => {
  const renderedCopy = Object.fromEntries(
    outcomeCardFixtures.map((fixture) => {
      const { actionId: _internalActionId, ...copy } = renderOutcomeCard(
        fixture.action,
        fixture.risk,
        fixture.effect,
        fixture.snapshot,
        fixture.capabilities,
      );
      return [fixture.name, copy];
    }),
  );

  expect(renderedCopy).toMatchSnapshot();
});

test("A-011 ordinary read has one mergeable non-mutating notice", () => {
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "ordinary read",
  );
  if (!fixture) throw new Error("read fixture missing");

  expect(renderReadNotice(fixture.action, fixture.risk, fixture.effect)).toBe(
    "正在查看：活动说明.txt，不会修改它。",
  );
});

test("A-011 read notice does not claim read-only when structured facts disagree", () => {
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "unsupported or unknown action",
  );
  if (!fixture) throw new Error("unknown fixture missing");

  expect(renderReadNotice(fixture.action, fixture.risk, fixture.effect)).toBe(
    "无法显示只读提示：无法确认这一步不会修改文件。",
  );
});

test("A-011 distinguishes saved absence, unknown existence, and no observed snapshot", () => {
  const action = actionFacts(
    {
      kind: "edit",
      mutatesState: "yes",
      impactFacts: { effect: "edit", createsParentDirectories: "no" },
    },
    { targetId: "target-state" },
  );
  const risk = assessRisk(action);
  const effect = predictEffects(action, risk)[0];
  if (!effect) throw new Error("effect missing");
  const base: PreImageSnapshotEvidence = {
    status: "saved",
    snapshotId: "private-snapshot",
    targetExisted: "unknown",
    permissionMetadata: "unknown",
    failureCode: null,
    canRestoreNow: false,
    recoveryGrade: "unknown",
  };
  const unknown = renderOutcomeCard(action, risk, effect, base, {
    interaction: "local_interactive",
    canPromptForApproval: "yes",
  });
  const notObserved = renderOutcomeCard(
    action,
    risk,
    effect,
    { ...base, status: "not_applicable", snapshotId: null },
    { interaction: "local_interactive", canPromptForApproval: "yes" },
  );

  expect(unknown.details).toContain(
    "修改前证据：已保存；无法确认执行前目标是否存在；无法确认原权限信息。",
  );
  expect(notObserved.recovery).toContain("没有观察到可用的修改前快照");
  expect(notObserved.recovery).toContain("当前不能自动恢复");
});

test("A-011 freezes copy and fails closed when target facts disagree", () => {
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "modify with saved pre-image",
  );
  if (!fixture) throw new Error("modify fixture missing");
  const card = renderOutcomeCard(
    fixture.action,
    fixture.risk,
    { ...fixture.effect, targetId: "different-target" },
    fixture.snapshot,
    fixture.capabilities,
  );

  expect(card.title).toContain("已停止");
  expect(card.expectedOutcome).toContain("未知文件");
  expect(card.attention).toContain("结构化事实彼此不一致");
  expect(Object.isFrozen(card)).toBe(true);
  expect(Object.isFrozen(card.details)).toBe(true);
});

test("A-011 fails closed when a non-info risk has no explanation", () => {
  const fixture = outcomeCardFixtures.find(
    (item) => item.name === "modify with saved pre-image",
  );
  if (!fixture) throw new Error("modify fixture missing");
  const card = renderOutcomeCard(
    fixture.action,
    { level: "critical", decision: "hard_block", reasonCodes: [] },
    fixture.effect,
    fixture.snapshot,
    fixture.capabilities,
  );

  expect(card.title).toContain("已停止");
  expect(card.attention).toContain("安全检查结果缺少可解释原因");
});
