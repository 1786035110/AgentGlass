import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createReadToolDefinition,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { registerPiAdapter } from "../../src/adapter/pi/adapter.js";
import {
  consumeApprovalToken,
  executionBinding,
  issueApprovalToken,
} from "../../src/core/approval.js";
import type {
  ExecutionBinding,
  HostExecutionFacts,
} from "../../src/core/domain.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function assistantMessage(
  calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
): Parameters<SessionManager["appendMessage"]>[0] {
  return {
    role: "assistant",
    content: calls.map((call) => ({ type: "toolCall" as const, ...call })),
    api: "anthropic-messages",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

async function createRuntime(options?: {
  overriddenRead?: boolean;
  snapshotUnavailable?: boolean;
  bindUI?: boolean;
}) {
  const cwd = await mkdtemp(join(tmpdir(), "agentglass-adapter-"));
  temporaryDirectories.push(cwd);
  const observed: HostExecutionFacts[] = [];
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager,
    extensionFactories: [
      {
        name: "agentglass-integration",
        factory: (pi) => {
          const observer = (facts: HostExecutionFacts) => {
            observed.push(facts);
          };
          if (options?.snapshotUnavailable) registerPiAdapter(pi, observer);
          else
            registerPiAdapter(
              pi,
              observer,
              join(cwd, ".agentglass", "snapshots"),
            );
        },
      },
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const sessionManager = SessionManager.inMemory(cwd, {
    id: "session-one",
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd,
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    modelRuntime,
    ...(options?.overriddenRead
      ? {
          customTools: [
            createReadToolDefinition(cwd) as unknown as ToolDefinition,
          ],
        }
      : {}),
  });
  const uiContext = options?.bindUI
    ? session.extensionRunner.getUIContext()
    : undefined;
  await session.bindExtensions({
    mode: options?.bindUI ? "tui" : "print",
    ...(uiContext ? { uiContext } : {}),
  });
  return { cwd, observed, session, sessionManager };
}

interface ApprovalUiStep {
  inputs?: string[];
  widths?: number[];
  missingResult?: boolean;
  error?: boolean;
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

function installApprovalUi(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  steps: ApprovalUiStep[],
  mode: "tui" | "rpc" | "print" | "json" = "tui",
) {
  const runner = runtime.session.extensionRunner;
  const base = runner.getUIContext();
  const rendered: string[][] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let customCalls = 0;
  let doneCalls = 0;
  const custom = (async <T>(factory: TestCustomFactory<T>) => {
    const step = steps[customCalls++];
    if (!step || step.error) throw new Error("synthetic UI error");
    if (step.missingResult) return undefined as T;
    await step.onOpen?.();
    let resolveResult: (value: T) => void = () => {};
    const resultPromise = new Promise<T>((resolve) => {
      resolveResult = resolve;
    });
    const component = await factory(
      { requestRender: () => {} },
      base.theme,
      {
        matches: (data: string, key: string) =>
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
      (value: T) => {
        doneCalls++;
        resolveResult(value);
      },
    );
    for (const width of step.widths ?? [80])
      rendered.push(component.render(width));
    for (const input of step.inputs ?? []) {
      component.handleInput?.(input);
      rendered.push(component.render(step.widths?.[0] ?? 80));
    }
    const result = await resultPromise;
    component.dispose?.();
    return result;
  }) as unknown as ExtensionUIContext["custom"];
  runner.setUIContext(
    {
      ...base,
      custom,
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    mode,
  );
  return {
    rendered,
    statuses,
    get customCalls() {
      return customCalls;
    },
    get doneCalls() {
      return doneCalls;
    },
  };
}

async function setGoal(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  goal: string,
): Promise<void> {
  await runtime.session.extensionRunner.emitBeforeAgentStart(
    goal,
    undefined,
    "system",
    { cwd: runtime.cwd },
  );
}

async function emitCall(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  call: { id: string; name: string; arguments: Record<string, unknown> },
) {
  runtime.sessionManager.appendMessage(assistantMessage([call]));
  return runtime.session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolCallId: call.id,
    toolName: call.name,
    input: call.arguments,
  });
}

async function emitBatch(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
) {
  runtime.sessionManager.appendMessage(assistantMessage(calls));
  return Promise.all(
    calls.map((call) =>
      runtime.session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolCallId: call.id,
        toolName: call.name,
        input: call.arguments,
      }),
    ),
  );
}

test("Pi 0.85.1 maps the current goal, current siblings, and real execution identities", async () => {
  const runtime = await createRuntime();
  runtime.sessionManager.appendMessage(
    assistantMessage([
      { id: "old-call", name: "read", arguments: { path: "old.txt" } },
    ]),
  );
  runtime.sessionManager.appendMessage({
    role: "user",
    content: "new turn",
    timestamp: Date.now(),
  });
  await setGoal(runtime, "读取当前说明");
  await writeFile(join(runtime.cwd, "now.txt"), "now", "utf8");
  runtime.sessionManager.appendMessage(
    assistantMessage([
      { id: "current-read", name: "read", arguments: { path: "now.txt" } },
      {
        id: "current-write",
        name: "write",
        arguments: { path: "note.txt", content: "ok" },
      },
    ]),
  );

  const result = await runtime.session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolCallId: "current-read",
    toolName: "read",
    input: { path: "now.txt" },
  });
  const facts = runtime.observed[0];

  expect(result).toBeUndefined();
  expect(facts).toMatchObject({
    toolCallId: "current-read",
    sessionId: "session-one",
    cwd: runtime.cwd,
    tool: { name: "read", status: "verified_builtin" },
    userGoal: { status: "observed", redactedText: "读取当前说明" },
  });
  expect(facts?.hostExecutionId).toMatch(/^[a-f\d]{64}$/);
  expect(facts?.siblings.map((sibling) => sibling.toolCallId)).toEqual([
    "current-read",
    "current-write",
  ]);
  expect(facts?.siblings.map((sibling) => sibling.toolCallId)).not.toContain(
    "old-call",
  );
  expect(facts?.siblings[0]?.hostExecutionId).toBe(facts?.hostExecutionId);
});

test("Pi 0.85.1 sibling guard blocks only mutation/unknown members when a batch has at least two", async () => {
  const cases = [
    {
      name: "read + read",
      calls: [
        { id: "r1", name: "read", arguments: { path: "a.txt" } },
        { id: "r2", name: "read", arguments: { path: "b.txt" } },
      ],
      blocked: [],
    },
    {
      name: "read + write",
      calls: [
        { id: "r", name: "read", arguments: { path: "a.txt" } },
        {
          id: "w",
          name: "write",
          arguments: { path: "one.txt", content: "one" },
        },
      ],
      blocked: [],
    },
    {
      name: "write + write to different files",
      calls: [
        {
          id: "w1",
          name: "write",
          arguments: { path: "one.txt", content: "one" },
        },
        {
          id: "w2",
          name: "write",
          arguments: { path: "two.txt", content: "two" },
        },
      ],
      blocked: ["w1", "w2"],
    },
    {
      name: "write + unknown",
      calls: [
        {
          id: "w",
          name: "write",
          arguments: { path: "one.txt", content: "one" },
        },
        { id: "u", name: "mystery", arguments: {} },
      ],
      blocked: ["w", "u"],
    },
    {
      name: "unknown + unknown",
      calls: [
        { id: "u1", name: "mystery", arguments: {} },
        { id: "u2", name: "other", arguments: {} },
      ],
      blocked: ["u1", "u2"],
    },
    {
      name: "three siblings",
      calls: [
        { id: "r", name: "read", arguments: { path: "a.txt" } },
        {
          id: "w",
          name: "write",
          arguments: { path: "one.txt", content: "one" },
        },
        {
          id: "e",
          name: "edit",
          arguments: {
            path: "a.txt",
            edits: [{ oldText: "a", newText: "b" }],
          },
        },
      ],
      blocked: ["w", "e"],
    },
  ] as const;

  for (const fixture of cases) {
    const runtime = await createRuntime();
    await Promise.all(
      fixture.calls
        .filter((call) => call.name === "read" || call.name === "edit")
        .map((call) =>
          writeFile(join(runtime.cwd, `${call.arguments.path}`), "a"),
        ),
    );
    const results = await emitBatch(runtime, [...fixture.calls]);
    const blockedBySiblingGuard = fixture.calls
      .filter((_call, index) =>
        results[index]?.reason?.includes("一次只提出一个变更"),
      )
      .map((call) => call.id);
    expect(blockedBySiblingGuard, fixture.name).toEqual(fixture.blocked);
    for (const result of results.filter((item) =>
      item?.reason?.includes("一次只提出一个变更"),
    )) {
      expect(result?.reason).toContain("一次只提出一个变更");
    }
    if (fixture.name === "read + write") {
      expect(results[0]).toBeUndefined();
      expect(results[1]).toMatchObject({
        block: true,
        reason: expect.stringContaining("明确确认"),
      });
    }
  }
});

test("Pi 0.85.1 verified read/write/edit sources and schemas stay locked", async () => {
  const runtime = await createRuntime();
  await writeFile(join(runtime.cwd, "existing.txt"), "before", "utf8");
  await setGoal(runtime, "classify built-in file tools");
  const fileTools = runtime.session
    .getAllTools()
    .filter((tool) => ["read", "write", "edit"].includes(tool.name));
  const schemas = Object.fromEntries(
    fileTools.map((tool) => [tool.name, tool.parameters]),
  );
  expect(
    Object.fromEntries(fileTools.map((tool) => [tool.name, tool.sourceInfo])),
  ).toEqual({
    read: {
      path: "<builtin:read>",
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
    write: {
      path: "<builtin:write>",
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
    edit: {
      path: "<builtin:edit>",
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
  });
  expect(schemas).toMatchObject({
    read: {
      required: ["path"],
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
    },
    write: {
      required: ["path", "content"],
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
    edit: {
      required: ["path", "edits"],
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            required: ["oldText", "newText"],
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
          },
        },
      },
    },
  });

  const calls = [
    { id: "read-file", name: "read", arguments: { path: "existing.txt" } },
    {
      id: "write-file",
      name: "write",
      arguments: { path: "new.txt", content: "new" },
    },
    {
      id: "edit-file",
      name: "edit",
      arguments: {
        path: "existing.txt",
        edits: [{ oldText: "before", newText: "after" }],
      },
    },
  ];

  for (const call of calls) {
    await emitCall(runtime, call);
    await runtime.session.extensionRunner.emit({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result: {},
      isError: false,
    });
  }

  expect(
    runtime.observed.map(({ tool, action, preImage }) => ({
      tool,
      action,
      preImage,
    })),
  ).toMatchObject([
    {
      tool: { name: "read", status: "verified_builtin" },
      action: {
        kind: "read",
        mutatesState: "no",
        impactFacts: { effect: "read" },
      },
    },
    {
      tool: { name: "write", status: "verified_builtin" },
      action: {
        kind: "write",
        mutatesState: "yes",
        impactFacts: { effect: "create" },
      },
      preImage: {
        status: "saved",
        targetExisted: "no",
        canRestoreNow: false,
        recoveryGrade: "unknown",
      },
    },
    {
      tool: { name: "edit", status: "verified_builtin" },
      action: {
        kind: "edit",
        mutatesState: "yes",
        impactFacts: { effect: "edit" },
      },
      preImage: {
        status: "saved",
        targetExisted: "yes",
        permissionMetadata: "captured",
        canRestoreNow: false,
        recoveryGrade: "unknown",
      },
    },
  ]);
  for (const facts of runtime.observed) {
    expect(facts.action.evidenceCodes).toContain("TOOL_IDENTITY_VERIFIED");
    expect(facts.action.evidenceCodes).toContain("TOOL_SCHEMA_VERIFIED");
  }
});

test("Pi 0.85.1 capability modes do not equate hasUI with safe approval", async () => {
  const runtime = await createRuntime();
  await setGoal(runtime, "inspect modes");
  const runner = runtime.session.extensionRunner;
  const dialogContext = runner.getUIContext();
  const cases = [
    ["tui", dialogContext, "local_interactive", "yes"],
    ["rpc", dialogContext, "remote_interactive", "no"],
    ["json", undefined, "event_stream", "no"],
    ["print", undefined, "one_shot", "no"],
    ["tui", undefined, "unknown", "unknown"],
    ["rpc", undefined, "unknown", "unknown"],
    ["json", dialogContext, "unknown", "unknown"],
    ["print", dialogContext, "unknown", "unknown"],
  ] as const;

  for (const [mode, ui, interaction, canPromptForApproval] of cases) {
    runner.setUIContext(ui, mode);
    const id = `call-${runtime.observed.length}`;
    await emitCall(runtime, {
      id,
      name: "read",
      arguments: { path: "note.txt" },
    });
    expect(runtime.observed.at(-1)?.capabilities).toEqual({
      interaction,
      canPromptForApproval,
    });
    await runner.emit({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "read",
      result: {},
      isError: false,
    });
  }
});

test("unknown and same-name overridden tools retain degraded identity", async () => {
  const unknown = await createRuntime();
  await setGoal(unknown, "unknown tool");
  const unknownResult = await emitCall(unknown, {
    id: "unknown-call",
    name: "mystery",
    arguments: {},
  });
  expect(unknown.observed[0]).toMatchObject({
    tool: { name: "mystery", status: "unknown" },
    evidenceCodes: ["TOOL_IDENTITY_UNKNOWN"],
  });
  expect(unknownResult).toMatchObject({ block: true });

  // Bash 分类结果不会进入文件工具 fast path；真实 Pi 生命周期中仍按 unsupported/unknown 阻止。
  const bashResult = await emitCall(unknown, {
    id: "bash-call",
    name: "bash",
    arguments: { command: "pwd" },
  });
  expect(unknown.observed.at(-1)).toMatchObject({
    tool: { name: "bash" },
    action: { kind: "unknown", mutatesState: "unknown" },
  });
  expect(bashResult).toMatchObject({ block: true });

  const overridden = await createRuntime({ overriddenRead: true });
  await setGoal(overridden, "overridden tool");
  await emitCall(overridden, {
    id: "override-call",
    name: "read",
    arguments: { path: "note.txt" },
  });
  expect(
    overridden.session.getAllTools().find((tool) => tool.name === "read"),
  ).toHaveProperty("sourceInfo.source", "sdk");
  expect(overridden.observed[0]).toMatchObject({
    tool: { name: "read", status: "overridden" },
    evidenceCodes: ["TOOL_IDENTITY_OVERRIDDEN"],
  });
});

test("missing, duplicate, changed-session, and incomplete sibling identities fail closed", async () => {
  const missing = await createRuntime();
  missing.sessionManager.appendMessage(
    assistantMessage([{ id: "", name: "read", arguments: {} }]),
  );
  expect(
    await missing.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "",
      toolName: "read",
      input: {},
    }),
  ).toMatchObject({ block: true });

  const duplicateSibling = await createRuntime();
  duplicateSibling.sessionManager.appendMessage(
    assistantMessage([
      { id: "duplicate", name: "read", arguments: {} },
      { id: "duplicate", name: "write", arguments: {} },
    ]),
  );
  expect(
    await duplicateSibling.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "duplicate",
      toolName: "read",
      input: {},
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("无法确认"),
  });

  const staleSession = await createRuntime();
  staleSession.sessionManager.newSession({ id: "session-two" });
  expect(
    await emitCall(staleSession, {
      id: "changed-session",
      name: "read",
      arguments: {},
    }),
  ).toMatchObject({ block: true });

  const incomplete = await createRuntime();
  incomplete.sessionManager.appendMessage({
    role: "user",
    content: "not an assistant tool-call message",
    timestamp: Date.now(),
  });
  expect(
    await incomplete.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "missing-sibling",
      toolName: "read",
      input: {},
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("无法确认"),
  });

  const staleTurn = await createRuntime();
  staleTurn.sessionManager.appendMessage(
    assistantMessage([
      { id: "old-write", name: "write", arguments: { path: "old.txt" } },
    ]),
  );
  staleTurn.sessionManager.appendMessage({
    role: "user",
    content: "new turn",
    timestamp: Date.now(),
  });
  staleTurn.sessionManager.appendMessage(
    assistantMessage([
      { id: "new-read", name: "read", arguments: { path: "new.txt" } },
    ]),
  );
  expect(
    await staleTurn.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "old-write",
      toolName: "write",
      input: { path: "old.txt", content: "old" },
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("无法确认"),
  });

  const unprovable = await createRuntime();
  unprovable.sessionManager.appendMessage({
    ...assistantMessage([
      { id: "current-write", name: "write", arguments: {} },
    ]),
    content: [
      {
        type: "toolCall",
        id: "current-write",
        name: "write",
        arguments: null,
      },
    ],
  } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
  expect(
    await unprovable.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "current-write",
      toolName: "write",
      input: { path: "new.txt", content: "new" },
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("无法确认"),
  });
});

test("active execution and goal state are cleaned up by Pi lifecycle events", async () => {
  const runtime = await createRuntime({ bindUI: true });
  await setGoal(runtime, "first goal");
  await writeFile(join(runtime.cwd, "note.txt"), "note", "utf8");
  const call = { id: "reused", name: "read", arguments: { path: "note.txt" } };
  expect(await emitCall(runtime, call)).toBeUndefined();
  const firstExecutionId = runtime.observed[0]?.hostExecutionId;
  const firstFacts = runtime.observed[0];
  if (!firstFacts) throw new Error("real Pi facts missing");
  const oldSessionToken = issueApprovalToken(
    firstFacts.action.actionId,
    executionBinding(firstFacts),
  );
  expect(
    await runtime.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
    }),
  ).toMatchObject({ block: true });

  await runtime.session.extensionRunner.emit({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result: {},
    isError: false,
  });
  expect(
    await runtime.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: call.id,
      toolName: call.name,
      input: call.arguments,
    }),
  ).toBeUndefined();

  const runnerBeforeReload = runtime.session.extensionRunner;
  await runtime.session.reload();
  expect(runtime.session.extensionRunner).not.toBe(runnerBeforeReload);
  expect(await emitCall(runtime, call)).toBeUndefined();
  expect(runtime.observed.at(-1)?.userGoal).toEqual({ status: "unknown" });

  await runtime.session.extensionRunner.emit({
    type: "agent_end",
    messages: [],
  });
  await runtime.session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolCallId: call.id,
    toolName: call.name,
    input: call.arguments,
  });
  expect(runtime.observed.at(-1)?.userGoal).toEqual({ status: "unknown" });

  await runtime.session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  expect(
    await runtime.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolCallId: "after-shutdown",
      toolName: "read",
      input: {},
    }),
  ).toMatchObject({ block: true });

  runtime.sessionManager.newSession({ id: "session-two" });
  await runtime.session.extensionRunner.emit({
    type: "session_start",
    reason: "new",
  });
  await setGoal(runtime, "second goal");
  expect(await emitCall(runtime, call)).toBeUndefined();
  const secondSessionFacts = runtime.observed.at(-1);
  expect(secondSessionFacts).toMatchObject({ sessionId: "session-two" });
  expect(secondSessionFacts?.hostExecutionId).not.toBe(firstExecutionId);
  if (!secondSessionFacts) throw new Error("new Pi session facts missing");
  expect(
    consumeApprovalToken(
      oldSessionToken,
      firstFacts.action.actionId,
      executionBinding(secondSessionFacts),
    ),
  ).toBe(false);
});

test("Pi 0.85.1 binds the real cwd so approval cannot cross project sessions", async () => {
  const first = await createRuntime();
  const second = await createRuntime();
  await Promise.all([
    writeFile(join(first.cwd, "same.txt"), "same", "utf8"),
    writeFile(join(second.cwd, "same.txt"), "same", "utf8"),
  ]);
  const call = {
    id: "same-call",
    name: "read",
    arguments: { path: "same.txt" },
  };
  expect(await emitCall(first, call)).toBeUndefined();
  expect(await emitCall(second, call)).toBeUndefined();
  const firstFacts = first.observed[0];
  const secondFacts = second.observed[0];
  if (!firstFacts || !secondFacts) throw new Error("real Pi facts missing");

  expect(firstFacts.cwd).not.toBe(secondFacts.cwd);
  expect(firstFacts.sessionId).toBe(secondFacts.sessionId);
  expect(firstFacts.toolCallId).toBe(secondFacts.toolCallId);
  expect(firstFacts.action.fingerprint).toEqual(secondFacts.action.fingerprint);
  const token = issueApprovalToken(
    firstFacts.action.actionId,
    executionBinding(firstFacts),
  );
  expect(
    consumeApprovalToken(
      token,
      firstFacts.action.actionId,
      executionBinding(secondFacts),
    ),
  ).toBe(false);
});

test("raw tool and goal secrets never enter observable or blocked adapter output", async () => {
  const runtime = await createRuntime();
  const secret = "token=synthetic-adapter-credential";
  await setGoal(runtime, `保存 ${secret}`);
  await writeFile(join(runtime.cwd, "note.txt"), "note", "utf8");
  const results = await emitBatch(runtime, [
    { id: "sibling-read", name: "read", arguments: { path: "note.txt" } },
    {
      id: "secret-call",
      name: "write",
      arguments: { path: "new.txt", content: secret },
    },
  ]);
  const serialized = JSON.stringify(runtime.observed);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("rawInput");
  expect(serialized).not.toContain('"canonical":');
  expect(JSON.stringify(results)).not.toContain(secret);

  const blocked = await runtime.session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolCallId: "secret-call",
    toolName: "write",
    input: { content: secret },
  });
  expect(JSON.stringify(blocked)).not.toContain(secret);
});

test("Pi 0.85.1 TUI Continue is single-shot, Explain is not approval, Stop/Esc fail closed, and resize rerenders", async () => {
  const continueRuntime = await createRuntime();
  const continueUi = installApprovalUi(continueRuntime, [
    { inputs: ["down", "down", "enter", "enter"], widths: [18, 80] },
  ]);
  const continueResult = await emitCall(continueRuntime, {
    id: "continue-write",
    name: "write",
    arguments: { path: "continue.txt", content: "approved" },
  });
  expect(continueResult).toBeUndefined();
  expect(continueUi.doneCalls).toBe(1);
  expect(continueUi.rendered[0]?.every((line) => [...line].length <= 18)).toBe(
    true,
  );

  const explainRuntime = await createRuntime();
  const explainUi = installApprovalUi(explainRuntime, [
    { inputs: ["down", "enter", "down", "enter"] },
  ]);
  expect(
    await emitCall(explainRuntime, {
      id: "explain-write",
      name: "write",
      arguments: { path: "explain.txt", content: "approved after details" },
    }),
  ).toBeUndefined();
  expect(explainUi.doneCalls).toBe(1);
  expect(explainUi.rendered.some((lines) => lines.includes("详情："))).toBe(
    true,
  );
  expect(
    explainUi.rendered.some((lines) =>
      lines.join("").includes("查看详情不会批准修改"),
    ),
  ).toBe(true);

  for (const [id, input] of [
    ["stop-write", "enter"],
    ["escape-write", "esc"],
  ] as const) {
    const runtime = await createRuntime();
    installApprovalUi(runtime, [{ inputs: [input] }]);
    expect(
      await emitCall(runtime, {
        id,
        name: "write",
        arguments: { path: `${id}.txt`, content: "must not run" },
      }),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("没有批准"),
    });
  }
});

test("Pi 0.85.1 TUI runs the complete supported read/write/edit pre-execution chain", async () => {
  const runtime = await createRuntime();
  const ui = installApprovalUi(runtime, [
    { inputs: ["down", "down", "enter"] },
    { inputs: ["down", "down", "enter"] },
  ]);
  await writeFile(join(runtime.cwd, "existing.txt"), "before", "utf8");

  expect(
    await emitCall(runtime, {
      id: "vertical-read",
      name: "read",
      arguments: { path: "existing.txt" },
    }),
  ).toBeUndefined();
  expect(
    await emitCall(runtime, {
      id: "vertical-write",
      name: "write",
      arguments: { path: "created.txt", content: "created" },
    }),
  ).toBeUndefined();
  const editArguments = {
    path: "existing.txt",
    edits: [{ oldText: "before", newText: "after" }],
  };
  expect(
    await emitCall(runtime, {
      id: "vertical-edit",
      name: "edit",
      arguments: editArguments,
    }),
  ).toBeUndefined();

  expect(ui.customCalls).toBe(2);
  expect(ui.statuses).toContainEqual({
    key: "agentglass-read",
    text: "正在查看：existing.txt，不会修改它。",
  });
  expect(runtime.observed.map((facts) => facts.action.kind)).toEqual([
    "read",
    "write",
    "edit",
  ]);
  const edit = runtime.session.getToolDefinition("edit");
  if (!edit) throw new Error("locked edit tool missing");
  await edit.execute(
    "vertical-edit",
    editArguments,
    undefined,
    undefined,
    undefined as never,
  );
  expect(await readFile(join(runtime.cwd, "existing.txt"), "utf8")).toBe(
    "after",
  );
});

test("Pi 0.85.1 abort, missing custom result, UI error, RPC hasUI, and no UI cannot approve", async () => {
  const aborted = await createRuntime();
  const abortUi = installApprovalUi(aborted, [{}]);
  const pending = emitCall(aborted, {
    id: "abort-write",
    name: "write",
    arguments: { path: "abort.txt", content: "must not run" },
  });
  await vi.waitFor(() => expect(abortUi.customCalls).toBe(1), {
    timeout: 30_000,
  });
  await aborted.session.extensionRunner.emit({
    type: "agent_end",
    messages: [],
  });
  await expect(pending).resolves.toMatchObject({ block: true });

  const reloaded = await createRuntime({ bindUI: true });
  const reloadUi = installApprovalUi(reloaded, [{}]);
  const pendingReload = emitCall(reloaded, {
    id: "reload-write",
    name: "write",
    arguments: { path: "reload.txt", content: "must not run" },
  });
  await vi.waitFor(() => expect(reloadUi.customCalls).toBe(1), {
    timeout: 30_000,
  });
  await reloaded.session.reload();
  await expect(pendingReload).resolves.toMatchObject({ block: true });

  for (const fixture of [
    { name: "missing custom result", step: { missingResult: true } },
    { name: "UI error", step: { error: true } },
  ]) {
    const runtime = await createRuntime();
    installApprovalUi(runtime, [fixture.step]);
    expect(
      await emitCall(runtime, {
        id: fixture.name,
        name: "write",
        arguments: { path: `${fixture.name}.txt`, content: "must not run" },
      }),
    ).toMatchObject({ block: true });
  }

  const rpc = await createRuntime();
  const rpcUi = installApprovalUi(
    rpc,
    [{ inputs: ["down", "down", "enter"] }],
    "rpc",
  );
  expect(
    await emitCall(rpc, {
      id: "rpc-write",
      name: "write",
      arguments: { path: "rpc.txt", content: "must not run" },
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("本地审批界面"),
  });
  expect(rpcUi.customCalls).toBe(0);

  for (const mode of ["print", "json"] as const) {
    const conflicting = await createRuntime();
    const conflictingUi = installApprovalUi(
      conflicting,
      [{ inputs: ["down", "down", "enter"] }],
      mode,
    );
    expect(
      await emitCall(conflicting, {
        id: `${mode}-ui-write`,
        name: "write",
        arguments: { path: `${mode}.txt`, content: "must not run" },
      }),
    ).toMatchObject({
      block: true,
      reason: expect.stringContaining("本地审批界面"),
    });
    expect(conflictingUi.customCalls).toBe(0);
  }

  const noUi = await createRuntime();
  expect(
    await emitCall(noUi, {
      id: "print-write",
      name: "write",
      arguments: { path: "print.txt", content: "must not run" },
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("本地审批界面"),
  });
  noUi.session.extensionRunner.setUIContext(undefined, "json");
  expect(
    await emitCall(noUi, {
      id: "json-write",
      name: "write",
      arguments: { path: "json.txt", content: "must not run" },
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("本地审批界面"),
  });
  noUi.session.extensionRunner.setUIContext(undefined, "tui");
  expect(
    await emitCall(noUi, {
      id: "tui-no-ui-write",
      name: "write",
      arguments: { path: "tui.txt", content: "must not run" },
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("本地审批界面"),
  });
});

test("Pi 0.85.1 regenerates the card after input change and executes only the exact current action", async () => {
  const runtime = await createRuntime();
  const call = {
    id: "changed-write",
    name: "write",
    arguments: { path: "changed.txt", content: "first" },
  };
  const ui = installApprovalUi(runtime, [
    {
      onOpen: () => {
        call.arguments.content = "second";
      },
      inputs: ["down", "down", "enter"],
    },
    { inputs: ["down", "down", "enter"] },
  ]);

  expect(await emitCall(runtime, call)).toBeUndefined();
  expect(ui.customCalls).toBe(2);
  expect(runtime.observed).toHaveLength(2);
  expect(runtime.observed[0]?.input.fingerprint.value).not.toBe(
    runtime.observed[1]?.input.fingerprint.value,
  );

  const write = runtime.session.getToolDefinition("write");
  if (!write) throw new Error("locked write tool missing");
  await write.execute(
    call.id,
    call.arguments,
    undefined,
    undefined,
    undefined as never,
  );
  expect(await readFile(join(runtime.cwd, "changed.txt"), "utf8")).toBe(
    "second",
  );
});

test("Pi 0.85.1 invalidates a saved pre-image after target drift and requires a fresh card", async () => {
  const runtime = await createRuntime();
  const targetPath = join(runtime.cwd, "drift.txt");
  await writeFile(targetPath, "before", "utf8");
  const ui = installApprovalUi(runtime, [
    {
      onOpen: () => writeFile(targetPath, "concurrent change", "utf8"),
      inputs: ["down", "down", "enter"],
    },
    { inputs: ["down", "down", "enter"] },
  ]);

  expect(
    await emitCall(runtime, {
      id: "drift-write",
      name: "write",
      arguments: { path: "drift.txt", content: "planned" },
    }),
  ).toBeUndefined();
  expect(ui.customCalls).toBe(2);
  expect(runtime.observed).toHaveLength(2);
  expect(runtime.observed[0]?.preImage.snapshotId).not.toBe(
    runtime.observed[1]?.preImage.snapshotId,
  );
});

test("Pi 0.85.1 exposes every required binding dimension and each changed value invalidates approval", async () => {
  const runtime = await createRuntime();
  await writeFile(join(runtime.cwd, "binding.txt"), "binding", "utf8");
  expect(
    await emitCall(runtime, {
      id: "binding-read",
      name: "read",
      arguments: { path: "binding.txt" },
    }),
  ).toBeUndefined();
  const facts = runtime.observed[0];
  if (!facts) throw new Error("real Pi facts missing");
  const approved = executionBinding(facts);
  const changes: Partial<ExecutionBinding>[] = [
    { fingerprint: { ...approved.fingerprint, value: "f".repeat(64) } },
    { toolName: "edit" },
    { cwd: join(runtime.cwd, "other") },
    { sessionId: "session-two" },
    { hostExecutionId: "different-execution" },
    { toolCallId: "different-call" },
  ];

  expect(approved).toMatchObject({
    toolName: "read",
    cwd: runtime.cwd,
    sessionId: "session-one",
    hostExecutionId: expect.stringMatching(/^[a-f\d]{64}$/),
  });
  for (const change of changes) {
    const token = issueApprovalToken(facts.action.actionId, approved);
    expect(
      consumeApprovalToken(token, facts.action.actionId, {
        ...approved,
        ...change,
      }),
    ).toBe(false);
  }
});

test("Pi 0.85.1 keeps snapshot downgrade explicit while allowing a fresh TUI approval", async () => {
  const runtime = await createRuntime({ snapshotUnavailable: true });
  const ui = installApprovalUi(runtime, [
    { inputs: ["down", "down", "enter"] },
  ]);

  expect(
    await emitCall(runtime, {
      id: "degraded-write",
      name: "write",
      arguments: { path: "degraded.txt", content: "approved" },
    }),
  ).toBeUndefined();
  expect(runtime.observed[0]?.preImage).toMatchObject({
    status: "unavailable",
    canRestoreNow: false,
    recoveryGrade: "unknown",
  });
  const copy = ui.rendered.flat().join("\n");
  expect(copy).toContain("未能保存修改前证据");
  expect(copy).toContain("当前不能自动恢复");
  expect(copy).not.toMatch(/可以恢复|可撤销|Undo|回滚/u);
});
