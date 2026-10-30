# Runtime Self-Learning Harness 6.2.8

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
- **有证据的技能演化**：项目、任务、根因与修复策略共同确定候选身份；只有执行前开启试验、真实调用匹配本地验证契约、独立检查返回指定断言结果时，才积累成功或回归证据。
- **可审计记忆**：支持时态事实、supersession、episode provenance、core/archive 分层、逻辑删除、导出、预览导入和逐条批准。

## 安装

本项目遵循官方 DSH bundle 格式：根目录 `package.json` 声明 `dsh.bundle.patch`，由 `cordis.patch.yml` 完成 Cordis 注入；包内没有名为 `dsh.bundle` 的独立文件。

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
├── skill_verification_contracts.json    # 维护者配置；默认不创建
├── skill_verification_receipts.jsonl   # 校验后生成的证据凭据
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
| `learning_skill_feedback` | 以 `begin` 开启候选试验，以 `complete` 校验同一回合内的执行结果；成功/回归由本地验证契约判定 |
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
- 已激活技能在达到验证证据门槛后默认参与 `agent/pre-step`，按当前项目过滤后再应用数量与 Token 预算。
- “技能已展示”“策略调用已完成”“检查结果已验证”分别处理。普通工具成功、技能被注入和调用者自行提交的 `verified: true` 都不会推动晋升。
- `learning_skill_feedback` 需要维护者先在数据目录配置候选专用验证契约；插件对照真实 session 事件核验工具参数、执行顺序、项目和 JSON 断言，并生成可追溯凭据。配置方法见 [技能验证](docs/SKILL-VERIFICATION.md)。
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
npm run check:package
```

测试覆盖记忆读写、原生工具注册、实际 DSH 消息工厂生成的工具结果、自动注入、跨项目与跨策略聚类隔离、验证契约、候选晋升与回归、Session 关联、伪造/重复反馈拒绝、旧证据隔离，以及默认配置下的 active skill 注入。

[GitHub Actions](https://github.com/326sun/runtime-self-learning-harness/actions/workflows/ci.yml) 在 Windows 与 Linux 的 Node.js 24 环境运行测试、生产依赖审计和包内容检查。自动化测试不等于真实宿主端到端验收。

从 v6.2.7 升级时，旧候选和宽松成功计数会备份到 `skill_candidates.pre-evidence-v2.json` 并退出激活注册表；原始 Reflexion 按项目重新生成候选，从零积累新版验证证据。记忆数据不受此候选迁移影响。

生产宿主仍应使用实际 profile 做一次安装、真实多轮对话、项目切换、导入预览和技能晋级验收。

## 许可

MIT License。
