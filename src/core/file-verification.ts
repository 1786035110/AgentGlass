import { createHash } from "node:crypto";
import type {
  ExpectedFilePostcondition,
  ToolOutcomeStatus,
  VerificationReasonCode,
  VerificationReport,
} from "./domain.js";
import {
  readStableFile,
  type StableFileRead,
  StableFileReadError,
} from "./stable-file.js";

export const FILE_OBSERVATION_LIMIT_BYTES = 10 * 1024 * 1024;
type StableReader = (
  targetPath: string,
  limitBytes: number,
) => Promise<StableFileRead>;

function report(
  expected: ExpectedFilePostcondition,
  toolOutcome: ToolOutcomeStatus,
  status: VerificationReport["status"],
  ...reasonCodes: VerificationReasonCode[]
): VerificationReport {
  return Object.freeze({
    actionId: expected.actionId,
    effectId: expected.effectId,
    targetId: expected.targetId,
    status,
    toolOutcome,
    reasonCodes: Object.freeze(reasonCodes),
    checkScope: "single_file",
    applicationOutcome: "unverifiable",
  });
}

function failureReason(error: StableFileReadError): VerificationReasonCode {
  switch (error.code) {
    case "missing":
      return "TARGET_MISSING";
    case "unsupported":
      return "TARGET_UNSUPPORTED";
    case "too_large":
      return "TARGET_TOO_LARGE";
    case "grew_over_limit":
      return "TARGET_GREW_OVER_LIMIT";
    case "changed":
      return "TARGET_CHANGED_DURING_READ";
    case "unreadable":
      return "TARGET_READ_FAILED";
  }
}

export function hashFileBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function verifyFilePostcondition(
  targetPath: string,
  expected: ExpectedFilePostcondition,
  toolOutcome: ToolOutcomeStatus,
  reader: StableReader = readStableFile,
): Promise<VerificationReport> {
  try {
    const observed = await reader(targetPath, FILE_OBSERVATION_LIMIT_BYTES);
    if (
      expected.beforeIdentity &&
      (observed.identity.device !== expected.beforeIdentity.device ||
        observed.identity.inode !== expected.beforeIdentity.inode)
    ) {
      return report(
        expected,
        toolOutcome,
        "unknown",
        "TARGET_IDENTITY_CHANGED",
      );
    }

    const actualHash = hashFileBytes(observed.bytes);
    if (expected.kind === "exact_bytes") {
      const matched =
        expected.expectedSha256 === actualHash &&
        expected.expectedByteLength === observed.bytes.length;
      return report(
        expected,
        toolOutcome,
        matched ? "matched" : "mismatch",
        matched ? "POSTCONDITION_MATCHED" : "POSTCONDITION_MISMATCH",
      );
    }

    // 无法可靠推导 edit 的精确结果时，只能证明“没有发生计划中的内容变化”；
    // 看到不同字节也不能把并发/外部改动归因给本次工具调用。
    return actualHash === expected.beforeSha256
      ? report(expected, toolOutcome, "mismatch", "POSTCONDITION_MISMATCH")
      : report(expected, toolOutcome, "unknown", "POSTCONDITION_INSUFFICIENT");
  } catch (error) {
    if (error instanceof StableFileReadError) {
      const reason = failureReason(error);
      return report(
        expected,
        toolOutcome,
        error.code === "missing" ? "mismatch" : "unknown",
        reason,
      );
    }
    return report(expected, toolOutcome, "unknown", "TARGET_READ_FAILED");
  }
}

export function unverifiableResult(
  expected: ExpectedFilePostcondition,
  toolOutcome: ToolOutcomeStatus,
  reason: "RESULT_MISSING" | "RESULT_IDENTITY_MISMATCH",
): VerificationReport {
  return report(expected, toolOutcome, "unknown", reason);
}
