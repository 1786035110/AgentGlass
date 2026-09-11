import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExpectedFilePostcondition } from "../../src/core/domain.js";
import {
  FILE_OBSERVATION_LIMIT_BYTES,
  hashFileBytes,
  verifyFilePostcondition,
} from "../../src/core/file-verification.js";
import { StableFileReadError } from "../../src/core/stable-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function expected(
  values: Partial<ExpectedFilePostcondition> = {},
): ExpectedFilePostcondition {
  const bytes = Buffer.from("after", "utf8");
  return {
    actionId: "action-one",
    effectId: "effect-one",
    targetId: "target-one",
    kind: "exact_bytes",
    expectedSha256: hashFileBytes(bytes),
    expectedByteLength: bytes.length,
    beforeSha256: hashFileBytes(Buffer.from("before", "utf8")),
    beforeIdentity: null,
    targetExisted: false,
    ...values,
  };
}

async function target(content = "after") {
  const root = await mkdtemp(join(tmpdir(), "agentglass-verify-"));
  roots.push(root);
  const path = join(root, "target.txt");
  await writeFile(path, content, "utf8");
  return path;
}

test("independent exact-byte observation matches create/write even when the tool reported failure", async () => {
  const path = await target();
  const report = await verifyFilePostcondition(path, expected(), "failed");
  expect(report).toMatchObject({
    status: "matched",
    toolOutcome: "failed",
    reasonCodes: ["POSTCONDITION_MATCHED"],
    checkScope: "single_file",
    applicationOutcome: "unverifiable",
  });
  expect(JSON.stringify(report)).not.toContain("after");
});

test("tool success cannot hide an explicit byte mismatch", async () => {
  const report = await verifyFilePostcondition(
    await target("different"),
    expected(),
    "succeeded",
  );
  expect(report).toMatchObject({
    status: "mismatch",
    toolOutcome: "succeeded",
    reasonCodes: ["POSTCONDITION_MISMATCH"],
  });
});

test("an edit with insufficient semantics is mismatch only when no content changed", async () => {
  const insufficient = expected({
    kind: "content_changed",
    expectedSha256: null,
    expectedByteLength: null,
  });
  expect(
    await verifyFilePostcondition(
      await target("before"),
      insufficient,
      "failed",
    ),
  ).toHaveProperty("status", "mismatch");
  expect(
    await verifyFilePostcondition(
      await target("other change"),
      insufficient,
      "succeeded",
    ),
  ).toMatchObject({
    status: "unknown",
    reasonCodes: ["POSTCONDITION_INSUFFICIENT"],
  });
});

test("missing final target is an explicit mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentglass-verify-missing-"));
  roots.push(root);
  expect(
    await verifyFilePostcondition(
      join(root, "missing.txt"),
      expected(),
      "failed",
    ),
  ).toMatchObject({ status: "mismatch", reasonCodes: ["TARGET_MISSING"] });
});

test.each([
  ["unreadable", "TARGET_READ_FAILED"],
  ["too_large", "TARGET_TOO_LARGE"],
  ["grew_over_limit", "TARGET_GREW_OVER_LIMIT"],
  ["changed", "TARGET_CHANGED_DURING_READ"],
  ["unsupported", "TARGET_UNSUPPORTED"],
] as const)("read failure %s remains unknown", async (failure, reason) => {
  const reader = async (_path: string, limit: number): Promise<never> => {
    expect(limit).toBe(FILE_OBSERVATION_LIMIT_BYTES);
    throw new StableFileReadError(failure);
  };
  expect(
    await verifyFilePostcondition("ignored", expected(), "succeeded", reader),
  ).toMatchObject({ status: "unknown", reasonCodes: [reason] });
});

test("replacement of an existing target makes attribution unknown", async () => {
  const path = await target();
  const report = await verifyFilePostcondition(
    path,
    expected({
      targetExisted: true,
      beforeIdentity: { device: "not-current", inode: "not-current" },
    }),
    "succeeded",
  );
  expect(report).toMatchObject({
    status: "unknown",
    reasonCodes: ["TARGET_IDENTITY_CHANGED"],
  });
});

test("the real stable reader refuses a file above the 10 MiB observation budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentglass-verify-large-"));
  roots.push(root);
  const path = join(root, "large.txt");
  await writeFile(path, Buffer.alloc(FILE_OBSERVATION_LIMIT_BYTES + 1));
  expect(
    await verifyFilePostcondition(path, expected(), "succeeded"),
  ).toMatchObject({
    status: "unknown",
    reasonCodes: ["TARGET_TOO_LARGE"],
  });
});
