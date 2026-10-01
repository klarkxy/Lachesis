# Lachesis 最小系统设计决策

日期：2026-10-01  
状态：**当前有效决策**，取代所有之前的架构讨论

---

## 核心结论

经过对多智能体协作、agent-bridge、同类产品、以及最新 harness vs model 研究的深入讨论，确定 Lachesis 的最小系统定位：

**工单系统 + 每个工单一个 agent (harness + LLM) + 冻结交付 + 人验收 + 显式 apply**

---

## 关键发现

### 1. Harness 比模型更重要（2026 年最新研究）

**GitHub 结论**（2026-06-26）：
> "Harness-level design decisions account for more performance variance than swapping frontier models"

**具体数字**：
- 同一模型 + 不同 harness：通过率差距 **68% → 88%**（20 个百分点）
- 优化 harness 能让弱模型超越强模型：Gemini 3.7 Flash + 优化 harness 通过率 **70.7% → 88.0%**
- Claude Code vs Codex：调到同样 xhigh effort，得分都是 63，但 Codex **更快、更便宜**（$1.04 vs $14.19）

**启示**：
- Lachesis 不是「多 harness 路由器」
- Lachesis 的价值在「工单系统 + 审慎执行 harness」
- 不要过早优化「自动选 harness」「失败切换」等高级功能

---

### 2. Lachesis 的独特价值不是「多 agent 调度」

**现有产品（Omnigent、Superset、Vibe Kanban）的模式**：
- agent 直接改 worktree → 看 diff → 合并/PR

**Lachesis 的模式**：
- 外部工单 → 独立工作区 → 冻结交付 → **人验收** → 三方合并 → 验证 → **显式 apply**

**差别在「工作流的审慎程度」，不在「能不能调度多个 agent」。**

适合场景：
- 生产环境，不能让 agent 直接改
- 批量工单（修 20 个类似 bug、迁移 10 个 API）
- 需要人工把关的项目

不适合场景：
- 个人项目、快速迭代
- 愿意「agent 改错了回滚就行」

---

## 最小系统设计（2 周内目标）

### Week 1：单个工单能跑通

**目标**：
- 手动创建工单 → 用 dsh 跑 → 冻结交付 → 人验收 → apply

**需要的代码**：
1. Issue CRUD（SQLite）
2. 启动 dsh agent（现有 `DshAcpRuntime`）
3. 独立工作区（现有 `@lachesis/workspace`）
4. 冻结交付（改动的文件存到 blob）
5. 显式 apply（三方合并 + 写回目标项目）

**验证**：
- 创建工单：「修 OCG 的一个 bug」
- Lachesis 启动 dsh → 在独立工作区改代码 → 冻结交付
- 看 diff，确认没问题 → 点 apply → 改动写回目标项目

---

### Week 2：并发 + 第二个 harness

**目标**：
- 同时跑 2 张工单 + 支持 Codex

**需要的代码**：
1. 调度器（全局并发 4，按 `harnessId` 分配容量）
2. Codex adapter（参考 harness-neutral-plan B2，启动 `codex acp`）
3. 工单队列（pending → running，按优先级/FIFO）

**验证**：
- 提交 4 张工单：2 张 dsh、2 张 codex
- 调度器并行跑，各自冻结交付
- 依次验收、apply

---

## 核心数据结构

```typescript
interface Issue {
  id: string
  title: string
  description: string
  workspace: string      // 项目路径
  harnessId: string      // 用哪个 harness（dsh / codex）
  modelId?: string       // 可选：指定模型
  status: 'pending' | 'running' | 'delivered' | 'accepted' | 'applied'
}

interface Run {
  id: string
  issueId: string
  harnessId: string
  workdir: string        // 独立工作区
  status: 'running' | 'success' | 'failed'
  delivery?: Delivery    // 跑完后的交付物
}

interface Delivery {
  id: string
  runId: string
  files: { path: string, content: string }[]
  frozen: boolean
}
```

---

## 不要做的事（第一版）

### ❌ 别做高级调度
- 自动选 harness
- 失败自动切换
- 检查点续跑
- 主动通知

### ❌ 别做自己的 harness
- 现在用现成的 dsh、codex
- 优化 harness 是第二阶段的事

### ❌ 别做浏览器验收
- 第一版只支持「看 diff」验收
- 截图、自动化测试后面再说

### ❌ 别做递归工单
- 风险大，先不做
- 需要时人工拆成两批

---

## Harness 选择

### 第一阶段：DSH + Codex

**保留 DSH**：
- 已有完整 adapter 代码
- 便宜（DeepSeek 模型成本低）
- 适合大量简单工单
- Windows Job 回收已调通
- 沙箱预检已通过

**加 Codex**：
- 官方产品，文档完整
- 模型强（GPT-6 系列）
- 生态成熟
- 适合复杂工单

**两个 harness 就够验证最小系统了。**

### 第二阶段：根据实际使用决定

- DSH 经常失败 → 换 Claude Code
- Codex 太贵 → 加 Gemini CLI
- 两个够用 → 不加第三个

---

## 验证标准

**第一版成功的标志**：
1. 能手动创建 3 张工单
2. Lachesis 并行跑（2 张 dsh、1 张 codex）
3. 能看到 3 份 diff
4. 点 apply，改动正确写回目标项目
5. **没有破坏现有的冻结 → 验收 → apply 流程**

---

## 参考

- `orchestration-layer-design.md`（已过时，存档参考）
- `why-not-existing-frameworks.md`（已过时，存档参考）
- `harness-neutral-plan-2026-10-01.md`（搁置，B1-B5 可参考技术细节）
- `unattended-harness-survey-2026-10-01.md`（同类产品调研，仍有效）

---

## 下一步

1. Week 1：单工单流程跑通
2. Week 2：并发 + Codex
3. 真实使用几批工单，验证价值
4. 根据反馈决定：继续 or 停掉
