import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createReadToolDefinition,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolCallEvent,
  type ToolDefinition,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";

// 允许 R-002 将同一套真实 Pi 调度回归切换到 npm tarball 的隔离安装目录；
// 这是测试侧注入，不进入产品代码，也不改变生产扩展的加载边界。
const packageRoot =
  process.env.AGENTGLASS_E2E_PACKAGE_ROOT ??
  fileURLToPath(new URL("../../", import.meta.url));
const extensionEntry = join(packageRoot, "extensions", "agentglass.ts");
const temporaryRoots: string[] = [];
const liveSessions: Array<{ dispose(): void }> = [];

type ModelMessage = Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
type ToolCall = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};
type FaultHandler = (event: ToolCallEvent) => void;
type EventTap = (
  event:
    | ToolCallEvent
    | ToolExecutionStartEvent
    | ToolResultEvent
    | ToolExecutionEndEvent,
) => unknown;
type ScriptedModel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["model"]
>;

const scriptedModel: ScriptedModel = {
  id: "agentglass-e2e",
  name: "AgentGlass deterministic E2E model",
  api: "openai-completions",
  provider: "agentglass-e2e",
  baseUrl: "http://127.0.0.1/unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1_024,
};

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function toolTurn(calls: ToolCall[]): ModelMessage {
  return {
    role: "assistant",
    content: calls,
    api: scriptedModel.api,
    provider: scriptedModel.provider,
    model: scriptedModel.id,
    usage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function finalTurn(): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "完成。" }],
    api: scriptedModel.api,
    provider: scriptedModel.provider,
    model: scriptedModel.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function deterministicStream(message: ModelMessage) {
  // 测试只提供固定模型事件；真实 Pi agent loop 仍负责消息落入会话、参数校验、
  // sibling 调度、扩展阻止与工具执行，且不会发起任何生产模型或网络请求。
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start" as const, partial: message };
      yield {
        type: "done" as const,
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      };
    },
    async result() {
      return message;
    },
  } as unknown as ReturnType<ModelRuntime["streamSimple"]>;
}

interface ApprovalStep {
  inputs?: string[];
  missingResult?: boolean;
  onOpen?: () => void | Promise<void>;
}

interface TestComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
}

type TestCustomFactory<T> = (
  tui: { requestRender(): void },
  theme: unknown,
  keybindings: { matches(data: string, key: string): boolean },
  done: (value: T) => void,
) => TestComponent | Promise<TestComponent>;

interface E2ERuntime {
  root: string;
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  loadedExtensionPaths: string[];
  executionEnds: Array<{
    toolCallId: string;
    toolName: string;
    isError: boolean;
  }>;
  enqueue(...messages: ModelMessage[]): void;
  setFault(handler: FaultHandler | undefined): void;
  setEventTap(handler: EventTap | undefined): void;
  streamCalls(): number;
}

async function createRuntime(options?: {
  sessionId?: string;
  breakSnapshotStorage?: boolean;
  customTools?: ToolDefinition[];
}): Promise<E2ERuntime> {
  // R-002 可指定一个隔离持久根来检查卸载后的私有副本保留；普通测试仍使用
  // 自动清理的临时目录，避免测试证据目录进入产品或用户数据范围。
  const persistentRoot = process.env.AGENTGLASS_E2E_PERSISTENT_ROOT;
  const root =
    persistentRoot ?? (await mkdtemp(join(tmpdir(), "agentglass-e2e-")));
  if (!persistentRoot) temporaryRoots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  if (options?.breakSnapshotStorage) {
    // 把私有目录位置占成普通文件，只让 snapshot 保存失败；风险和批准路径仍走真实产品代码。
    await writeFile(join(agentDir, ".agentglass"), "unavailable", "utf8");
  }

  let fault: FaultHandler | undefined;
  let eventTap: EventTap | undefined;
  const faultExtensionPath = join(root, "fault-extension.mjs");
  const faultKey = `__agentglassFault${temporaryRoots.length}`;
  Object.assign(globalThis, {
    [faultKey]: (event: ToolCallEvent) => fault?.(event),
    [`${faultKey}Tap`]: (event: Parameters<EventTap>[0]) => eventTap?.(event),
  });
  await writeFile(
    faultExtensionPath,
    `export default function (pi) {
  pi.on("tool_execution_start", (event) => globalThis[${JSON.stringify(`${faultKey}Tap`)}]?.(event));
  pi.on("tool_call", (event) => { globalThis[${JSON.stringify(faultKey)}]?.(event); return globalThis[${JSON.stringify(`${faultKey}Tap`)}]?.(event); });
  pi.on("tool_result", (event) => globalThis[${JSON.stringify(`${faultKey}Tap`)}]?.(event));
  pi.on("tool_execution_end", (event) => globalThis[${JSON.stringify(`${faultKey}Tap`)}]?.(event));
}\n`,
    "utf8",
  );

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [faultExtensionPath, packageRoot],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await loader.reload();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }

  const sessionManager = SessionManager.inMemory(cwd, {
    id: options?.sessionId ?? `session-${temporaryRoots.length}`,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const queued: ModelMessage[] = [];
  vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
  const stream = vi
    .spyOn(modelRuntime, "streamSimple")
    .mockImplementation(() => {
      const message = queued.shift();
      if (!message) throw new Error("deterministic model response missing");
      return deterministicStream(message);
    });

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    modelRuntime,
    model: scriptedModel,
    ...(options?.customTools ? { customTools: options.customTools } : {}),
  });
  liveSessions.push(session);
  const executionEnds: E2ERuntime["executionEnds"] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      executionEnds.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
    }
  });
  await session.bindExtensions({ mode: "print" });

  return {
    root,
    cwd,
    agentDir,
    sessionManager,
    session,
    loadedExtensionPaths: loader
      .getExtensions()
      .extensions.map((extension) => extension.resolvedPath),
    executionEnds,
    enqueue: (...messages) => queued.push(...messages),
    setFault: (handler) => {
      fault = handler;
    },
    setEventTap: (handler) => {
      eventTap = handler;
    },
    streamCalls: () => stream.mock.calls.length,
  };
}

function installApprovalUi(
  runtime: E2ERuntime,
  steps: ApprovalStep[],
  mode: "tui" | "rpc" = "tui",
) {
  const runner = runtime.session.extensionRunner;
  const base = runner.getUIContext();
  const rendered: string[][] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const widgets: Array<{ key: string; content: string[] | undefined }> = [];
  let customCalls = 0;
  const custom = (async <T>(factory: TestCustomFactory<T>) => {
    const step = steps[customCalls++];
    if (!step) throw new Error("approval input missing");
    if (step.missingResult) return undefined as T;
    await step.onOpen?.();
    let finish: (value: T) => void = () => {};
    const result = new Promise<T>((resolve) => {
      finish = resolve;
    });
    const component = await factory(
      { requestRender: () => {} },
      base.theme,
      {
        matches: (data, key) =>
          data ===
          (
            {
              "tui.select.cancel": "esc",
              "tui.select.up": "up",
              "tui.select.down": "down",
              "tui.input.tab": "tab",
              "tui.select.confirm": "enter",
            } as Record<string, string>
          )[key],
      },
      finish,
    );
    rendered.push(component.render(80));
    for (const input of step.inputs ?? []) {
      component.handleInput?.(input);
      rendered.push(component.render(80));
    }
    const value = await result;
    component.dispose?.();
    return value;
  }) as unknown as ExtensionUIContext["custom"];
  runner.setUIContext(
    {
      ...base,
      custom,
      setStatus: (key, text) => statuses.push({ key, text }),
      setWidget: (key, content) =>
        widgets.push({
          key,
          content: Array.isArray(content) ? [...content] : undefined,
        }),
    },
    mode,
  );
  return {
    rendered,
    statuses,
    widgets,
    get customCalls() {
      return customCalls;
    },
  };
}

async function promptCalls(
  runtime: E2ERuntime,
  calls: ToolCall[],
  goal = "读取并修改活动说明",
): Promise<void> {
  runtime.enqueue(toolTurn(calls), finalTurn());
  await runtime.session.prompt(goal, { expandPromptTemplates: false });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const session of liveSessions.splice(0)) session.dispose();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("A-016 Pi 0.85.1 real dispatch E2E", () => {
  test("actual package entry dispatches read, create, overwrite, and edit with explicit Continue", async () => {
    const runtime = await createRuntime();
    await writeFile(join(runtime.cwd, "活动说明.txt"), "草稿", "utf8");
    await writeFile(join(runtime.cwd, "活动说明-旧.txt"), "旧内容", "utf8");
    const ui = installApprovalUi(runtime, [
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
    ]);

    runtime.enqueue(
      toolTurn([
        {
          type: "toolCall",
          id: "read-activity",
          name: "read",
          arguments: { path: "活动说明.txt" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "create-activity",
          name: "write",
          arguments: { path: "活动说明-副本.txt", content: "新活动" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "overwrite-activity",
          name: "write",
          arguments: { path: "活动说明-旧.txt", content: "已覆盖" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "edit-activity",
          name: "edit",
          arguments: {
            path: "活动说明.txt",
            edits: [{ oldText: "草稿", newText: "已确认" }],
          },
        },
      ]),
      finalTurn(),
    );
    await runtime.session.prompt("读取并修改活动说明", {
      expandPromptTemplates: false,
    });

    expect(runtime.loadedExtensionPaths).toEqual([
      join(runtime.root, "fault-extension.mjs"),
      extensionEntry,
    ]);
    expect(ui.customCalls).toBe(3);
    expect(ui.statuses).toContainEqual({
      key: "agentglass-read",
      text: "正在查看：活动说明.txt，不会修改它。",
    });
    expect(ui.statuses).toContainEqual({
      key: "agentglass-read",
      text: "已完成这次文件查看；文件内容由 Pi 显示。",
    });
    const verificationCards = ui.widgets.filter(
      ({ key }) => key === "agentglass-action",
    );
    expect(verificationCards).toHaveLength(6);
    expect(
      verificationCards.filter(({ content }) =>
        content?.[0]?.startsWith("执行中："),
      ),
    ).toHaveLength(3);
    expect(
      verificationCards.filter(({ content }) =>
        content?.[0]?.startsWith("已确认："),
      ),
    ).toHaveLength(3);
    expect(
      verificationCards.flatMap(({ content }) => content ?? []).join("\n"),
    ).toContain("/agentglass");
    expect(await readFile(join(runtime.cwd, "活动说明-副本.txt"), "utf8")).toBe(
      "新活动",
    );
    expect(await readFile(join(runtime.cwd, "活动说明-旧.txt"), "utf8")).toBe(
      "已覆盖",
    );
    expect(await readFile(join(runtime.cwd, "活动说明.txt"), "utf8")).toBe(
      "已确认",
    );
    expect(
      runtime.executionEnds.map(({ toolName, isError }) => [toolName, isError]),
    ).toEqual([
      ["read", false],
      ["write", false],
      ["write", false],
      ["edit", false],
    ]);
    expect(
      await readdir(join(runtime.agentDir, ".agentglass", "snapshots")),
    ).not.toHaveLength(0);
    expect(await exists(join(runtime.cwd, ".agentglass"))).toBe(false);
  });

  test("B-002 real Pi dispatch connects one file change to restore and cleanup", async () => {
    const runtime = await createRuntime();
    const targetPath = join(runtime.cwd, "可恢复.txt");
    await writeFile(targetPath, "修改前", "utf8");
    const ui = installApprovalUi(runtime, [
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
    ]);
    await promptCalls(runtime, [
      {
        type: "toolCall",
        id: "recoverable-change",
        name: "edit",
        arguments: {
          path: "可恢复.txt",
          edits: [{ oldText: "修改前", newText: "修改后" }],
        },
      },
    ]);
    expect(await readFile(targetPath, "utf8")).toBe("修改后");
    expect(ui.widgets.at(-1)?.content?.join("\n")).toContain("/agentglass");

    await runtime.session.prompt("/agentglass restore");
    expect(await readFile(targetPath, "utf8")).toBe("修改前");
    expect(ui.widgets.at(-1)?.content?.join("\n")).toContain("已恢复");

    await runtime.session.prompt("/agentglass cleanup");
    expect(
      await readdir(join(runtime.agentDir, ".agentglass", "snapshots")),
    ).toEqual([]);
    expect(ui.customCalls).toBe(3);
  });

  test("B-003 real Pi package entry prepares the safe example, edits it, restores it, and cleans snapshots", async () => {
    const runtime = await createRuntime();
    const ui = installApprovalUi(runtime, [
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
    ]);

    await runtime.session.prompt("/agentglass example");
    const examplePath = join(runtime.cwd, "agentglass-example", "活动说明.txt");
    expect(await readFile(examplePath, "utf8")).toContain("社区旧物交换日");

    await promptCalls(
      runtime,
      [
        {
          type: "toolCall",
          id: "edit-example",
          name: "edit",
          arguments: {
            path: "agentglass-example/活动说明.txt",
            edits: [{ oldText: "现场登记。", newText: "网上登记。" }],
          },
        },
      ],
      "帮我修改这份活动说明",
    );
    expect(await readFile(examplePath, "utf8")).toContain("网上登记。");
    expect(ui.customCalls).toBe(2);

    await runtime.session.prompt("/agentglass restore");
    expect(await readFile(examplePath, "utf8")).toContain("现场登记。");
    expect(ui.widgets.at(-1)?.content?.join("\n")).toContain("已恢复");

    await runtime.session.prompt("/agentglass cleanup");
    expect(
      await readdir(join(runtime.agentDir, ".agentglass", "snapshots")),
    ).toEqual([]);
    expect(ui.customCalls).toBe(4);
  });

  test("Stop stays focused; details do not approve; Continue, Stop, Esc, and cancel remain distinct", async () => {
    const cases: Array<{
      name: string;
      step: ApprovalStep;
      executed: boolean;
      details: boolean;
    }> = [
      {
        name: "stop",
        step: { inputs: ["enter"] },
        executed: false,
        details: false,
      },
      {
        name: "details-continue",
        step: { inputs: ["down", "enter", "down", "enter"] },
        executed: true,
        details: true,
      },
      {
        name: "details-stop",
        step: { inputs: ["down", "enter", "up", "enter"] },
        executed: false,
        details: true,
      },
      {
        name: "escape",
        step: { inputs: ["esc"] },
        executed: false,
        details: false,
      },
      {
        name: "cancel",
        step: { missingResult: true },
        executed: false,
        details: false,
      },
    ];

    for (const fixture of cases) {
      const runtime = await createRuntime();
      const order: string[] = [];
      runtime.setEventTap((event) => order.push(event.type));
      const ui = installApprovalUi(runtime, [fixture.step]);
      const target = join(runtime.cwd, `${fixture.name}.txt`);
      await promptCalls(runtime, [
        {
          type: "toolCall",
          id: fixture.name,
          name: "write",
          arguments: { path: `${fixture.name}.txt`, content: "planned" },
        },
      ]);

      if (!fixture.step.missingResult) {
        expect(ui.rendered[0]?.join("\n"), fixture.name).toContain(
          "[当前] 停止这一步",
        );
      }
      expect(
        ui.rendered.some((card) => card.includes("详情：")),
        fixture.name,
      ).toBe(fixture.details);
      expect(await exists(target), fixture.name).toBe(fixture.executed);
      expect(order, fixture.name).toEqual(
        fixture.executed
          ? [
              "tool_execution_start",
              "tool_call",
              "tool_result",
              "tool_execution_end",
            ]
          : ["tool_execution_start", "tool_call", "tool_execution_end"],
      );
    }
  });

  test("Pi 0.85.1 emits start → tool_call → modifiable tool_result → end, and verification ignores result text", async () => {
    const runtime = await createRuntime();
    const order: string[] = [];
    runtime.setEventTap((event) => {
      order.push(event.type);
      if (event.type === "tool_result") {
        return {
          content: [{ type: "text", text: "synthetic changed result" }],
          isError: true,
        };
      }
    });
    const ui = installApprovalUi(runtime, [
      { inputs: ["down", "down", "enter"] },
    ]);
    await promptCalls(runtime, [
      {
        type: "toolCall",
        id: "result-contract",
        name: "write",
        arguments: { path: "contract.txt", content: "expected bytes" },
      },
    ]);

    expect(order).toEqual([
      "tool_execution_start",
      "tool_call",
      "tool_result",
      "tool_execution_end",
    ]);
    expect(runtime.executionEnds).toContainEqual({
      toolCallId: "result-contract",
      toolName: "write",
      isError: true,
    });
    expect(await readFile(join(runtime.cwd, "contract.txt"), "utf8")).toBe(
      "expected bytes",
    );
    const resultCard = ui.widgets.at(-1)?.content?.join("\n") ?? "";
    expect(resultCard).toContain("已确认：contract.txt");
    expect(resultCard).toContain("工具报告失败");
    expect(resultCard).not.toContain("synthetic changed result");
  });

  test("product verification reports a tool success whose file bytes were changed before observation", async () => {
    const runtime = await createRuntime();
    runtime.setEventTap(async (event) => {
      if (event.type === "tool_result")
        await writeFile(join(runtime.cwd, "mismatch.txt"), "different", "utf8");
    });
    const ui = installApprovalUi(runtime, [
      { inputs: ["down", "down", "enter"] },
    ]);
    await promptCalls(runtime, [
      {
        type: "toolCall",
        id: "result-mismatch",
        name: "write",
        arguments: { path: "mismatch.txt", content: "expected" },
      },
    ]);
    expect(runtime.executionEnds.at(-1)).toMatchObject({ isError: false });
    expect(ui.widgets.at(-1)?.content?.join("\n")).toContain(
      "不符：mismatch.txt",
    );
  });

  test("locked edit BOM/CRLF semantics match, while an ambiguous edit fails and reports mismatch", async () => {
    const runtime = await createRuntime();
    await writeFile(
      join(runtime.cwd, "crlf.txt"),
      Buffer.from("\uFEFFfirst “item”\r\nsecond\r\n", "utf8"),
    );
    await writeFile(join(runtime.cwd, "ambiguous.txt"), "same\nsame\n", "utf8");
    const ui = installApprovalUi(runtime, [
      { inputs: ["down", "down", "enter"] },
      { inputs: ["down", "down", "enter"] },
    ]);
    runtime.enqueue(
      toolTurn([
        {
          type: "toolCall",
          id: "edit-crlf",
          name: "edit",
          arguments: {
            path: "crlf.txt",
            edits: [{ oldText: 'first "item"\nsecond', newText: "one\ntwo" }],
          },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "edit-ambiguous",
          name: "edit",
          arguments: {
            path: "ambiguous.txt",
            edits: [{ oldText: "same", newText: "changed" }],
          },
        },
      ]),
      finalTurn(),
    );
    await runtime.session.prompt("验证编辑语义", {
      expandPromptTemplates: false,
    });

    expect(await readFile(join(runtime.cwd, "crlf.txt"), "utf8")).toBe(
      "\uFEFFone\r\ntwo\r\n",
    );
    expect(runtime.executionEnds.map(({ isError }) => isError)).toEqual([
      false,
      true,
    ]);
    const finalCards = ui.widgets
      .filter(({ content }) => !content?.[0]?.startsWith("执行中："))
      .map(({ content }) => content?.[0]);
    expect(finalCards).toEqual([
      expect.stringContaining("已确认：crlf.txt"),
      expect.stringContaining("不符：ambiguous.txt"),
    ]);
  });

  test("no UI and RPC hasUI cannot approve a state-changing action", async () => {
    const noUi = await createRuntime();
    await promptCalls(noUi, [
      {
        type: "toolCall",
        id: "no-ui",
        name: "write",
        arguments: { path: "no-ui.txt", content: "planned" },
      },
    ]);
    expect(await exists(join(noUi.cwd, "no-ui.txt"))).toBe(false);

    const rpc = await createRuntime();
    const rpcUi = installApprovalUi(
      rpc,
      [{ inputs: ["down", "down", "enter"] }],
      "rpc",
    );
    await promptCalls(rpc, [
      {
        type: "toolCall",
        id: "rpc-ui",
        name: "write",
        arguments: { path: "rpc.txt", content: "planned" },
      },
    ]);
    expect(rpcUi.customCalls).toBe(0);
    expect(await exists(join(rpc.cwd, "rpc.txt"))).toBe(false);
  });

  test("multiple mutations and missing sibling context are blocked without reordering", async () => {
    const multiple = await createRuntime();
    const multipleUi = installApprovalUi(multiple, []);
    await promptCalls(multiple, [
      {
        type: "toolCall",
        id: "multi-one",
        name: "write",
        arguments: { path: "one.txt", content: "one" },
      },
      {
        type: "toolCall",
        id: "multi-two",
        name: "write",
        arguments: { path: "two.txt", content: "two" },
      },
    ]);
    expect(await exists(join(multiple.cwd, "one.txt"))).toBe(false);
    expect(await exists(join(multiple.cwd, "two.txt"))).toBe(false);
    expect(multiple.executionEnds.map(({ isError }) => isError)).toEqual([
      true,
      true,
    ]);
    expect(multipleUi.customCalls).toBe(0);
    expect(multiple.streamCalls()).toBe(2);

    const unknownSibling = await createRuntime();
    const unknownSiblingUi = installApprovalUi(unknownSibling, []);
    await promptCalls(unknownSibling, [
      {
        type: "toolCall",
        id: "mutation-with-unknown",
        name: "write",
        arguments: { path: "unknown-sibling.txt", content: "planned" },
      },
      {
        type: "toolCall",
        id: "unknown-sibling",
        name: "mystery",
        arguments: {},
      },
    ]);
    expect(await exists(join(unknownSibling.cwd, "unknown-sibling.txt"))).toBe(
      false,
    );
    expect(
      unknownSibling.executionEnds.find(
        ({ toolCallId }) => toolCallId === "mutation-with-unknown",
      ),
    ).toMatchObject({ isError: true });
    expect(unknownSiblingUi.customCalls).toBe(0);

    const missing = await createRuntime();
    const missingUi = installApprovalUi(missing, []);
    missing.setFault(() => {
      // 在 AgentGlass 前移走当前 assistant leaf，模拟宿主无法提供完整 sibling 身份；
      // 产品必须直接失败关闭，不能猜成只有一个动作或自动重排。
      missing.sessionManager.appendMessage({
        role: "user",
        content: "synthetic sibling context loss",
        timestamp: Date.now(),
      });
      missing.setFault(undefined);
    });
    await promptCalls(missing, [
      {
        type: "toolCall",
        id: "missing-sibling",
        name: "write",
        arguments: { path: "missing.txt", content: "planned" },
      },
    ]);
    expect(await exists(join(missing.cwd, "missing.txt"))).toBe(false);
    expect(missing.executionEnds).toContainEqual({
      toolCallId: "missing-sibling",
      toolName: "write",
      isError: true,
    });
    expect(missingUi.customCalls).toBe(0);
  });

  test("input, target, and pre-image drift invalidate the old card and require a fresh decision", async () => {
    const changedInput = await createRuntime();
    let currentInput: Record<string, unknown> | undefined;
    changedInput.setFault((event) => {
      currentInput = event.input as Record<string, unknown>;
      changedInput.setFault(undefined);
    });
    const inputUi = installApprovalUi(changedInput, [
      {
        onOpen: () => {
          if (!currentInput) throw new Error("current input not captured");
          currentInput.content = "second";
        },
        inputs: ["down", "down", "enter"],
      },
      { inputs: ["down", "down", "enter"] },
    ]);
    await promptCalls(changedInput, [
      {
        type: "toolCall",
        id: "changed-input",
        name: "write",
        arguments: { path: "input.txt", content: "first" },
      },
    ]);
    expect(inputUi.customCalls).toBe(2);
    expect(await readFile(join(changedInput.cwd, "input.txt"), "utf8")).toBe(
      "second",
    );

    const changedTarget = await createRuntime();
    let targetInput: Record<string, unknown> | undefined;
    changedTarget.setFault((event) => {
      targetInput = event.input as Record<string, unknown>;
      changedTarget.setFault(undefined);
    });
    const targetUi = installApprovalUi(changedTarget, [
      {
        onOpen: () => {
          if (!targetInput) throw new Error("current target not captured");
          targetInput.path = "current.txt";
        },
        inputs: ["down", "down", "enter"],
      },
      { inputs: ["down", "down", "enter"] },
    ]);
    await promptCalls(changedTarget, [
      {
        type: "toolCall",
        id: "changed-target",
        name: "write",
        arguments: { path: "old.txt", content: "current" },
      },
    ]);
    expect(targetUi.customCalls).toBe(2);
    expect(await exists(join(changedTarget.cwd, "old.txt"))).toBe(false);
    expect(await readFile(join(changedTarget.cwd, "current.txt"), "utf8")).toBe(
      "current",
    );

    const drift = await createRuntime();
    const driftPath = join(drift.cwd, "drift.txt");
    await writeFile(driftPath, "before", "utf8");
    const driftUi = installApprovalUi(drift, [
      {
        onOpen: () => writeFile(driftPath, "external change", "utf8"),
        inputs: ["down", "down", "enter"],
      },
      { inputs: ["enter"] },
    ]);
    await promptCalls(drift, [
      {
        type: "toolCall",
        id: "target-drift",
        name: "write",
        arguments: { path: "drift.txt", content: "planned" },
      },
    ]);
    expect(driftUi.customCalls).toBe(2);
    expect(await readFile(driftPath, "utf8")).toBe("external change");
  });

  test("replay and a new session never inherit an earlier Continue", async () => {
    const replay = await createRuntime({ sessionId: "session-replay" });
    let ui = installApprovalUi(replay, [{ inputs: ["down", "down", "enter"] }]);
    await promptCalls(replay, [
      {
        type: "toolCall",
        id: "reused-call",
        name: "write",
        arguments: { path: "replay.txt", content: "first" },
      },
    ]);
    expect(ui.customCalls).toBe(1);

    ui = installApprovalUi(replay, [{ inputs: ["enter"] }]);
    await promptCalls(replay, [
      {
        type: "toolCall",
        id: "reused-call",
        name: "write",
        arguments: { path: "replay.txt", content: "replayed" },
      },
    ]);
    expect(ui.customCalls).toBe(1);
    expect(await readFile(join(replay.cwd, "replay.txt"), "utf8")).toBe(
      "first",
    );

    replay.sessionManager.newSession({ id: "session-new" });
    await replay.session.reload();
    ui = installApprovalUi(replay, [{ inputs: ["enter"] }]);
    await promptCalls(replay, [
      {
        type: "toolCall",
        id: "reused-call",
        name: "write",
        arguments: { path: "replay.txt", content: "new session" },
      },
    ]);
    expect(replay.session.sessionId).toBe("session-new");
    // 会话替换必须至少失败关闭；旧 Continue 不能让新会话在没有新卡的情况下执行。
    expect(ui.customCalls).toBe(0);
    expect(replay.executionEnds.at(-1)).toMatchObject({
      toolCallId: "reused-call",
      isError: true,
    });
    expect(await readFile(join(replay.cwd, "replay.txt"), "utf8")).toBe(
      "first",
    );
  });

  test("B-001 blocks before approval when required snapshot storage is unavailable", async () => {
    const runtime = await createRuntime({ breakSnapshotStorage: true });
    const ui = installApprovalUi(runtime, []);
    await promptCalls(runtime, [
      {
        type: "toolCall",
        id: "snapshot-unavailable",
        name: "write",
        arguments: { path: "degraded.txt", content: "approved" },
      },
    ]);

    expect(ui.customCalls).toBe(0);
    expect(await exists(join(runtime.cwd, "degraded.txt"))).toBe(false);
    expect(runtime.executionEnds.at(-1)).toMatchObject({ isError: true });
  });

  test("B-001 blocks implicit parent-directory creation before approval", async () => {
    const runtime = await createRuntime();
    const ui = installApprovalUi(runtime, []);
    await promptCalls(runtime, [
      {
        type: "toolCall",
        id: "implicit-parent",
        name: "write",
        arguments: { path: "missing/child.txt", content: "blocked" },
      },
    ]);
    expect(ui.customCalls).toBe(0);
    expect(await exists(join(runtime.cwd, "missing"))).toBe(false);
    expect(runtime.executionEnds.at(-1)).toMatchObject({ isError: true });
  });

  test("unknown, overridden, unsupported, linked, outside, sensitive, and Critical inputs never execute", async () => {
    const unknownRoot = await mkdtemp(join(tmpdir(), "agentglass-unknown-"));
    temporaryRoots.push(unknownRoot);
    const unknownMarker = join(unknownRoot, "unknown-marker.txt");
    const unknownBase = createReadToolDefinition(unknownRoot);
    const unknownExecute = vi.fn(async () => {
      await writeFile(unknownMarker, "ran", "utf8");
      return { content: [{ type: "text" as const, text: "ran" }], details: {} };
    });
    const runtime = await createRuntime({
      customTools: [
        {
          ...unknownBase,
          name: "mystery",
          execute: unknownExecute,
        } as ToolDefinition,
      ],
    });
    // 安全分支提供真实 TUI 能力但不给任何审批输入，并断言从未打开卡片；
    // 这样能区分规则本身的 hard-block 与“错误降为 ask 后碰巧因无 UI 被阻止”。
    const ui = installApprovalUi(runtime, []);
    const outside = join(runtime.root, "outside.txt");
    const shellMarker = join(runtime.cwd, "shell-marker.txt");
    const linkedOutside = join(runtime.root, "linked-outside");
    await mkdir(linkedOutside);
    await symlink(linkedOutside, join(runtime.cwd, "linked"), "junction");
    await writeFile(join(runtime.cwd, ".env"), "original", "utf8");
    runtime.enqueue(
      toolTurn([
        {
          type: "toolCall",
          id: "unknown-tool",
          name: "mystery",
          arguments: { path: "ignored.txt" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "unsupported-shell",
          name: "bash",
          arguments: {
            command: `node -e "require('fs').writeFileSync(${JSON.stringify(shellMarker)}, 'ran')"`,
          },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "install-rejected",
          name: "bash",
          arguments: { command: "npm install --help" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "run-project-rejected",
          name: "bash",
          arguments: { command: "npm run --help" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "sensitive-target",
          name: "write",
          arguments: { path: ".env", content: "replacement" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "outside-target",
          name: "write",
          arguments: { path: outside, content: "outside" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "linked-target",
          name: "write",
          arguments: { path: "linked/file.txt", content: "linked" },
        },
      ]),
      toolTurn([
        {
          type: "toolCall",
          id: "critical-input",
          name: "write",
          arguments: {
            path: "ordinary.txt",
            // 超过 Canonicalization v1 的 1 MiB 上限，必须在进入审批前按 Critical 输入失败关闭；
            // 该纯合成数据没有 shell 语义，且目标文件不存在可证明真实工具未执行。
            content: "x".repeat(1_048_577),
          },
        },
      ]),
      finalTurn(),
    );
    await runtime.session.prompt("拒绝不支持或危险的动作", {
      expandPromptTemplates: false,
    });

    expect(runtime.executionEnds).toHaveLength(8);
    expect(runtime.executionEnds.every(({ isError }) => isError)).toBe(true);
    expect(ui.customCalls).toBe(0);
    expect(unknownExecute).not.toHaveBeenCalled();
    expect(await exists(unknownMarker)).toBe(false);
    expect(await exists(shellMarker)).toBe(false);
    expect(await readFile(join(runtime.cwd, ".env"), "utf8")).toBe("original");
    expect(await exists(outside)).toBe(false);
    expect(await exists(join(linkedOutside, "file.txt"))).toBe(false);
    expect(await exists(join(runtime.cwd, "ordinary.txt"))).toBe(false);

    const overriddenRoot = await mkdtemp(
      join(tmpdir(), "agentglass-overridden-"),
    );
    temporaryRoots.push(overriddenRoot);
    const overriddenTarget = join(overriddenRoot, "overridden-marker.txt");
    const base = createReadToolDefinition(overriddenRoot);
    const execute = vi.fn(async () => {
      await writeFile(overriddenTarget, "ran", "utf8");
      return { content: [{ type: "text" as const, text: "ran" }], details: {} };
    });
    const overridden = await createRuntime({
      customTools: [{ ...base, execute } as ToolDefinition],
    });
    const overriddenUi = installApprovalUi(overridden, []);
    await writeFile(join(overridden.cwd, "activity.txt"), "unchanged", "utf8");
    await promptCalls(overridden, [
      {
        type: "toolCall",
        id: "overridden-read",
        name: "read",
        arguments: { path: "activity.txt" },
      },
    ]);
    expect(overriddenUi.customCalls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(await exists(overriddenTarget)).toBe(false);
    expect(await readFile(join(overridden.cwd, "activity.txt"), "utf8")).toBe(
      "unchanged",
    );
  });
});
