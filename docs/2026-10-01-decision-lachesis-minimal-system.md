# Lachesis 最小系统设计决策

日期：2026-10-01  
状态：**当前有效决策**，取代所有之前的架构讨论

---

## 核心结论

经过对多智能体协作、agent-bridge、同类产品、以及最新 harness vs model 研究的深入讨论，确定 Lachesis 的最小系统定位：

> **企业级、自托管的多 harness 工单调度系统**
> 
> **核心**：工单调度 + 多 harness 执行 + 交付冻结
> 
> **极简原则**：Lachesis 只负责「接工单 → 选 harness → 并发执行 → 返回交付」，不管验收和 apply——那是调用方（人/主 agent/CI）的事。

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

### 2. Lachesis vs 云 Agent 的核心区别

**不是「远程 vs 本地」，而是四大支柱**：

#### ① 自托管 + 隐私可控
| | Devin / Replit Agent | Lachesis |
|---|---|---|
| 部署 | 云服务 | **自托管**（你的机器/内网）|
| 代码 | 上传到第三方 | **完全可控** |
| 审计 | 依赖供应商 | **自己的数据库** |
| 成本 | 订阅费 | **自己的算力 + API** |

#### ② Harness 中立 + 订阅池管理
| | Codex | Cursor | Lachesis |
|---|---|---|---|
| Harness | OpenAI Codex | Cursor 自己的 | **可插拔**（dsh/codex/claude）|
| 模型 | GPT 系列 | 有限选择 | **任意模型** |
| 扩展 | 封闭 | 封闭 | **开放** |

#### ③ 批量 + 并发 + 调度
| | Cursor | Claude Code | Lachesis |
|---|---|---|---|
| 并发 | 1 | 1 | **可配置（4/8/16）** |
| 批量 | ❌ | ❌ | **✅ 一次提 20 张工单** |
| 调度 | 无 | 无 | **按 harness 分配容量** |

#### ④ 交付冻结 + 可审计
| | Cursor/Codex | Devin | Lachesis |
|---|---|---|---|
| 执行 | 直接改代码 | 云端沙箱 | **独立工作区 + 冻结交付** |
| 验收 | 人工看 diff | Devin 内审核 | **调用方决定**（人/主agent/CI）|
| 回滚 | 手动 undo | ❌ | **交付物永久保存** |

**目标用户**：
- 企业内网开发（代码不能上传第三方）
- 团队协作（共享订阅池 + 批量工单）
- 敏感项目（金融、医疗、政府，需要审计）
- 成本敏感（自己的算力 + 自选便宜模型）

---

## 最小系统设计（2 周内目标）

### Week 1：单个工单能跑通

**目标**：
- 手动创建工单 → 用 dsh 跑 → 返回交付物（改动的文件）

**需要的代码**：
1. Issue CRUD（SQLite）
2. 启动 dsh agent（现有 `DshAcpRuntime`）
3. 独立工作区（现有 `@lachesis/workspace`）
4. 返回 Delivery（改动的文件）

**验证**：
- 创建工单：「修 OCG 的一个 bug」
- Lachesis 启动 dsh → 在独立工作区改代码 → 返回交付物
- 拿到 changes → 自己决定要不要 apply

---

### Week 2：并发 + 第二个 harness

**目标**：
- 同时跑 2 张工单 + 支持 Codex

**需要的代码**：
1. 调度器（全局并发 4，按 `harnessId` 分配容量）
2. Codex adapter（启动 `codex acp`）
3. 工单队列（pending → running，按 FIFO）

**验证**：
- 提交 4 张工单：2 张 dsh、2 张 codex
- 调度器并行跑，各自返回交付物
- 调用方自己决定怎么处理

---

## 核心数据结构（极简版）

```typescript
// Lachesis 只负责这些
interface Issue {
  id: string
  title: string
  description: string
  workspace: string      // git repo 或本地路径
  harnessId: string      // dsh / codex / ...
  status: 'pending' | 'running' | 'completed' | 'failed'
}

interface Delivery {
  id: string
  issueId: string
  status: 'success' | 'failed'
  changes: { path: string, content: string }[]  // 改了哪些文件
  logs: string
}
```

**API（极简）**：
```
POST /issues          → 提交工单
GET  /issues/:id      → 查工单状态
GET  /deliveries/:id  → 拿交付物（改动的文件）
```

**调用方决定怎么用**：
- 人直接用：`lachesis submit "..." → lachesis get delivery-abc → 人看 patch → git apply`
- 主 agent 编排：`await lachesis.submit() → await delivery.waitUntil('completed') → git.apply()`
- 全自动 CI：`lachesis submit --wait → lachesis apply $DELIVERY_ID`

**Lachesis 不需要知道**：
- ❌ 是否需要人验收
- ❌ 什么时候 apply
- ❌ apply 到哪里
- ❌ 条件验证规则

**这些都是调用方的策略，不是 Lachesis 的职责。**

---

## 不要做的事（第一版）

### ❌ 别做验收和 apply 逻辑
- 那是调用方的事，不是 Lachesis 的事
- 人验收、自动验收、条件验收——都交给调用方决定

### ❌ 别做高级调度
- 自动选 harness
- 失败自动切换
- 检查点续跑

### ❌ 别做自己的 harness
- 现在用现成的 dsh、codex
- 优化 harness 是第二阶段的事

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
3. 能拿到 3 份交付物（改动的文件）
4. 调用方能自己决定怎么处理（人看 diff / 自动 apply / CI 集成）
5. **交付物永久保存，可审计**

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
