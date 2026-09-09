import type {
  ApprovalToken,
  ExecutionBinding,
  HostExecutionFacts,
} from "./domain.js";

type TokenState = ApprovalToken["state"];

const states = new WeakMap<ApprovalToken, { value: TokenState }>();

function sameFingerprint(
  left: ExecutionBinding["fingerprint"],
  right: ExecutionBinding["fingerprint"],
): boolean {
  return (
    left.algorithm === right.algorithm &&
    left.canonicalizationVersion === right.canonicalizationVersion &&
    left.value === right.value
  );
}

export function executionBinding(
  facts: HostExecutionFacts,
): Readonly<ExecutionBinding> {
  return Object.freeze({
    fingerprint: facts.input.fingerprint,
    toolName: facts.tool.name,
    cwd: facts.cwd,
    sessionId: facts.sessionId,
    hostExecutionId: facts.hostExecutionId,
    toolCallId: facts.toolCallId,
  });
}

export function sameExecutionBinding(
  left: ExecutionBinding,
  right: ExecutionBinding,
): boolean {
  return (
    sameFingerprint(left.fingerprint, right.fingerprint) &&
    left.toolName === right.toolName &&
    left.cwd === right.cwd &&
    left.sessionId === right.sessionId &&
    left.hostExecutionId === right.hostExecutionId &&
    left.toolCallId === right.toolCallId
  );
}

export function issueApprovalToken(
  actionId: string,
  binding: ExecutionBinding,
): ApprovalToken {
  const mutableState = { value: "issued" as TokenState };
  // token 只能由本模块登记；伪造相同字段的对象无法进入 WeakMap，也不能恢复授权。
  const token = Object.freeze({
    actionId,
    binding: Object.freeze({
      ...binding,
      fingerprint: Object.freeze({ ...binding.fingerprint }),
    }),
    get state() {
      return mutableState.value;
    },
  });
  states.set(token, mutableState);
  return token;
}

export function invalidateApprovalToken(token: ApprovalToken): void {
  const state = states.get(token);
  if (state?.value === "issued") state.value = "invalidated";
}

export function consumeApprovalToken(
  token: ApprovalToken,
  actionId: string,
  binding: ExecutionBinding,
): boolean {
  const state = states.get(token);
  if (state?.value !== "issued") return false;
  // 先同步撤销 issued，再比较；同一事件循环中的重复点击或重放最多有一次成功机会。
  state.value = "invalidated";
  if (
    token.actionId !== actionId ||
    !sameExecutionBinding(token.binding, binding)
  ) {
    return false;
  }
  state.value = "consumed";
  return true;
}
