import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const forbidden = [
  /\b(?:from|import)\s*(?:\(\s*)?["'][^"']*(?:pi-(?:coding-agent|tui)|adapter\/pi)/,
  /\b(?:ExtensionAPI|ExtensionContext|ToolCallEvent|ToolResultEvent|DefaultResourceLoader|SettingsManager)\b/,
  /\btype\s*:\s*["'](?:tool_call|session_start|session_shutdown)["']/,
  /\bctx\s*\.\s*ui\b|\b(?:hasUI|appendEntry|agentDir|piToolCallId|piEvent|piContext|piTui)\b/i,
  /\bhost\s*:\s*["']pi["']|["']\.pi[\\/"']/i,
];

// 通过源码扫描守住宿主边界，防止核心层意外依赖 Pi API 或语义。
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

test("INV-018: Alpha exposes only the Pi adapter", async () => {
  const adapterRoot = fileURLToPath(
    new URL("../../src/adapter", import.meta.url),
  );
  const entries = await readdir(adapterRoot, { withFileTypes: true });
  const adapters = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  expect(adapters).toEqual(["pi"]);
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
  [
    'const pi = await import("@earendil-works/pi-coding-agent");',
    "dynamic Pi package import",
  ],
  ['import "@earendil-works/pi-coding-agent";', "side-effect Pi import"],
  [
    'import { wrapTextWithAnsi } from "@earendil-works/pi-tui";',
    "Pi TUI value",
  ],
  ['import type { Component } from "@earendil-works/pi-tui";', "Pi TUI type"],
  ['const tui = import("@earendil-works/pi-tui");', "dynamic Pi TUI import"],
  [
    'type Event = { type: "tool_call"; toolCallId: string; input: unknown }',
    "Pi event structure",
  ],
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
