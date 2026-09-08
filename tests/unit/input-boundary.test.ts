import { expect, test, vi } from "vitest";
import {
  CANONICALIZATION_SCHEMA,
  CANONICALIZATION_VERSION,
  InputBoundaryError,
  MAX_CANONICAL_BYTES,
  MAX_CANONICAL_DEPTH,
  projectTransientActionInput,
  REDACTION_MARKER,
} from "../../src/core/input-boundary.js";

const fingerprint = (input: unknown, toolName = "write") =>
  projectTransientActionInput(toolName, input).fingerprint;

test("Canonicalization v1 sorts object keys but preserves array order", () => {
  const first = fingerprint({ z: 1, nested: { b: true, a: null } });
  const reordered = fingerprint({ nested: { a: null, b: true }, z: 1 });
  expect(first).toEqual(reordered);
  expect(fingerprint({ values: ["a", "b"] }).value).not.toBe(
    fingerprint({ values: ["b", "a"] }).value,
  );
  expect(first).toMatchObject({
    algorithm: "sha256",
    canonicalizationVersion: CANONICALIZATION_VERSION,
  });
  expect(CANONICALIZATION_SCHEMA).toBe("agentglass-action-canonical");
  expect(first.value).toMatch(/^[a-f\d]{64}$/);
});

test("Canonicalization v1 preserves Unicode and command string semantics", () => {
  expect(fingerprint({ text: "中文🙂e\u0301" })).toEqual(
    fingerprint({ text: "中文🙂e\u0301" }),
  );
  expect(fingerprint({ text: "é" }).value).not.toBe(
    fingerprint({ text: "e\u0301" }).value,
  );
  expect(fingerprint({ command: "echo  value\n" }).value).not.toBe(
    fingerprint({ command: "echo value" }).value,
  );
});

test("the fingerprint pins the complete action and Canonicalization v1 bytes", () => {
  expect(
    fingerprint({ path: "note.txt", content: "hello" }, "write").value,
  ).toBe("a0eab30b5da788ff085b55970e34a64cbc64bfd59c5ace1e048c3f9e1d21d354");
  expect(
    fingerprint({ path: "note.txt", content: "hello" }, "edit").value,
  ).not.toBe(
    fingerprint({ path: "note.txt", content: "hello" }, "write").value,
  );
});

test.each([
  ["undefined", { value: undefined }],
  ["function", { value: () => undefined }],
  ["symbol", { value: Symbol("value") }],
  ["BigInt", { value: 1n }],
  ["NaN", { value: Number.NaN }],
  ["Infinity", { value: Number.POSITIVE_INFINITY }],
  ["negative zero", { value: -0 }],
  ["non-JSON object", { value: new Date(0) }],
  ["Proxy", new Proxy({}, {})],
  ["sparse array", { value: Array(1) }],
])("rejects %s", (_name, input) => {
  expect(() => fingerprint(input)).toThrowError(
    expect.objectContaining({ code: "INPUT_INVALID" }),
  );
});

test("rejects cycles, accessors, symbol keys, and hidden properties", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  let getterCalled = false;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "must-not-run";
    },
  });
  const symbolKey = { visible: true } as Record<PropertyKey, unknown>;
  symbolKey[Symbol("hidden")] = "value";
  const hidden = Object.defineProperty({}, "value", { value: "hidden" });
  let toJSONCalled = false;
  const customSerialization = {
    toJSON() {
      toJSONCalled = true;
      return "must-not-run";
    },
  };

  for (const input of [
    cyclic,
    accessor,
    symbolKey,
    hidden,
    customSerialization,
  ]) {
    expect(() => fingerprint(input)).toThrowError(
      expect.objectContaining({ code: "INPUT_INVALID" }),
    );
  }
  expect(getterCalled).toBe(false);
  expect(toJSONCalled).toBe(false);
});

test("rejects a non-string tool identity at the input boundary", () => {
  expect(() => projectTransientActionInput(42 as never, {})).toThrowError(
    expect.objectContaining({ code: "INPUT_INVALID" }),
  );
});

test("enforces canonical depth and UTF-8 byte limits", () => {
  let atDepthLimit: unknown = "leaf";
  for (let index = 0; index < MAX_CANONICAL_DEPTH; index += 1) {
    atDepthLimit = { child: atDepthLimit };
  }
  expect(() => fingerprint(atDepthLimit)).not.toThrow();
  expect(() => fingerprint({ child: atDepthLimit })).toThrowError(
    expect.objectContaining({ code: "INPUT_TOO_DEEP" }),
  );

  const emptyStringCanonicalBytes = Buffer.byteLength(
    `${CANONICALIZATION_SCHEMA}-v${CANONICALIZATION_VERSION}\n{"input":"","toolName":"write"}`,
    "utf8",
  );
  const atByteLimit = "a".repeat(
    MAX_CANONICAL_BYTES - emptyStringCanonicalBytes,
  );
  expect(() => fingerprint(atByteLimit)).not.toThrow();
  expect(() => fingerprint(`${atByteLimit}a`)).toThrowError(
    expect.objectContaining({ code: "INPUT_TOO_LARGE" }),
  );
});

test("redaction failure is fail-closed and never falls back to raw input", () => {
  const syntheticSecret = "synthetic-redaction-failure-secret";
  const freeze = vi.spyOn(Object, "freeze").mockImplementationOnce(() => {
    throw new Error(syntheticSecret);
  });

  let caught: unknown;
  try {
    projectTransientActionInput("write", { value: "safe" });
  } catch (error) {
    caught = error;
  } finally {
    freeze.mockRestore();
  }
  expect(caught).toBeInstanceOf(InputBoundaryError);
  expect(caught).toMatchObject({ code: "REDACTION_FAILED" });
  expect(String(caught)).not.toContain(syntheticSecret);
});

test("redacted projections are immutable persistable JSON values", () => {
  const projected = projectTransientActionInput("write", {
    safe: ["visible"],
    password: "synthetic-password-one",
  });
  expect(projected.redactedInput).toEqual({
    password: REDACTION_MARKER,
    safe: ["visible"],
  });
  expect(Object.isFrozen(projected)).toBe(true);
  expect(Object.isFrozen(projected.redactedInput)).toBe(true);
  expect(
    Object.isFrozen(
      (projected.redactedInput as unknown as { safe: unknown[] }).safe,
    ),
  ).toBe(true);
});
