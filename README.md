# Runtime Self-Learning Harness 6.2.2

这是独立目录中的 6.2 DeepSeek Harness 插件版。它通过 MCP stdio server 把长期记忆工具接入 Harness，内置自己的记忆核心和默认数据目录，不依赖其他宿主或 `6.2/` 目录。

## 官方 Harness 插件安装

这是可由 DeepSeek Harness 官方插件管理器识别的 DSH bundle，包含 `dsh.bundle` 和 `cordis.patch.yml`。

```powershell
dsh plugin --profile web add github:326sun/runtime-self-learning-harness
```

安装后重启对应 profile。插件会原生注册 `memory_search`、`memory_list`、`memory_get` 等长期记忆工具；默认数据目录为 `<HARNESS_HOME>/self-learning-harness/`。

## MCP 兼容安装

在本目录执行：

```powershell
npm install
```

要求 Node.js 22 或更高版本。

## Harness 配置

把下面的配置加入 DeepSeek Harness 对应 Agent 的 Cordis 配置；`cwd` 指向本目录。默认数据目录是 `<HARNESS_HOME>/self-learning-harness/`；只有明确设置 `HARNESS_DATA_DIR` 时才会使用其他数据目录。

```yaml
- id: mcp-harness-memory
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: harness-memory
    transport: stdio
    command: node
    args: ['server.js']
    cwd: 'D:/openharness/自学习/6.2harness'
    env:
      HARNESS_DATA_DIR: 'C:/Users/<你的用户名>/.harness/self-learning-harness'
      HARNESS_PROJECT: 'your-project'
    failOnStartupError: true
```

启动后，Harness 会注册名称类似 `mcp__harness-memory__memory_search` 的工具。默认使用 general 作用域；设置 `HARNESS_PROJECT` 后，项目记忆会按项目隔离。

## 工具

提供 `memory_search`、`memory_list`、`memory_get`、`memory_history`、`memory_provenance`、`memory_episodes`、`memory_upsert`、`memory_delete`、`memory_approve`、`memory_export`、`memory_preview_import` 和 `memory_import`。

写入、删除、批准和导入都是显式工具调用；删除仍是逻辑隐藏，保留原始日志和历史备份。Episode 只保存受限任务/工具摘要和 opaque session hash，不保存原始对话正文。

## 验证

```powershell
npm test
```

这个插件已在本地 MCP server 层做工具注册、作用域和记忆读写测试；完整的 DeepSeek Harness 启动验证需要安装 Harness 并在其 Agent scope 中启用 MCP client。它内置 `core/`，复制或发布整个目录即可独立运行。
