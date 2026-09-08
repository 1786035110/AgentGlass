import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

test("Pi 0.85.1 discovers the package manifest and loads the real TS entry", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const manifest: unknown = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    name: "agentglass",
    type: "module",
    engines: { node: ">=22.19.0" },
    keywords: ["pi-package"],
    pi: { extensions: ["extensions/agentglass.ts"] },
    peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
    devDependencies: { "@earendil-works/pi-coding-agent": "0.85.1" },
  });
  const installed: unknown = JSON.parse(
    await readFile(
      join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"),
      "utf8",
    ),
  );
  expect(installed).toMatchObject({ version: "0.85.1" });

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
    expect(extension?.handlers.size).toBe(0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
