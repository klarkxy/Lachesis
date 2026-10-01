# Lachesis 协调层架构设计

状态：草案，2026-10-01。基于当日关于多智能体协作、agent-bridge 问题和同类产品调研的讨论。

## 核心定位

**Lachesis 是多 harness 的协调层，不是又一个多智能体框架。**

它负责子任务的**启动、监控、续跑**，但不包办通信、不重新实现工具、不强制所有消息都走中央路由。

## 与现有多智能体框架的区别

| 维度 | 普通框架（AutoGen/MetaGPT） | Lachesis 协调层 |
|------|---------------------------|----------------|
| **状态可见性** | 框架内部状态，外部不可见 | 每个检查点落盘，主智能体和人都能查 |
| **中途接管** | 不支持，要么等完要么重来 | 任何检查点都能暂停、人工调整、继续 |
| **失败处理** | 整个流程失败，从头重跑 | 从最近检查点续跑，只损失一个里程碑 |
| **agent 间通信** | 必须绕中央调度器 | 查询走 Lachesis，通信走各 harness 原生能力 |
| **编排者角色** | 单点、全知全能、挂了就全废 | 轻量、只读状态 + 做决策，挂了换一个继续 |

## 核心问题：当前架构的痛点

### 1. 信息不对称

主智能体派任务后只能等 `<background-task-finished>` 或轮询 `task_output`。子会话被 crash-recovery 杀了 4 次，主智能体毫不知情。20 分钟的编译进度只能靠「猜 target 目录的 mtime」倒推。

**结果**：主智能体永远在做「薛定谔的进度管理」——不敢催（怕打断真跑），不敢不催（怕早就死了没人知道）。

### 2. 完工通知是脆弱的单点

子会话一旦被 runtime crash-recovery 杀死，完工通知永远不会有，父会话就会一直 idle 下去。**这不是 bug，这是架构的必然**——通知机制假设了任务会跑完。

### 3. 上下文隔离导致重复发现成本高

每次派新子任务都要把「已知事实 + 排除路径 + 当前 diff 现状」重新序列化进 prompt。子智能体自己的发现（比如「这个测试文件写了但从没真跑过」）要么丢失，要么得手动转述。

## 解决方案：四个核心能力

### 1. 统一的子任务生命周期管理

```typescript
// 主智能体发起子任务
const task = await lachesis.dispatch({
  harness: "dsh",  // 或 "codex" / "claude" 等
  agent: "worker",
  prompt: "...",
  workspace: "/path/to/project",
  timeout: "30m"
})

// 主智能体能随时查状态
const status = await lachesis.query(task.id)
// 返回：{ stage: "compiling", lastCheckpoint: "...", alive: true }

// 如果子任务死了，Lachesis 能检测到
if (status.alive === false && status.stage !== "done") {
  // 主智能体决定：重试 or 换个 harness or 人工介入
}
```

**关键点**：
- Lachesis 不是"又一个 harness"，而是 **「harness 的调度器」**
- 每个 harness 保持自己的原生能力（DSH 用自己的工具、Codex 用自己的）
- Lachesis 只负责 **「启动、查询、判活、清理」**

### 2. 轻量的检查点机制

```typescript
// 子智能体（通过 harness）主动上报检查点
await lachesis.checkpoint(task.id, {
  stage: "wrote_tests",
  artifacts: ["tests/dashboard.rs"],
  canResumeFrom: true  // 这个检查点能续跑
})
```

**主智能体不用轮询**，Lachesis 会在子任务状态变化时（stage 切换、失败、完成）**主动通知**。

### 3. 失败后的续跑策略

```typescript
// 子任务失败后
const lastCheckpoint = await lachesis.getLastCheckpoint(task.id)

if (lastCheckpoint.canResumeFrom) {
  // 从检查点续跑，不是从头来
  await lachesis.resume(task.id, {
    from: lastCheckpoint.stage
  })
} else {
  // 这个失败点续不了，重新派
  await lachesis.dispatch({ ... })
}
```

**实现上**：
- 子智能体（通过 harness）把中间产物存在约定位置
- 续跑时，Lachesis 告诉 harness「从这个检查点开始，前面的步骤跳过」
- 如果 harness 不支持续跑，Lachesis 至少能 **「检测到失败 + 通知主智能体」**

### 4. 统一的查询接口，但不包办通信

**Lachesis 应该是**：
- 提供查询 API
- 子智能体之间的通信走各自 harness 的原生能力

**比如**：
- DSH 的 session 之间想通信？用 DSH 自己的 `dsh session send`
- Codex 的 session 之间想通信？用 Codex 的 `mavis session send`
- **Lachesis 只提供「主智能体 → 子智能体」的调度，不管「子智能体 ↔ 子智能体」的对等通信**

这样 Lachesis 的职责就清晰了：**「调度层」**，不是「通信中枢」。

## Lachesis 不应该做什么

### ❌ 不要成为「又一个 harness」
- 不要自己实现工具（文件读写、命令执行、浏览器控制）
- 让 DSH 用 DSH 的工具、Codex 用 Codex 的工具

### ❌ 不要包办所有通信
- 主智能体 → 子智能体：Lachesis 管
- 子智能体 ↔ 子智能体：各 harness 自己的能力
- 这样就不用「开很多 MCP studio」（agent-bridge 的问题）

### ❌ 不要强制检查点格式
- 有些 harness 可能支持细粒度检查点（每个函数写完就存一次）
- 有些可能只支持粗粒度（整个模块写完才存）
- Lachesis 只要求「能查到最近一个检查点」，不管它多细

## 与 agent-bridge 的区别

| 维度 | agent-bridge（现状） | Lachesis（新方向） |
|------|---------------------|------------------|
| **定位** | 外部 CLI worker 的 MCP 包装 | 多 harness 的协调层 |
| **通信** | 所有通信走 MCP（所以要开很多 studio） | 查询走 Lachesis，通信走各 harness 原生能力 |
| **失败处理** | 子任务死了父不知道，傻等 | 主动检测失败 + 支持续跑 |
| **检查点** | 无 | 有，且可选粒度 |
| **harness 支持** | 只支持有 CLI 的（Grok、Kimi 等） | 任何有编程接口的 harness 都能接 |

## 技术架构

### 核心组件

1. **Dispatcher**：接收主智能体的任务，选 harness 并启动
2. **Monitor**：轮询子任务的健康状态（通过 harness 提供的接口）
3. **Checkpoint Store**：存子任务的检查点（SQLite 或文件）
4. **Notification Hub**：子任务状态变化时通知主智能体

### 接入一个新 harness 的成本

Lachesis 对 harness 的要求极简：

```typescript
interface HarnessAdapter {
  // 启动一个子任务
  start(config: TaskConfig): Promise<TaskHandle>
  
  // 查询子任务状态
  query(handle: TaskHandle): Promise<TaskStatus>
  
  // 可选：续跑一个失败的任务
  resume?(handle: TaskHandle, from: Checkpoint): Promise<void>
}
```

只要 harness 能提供这三个能力（或者两个，`resume` 是可选的），就能接入 Lachesis。

**DSH、Codex、Cursor、Aider** 都已经有了类似的能力（启动 session、查 session 状态），所以接入成本不高。

## 实施优先级

这个设计**不影响当前 Lachesis 的核心价值**（工单、冻结交付、验收、三方合并、显式 apply）。

**可以分阶段实施**：

### Phase 1：最小监控层（保持现有功能）
- 在现有 `DshAcpRuntime` 外包一个轻量的 `TaskMonitor`
- 主智能体能通过 MCP 查询子任务状态
- **不改**现有工单、交付、验收流程

### Phase 2：检查点支持
- 子任务主动上报 stage 变化
- 失败后能查到最后一个 stage
- **不改**冻结交付的格式

### Phase 3：第二个 harness
- 接入 Codex 或 Claude Code
- 验证「换 harness」的可行性
- **不改**工单调度逻辑

### Phase 4：续跑能力
- 从检查点恢复
- 只针对支持的 harness
- **不改**已有的「返工」机制

## 与现有设计的兼容性

### 保持不变

- Issue、Run、Instance、Session、Profile 身份分离
- 每个 Run 独立工作区
- 冻结交付、人验收、三方合并、显式 apply
- 评价绑定具体 Run 和 Profile 修订版
- 凭据不写入 Profile、工单、日志、交付

### 需要扩展

- `RunHandle` 增加 `query()` 方法，返回当前 stage
- `RunEvent` 增加 `checkpoint` 类型
- Profile 增加 `harnessId` 字段（已在 harness-neutral-plan 中规划）

### 不需要改

- `@lachesis/workspace` 的准备、冻结、合并、应用
- Git 和普通目录的集成逻辑
- MCP 和 HTTP API 契约

## 后续问题（暂不在本设计范围）

1. **浏览器类验收**：截图证据如何冻结进交付（需要单独设计）
2. **独立验收 Run**：是否引入另一个 harness 做只读复核（需要与「不自验收」不变量对齐）
3. **系统沙箱**：原生 Windows 上无现成方案，WSL2/容器会改变进程回收和退出证明
4. **订阅条款**：后台并发使用订阅账号是否允许，需要逐家核对

## 参考

- `docs/harness-neutral-plan-2026-10-01.md`：多 harness 施工计划（已搁置）
- `docs/unattended-harness-survey-2026-10-01.md`：同类产品调研
- 2026-10-01 讨论：agent-bridge 问题、多智能体协作的最佳路径
