import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createReadToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "vitest";
import { registerPiAdapter } from "../../src/adapter/pi/adapter.js";
import type { HostExecutionFacts } from "../../src/core/domain.js";

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

async function createRuntime(options?: { overriddenRead?: boolean }) {
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
        factory: (pi) =>
          registerPiAdapter(
            pi,
            (facts) => {
              observed.push(facts);
            },
            join(cwd, ".agentglass", "snapshots"),
          ),
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
  await session.bindExtensions({ mode: "print" });
  return { cwd, observed, session, sessionManager };
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

test("Pi 0.85.1 verified read/write/edit identities use their locked schemas", async () => {
  const runtime = await createRuntime();
  await writeFile(join(runtime.cwd, "existing.txt"), "before", "utf8");
  await setGoal(runtime, "classify built-in file tools");
  const schemas = Object.fromEntries(
    runtime.session
      .getAllTools()
      .filter((tool) => ["read", "write", "edit"].includes(tool.name))
      .map((tool) => [tool.name, tool.parameters]),
  );
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
  const runtime = await createRuntime();
  await setGoal(runtime, "first goal");
  await writeFile(join(runtime.cwd, "note.txt"), "note", "utf8");
  const call = { id: "reused", name: "read", arguments: { path: "note.txt" } };
  expect(await emitCall(runtime, call)).toBeUndefined();
  const firstExecutionId = runtime.observed[0]?.hostExecutionId;
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
  expect(runtime.observed.at(-1)).toMatchObject({ sessionId: "session-two" });
  expect(runtime.observed.at(-1)?.hostExecutionId).not.toBe(firstExecutionId);
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
