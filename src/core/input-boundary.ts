import { createHash } from "node:crypto";
import { types } from "node:util";
import type {
  ActionFingerprint,
  ProjectedActionInput,
  RedactedPersistableInput,
  TransientRawInput,
} from "./domain.js";

export const CANONICALIZATION_SCHEMA = "agentglass-action-canonical" as const;
export const CANONICALIZATION_VERSION = 1 as const;
export const MAX_CANONICAL_BYTES = 1024 * 1024;
export const MAX_CANONICAL_DEPTH = 64;
export const REDACTION_MARKER = "[REDACTED]";

export type InputBoundaryErrorCode =
  | "INPUT_INVALID"
  | "INPUT_TOO_DEEP"
  | "INPUT_TOO_LARGE"
  | "CANONICALIZATION_FAILED"
  | "FINGERPRINT_FAILED"
  | "REDACTION_FAILED";

export class InputBoundaryError extends Error {
  readonly code: InputBoundaryErrorCode;

  constructor(code: InputBoundaryErrorCode) {
    // Core 只向后续风险层提供固定代码，不提前承担 A-010 的用户文案职责。
    super(code);
    this.name = "InputBoundaryError";
    this.code = code;
  }
}

const canonicalPrefix = `${CANONICALIZATION_SCHEMA}-v${CANONICALIZATION_VERSION}\n`;

class CanonicalWriter {
  #canonical = "";
  #bytes = 0;

  write(chunk: string): void {
    this.#bytes += Buffer.byteLength(chunk, "utf8");
    if (this.#bytes > MAX_CANONICAL_BYTES) {
      throw new InputBoundaryError("INPUT_TOO_LARGE");
    }
    this.#canonical += chunk;
  }

  finish(): string {
    return this.#canonical;
  }
}

function ownDataDescriptors(
  value: object,
): Record<PropertyKey, PropertyDescriptor> {
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      // 访问器可能执行任意代码，不能成为批准指纹的一部分。
      throw new InputBoundaryError("INPUT_INVALID");
    }
  }
  return descriptors;
}

function arrayData(value: unknown[]): {
  descriptors: Record<PropertyKey, PropertyDescriptor>;
  length: number;
} {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  const length = value.length;
  if (length > Math.floor(MAX_CANONICAL_BYTES / 2)) {
    // JSON 数组的每个元素至少需要一个字节和一个分隔符。
    throw new InputBoundaryError("INPUT_TOO_LARGE");
  }
  const descriptors = ownDataDescriptors(value);
  if (descriptors.length?.value !== length) {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    descriptors.length?.enumerable !== false ||
    keys.some((key) => typeof key === "symbol")
  ) {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  const indexes = keys.filter((key) => key !== "length") as string[];
  if (
    indexes.length !== length ||
    indexes.some(
      (key) =>
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= length ||
        descriptors[key]?.enumerable !== true,
    )
  ) {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  return { descriptors, length };
}

function objectData(value: object): {
  descriptors: Record<PropertyKey, PropertyDescriptor>;
  sortedKeys: string[];
} {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  if (keys.length > Math.floor(MAX_CANONICAL_BYTES / 4)) {
    // 对象属性在 canonical JSON 中至少包含两个引号、冒号和一字节值。
    throw new InputBoundaryError("INPUT_TOO_LARGE");
  }
  const descriptors = ownDataDescriptors(value);
  if (keys.some((key) => descriptors[key]?.enumerable !== true)) {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  return { descriptors, sortedKeys: (keys as string[]).sort() };
}

function writeCanonical(
  writer: CanonicalWriter,
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): void {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new InputBoundaryError("INPUT_TOO_DEEP");
  }
  if (value === null || typeof value === "boolean") {
    writer.write(String(value));
    return;
  }
  if (typeof value === "string") {
    writer.write(JSON.stringify(value));
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new InputBoundaryError("INPUT_INVALID");
    }
    writer.write(JSON.stringify(value));
    return;
  }
  if (typeof value !== "object") {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  if (types.isProxy(value)) {
    // Proxy 的 trap 可在指纹与脱敏遍历之间改变语义，不属于普通 JSON 对象。
    throw new InputBoundaryError("INPUT_INVALID");
  }
  if (ancestors.has(value)) {
    throw new InputBoundaryError("INPUT_INVALID");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const { descriptors, length } = arrayData(value);
      writer.write("[");
      for (let index = 0; index < length; index += 1) {
        if (index > 0) writer.write(",");
        writeCanonical(
          writer,
          descriptors[String(index)]?.value,
          depth + 1,
          ancestors,
        );
      }
      writer.write("]");
      return;
    }

    const { descriptors, sortedKeys } = objectData(value);
    writer.write("{");
    for (const [index, key] of sortedKeys.entries()) {
      if (index > 0) writer.write(",");
      writer.write(JSON.stringify(key));
      writer.write(":");
      writeCanonical(writer, descriptors[key]?.value, depth + 1, ancestors);
    }
    writer.write("}");
  } catch (error) {
    if (error instanceof InputBoundaryError) throw error;
    throw new InputBoundaryError("CANONICALIZATION_FAILED");
  } finally {
    ancestors.delete(value);
  }
}

function canonicalize(toolName: string, input: TransientRawInput): string {
  if (typeof toolName !== "string") {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  const writer = new CanonicalWriter();
  writer.write(canonicalPrefix);
  // 固定包装层不消耗 raw input 的 64 层深度额度。
  writer.write('{"input":');
  writeCanonical(writer, input, 0, new WeakSet());
  writer.write(',"toolName":');
  writeCanonical(writer, toolName, 0, new WeakSet());
  writer.write("}");
  return writer.finish();
}

export function fingerprintTransientActionInput(
  toolName: string,
  input: TransientRawInput,
): ActionFingerprint {
  const canonical = canonicalize(toolName, input);
  let value: string;
  try {
    value = createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    throw new InputBoundaryError("FINGERPRINT_FAILED");
  }
  return Object.freeze({
    algorithm: "sha256",
    canonicalizationVersion: CANONICALIZATION_VERSION,
    value,
  });
}

const secretFieldWords = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passwd",
  "password",
  "pwd",
  "secret",
  "token",
]);

function isSecretField(key: string): boolean {
  const normalized = key
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z\d]+/g, "_");
  const words = normalized.split("_");
  return (
    words.some((word) => secretFieldWords.has(word)) ||
    /(?:api_?key|private_?key|client_?secret|connection_?string|database_?url|access_?key)/.test(
      normalized,
    )
  );
}

const secretValuePatterns = [
  /-----BEGIN (?:[A-Z\d ]+ )?PRIVATE KEY-----/,
  /\b(?:Bearer|Basic)\s+[A-Za-z\d+/_=.-]{8,}/i,
  /\beyJ[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\b/,
  /\b[a-z][a-z\d+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:AKIA|ASIA)[A-Z\d]{16}\b/,
  /\b(?:gh[opusr]_[A-Za-z\d]{20,}|sk-[A-Za-z\d_-]{20,})\b/,
  /(?:^|[^a-z\d])(?:password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret|connection[_-]?string|database[_-]?url|access[_-]?key)(?:[_-][a-z\d]+)*\s*[:=]\s*["']?[^\s"'&,;]{4,}/i,
];

function isSecretValue(value: string): boolean {
  // 只识别可确定的结构标记和常见凭据形状；路径是否敏感由 A-005 使用 raw 值另行判定。
  return secretValuePatterns.some((pattern) => pattern.test(value));
}

interface RedactionState {
  secretDetected: boolean;
}

function redactValue(
  value: unknown,
  state: RedactionState,
  depth = 0,
  ancestors = new WeakSet<object>(),
): RedactedPersistableInput {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new InputBoundaryError("INPUT_TOO_DEEP");
  }
  if (typeof value === "string") {
    if (isSecretValue(value)) {
      state.secretDetected = true;
      return REDACTION_MARKER as RedactedPersistableInput;
    }
    return value as RedactedPersistableInput;
  }
  if (value === null || typeof value === "boolean") {
    return value as RedactedPersistableInput;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new InputBoundaryError("INPUT_INVALID");
    }
    return value as RedactedPersistableInput;
  }
  if (typeof value !== "object") {
    throw new InputBoundaryError("INPUT_INVALID");
  }
  if (ancestors.has(value)) {
    throw new InputBoundaryError("INPUT_INVALID");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const { descriptors, length } = arrayData(value);
      return Object.freeze(
        Array.from({ length }, (_, index) =>
          redactValue(
            descriptors[String(index)]?.value,
            state,
            depth + 1,
            ancestors,
          ),
        ),
      ) as unknown as RedactedPersistableInput;
    }

    const { descriptors, sortedKeys } = objectData(value);
    const output: Record<string, RedactedPersistableInput> =
      Object.create(null);
    let hiddenKeyCount = 0;
    for (const key of sortedKeys) {
      const descriptor = descriptors[key];
      let outputKey = key;
      if (isSecretValue(key)) {
        state.secretDetected = true;
        hiddenKeyCount += 1;
        outputKey = `${REDACTION_MARKER}_KEY_${hiddenKeyCount}`;
      }
      if (isSecretField(key)) {
        state.secretDetected = true;
        output[outputKey] = REDACTION_MARKER as RedactedPersistableInput;
      } else {
        output[outputKey] = redactValue(
          descriptor?.value,
          state,
          depth + 1,
          ancestors,
        );
      }
    }
    return Object.freeze(output) as unknown as RedactedPersistableInput;
  } finally {
    ancestors.delete(value);
  }
}

export function projectTransientActionInput(
  toolName: string,
  input: TransientRawInput,
): ProjectedActionInput {
  // A-003 的顺序边界：先用完整 raw 语义生成版本化 canonical 字节，
  // 再计算 SHA-256，最后才进行 secret 检测与脱敏投影。canonical 不会越过本函数边界。
  const fingerprint = fingerprintTransientActionInput(toolName, input);

  const state: RedactionState = { secretDetected: false };
  let redactedInput: RedactedPersistableInput;
  try {
    redactedInput = redactValue(input, state);
  } catch {
    throw new InputBoundaryError("REDACTION_FAILED");
  }
  return Object.freeze({
    fingerprint: Object.freeze({
      ...fingerprint,
    }),
    redactedInput,
    secretDetected: state.secretDetected,
  });
}
