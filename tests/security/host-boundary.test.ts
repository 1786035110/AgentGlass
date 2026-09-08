import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const forbidden = [
  /\b(?:from|import)\s*(?:\(\s*)?["'][^"']*(?:pi-coding-agent|adapter\/pi)/,
  /\b(?:ExtensionAPI|ExtensionContext|ToolCallEvent|ToolResultEvent|DefaultResourceLoader|SettingsManager)\b/,
  /\bctx\s*\.\s*ui\b|\b(?:hasUI|appendEntry|agentDir|piToolCallId|piEvent|piContext|piTui)\b/i,
  /\bhost\s*:\s*["']pi["']|["']\.pi[\\/"']/i,
];

function violations(source: string): number {
  return forbidden.filter((pattern) => pattern.test(source)).length;
}

test("host-neutral source contains no Pi imports or semantics", async () => {
  const root = fileURLToPath(new URL("../../src", import.meta.url));
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(root, "adapter", "pi")) await visit(path);
      } else if (entry.name.endsWith(".ts")) {
        files.push(path);
      }
    }
  };
  await visit(root);

  const failures: string[] = [];
  for (const file of files) {
    if (violations(await readFile(file, "utf8")) > 0) failures.push(file);
  }
  expect(files.length).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

test.each([
  [
    'import { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    "Pi package",
  ],
  [
    'import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";',
    "Pi event type",
  ],
  ['import "@earendil-works/pi-coding-agent";', "side-effect Pi import"],
  [
    "type Context = { hasUI: boolean; agentDir: string }",
    "Pi capability/default path",
  ],
  ["const tui = ctx.ui", "Pi TUI context"],
  ['type Action = { host: "pi"; piContext: unknown }', "Pi domain semantics"],
])("boundary rejects %s (%s)", (source) => {
  expect(violations(source)).toBeGreaterThan(0);
});

test("boundary accepts host-neutral execution identity", () => {
  expect(
    violations(
      "type Binding = { toolName: string; cwd: string; sessionId: string; toolCallId: string }",
    ),
  ).toBe(0);
});
