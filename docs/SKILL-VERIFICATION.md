# 技能验证与晋升

工具没有报错，只能证明工具完成；技能被注入，只能证明它被展示。v6.2.8 将技能晋升证据限定为执行前声明的候选试验，并将验收条件交给本地维护者配置。

## 配置一个候选的验收条件

用 `learning_skill_evolve` 的 `options.dryRun=true` 查看当前候选 ID、完整 `rule` 和 `scope.project`。维护者在插件数据目录创建 `skill_verification_contracts.json`：

```json
{
  "schemaVersion": 1,
  "contracts": [
    {
      "candidateId": "<当前候选完整 ID>",
      "project": "alpha",
      "rule": "<当前候选完整 rule>",
      "strategy": {
        "tool": "shell_exec",
        "arguments": { "command": "repair-permission --project alpha" }
      },
      "verification": {
        "tool": "shell_exec",
        "arguments": { "command": "run-independent-repair-test --json" },
        "resultPath": ["checks", "permission"],
        "successValue": true,
        "regressionValue": false
      }
    }
  ]
}
```

命令与工具名仅为结构示例，应替换成当前宿主实际注册的工具和项目已有的策略、测试命令。`strategy.tool` 必须等于候选的 `actionType`；参数对象须完整匹配，包括工作目录等执行边界。不要将打印固定结果的命令当作验证器。应由独立测试检查候选策略所针对的结果。

示例验证器必须输出纯 JSON，例如 `{"checks":{"permission":true}}`。插件按 `resultPath` 读取值并进行严格类型比较；缺字段、无法解析、值未匹配、工具错误均不产生晋升证据。验证可以使用与策略相同的执行工具，但必须是策略完成之后的另一次调用，且工具参数必须不同。记忆工具与学习工具不能充当验证器。

本文件属于本地维护者的验收配置，不通过学习工具自动创建。没有配置时，观察、记忆与候选生成正常运行，技能不会因为普通成功回合自动晋升。数据目录及验证器应由可信维护者管理；文件摘要用于追踪，无法防止拥有文件写权限的主体同时修改证据与凭据。

## 运行一次试验

在同一 Harness session 的同一回合中依次进行：

1. 调用 `learning_skill_feedback`，参数为 `{"phase":"begin","candidateId":"<ID>"}`。返回的 `trialId` 关联本次候选、项目、策略与验证契约；状态为 `shown`。已激活候选还必须已在该 session 中被注入。
2. Agent 显式采用该策略，通过宿主工具执行返回的完整策略参数。插件本身不执行命令。
3. 策略调用完成后，执行契约指定的独立检查。Harness 必须记录可配对的工具调用与原生工具结果。
4. 调用 `learning_skill_feedback`，参数为 `{"phase":"complete","candidateId":"<ID>","trialId":"<返回值>"}`。插件核验原生事件，再根据契约计算 `success` 或 `regression`；调用者不能提交成功布尔值代替检查。

试验开始之前的调用、其他 session 的调用、其他项目的结果、已消费的试验和回合结束后补交的反馈均不计数。验证契约中途修改会使本次试验失效。回合结束会丢弃未完成试验，不推断结果。

## 证据与边界

通过核验后，插件向 `action_feedback.jsonl` 写入候选 ID、项目、Session ID、策略/验证调用 ID、参数及结果摘要，并向 `skill_verification_receipts.jsonl` 写入匹配凭据。晋升循环同时核对凭据，旧版自报 `verified=true` 和无凭据记录均不被采纳；同一 `trialId` 只计数一次。

候选默认先达到 5 次可信成功进入 staged，再达到 7 次进入 active；出现已验证回归会降级并移出激活注册表。候选、策略与项目均独立计数。日志中的展示不等于应用，应用不等于验证；成功计数只来自完成验证的试验。

该机制证明执行记录满足维护者选定的验收条件，不证明任意技能在所有任务中都有因果收益。验收覆盖面取决于验证器本身。仓库自动化测试使用模拟事件与实际 DSH 消息工厂，真实宿主安装、多轮交互和项目切换仍需单独验收。
