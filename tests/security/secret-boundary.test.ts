import { expect, test, vi } from "vitest";
import {
  projectTransientActionInput,
  REDACTION_MARKER,
} from "../../src/core/input-boundary.js";

function syntheticSecret(suffix: string): string {
  return `token=synthetic-${suffix}-credential`;
}

test("INV-005: secret candidates only cross the boundary as redacted values", () => {
  const secret = syntheticSecret("alpha");
  const logs: unknown[][] = [];
  const spies = [
    vi
      .spyOn(console, "log")
      .mockImplementation((...values) => logs.push(values)),
    vi
      .spyOn(console, "warn")
      .mockImplementation((...values) => logs.push(values)),
    vi
      .spyOn(console, "error")
      .mockImplementation((...values) => logs.push(values)),
  ];
  try {
    const projected = projectTransientActionInput("write", {
      content: secret,
      nested: { authorization: `Bearer ${secret}` },
    });
    const persistable = JSON.stringify(projected.redactedInput);
    expect(projected.secretDetected).toBe(true);
    expect(persistable).not.toContain(secret);
    expect(persistable).toContain(REDACTION_MARKER);
    expect(JSON.stringify(logs)).not.toContain(secret);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

test("INV-006: different raw secrets cannot share approval fingerprints", () => {
  const first = projectTransientActionInput("write", {
    token: syntheticSecret("first"),
  });
  const second = projectTransientActionInput("write", {
    token: syntheticSecret("second"),
  });
  expect(first.redactedInput).toEqual(second.redactedInput);
  expect(first.fingerprint.value).not.toBe(second.fingerprint.value);
});

test.each([
  ["field", { apiKey: "synthetic-plain-value" }],
  ["private key", { value: "-----BEGIN PRIVATE KEY-----\nsynthetic\n" }],
  ["authorization", { value: "Bearer synthetic-authorization-value" }],
  [
    "connection URI",
    { value: "scheme://synthetic:credential@example.invalid/db" },
  ],
  ["cloud assignment", { value: "AWS_SECRET_ACCESS_KEY=synthetic-value" }],
])("INV-005: detects and redacts a synthetic %s candidate", (_name, input) => {
  const rawText = Object.values(input)[0];
  const projected = projectTransientActionInput("write", input);
  expect(projected.secretDetected).toBe(true);
  expect(JSON.stringify(projected.redactedInput)).not.toContain(rawText);
});

test("INV-016: the persistable result exposes no raw or canonical payload", () => {
  const projected = projectTransientActionInput("write", {
    path: "notes.txt",
    token: syntheticSecret("boundary"),
  });
  expect(Object.keys(projected).sort()).toEqual([
    "fingerprint",
    "redactedInput",
    "secretDetected",
  ]);
  expect(projected).not.toHaveProperty("rawInput");
  expect(projected).not.toHaveProperty("canonical");
});

test("INV-005: validation errors discard hostile raw exception messages", () => {
  const secret = syntheticSecret("exception");
  const descriptors = vi
    .spyOn(Object, "getOwnPropertyDescriptors")
    .mockImplementationOnce(() => {
      throw new Error(secret);
    });
  let caught: unknown;
  try {
    projectTransientActionInput("write", { safe: "value" });
  } catch (error) {
    caught = error;
  } finally {
    descriptors.mockRestore();
  }
  expect(caught).toMatchObject({ code: "INPUT_INVALID" });
  expect(String(caught)).not.toContain(secret);
});
