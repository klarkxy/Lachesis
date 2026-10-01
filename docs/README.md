# Lachesis 文档索引

最后更新：2026-10-01

## 当前有效文档

### 核心决策
- **[2026-10-01-decision-lachesis-minimal-system.md](2026-10-01-decision-lachesis-minimal-system.md)** ⭐
  - **最小系统设计决策**
  - 取代所有之前的架构讨论
  - 工单系统 + 多 harness + 审慎执行流程
  - Week 1-2 实施计划

### 技术参考（仍有效）
- **[unattended-harness-survey-2026-10-01.md](unattended-harness-survey-2026-10-01.md)**
  - 同类产品调研（Omnigent、Superset、Vibe Kanban 等）
  - 权限、隔离、多 harness、交付流程对比
  - 2026-10-01 调研记录

- **[harness-neutral-plan-2026-10-01.md](harness-neutral-plan-2026-10-01.md)**
  - 多 harness 施工计划（已搁置，但 B1-B5 技术细节可参考）
  - Codex adapter 实现参考
  - 权限策略、上下文管理设计

- **[runtime-contract.md](runtime-contract.md)**
  - 运行时契约（dsh 相关，部分仍有效）

- **[api-contract.md](api-contract.md)**
  - HTTP/MCP API 合约

### 验收记录（历史参考）
- **[acceptance-2026-09-24.md](acceptance-2026-09-24.md)**
  - 2026-09-24 验收记录
  - M0-M5 覆盖矩阵

- **[coverage-matrix.md](coverage-matrix.md)**
  - 覆盖矩阵（T01-T26）

- **[program-repair-acceptance-2026-09-25.md](program-repair-acceptance-2026-09-25.md)**
  - 程序修复验收

- **[reading-ledger-real-run-2026-09-24.md](reading-ledger-real-run-2026-09-24.md)**
  - 真实运行日志

- **[repair-and-concurrency-plan-2026-09-24.md](repair-and-concurrency-plan-2026-09-24.md)**
  - 修复与并发计划

- **[adr-0001-evaluation-attribution.md](adr-0001-evaluation-attribution.md)**
  - ADR-0001：评价归因

---

## 已归档文档（过时，仅供参考）

### archive/
- **orchestration-layer-design.md** ❌
  - 协调层架构设计（已过时）
  - 被 2026-10-01 决策取代
  - 过度设计了「检查点」「续跑」「peer 通信」等高级功能

- **why-not-existing-frameworks.md** ❌
  - 为什么不用现有框架（已过时）
  - 被 2026-10-01 决策取代
  - 讨论方向不符合最小系统定位

---

## 阅读指南

### 如果你要开始实施 Lachesis：
1. **必读**：`2026-10-01-decision-lachesis-minimal-system.md`
2. **参考**：`harness-neutral-plan-2026-10-01.md` 的 B1-B5（Codex adapter 实现）
3. **了解背景**：`unattended-harness-survey-2026-10-01.md`（同类产品对比）

### 如果你要理解现有代码：
1. `runtime-contract.md`（运行时契约）
2. `api-contract.md`（API 设计）
3. `acceptance-2026-09-24.md`（验收标准）

### 不要读的文档：
- `archive/` 下的所有文档（已过时，会误导方向）

---

## 重要提醒

⚠️ **2026-10-01 之前的所有架构讨论文档已过时。**

新的最小系统设计：
- 不做「协调层」「检查点续跑」「主动通知」
- 不做「自己的 harness」「递归工单」「浏览器验收」
- **只做**：工单系统 + 多 harness (dsh + codex) + 冻结交付 + 人验收 + 显式 apply

**聚焦 2 周内跑通最小系统，再决定要不要继续。**
