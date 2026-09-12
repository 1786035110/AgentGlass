# AgentGlass

[English](./README.md)

**一个面向新手的 [Pi  Agent](https://github.com/earendil-works/pi) 文件变更审批扩展。**

AgentGlass 面向不熟悉 shell 命令、Git diff 和文件风险的新手用户。它用易懂的语言说明 Pi 准备带来的文件结果，让用户在文件真正变化前确认这个结果。

> **0.8.0 候选版本 · 仅支持 Windows · 尚未发布**

## 为什么需要 AgentGlass？

AI 助手可能提出技术上有效的文件操作，却没有让新手看清实际影响。AgentGlass 始终把这几个问题放在前面：

> **哪个文件会变化、会变成什么、出了问题能否恢复？**

用户批准的是预期结果和影响，而不是命令、工具名称或模型的隐藏推理。

## 新手实际看到的流程

1. 让 Pi 查看、创建或修改普通项目文件。
2. 对于变更，AgentGlass 显示结果卡片：目标文件、预期结果、风险和恢复信息。
3. 卡片初始焦点是**停止**，查看详情不会产生批准。
4. 只有确认预期结果清楚后，用户才选择**继续**。
5. AgentGlass 在使用一次性批准前再次检查已批准的操作。
6. 执行后只核对卡片明确列出的文件。

普通读取在必要安全检查全部通过后，不需要审批卡片。

## 功能

- **面向新手的说明**：重点说明文件结果和影响，不要求用户理解 shell 语法或隐藏推理。
- **安全默认值**：未知、不支持、敏感、链接和范围外的目标会被阻止。
- **小范围支持**：仅支持已验证的 Pi 内置 `read`、`write` 和 `edit`。
- **恢复独立批准**：`/agentglass restore` 需要单独批准，并且只使用有证据支持的恢复能力。
- **清理独立批准**：`/agentglass cleanup` 只处理已验证的 AgentGlass 私有数据，不能删除项目文件。
- **安全示例**：`/agentglass example` 提供固定的无秘密文件流程。

## 环境要求

当前已验证环境：

- Windows x64
- Node.js `>=22.19.0`
- Pi `>=0.84.3`

当前版本不支持 macOS 和 Linux。

Pi 需要先安装，并在可交互终端中启动。

Pi `0.85.0` 还需要安装匹配版本的 `@earendil-works/pi-server@0.85.0`，因为该 Pi 包自身没有声明这个依赖。这是上游前置条件，不是 AgentGlass 的运行时依赖。

## 安装

npm 包尚未发布。先在隔离目录中安装真实 tarball，再把安装目录交给 Pi：

```powershell
npm install C:\path\to\ddt-agentglass-0.8.0.tgz `
  --prefix .\agentglass-install --omit=dev --no-save
pi install .\agentglass-install\node_modules\@ddt\agentglass
```

在需要保护的项目目录中启动 Pi：

```powershell
pi
```

然后输入：

```text
/agentglass help
/agentglass example
```

Pi 会把本地 `.tgz` 路径当作单个扩展，而不是按本包 manifest 安装；请使用上面的已安装包目录。

## 不支持的操作

AgentGlass 不批准或执行 shell 命令、依赖安装、项目启动、部署、批量删除、进程管理，以及未知/自定义/覆盖后的工具。它不宣称提供操作系统级沙箱，也不保证能防止恶意共存 Pi 扩展修改工具输入。

如果任务被阻止，应让 Pi 缩小请求或改成文件操作；不要通过禁用 AgentGlass 继续被阻止的任务。

## 恢复与私有数据

当执行后的证据完整时，当前会话可以为最近一次受支持的单文件变更提供单独批准的恢复。发生冲突时保留后续文件内容。

Windows 私有恢复副本位于：

```text
%PI_CODING_AGENT_DIR%\.agentglass\snapshots
```

这些副本可能包含恢复所需的原始文件字节，不能保证“无秘密”。卸载不会静默删除它们或项目文件，重新安装也不会恢复旧的审批授权。

## 禁用或卸载

```text
pi config
pi list
pi remove <已安装来源>
```

禁用后，AgentGlass 不再保护后续 Pi 调用；这不是绕过阻止的方式。移除包来源与批准清理私有恢复数据是两件独立的事。

## 许可证

[MIT](./LICENSE)
