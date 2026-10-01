# 无人值守执行与同类产品：2026-10-01 讨论记录

状态：研究记录，2026-10-01。不是施工决定，也没有改产品代码。外部仓库的 `pushed_at`、星标和许可证来自当日 `gh api`；文档页用当时打开的原文。文中单独标出「推测」的句子没有打开对应源码或官方页。

讨论分三段：同类产品怎样做无人值守；Lachesis 还有没有必要继续做；本仓库执行链上，第二套 harness 或无人值守会先断在哪里。最后一节是当日在本机补跑的无模型沙箱预检。

## Lachesis 已经定下的边界

Lachesis 是本机工单与交付工作台，Windows 优先。外部主代理或操作者提交工单，调度器并行跑编码代理。一个 Run 使用隔离工作区；结果冻结为交付；人验收之后做三方合并和项目验证；只有显式 apply 才写目标。Git 仓库和普通目录都支持。Profile 不存凭据。全局并发默认 4。崩溃进程树用 Windows Job 回收。数据在 `.lachesis/`。

当前执行器只有 DeepSeek Harness（dsh `0.1.7-alpha.2`），经 ACP stdio JSON-RPC 连接。ACP SDK 为 `@agentclientprotocol/sdk` `1.4.0`。计划中的 harness 包括 Claude Code、Codex、Gemini CLI、OpenCode 等，代码里还没有第二套适配器。

工人自报完成最多到「待验收」。工作区隔离不等于操作系统沙箱。这些不变量也写在施工包和 `README.md`、`docs/runtime-contract.md`、`packages/workspace/README.md` 里。

## 本仓库现在怎样处理四件事

### 权限

`PermissionMode` 只有 `defer`、`allow-once`、`reject-once`（`packages/runtime/src/types.ts`）。正式工单在 `apps/server/src/supervisor.ts` 里以 `defer` 启动。Profile 能力探测用 `reject-once`，而且那次会话不发 prompt。调度器没有把 `allow-once` 用于工单。没有 allow-always，没有分类器，也没有按工具名写的策略。

`defer` 发出权限事件，并落成领域问题，题面固定为 “Allow this dsh tool action?”。选项只保存 `optionId`。`apps/web/src/components/QuestionCard.tsx` 的下拉框显示这些原始 id。`answerQuestion` 要求选中的 id 属于当次提供的集合，然后 `handle.answerPermission`。取消或关闭会把未决等待标成 cancelled，迟到答复不能再授权一次写入。

`allow-once` / `reject-once` 按选项 `kind`（`allow_once` / `reject_once`）或固定 optionId 选择；找不到就取消。单次 prompt 默认 30 分钟，等候权限的时间算在里面。

ACP 请求里适配器只保留 `toolCallId` 和选项的 `optionId`、`name`、`kind`（`packages/runtime/src/run.ts` 的 `onPermission`）。工具标题、种类和原始参数在事件发出前就丢掉了。持久事件保留选项的 name 和 kind；界面问题连 name 都不显示。ACP 文本块只留元数据，因为同一凭据可能拆在多个 chunk 里；交付摘要在落盘前整体脱敏。

### 隔离

工作区包拥有 Git detached worktree，或普通目录的 `baseline/` + `work/` 快照。交付 blob 按内容寻址。冻结时丢掉 `.env`、`credentials.json`、密钥、`.dsh/` 和 gitignore 覆盖的文件。

运行前预检（`packages/runtime/src/readiness.ts`）加载 dsh 的 `LocalSubprocessRuntime`、`SandboxPolicyService`（`workspace-write`）、`LocalSandboxProvider`、`SandboxedFileSystem`，Windows 上再加 `SandboxPwshExecutor`。探针做写、读和受限命令。启动前要求原生 Windows Job（`@deepseek-ai/dsh-win32-process`）。拒绝用户主目录、文件系统根、`~/.dsh` 和非规范路径。

`SetNamedSecurityInfoW` Win32 5 映射为 `sandbox_write_grant_failed`（`packages/runtime/src/errors.ts`）。契约（2026-09-24，2026-09-25 修订）记录：受限 Windows 身份下真实后端稳定返回该错误；兼容环境有确定性测试；当时没有普通用户启动的原生成功证据。没有改全局 ACL，也没有为了继续跑而关掉沙箱。预检失败会 `blockProjectEnvironment`。

预检只加载固定的沙箱、文件和命令后端，不加载模型或凭据插件。自定义 profile 对工具实现的覆盖不在这次检查的证明范围内。

凭据路径：dsh 子进程清掉环境里形状像凭据的变量；只有 `OCG_GATEWAY_KEY` 被显式转发，且不得写入 Profile、工单、日志或文档。这不是凭据代理。Git 调用带 `GIT_TERMINAL_PROMPT=0`，Lachesis 自己的提交关闭 `commit.gpgsign`。Apply 的快进使用操作者仓库的现有登录，凭据留在主机上。

### 挂接 harness

`RunSpec.command` 可以替换 ACP argv，默认是本包里的 `dsh --profile acp`。调度器从不传 `command`。`DshAcpRuntime.start` 只在传入 `command` 时跳过预检；源码把这条标成测试和自定义传输的缝，正式路径预检失败就不能启动。调度器在 `start` 之前还会自己再调一次 `checkReadiness`。

握手固定调用 `session/set_config_option`。配置 id 是 dsh 的 `model` 和 `reasoning_effort`，模型值必须是 JSON `[provider, model]`。子进程环境总会写入该 Run 自己的 `DSH_HOME`。每个 Run 从服务数据目录复制 `dsh/cordis.patch.yml` 到 `run-homes/<runId>`。

`@lachesis/workspace` 的准备、冻结、合并和应用不关心文件是谁写的。

### 失败、取消、验收、合并

`rangeExited` 只在托管范围成功 dispose 之后为真。退出无法确认时，工单持久保持待恢复，重启也不解除。公共 SubprocessHandle 没有可持久化的范围身份；无名 Windows Job 不能重开。不能用 PID 消失或操作者勾选伪造退出确认。只有确认退出的未完成 Run 才能冻结检查点并显式接续。

取消是 ACP `session/cancel` 加上范围关闭。prompt 结束不是验收。冻结要求工人退出证明，空证明是 `worker_unproven`。返工从上一份冻结交付播种，并可写入 `.dsh/lachesis-verification.json`（清单排除该目录）。

集成使用独立 worktree 和真实 `git merge`。文本上干净的合并仍跑 `verificationCommand`。Git apply 要求 HEAD 仍是 `expectedTarget` 且工作树干净，旧 HEAD 记在 `refs/lachesis/rollback/<id>`。普通目录要求每个被碰路径的当前哈希等于集成时的 “ours”；先备份再写 jsonl；外部改动不覆盖。应用后验证失败则回滚，恢复失败则为 `recovery_required`。`expectedTarget` 不一致是预检失败，不会静默应用。

## 同类产品

下面每条先写仓库或站点、当日能核对的更新时间，再回答权限、隔离、多 harness、失败后的交付。

### Omnigent

仓库 [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent)。`pushed_at` 2026-10-01T10:43:34Z，Apache-2.0，约 10390 星。

SDK harness 能在 Windows 上工作。原生 `omnigent claude|codex|...` 是 tmux/PTY：Linux 用 bwrap，否则失败；macOS 用 seatbelt。Windows 上有服务器、网页、SDK harness 和 Job Object。没有 tmux 包装，没有 bwrap/seatbelt，也没有 L7 出站代理，因此原生 Windows 上做不了凭据代理的中间人。

策略是 ALLOW / DENY / ASK，顺序为会话、agent spec、服务器。内建包含 `enforce_sandbox` 和 `cost_budget`（超预算是降级，不是硬停）。环境变量默认拒绝。凭据代理已实现：真实 token 留在父进程（`os_env.sandbox.credential_proxy`、`omnigent/inner/credential_proxy.py`、`designs/SANDBOX_CREDENTIAL_PROXY.md`）。

Polly（编排器、并行 worktree、换厂商复核）出现在 README 和宣传里。当日没有打开 `examples/polly` 的 YAML，不能把它当成已实现的交付流。

### Superset

仓库 [superset-sh/superset](https://github.com/superset-sh/superset)。`pushed_at` 2026-10-01T10:34:20Z，许可证 NOASSERTION，约 14791 星。macOS 桌面；Linux AppImage 为实验；Windows 还没有。

每个工作区一个 Git worktree。文档说明这不是进程或凭据沙箱。代理以 PTY 里的 CLI 命令启动，不走 ACP。捆绑脚本里 Claude 使用 `--dangerously-skip-permissions`，Codex 全绕过（含 hook trust），Gemini 使用 `--approval-mode=auto_edit`（不是 yolo）。宿主绑 `127.0.0.1`。集成走分支和 PR。`docs.superset.sh` 当日抓取被拦截，事实来自检索摘录。

### Vibe Kanban

仓库 [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)。`pushed_at` 2026-09-19T06:52:48Z，Apache-2.0，约 28228 星。README 写明正在停止维护，仓库未归档。

Worktree 在 `.vibe-kanban-workspaces` 或临时目录。Claude 执行器使用 `--permission-prompt-tool=stdio`，并在 plan/approvals 时加 `--permission-mode=bypassPermissions`，以便稍后还能改模式。另有 `ExecutorApprovalService`、`AUTO_APPROVE_CALLBACK_ID`；`dangerously_skip_permissions` 会加上 CLI 标志。进程用 tokio `Command` 启动。续跑用 `--resume` / `--resume-session-at`。默认 `PermissionPolicy` 为 Auto，plan 或受监督审批除外。文档里的 DEFAULT profile 仍设置 yolo。另一条 ACP 执行器发出 RequestPermission / ApprovalResponse。

已知问题：目标分支在别处被检出时直接合并会静默失败（#1897）；合并后 worktree 没清（#1764）；孤儿 worktree，以及 ACP “server shut down unexpectedly”（#1731）；yolo 不能以 root 运行（#1996）。Git 交付是 PR/rebase；冲突条可以把解决方案喂回代理。

### Conductor

站点 [conductor.build](https://conductor.build)（Melty，闭源）。Mac 桌面。本机模式是 Git worktree，代理以用户身份运行，部分工具调用要审批。FAQ 曾经写过没有沙箱。云端是隔离 Linux（主页写 Firecracker microVM）；FAQ 写 8 vCPU / 16 GB / 32 GB 临时 NVMe，区域 us-east-1。Harness 为 Claude Code、Codex，文档还提到 Cursor 和 OpenCode。MCP 入口 `https://api.conductor.build/mcp`。宣传版本 0.29.0 和 0.61.3 互相矛盾，记录里不选其中一个。没有 Windows 桌面。检查点只出现在第三方文章里，标为推测。

### Claude Squad

仓库 [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)。`pushed_at` 2026-08-20T05:09:53Z，AGPL-3.0，约 8555 星。Go TUI，版本串 1.0.20。tmux 加 Git worktree。`-y` / `--autoyes` 是实验功能；文档说只覆盖 Claude Code 和 Aider。实现是按键注入，不是协议答复。当日打开 `session/tmux.go` 没有取到内容，daemon 源码没有读，autoyes 只依据 README 和 v1.0.0 发布说明。

### acpx 与 OpenClaw

仓库 [openclaw/acpx](https://github.com/openclaw/acpx)。`pushed_at` 2026-10-01T03:04:01Z，MIT，约 3306 星。

权限模式互斥：`--approve-all`、`--approve-reads`（默认）、`--deny-all`。单工具策略顺序是 autoDeny、autoApprove、escalate、defaultAction，然后才是模式。非交互默认拒绝，或直接失败。一轮里每个请求都被拒绝或取消时退出码 5。固定选项的用户提问即使在 approve-all 下也以 `PERMISSION_PROMPT_UNAVAILABLE` 取消（退出码 5）。取消和超时会撤销未决批准。`--cwd` 的文件系统检查是尽力而为，不是操作系统沙箱。`--no-terminal` / `--no-fs` 只关掉 ACP 能力。会话策略不写在会话记录上。OpenClaw 插件把 approve-all 标成危险，默认 approve-reads。

[openclaw/openclaw](https://github.com/openclaw/openclaw) 的 `pushed_at` 为 2026-10-01T10:46:53Z，约 391110 星。`/codex` 走原生 Codex app-server，ACP 是显式回退。

### IMClaw

仓库 [smallnest/imclaw](https://github.com/smallnest/imclaw)。`pushed_at` 2026-04-18T09:15:18Z，MIT，50 星。默认分支是 `master`（`main` 返回 404）。它是 acpx 之上的 ACP 网关。预设 safe-readonly、dev-default、full-auto。没有 worktree、沙箱或合并。Windows 发布产物没有核对。相对当时的 acpx 已经过时。

### CC Web Manager

没有找到同名仓库。最近的三个：

- [ZgDaniel/cc-web](https://github.com/ZgDaniel/cc-web)，2026-08-30，约 264 星，许可证空。浏览器里的 PTY，没有 worktree 或沙箱。
- [zbc0315/cc-web](https://github.com/zbc0315/cc-web)，npm `@tom2012/cc-web`，2026-09-06，1 星，MIT。xterm，能力低于 `--dangerously-skip-permissions`。
- zhangyifei1/ccWeb，2026 年 7 月掘金文章，提到 Claude Agent SDK 的 `canUseTool`。源码没有核对。

### OpenHands

仓库 [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)。`pushed_at` 2026-10-01T06:51:08Z，MIT，约 89695 星。

推荐 Docker sandbox，用 `SANDBOX_VOLUMES`。Windows 通过 Docker Desktop 或 WSL。CLI 有 `--always-approve` 和 `--llm-approve`。Headless 的 ALWAYS 会一律批准，此时不能用 `--llm-approve`。SDK 有 AlwaysConfirm、NeverConfirm、ConfirmRisky。会话可 `--resume`。产出落在挂载目录里，没有冻结层。把 `GITHUB_TOKEN` 挂进容器不是凭据隔离。2026 年 9 月关于 Agent Canvas（Claude/Codex、无沙箱加 NeverConfirm）的说法来自第三方，标为推测。

### Devin

Cognition 为每个会话提供 VM；秘密放在保险库；会话结束回收 VM；持久化靠 Git/PR。Managed Devins 博文日期 2026-03-19。CLI 云博文日期 2026-09-21，有 `/handoff` 和 `devin --cloud --resume`。Windows 客户机镜像没有确认。快照保留文件和包，不保留进程。CLI 沙箱文档（https://docs.devin.ai/cli/sandbox）：可写路径来自 Write scopes；`sandbox.excluded` 排除路径；优先级是 deny、ask、allow。

### Cursor Cloud Agents

每个代理一个 Firecracker microVM，放在单独的 AWS 账号；产出是 draft PR；秘密脱敏；Git 权限有范围；提交由 HSM 签名。自托管时工具跑在你的 worker 上，代理循环在 Cursor 云端，出站只有 HTTPS。

### Claude Code 云与本机沙箱

文档页日期 2026-09-30。每个会话一个 Anthropic VM。GitHub token 不进入 VM；使用短时、有范围的凭据和 GitHub 代理；推送限于当前分支；网络有允许列表。网页模式是 Accept edits / Plan / Auto，不是本机那种完全绕过。官方 bash 沙箱是 macOS Seatbelt 和 Linux/WSL2 bubblewrap；原生 Windows 不支持。「deny/ask 规则在 `--dangerously-skip-permissions` 之后仍然生效」只出现在二手来源，当日没有复核。

### Codex、Gemini CLI、OpenCode

Codex 沙箱档位是 `read-only`、`workspace-write`、`danger-full-access`。`--dangerously-bypass-approvals-and-sandbox` 同时关掉审批和沙箱。Omnigent issue #657：`suggest` / `auto-edit` / `full-auto` 仍在命令沙箱里；只有绕过旗标跳过沙箱。这个矩阵由该 issue 和 2026-09-28 的一篇 aq.dev 指南互相印证，当日没有打开 developers.openai.com。

Gemini CLI 使用 `--yolo` 或 `--approval-mode=auto_edit`。

OpenCode（opencode.ai/docs/permissions，2026-09-29）：allow / ask / deny。`opencode --auto` 自动批准没有被明确拒绝的请求，deny 仍然有效。无头模式下 `ask` 自动拒绝。

## 对照

| 产品 | 权限 | 隔离 | 多 harness | 交付 |
| --- | --- | --- | --- | --- |
| Lachesis | 编排器收 ACP 请求，正式 Run 人工 `defer` | Git worktree 或目录快照；dsh workspace-write 预检；Windows Job。预检不覆盖 profile 工具替换 | 仅 dsh ACP。`command` 是测试缝 | 冻结、人验收、三方合并、验证、显式 apply。支持非 Git 目录 |
| Omnigent | 会话 / spec / 服务器的 ALLOW、DENY、ASK | Linux bwrap、macOS seatbelt；Windows 只有 Job。凭据代理已实现，原生 Windows 无 L7 代理 | SDK；原生 CLI 是 tmux/PTY | Polly 并行 worktree 未核 YAML |
| Superset | 捆绑脚本直接带各家 yolo/bypass | 每工作区一个 worktree。文档说明不是进程或凭据沙箱 | PTY CLI，不走 ACP。无 Windows | 分支和 PR |
| Vibe Kanban | 默认 Auto；文档 DEFAULT 仍是 yolo；另有 ACP 执行器 | worktree。进程用 tokio 启动 | 每家一个执行器，含 ACP | PR/rebase。直接合并在目标被检出时会静默失败 |
| Conductor | 本机部分工具要人批 | 本机 worktree，代理即用户。云端隔离 Linux / Firecracker | Claude、Codex，文档还写 Cursor、OpenCode | 云端以远端环境为主。检查点为推测 |
| Claude Squad | 实验性按键 `--autoyes`，仅 Claude 与 Aider | tmux + worktree | PTY/tmux | 源码级恢复没有读到 |
| acpx | 默认 approve-reads；deny 先于 approve；全拒绝退出 5 | `--cwd` 检查不是 OS 沙箱 | ACP 客户端 | 不负责合并 |
| IMClaw | 预设含 full-auto，经 acpx | 无 | ACP 网关 | 无合并 |
| OpenHands | headless 一律批准；另有 LLM 审批 | 推荐 Docker。Windows 靠 Docker/WSL | 自有运行时 | 结果在挂载卷，无冻结层 |
| Devin / Cursor / Claude 云 | 云端策略或有范围的自动编辑 | 每会话 VM；凭据留在 VM 外或短时代理 | 各家自己的代理 | Git/PR。快照不保留进程 |

2026-10-01 没有看到同时具备这四样的产品：本机工单、多 harness、冻结交付、验收后的三方合并。最接近的公开模式是 Git worktree 加人工 diff/PR。无人值守在这些产品里拆成两件事：编排器回答权限，以及另一套文件系统、网络和凭据的沙箱。

## 还有没有必要继续做

有。重叠产品覆盖的是并行代理加 diff/PR。Lachesis 的交付状态机是另一件事：外部工单、冻结、人验收、三方合并、验证、显式 apply、Git 与普通目录、评价归到具体 Run 和 Profile 修订。

不值得重做的是代理 IDE、各家 yolo 旗标，以及又一套 worktree 记账。如果目标收成「Mac 上的 CLI worktree 加 PR」，现有产品已经够用。

## 本机预检，2026-10-01

契约里「普通用户没有原生成功证据」对当前这个身份已经过时。当日在仓库里跑了 `packages/runtime` 的无模型探针：

`pnpm --filter @lachesis/runtime exec node --test --experimental-strip-types --test-concurrency=1 --test-name-pattern "installed pinned" ./test/readiness.test.ts`

退出码 0，约 1.5 秒，诊断输出 `{"ready":true,"code":null,"diagnostic":null}`。测试名是 “installed pinned dsh tool backends either execute confined writes or report an actual environment denial, without a model”。它调用真实的 `checkToolReadiness`，没有注入假后端。

这次通过说明：当前用户身份可以给私有工作目录做 dsh 的 workspace-write 授权，原生 Job 可用，受限 PowerShell 能在该目录里完成一次写、读、改写和删除，托管范围随后退出。

它没有证明工作区以外的写入会被拒绝，没有证明网络隔离，没有证明真实 agent 回合使用同一套后端。预检不加载 ACP profile 的工具插件。没有启动模型，也没有改仓库。受限身份下的 Win32 5 记录仍然是当时那次身份的事实，不能用这次成功擦掉。

## 对 Lachesis 有用的做法

1. 权限在编排器里经 ACP（或各厂商自己的控制协议）回答。可参考 acpx：默认只自动放行读；非交互时拒绝或失败；按工具的拒绝先于放行；需要升级给人的请求单独标出；一轮全部被拒时以明确退出码结束；取消使迟到批准失效。yolo 只作为显式的危险配置。OpenCode 那种 deny 在 auto 下仍然有效，值得保留。固定选项的用户提问必须失败，不能自动答。优先 ACP 或厂商控制协议，不用 PTY 按键。

2. 把进程树、文件系统/网络沙箱、凭据分成三道边界。Job Object 只回收进程树。Windows 上真正无人值守的 shell 需要 WSL2 加 bubblewrap、容器，或虚拟机，再加凭据代理，让 git、gh、SSH 的 token 不进入工作区。

3. 保持冻结、人验收、三方合并、验证、显式 apply。可以从别人那里借的是续跑，以及把冲突当作下一轮输入。云端 PR 替代不了写到脏的本地仓库或非 Git 目录。

已知会反复出现的失败：worktree 共享 `.git`、钩子和用户的凭据助手；目标分支在别处被检出时直接合并失败；孤儿 worktree；合并错误被吞掉；yolo 不是隔离；approve-all 不是沙箱；非交互提示必须拒绝或失败；用户提问不能自动回答。

## 若继续做，断点在这里

预检在本机已经能过，不再是等待无人值守的理由。正式 Run 仍应使用人工 `defer`。不要加 yolo profile，也不要让工单走现成的 `allow-once`：那个模式对每次请求无差别放行一次，选项里没有 `allow_once` 就取消。

若要减少点击，先把工具标题、种类和脱敏后的参数放进权限事件和问题卡，选项显示 `name`。之后才可能只对读操作自动选 `allow_once`，写和 shell 仍交给人。

第二套 harness 不能靠 `RunSpec.command`。调度器不传它，而且会先跑 dsh 预检；握手仍要求 dsh 的 `model` / `reasoning_effort` 和 `DSH_HOME`。用 `command` 跳过预检会拆掉刚刚通过的那道检查。换 harness 需要单独的适配边界：启动、权限映射、预检、home、路由选择。冻结、验收、三方合并和显式 apply 继续共用。

## 当日没有当成事实的材料

- Omnigent `examples/polly` 的 YAML 没有打开。
- Claude Squad 的 `session/tmux.go` 没有取到内容，daemon 没有读。
- OpenHands Agent Canvas 的官方文档没有打开，相关说法标为推测。
- Claude Code 权限页上 deny/ask 是否在 bypass 之后仍然生效，没有复核。
- Codex 旗标矩阵没有对照 developers.openai.com 原文。
- Conductor 的两个宣传版本没有选定，检查点没有官方出处。
- Superset 文档站当日抓取失败，事实来自检索摘录。
