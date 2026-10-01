# Lachesis 运行时契约

状态：2026-09-24 实机记录。施工包 M0 的运行时选择和复现依据在此冻结；模型可用性以每次运行时的 OCG 路由状态为准。

## 固定版本与组合

- `@deepseek-ai/dsh`、`@deepseek-ai/dsh-subprocess`、`@deepseek-ai/dsh-subprocess-local` 与相关 dsh 包固定为 `0.1.7-alpha.2`，见 `pnpm-lock.yaml`。
- `@agentclientprotocol/sdk` 为 `1.4.0`；Lachesis 使用 dsh 的 `acp` profile，通过 stdio JSON-RPC 连接。Web 服务使用单独的 `lachesis` profile 和 `@deepseek-ai/dsh-host-webserver`。
- ACP profile 的 base 组合包含 `llm-pi-ai`、凭据、会话和工具插件。定制供应商写在服务数据目录 `dsh/cordis.patch.yml`；每次 Run 把这份补丁复制到独立 `run-homes/<runId>`，不复用 dsh 会话目录。
- Profile 行为快照是 `providerRef`、`modelId`、可选 `reasoningEffort`。运行前通过 ACP `session/set_config_option` 明确选择 `model`（值为 JSON 数组 `[provider, model]`）和 `reasoning_effort`，并核对返回的当前值；配置不被支持时不能静默换路由。
- Profile 表单的「检查可用强度」在独立临时目录建立无 prompt ACP 会话，读取该模型当前给出的 `reasoning_effort` 选项，确认进程范围退出后清理；没有选项时使用供应商默认。实际 Run 在发出 prompt 前仍重复核对行为配置。

## Run 生命周期

每张被领取的工单建立独立工作区、`DSH_HOME`、ACP 进程范围和会话。事件从 ACP 通知写入持久事件表，客户端断线后仍能按游标补读。一次 prompt 结束只表示执行结束；Lachesis 在确认进程范围已退出后冻结交付，交付仍需操作者验收、准备集成与显式应用。取消通过 ACP `session/cancel` 和进程范围关闭处理，不使用全局 dsh 会话取消。Windows 启动前探测原生 Job 支持，并使用固定版本的文件和受限 Shell 后端实际验证隔离工作目录。缺少能力时阻止派发，检查不请求模型。

2026-09-25 修订：进程范围退出无法确认时，工单持久保持「待恢复」，跨服务重启也不解除。当前公共 SubprocessHandle 没有可持久化的范围身份，Windows Job 无名称，旧原生句柄无法重开；kill-on-close 的预期行为不能替代某次 Run 的实际退出证明。仅有确切退出事件的未完成 Run 才能冻结检查点并显式接续。实现没有根据 PID 消失或操作者勾选来伪造退出确认。

预检通过时生成绑定工作目录、dsh Home、配置元数据、运行时版本和当前进程身份的短期一次性凭据，正式启动消费它；配置变化或跨工作区均重新检查。预检只加载固定的沙箱、文件和命令执行后端，不加载模型或凭据插件；自定义 profile 对工具实现的覆盖不在这个检查的证明范围内。检查只允许新建的服务私有工作目录，不能用于给用户目标或全局目录补权限。

本次在受限 Windows 身份下使用真实后端、无模型的检查稳定返回 `sandbox_write_grant_failed`，命中 `SetNamedSecurityInfoW failed (Win32 5)`；兼容环境成功路径有确定性测试，尚未获得普通用户启动环境的原生成功证据。未修改全局 ACL，也未以关闭沙箱方式继续执行。

敏感环境变量由 dsh subprocess 默认从父进程环境中清除。给自定义 OCG 路由提供的 `OCG_GATEWAY_KEY` 必须明确传给 ACP 子进程；不得写入 Profile、工单、日志或文档。dsh 工具子进程仍按其自己的环境清理规则处理凭据。
ACP 文本流可能把同一凭据拆在多个事件里，持久事件因此只保留文本更新的类型等元数据；完整回复在形成交付摘要前整体脱敏。

## 本机 OCG 配置示例

仅在本机 OCG 已启用相应模型协议时使用。将下面内容放入服务数据目录 `dsh/cordis.patch.yml`；端口按 OCG 当前监听值修改。Key 通过启动 Lachesis 进程时的 `OCG_GATEWAY_KEY` 环境变量提供，配置文件只保留引用。

```yaml
- id: llm-pi-ai
  config:
    providers:
      local-ocg:
        displayName: Local OCG
        apiKeyEnv: OCG_GATEWAY_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:19042/v1
        models:
          - id: minimax-m3
            contextWindow: 200000
          - id: step-5-preview
            contextWindow: 200000
          - id: step-3.7-flash
            contextWindow: 200000
          - id: mimo-v2.6-flash
            contextWindow: 200000
```

模型容量值必须由当前供应商目录或用户配置确认；示例值只用于本次隔离调试，不能当作产品默认值。

## 复现与结果

本地确定性契约：`pnpm --filter @lachesis/runtime test` 覆盖模型选项确认、两个 Run 的目录与会话隔离、ACP 事件、权限答复、局部取消和退出范围。`pnpm check` 与 `pnpm build` 检查接口及产物。`dsh --profile acp --help` 只证明 CLI 可启动，不算模型调用。

2026-09-24，本机 OCG 开发实例监听 `127.0.0.1:19042`。用隔离 `DSH_HOME`、上述 `local-ocg` 路由和不含文件操作的短 prompt 调用：

| 模型 | OCG `/v1/models` 与路由解释 | ACP 实测 |
|---|---|---|
| `minimax-m3` | 在目录中；有三条可用候选 | 成功，`end_turn`，收到文本事件，关闭后 `rangeExited=true` |
| `step-3.7-flash` | 在目录中 | 成功，`end_turn`，收到文本事件，关闭后 `rangeExited=true` |
| `step-5-preview` | 不在目录；候选均为 `mapping_protocol_incompatible` | ACP 会话可建，prompt 报 `Connection error`，无交付 |
| `mimo-v2.6-flash` | 不在目录；候选均为 `mapping_protocol_incompatible` | ACP 会话可建，prompt 报 `Connection error`，无交付 |

`minimax-m3` 与 `step-3.7-flash` 构成两套当前用户可用的真实模型配置。向 `local-ocg/minimax-m3` 显式设置 `high` 思考强度时，dsh 在 prompt 前返回 `unknown reasoning effort`，未静默使用默认值。当前两套配置均未提供可选思考强度，因此实机成功路径使用供应商默认值；支持值的选择和生效由确定性 ACP 测试覆盖。

这份记录仅证明当时的本机路由状态；原先点名的后两者需要在 OCG 侧启用可用协议并重测，不能把 ACP 会话建立当成模型成功。OCG 的协议配置是其独立持久设置。

## 待验证边界

M0 的两套可用配置已有真实短请求；同 Profile 两个 `minimax-m3` ACP 实例的实机并发也已验证：不同会话和目录，取消 A 的流式请求后 B 正常 `end_turn`，两个进程范围均退出且工作目录未交叉写入。M3 已有有界超时、服务独占、确定性并发测试和 Windows 原生 Job 崩溃实测；公共 subprocess API 仍不提供跨重启逐个查询旧 Run 范围的身份，重启中断标记不能当作该证明。每次升级 dsh 版本须重复 ACP 配置、事件、取消、范围退出与交付隔离测试。
