# AgentGlass

[简体中文](./README.zh-CN.md)

**A beginner-first file approval extension for the [Pi Agent](https://github.com/earendil-works/pi).**

AgentGlass is for beginners who are not familiar with shell commands, Git diffs, or file risks. It explains the file result Pi is about to produce in plain language, so the user can confirm it before the file actually changes.

> **0.8.0 candidate · Windows only · Not published**

## Why AgentGlass?

An AI assistant may propose a technically valid file operation without making its practical impact clear to a beginner. AgentGlass keeps these questions visible:

> **Which file will change, what will it become, and can it be recovered if something goes wrong?**

The user approves the expected outcome and impact—not a command, a tool name, or hidden model reasoning.

## What a beginner sees

1. Ask Pi to read, create, or edit an ordinary project file.
2. For a change, AgentGlass shows an outcome card with the target file, expected result, risks, and recovery information.
3. The card starts on **Stop**. Reading details does not approve anything.
4. The user chooses **Continue** only when the expected result is clear.
5. AgentGlass checks the approved action again before using the one-time approval.
6. After execution, it checks only the files named in the card.

Ordinary reads do not require an approval card after the required safety checks pass.

## Features

- **Beginner-friendly explanations**: focus on file results and impact instead of shell syntax or hidden reasoning.
- **Safe defaults**: unknown, unsupported, sensitive, linked, and out-of-scope targets are blocked.
- **Small supported surface**: verified Pi built-in `read`, `write`, and `edit` actions.
- **Separate recovery approval**: `/agentglass restore` requires its own approval and only uses evidence-backed recovery capability.
- **Separate cleanup approval**: `/agentglass cleanup` handles validated private AgentGlass data and cannot delete project files.
- **Safe example**: `/agentglass example` provides a fixed, no-secret file workflow.

## Requirements

The current candidate has been verified on:

- Windows x64
- Node.js `>=22.19.0`
- Pi `>=0.84.3`

macOS and Linux are not supported by this version.

Pi must be installed first and started in an interactive terminal.

Pi `0.85.0` also requires the matching `@earendil-works/pi-server@0.85.0` package because that Pi package does not declare the dependency itself. This is an upstream prerequisite, not an AgentGlass runtime dependency.

## Install

The npm package is not published yet. Install the real tarball in an isolated directory, then install its package directory in Pi:

```powershell
npm install C:\path\to\ddt-agentglass-0.8.0.tgz `
  --prefix .\agentglass-install --omit=dev --no-save
pi install .\agentglass-install\node_modules\@ddt\agentglass
```

Start Pi in the project you want to protect:

```powershell
pi
```

Then run:

```text
/agentglass help
/agentglass example
```

Pi treats a local `.tgz` path as a single extension rather than as this package's manifest. Use the installed package directory shown above.

## Unsupported operations

AgentGlass does not approve or run shell commands, dependency installation, project startup, deployment, bulk deletion, process management, or unknown/custom/overridden tools. It does not claim OS-level sandboxing or protection from a malicious co-resident Pi extension.

If a task is blocked, ask Pi to make the request smaller or file-oriented. Do not disable AgentGlass as a way to continue a blocked task.

## Recovery and private data

When complete evidence exists, the current session may offer a separately approved restore for the most recent supported single-file change. A conflict preserves later file contents.

On Windows, private recovery copies are stored under:

```text
%PI_CODING_AGENT_DIR%\.agentglass\snapshots
```

These copies may contain original file bytes required for recovery and are not guaranteed to be secret-free. Uninstalling does not silently delete them or project files. Reinstalling does not restore old approval authorization.

## Disable or uninstall

```text
pi config
pi list
pi remove <installed-source>
```

Disabling removes AgentGlass protection from later Pi calls; it is not a bypass for a blocked action. Removing the package source is separate from approving cleanup of private recovery data.

## License

[MIT](./LICENSE)
