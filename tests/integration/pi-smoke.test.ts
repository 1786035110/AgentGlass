import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Pi 0.85.1 discovers the package manifest and loads the real TS entry", async () => {
  const manifest: unknown = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    name: "agentglass",
    type: "module",
    engines: { node: ">=22.19.0" },
    keywords: ["pi-package"],
    pi: { extensions: ["extensions/agentglass.ts"] },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-tui": "*",
    },
    devDependencies: {
      "@earendil-works/pi-coding-agent": "0.85.1",
      "@earendil-works/pi-tui": "0.85.1",
    },
  });
  const installed: unknown = JSON.parse(
    await readFile(
      join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
      "utf8",
    ),
  );
  expect(installed).toMatchObject({ version: "0.85.1" });
  const installedTui: unknown = JSON.parse(
    await readFile(
      join(root, "node_modules/@earendil-works/pi-tui/package.json"),
      "utf8",
    ),
  );
  expect(installedTui).toMatchObject({ version: "0.85.1" });

  const temporary = await mkdtemp(join(tmpdir(), "agentglass-smoke-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: temporary,
      agentDir: join(temporary, "agent"),
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [root],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    expect(errors).toEqual([]);
    expect(extensions).toHaveLength(1);
    const extension = extensions[0];
    expect(extension?.resolvedPath).toBe(
      join(root, "extensions/agentglass.ts"),
    );
    expect(extension?.commands.size).toBe(0);
    expect(extension?.tools.size).toBe(0);
    expect(extension).toBeDefined();
    expect([...(extension?.handlers.keys() ?? [])].sort()).toEqual([
      "agent_end",
      "before_agent_start",
      "session_shutdown",
      "session_start",
      "tool_call",
      "tool_execution_end",
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

test("Windows CI pins official actions and runs every Alpha gate in order", async () => {
  // Windows runner 默认可能启用 autocrlf；仓库级属性必须让全新 checkout 保持 Biome 要求的 LF。
  expect(await readFile(join(root, ".gitattributes"), "utf8")).toBe(
    "* text=auto eol=lf\n",
  );
  const workflow = await readFile(
    join(root, ".github", "workflows", "windows-ci.yml"),
    "utf8",
  );

  expect(workflow).toMatch(
    /on:\r?\n {2}pull_request:\r?\n {2}push:\r?\n {2}workflow_dispatch:/,
  );
  expect(workflow).toMatch(/permissions:\r?\n {2}contents: read/);
  expect(workflow.match(/^ {4}runs-on:/gmu)).toEqual(["    runs-on:"]);
  expect(workflow).toContain("runs-on: windows-latest");
  expect(workflow).toContain(
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  );
  expect(workflow).toContain(
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0",
  );
  expect(workflow).toContain("node-version: 24.14.0");
  expect(workflow).toContain("package-manager-cache: false");

  // 工作流是执行供应链边界：只允许锁定 npm 后按固定顺序运行已存在的门槛；本检查不冒充远端执行结果。
  const commands = [...workflow.matchAll(/^\s+- run: (.+)$/gmu)].map(
    (match) => match[1],
  );
  expect(commands).toEqual([
    "npm install --global npm@11.9.0",
    "npm ci",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
    "npm run test:unit",
    "npm run test:corpus",
    "npm run test:security",
    "npm run test:integration",
    "npm run test:e2e",
    "npm pack --dry-run --json",
  ]);
  expect(workflow).not.toMatch(
    /continue-on-error|\bmatrix\b|\bsecrets\.|npm publish|deploy/iu,
  );
});
