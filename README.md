# Runtime Self-Learning Harness 6.2.6

一个独立的 DeepSeek Harness 原生 DSH bundle：让 Agent 在本地观察任务过程、沉淀可追溯记忆、按项目范围检索，并在下一步模型调用前自动注入经过治理的经验。

它自带记忆核心和数据目录，不引用其他产品源码，也不依赖另一个宿主插件。MCP stdio 入口仍保留，用于兼容没有原生 bundle 管理器的环境。

## 解决的问题

普通长期记忆通常只保存文本，缺少来源、作用域和修订边界。这个插件把运行时经验拆成四条可检查的链：

```text
Harness session/event
        ↓
受限 episode 与任务经验
        ↓
模式识别、事实修订、项目隔离
        ↓
下一步模型调用前的作用域记忆注入
        ↓
失败反馈与重复模式 → 技能候选 → 审核后激活
```

- **自动观察与学习**：订阅 DSH 的 `session/event`，记录用户消息、工具调用、工具结果和助手回合；Episode 只保存任务/工具摘要与 opaque session hash，不保存原始对话正文。
- **自动记忆注入**：通过 DSH 的 `agent/pre-step` 在当前步骤组装作用域记忆；只注入可用、已治理且与当前项目匹配的条目。
- **技能演化闭环**：重复失败和反馈先生成候选，按成功次数、回归次数和风险门槛进入 staged/active 状态；生成的技能文件写入数据目录，不覆盖安装包。
- **可审计记忆**：支持时态事实、supersession、episode provenance、core/archive 分层、逻辑删除、导出、预览导入和逐条批准。

## 官方安装

这是官方 DSH bundle：根目录 `package.json` 声明 `dsh.bundle.patch`，由 `cordis.patch.yml` 完成 Cordis 注入；包内没有名为 `dsh.bundle` 的独立文件。

```powershell
dsh plugin --profile web add github:326sun/runtime-self-learning-harness
```

安装后重启对应 profile。原生 bundle 会注册 18 个工具，并自动连接 DSH 的 session 与 agent 生命周期。

默认数据目录：

```text
<HARNESS_HOME>/self-learning-harness/
├── patterns.json
├── episodes.jsonl
├── experience_log.jsonl
├── activity_log.jsonl
├── skill_candidates.json
├── active_skills.json
└── generated/skills/self-learning/SKILL.md
```

## 工具

### 记忆工具

`memory_search`、`memory_list`、`memory_get`、`memory_history`、`memory_provenance`、`memory_episodes`、`memory_upsert`、`memory_delete`、`memory_approve`、`memory_export`、`memory_preview_import`、`memory_import`。

写入、删除、批准和导入都是显式操作。导入必须先预览，再使用同一数据版本的 `previewId`；导入项先进入待审核队列，事实替代需要单独批准。

### 自学习工具

| 工具 | 用途 |
| --- | --- |
| `learning_status` | 查看观察回合、注入次数、模式数量和技能数量 |
| `learning_observe` | 手动提交一个受限回合，用于诊断或离线回放；正常 Harness 回合会自动观察 |
| `learning_inject` | 预览某个查询和项目将获得的记忆注入 |
| `learning_skill_evolve` | 运行技能候选晋级循环；默认不直接写安装目录 |
| `learning_skill_feedback` | 提交带独立验证的候选成功/回归反馈 |
| `learning_skill_render` | 将当前模式和已激活技能渲染到数据目录 |

自动链路由原生 DSH 事件驱动：

- `session/event` → 观察用户消息、工具调用/结果和助手消息；
- `agent/pre-step` → 注入当前作用域的可用记忆；
- `agent/created` → 为新 Agent 准备初始记忆上下文。

## 记忆与治理

- `core` 记忆可在预算范围内参与自动注入，`archive` 记忆通过显式检索使用。
- 项目范围从 Harness session 的工作目录推导；项目记忆不会泄露到其他项目。
- 本地检索组合 CJK BM25、RRF、实体/别名/关系和字符 n-gram，不依赖云端向量数据库。
- 事实保留 `validFrom`、`validTo`、`learnedAt` 与替代关系，不静默覆盖历史。
- 删除是逻辑隐藏；旧日志和已有外部备份不会被承诺安全擦除。
- 技能文件生成到 `<dataDir>/generated/`，候选晋级受成功次数、回归次数和治理门槛限制。
- 已激活技能会在通过成功/回归证据门槛后进入 `agent/pre-step`；没有候选 ID、策略应用标记和 `verification.verified=true` 的普通工具成功不会计入技能证据。
- Harness 版本默认关闭自动动作执行，只进行观察、检索、注入和受治理的技能反馈。
- 默认不调用外部模型，不上传原始对话，不执行自动代码补丁。

## MCP 兼容入口

没有原生 bundle 管理器时，可以使用独立 stdio server：

```powershell
npm install
node server.js
```

MCP 入口提供记忆工具；自动观察、自动注入和技能演化需要原生 DSH bundle 的事件与 agent 契约。

## 开发与验证

要求 Node.js 24.9+。本地验证：

```powershell
npm install
npm test
npm audit --omit=dev
```

测试覆盖：记忆读写、统一检索门控、作用域、原生 18 工具注册、DSH session/turn/agent 事件观察、工具调用配对、自动注入、重复失败聚类、成功/回归反馈、宿主 dataDir 隔离和技能演化 dry-run。

生产宿主仍应使用实际 profile 做一次安装、真实多轮对话、项目切换、导入预览和技能晋级验收。

## 许可

MIT License。
