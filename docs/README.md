# Lachesis 文档索引

最后更新：2026-10-02

---

## 当前有效文档

### 核心定位和决策
- **[why-lachesis.md](why-lachesis.md)** ⭐⭐⭐  
  **为什么要做 Lachesis？和云 Agent 的核心区别是什么？**
  - 四大支柱：自托管、Harness 中立、批量并发、交付冻结
  - vs Devin / Cursor / Claude Code / Copilot Workspace
  - 目标用户：企业内网、团队协作、敏感项目、成本敏感

- **[2026-10-01-decision-lachesis-minimal-system.md](2026-10-01-decision-lachesis-minimal-system.md)** ⭐⭐  
  **最小系统设计决策（技术细节）**
  - Harness vs Model 最新研究（GitHub 2026-06）
  - 极简原则：只做「接工单 → 选 harness → 并发执行 → 返回交付」
  - Week 1-2 实施计划

### 调研和参考
- **[unattended-harness-survey-2026-10-01.md](unattended-harness-survey-2026-10-01.md)**  
  同类产品调研（Omnigent、Superset、Vibe Kanban 等）

- **[harness-neutral-plan-2026-10-01.md](harness-neutral-plan-2026-10-01.md)**  
  Harness 中立方案技术细节（已搁置，可参考 B1-B5 技术点）

- **[runtime-contract.md](runtime-contract.md)**  
  运行时契约设计

- **[api-contract.md](api-contract.md)**  
  API 设计

### 历史验收
- **[acceptance-2026-09-24.md](acceptance-2026-09-24.md)**  
  早期验收标准（已过时，仅供参考）

---

## 已归档文档

以下文档已移至 `archive/`，内容已过时，**不要**按这些文档实施：

- ❌ `orchestration-layer-design.md` — 过度设计了协调层
- ❌ `why-not-existing-frameworks.md` — 讨论方向不符合最小系统

---

## 阅读指南

### 如果你想了解「为什么做 Lachesis」
1. **必读**：`why-lachesis.md` ⭐
2. 补充：`unattended-harness-survey-2026-10-01.md`（同类产品对比）

### 如果你想开始实施
1. **必读**：`2026-10-01-decision-lachesis-minimal-system.md` ⭐
2. 参考：`harness-neutral-plan-2026-10-01.md`（技术细节）
3. 参考：`runtime-contract.md`、`api-contract.md`

### 如果你想了解同类产品
1. 读：`unattended-harness-survey-2026-10-01.md`

---

## 重要提醒

⚠️ **只有「当前有效文档」里的内容是可信的**  
⚠️ **archive/ 里的文档已过时，不要按它们实施**  
⚠️ **如有冲突，以 `why-lachesis.md` 和 `2026-10-01-decision-lachesis-minimal-system.md` 为准**

---

## 核心原则（2026-10-02 最新）

**Lachesis 只做一件事**：
- 工单调度系统 + 多 harness 执行
- 提交工单 → 选 harness → 并发执行 → 返回交付物

**Lachesis 不管**：
- ❌ 谁验收
- ❌ 什么时候 apply
- ❌ apply 到哪里
- ❌ 条件验证规则

**这些都是调用方（人/主 agent/CI）的策略，不是 Lachesis 的职责。**
