# Lachesis 多 Harness 架构施工计划

状态：搁置，2026-10-01。未改代码，未经评审（原计划交 Fable 评审，当时权限判定服务不可用，未执行）。重新启用前先读第 7 节。依据：[无人值守调研](unattended-harness-survey-2026-10-01.md)、本机 `D:\0 code\Agent-Bridge`、当前仓库源码。

## 1. 目标与决定

Lachesis 不再以 dsh 为架构底座。它负责工单、调度、隔离工作区、冻结交付、验收、三方合并与显式 apply；harness 是可替换的执行器，dsh 只是其中一个。

| 编号 | 决定 | 理由 |
| --- | --- | --- |
| H1 | 服务宿主改为 `node:http`，去掉 dsh `profile-boot`、`dsh-host-webserver` 与 cordis Service 包装 | 本地 HTTP 服务不需要插件宿主；服务生命周期不再依赖 dsh |
| H2 | 执行层改为「harness 注册表 + 按协议的适配器」，第一阶段只做通用 ACP 适配器 | 参照 Agent-Bridge：普通 ACP CLI 只需配置，不写代码 |
| H3 | 不经 dsh 插件（`dsh-subagent-*`）接其他 harness | 多一层父代理；权限仍归各家；丢失流式事件与退出证明 |
| H4 | 不单独采用 cordis 作为插件框架 | 扩展点只有适配器；热卸载与 Run 退出证明冲突；仍随 dsh 发版。接口保持可包装成 cordis 插件 |
| H5 | 第一阶段不管理 harness 内部配置（供应商、登录、插件）；只做命令、环境、ACP 公布的模型/强度、权限开关 | 用户在各 harness 自己的 home 里配置；Lachesis 不存凭据 |
| H6 | 进程树回收继续用 `@deepseek-ai/dsh-subprocess(-local)` 与 `dsh-win32-process`，作为普通库 | Windows Job 退出证明是恢复语义的基础；后续可评估自研 |
| H7 | 无人值守 = harness 自身的 auto/yolo 开关 + Lachesis 侧权限策略；默认人工 | 原生 Windows 上没有同类产品解决 OS 沙箱；yolo 必须显式、可见 |

需要新 ADR（`adr-0002-harness-neutral-runtime.md`）修订施工包 D02「第一阶段只支持 dsh」与 D03「沿用 dsh 插件式架构」。

## 2. 不变量（必须保持）

- Issue、Run、Instance、Session、Profile 身份分离；worker 不自验收、不自评分。
- 每个 Run 独立工作区；目标项目只在显式 apply 时写入。
- `rangeExited` 只在托管进程范围确认退出后为真；未确认保持 `recovery_required`，重启不解锁。
- 取消、迟到结果保护、幂等、数据目录单实例租约。
- 凭据不写入 Profile、工单、日志、交付。
- 评价绑定具体 Run、交付与 Profile 修订版。

## 3. 目标结构

```
apps/server      node:http 宿主、鉴权、HTTP/MCP、supervisor（不再 import dsh 类型）
packages/runtime
  core/          RunHandle、RunEvent、PermissionPolicy、进程托管（SubprocessHost）
  acp/           通用 ACP 适配器（由现 AcpRun 抽出）
  harnesses/     内置注册表：dsh、claude-agent-acp、opencode、gemini（配置，非代码）
  dsh/           dsh 专属：home 准备、cordis.patch.yml、沙箱预检（可选能力）
packages/domain  Profile 增 harness 维度；迁移 V3
packages/workspace  不变；私有目录排除改为由适配器声明
```

### 3.1 注册表条目

数据目录 `harnesses.json`（内置默认 + 用户覆盖，结构参考 Agent-Bridge `agents.toml`）：

```ts
interface HarnessEntry {
  id: string                       // 'dsh' | 'claude' | 'opencode' | ...
  protocol: 'acp'                  // 第一阶段只有 acp；codex 原生后置
  command: string[]                // 例：['claude-agent-acp']
  fallbackCommands?: string[][]
  env?: Record<string, string>     // 非凭据环境；凭据只按名称白名单转发
  forwardEnv?: string[]            // 例：['ANTHROPIC_API_KEY']，值不落盘
  home?: 'shared' | 'per-run'      // shared 使用用户登录态；dsh 为 per-run
  auto?: {                         // 进入无人值守时如何打开 harness 自身开关
    args?: string[]; env?: Record<string, string>
    sessionMeta?: Record<string, unknown>; setMode?: string
  }
  route?: {                        // 模型/强度如何选；缺省 = 读 ACP 公布的配置项
    modelConfigId?: string; effortConfigId?: string
    encodeModel?: 'plain' | 'dsh-provider-model'
  }
  privateDirs?: string[]           // 冻结时排除，例：['.dsh']
}
```

### 3.2 适配器接口

```ts
interface HarnessAdapter {
  readonly entry: HarnessEntry
  capabilities(): {
    sandbox: 'enforced-workspace-write' | 'none'
    permissionChannel: 'acp' | 'none'
  }
  probe(spec: ProbeSpec): Promise<RouteCapabilities>      // 列出可用模型与强度，不发 prompt
  checkReadiness(spec: RunEnv): Promise<RuntimeReadiness> // 通用：命令存在、initialize、session/new
  start(spec: RunEnv & RunRoute & { permission: PermissionPolicy }): Promise<RunHandle>
  dispose(): Promise<void>
}
```

`RunHandle` 保持现有形状（send、events、answerPermission、cancel、close、done）。`RunEvent.permission` 增加脱敏后的 `title`、`kind`、`rawInput` 摘要与选项 `name`。

### 3.3 权限策略

`PermissionPolicy = 'manual' | 'auto'`，挂在 Profile 修订版上。

- `manual`：现有 `defer` 流程，问题卡显示工具标题、种类、选项名。
- `auto`：启动时应用 `entry.auto`；ACP `request_permission` 自动选 `allow_once`（无则取消）。固定选项的「用户提问」不自动答，转为人工。界面与交付证据标注「无系统沙箱」。
- 规则化应答（acpx 式 deny → escalate → allow）放到第二阶段。

## 4. 实施批次

每批独立可验证；任何一批完成后 `pnpm check`、`pnpm test`、`pnpm build` 必须通过。

### B0 ADR 与契约（文档）
- 写 ADR-0002；更新 `docs/runtime-contract.md`、`docs/api-contract.md` 中 dsh 专属表述。
- 验收：评审通过。

### B1 宿主替换
- `scripts/start.mjs` 改为直接启动 `apps/server` 的 `node:http` 服务；保留 `/api/v1/health` 的 `launchId` 校验、数据目录租约、配对码、静态资源、MCP 路由。
- `apps/server/src/plugin.ts` 拆为 `server.ts`（无 cordis）。
- 移除 server 对 `@deepseek-ai/cordis`、`dsh-host-webserver`、`schemastery` 的依赖。
- 验收：server 现有 22 项测试通过；`pnpm start` 后浏览器配对、工单列表可用；第二实例启动被租约拒绝。

### B2 runtime 抽出通用 ACP 适配器（行为不变）
- `AcpRun` 去掉对 `DSH_HOME`、`[provider, model]` 编码、`model`/`reasoning_effort` 常量的硬编码，改读 `HarnessEntry.route`。
- `command.ts`、`readiness.ts`、`assertIsolatedDshHome`、`cordis.patch.yml` 复制移入 `runtime/dsh/`。
- `DshAcpExecutor` → `HarnessRuntime`（按 `harnessId` 取适配器）；`SubprocessHost` 留在 core。
- supervisor 的 `prepareDshHome`、`OCG_GATEWAY_KEY` 转发、`.dsh/lachesis-verification.json` 路径、“Allow this dsh tool action?” 文案改为调用适配器或通用表述。
- 验收：runtime 30 项、server 22 项测试通过；fixture `acp-agent.mjs` 以「通用 ACP」与「dsh 配置」两种条目各跑一遍生命周期测试；真实 dsh 无模型预检仍 `ready: true`。

### B3 数据模型与界面
- 迁移 V3：`profiles` / `profile_revisions` 增 `harness_id TEXT NOT NULL DEFAULT 'dsh'`、`permission_policy TEXT NOT NULL DEFAULT 'manual'`；`provider_ref`、`model_id` 改为可空（由 harness 解释）。V2 → V3 事务迁移，拒绝未知未来版本（沿用现有 `migrate()`）。
- 调度容量：`providerRef` 维度改为 `capacityKey`（默认 `harnessId`，dsh 为 `dsh:<providerRef>`）。
- contracts、HTTP、MCP、Web Profile 表单与详情页同步；「检查可用强度」改为通用 `probe`。
- 验收：domain 36 项通过并新增迁移测试（V2 数据库升级后历史评价归因不变）；MCP 6 项通过；网页构建通过。

### B4 权限事件与 auto 策略
- `onPermission` 保留工具标题、种类、脱敏参数；问题卡显示选项 `name`。
- 实现 `PermissionPolicy`：`manual` / `auto`；用户提问在 auto 下转人工。
- worker 环境默认设 `GIT_TERMINAL_PROMPT=0`，并清空 git credential helper，防止 worktree 中直接 push（逐 harness 验证）。
- 验收：新增测试覆盖 auto 自动放行、无 allow 选项时取消、用户提问转人工、取消后迟到答复无效；交付证据记录权限策略。

### B5 第二个 harness
- 内置 `claude`（`claude-agent-acp`）或 `opencode`（`opencode acp`）条目，`home: 'shared'`。
- 无模型探测：记录其 `initialize` 能力、配置项 id、权限选项 kind、`session/close` 支持情况。
- 真实工单一张：从创建到显式 apply；再以并发 2–4 跑同一 harness，确认共享 home 不互相干扰。
- 验收：验收记录写入 `docs/acceptance-<date>.md`，含版本、命令、真实结果与失败项。

### 后续（不在本计划）
Codex 原生适配器（app-server）；规则化权限应答；预检反向探针（工作区外写入必须被拒）；WSL2/容器隔离与凭据代理；评估自研 Windows Job 替代 dsh-subprocess。

## 5. 风险与待核实

| 风险 | 处理 |
| --- | --- |
| 第三方 ACP 适配器不标准（配置项、会话关闭） | B5 先做无模型探测；不支持 ACP 选模型时，退回 harness 默认模型并在 Run 证据中记录 |
| `session/close` 缺失导致退出证明依赖强制终止 | 退出证明以托管范围为准，不依赖协议；记录为降级 |
| 共享 home 的并发冲突 | B5 并发实测；冲突时该 harness 降为 `per-run` 或容量 1 |
| auto 无 OS 沙箱 | 默认 manual；显式开启；界面与证据标注；git 凭据防护 |
| 订阅账号用于后台并发是否合规、限速 | 接入前逐家核对条款；容量键按账号设置 |
| dsh-subprocess 仍是 alpha 依赖 | 锁版本；接口隔离在 `runtime/core` |
| B1 去掉 cordis 后服务关闭顺序 | 保留「先阻止新操作、等待已受理操作、再释放租约」，用现有 instance/recovery 测试覆盖 |

## 6. 需要决定

1. 第二个 harness：`claude-agent-acp` 还是 `opencode`。
2. auto 在第一阶段是否只对 `capabilities().sandbox = 'enforced-workspace-write'` 的组合开放，还是允许操作者对任意 harness 显式开启。
3. B1 与 B2 能否并行：二者文件不重叠（server 宿主 vs runtime），但 B2 的 supervisor 改动依赖 B1 拆出的 `server.ts`。

## 7. 搁置原因与重启前要先想清楚的问题

本计划只解决「换 harness」，下列问题没有方案，实际施工时会比计划看起来麻烦：

- **浏览器类验收**。现有验证只有项目填写的 `verificationCommand`，能证明构建和测试，不能证明页面效果。前端工单需要浏览器 agent 或 Playwright 截图作为证据，但各 harness 是否带浏览器工具、怎么挂（MCP、内置工具）不一致；截图证据如何冻结进交付、如何给操作者对比也没设计。auto 模式下浏览器 agent 还意味着放开网络。
- **验收仍靠人**。worker 不能自验收；无人值守后瓶颈会移到人工验收。是否引入「独立验收 Run」（换一个 harness/Profile 只读复核）需要单独设计，并与「不自验收」不变量对齐。
- **各家 harness 的真实行为未验证**。第三方 ACP 适配器的配置项、权限选项、`session/close`、共享 home 并发，都只来自文档和社区反馈。
- **auto 没有系统沙箱**。原生 Windows 上无现成方案；WSL2/容器会改变工作区挂载、进程回收和退出证明的实现。
- **订阅条款与限速**。后台并发使用订阅账号是否允许，没有逐家核对。

重启时建议顺序：先把上面五条各写成一页结论，再从 B0 开始；必要时先只做 B1（宿主替换），它单独也有收益且风险低。
