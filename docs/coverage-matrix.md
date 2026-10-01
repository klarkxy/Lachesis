# Lachesis 施工包覆盖矩阵

依据：`Lachesis_施工包_2026-09-23.zip` 的 M0–M5 与 T01–T26。状态按 2026-09-24 的本机代码、测试、真实 OCG 请求和浏览器验收记录判断；详细命令及边界见 [验收记录](acceptance-2026-09-24.md)。

| 阶段 | 完成证据 |
|---|---|
| M0 运行时 | [运行时契约](runtime-contract.md)、固定 dsh/ACP 版本、真实 `minimax-m3` 与 `step-3.7-flash` 请求、同 Profile 并行取消；不支持的强度在 prompt 前拒绝 |
| M1 数据与 Profile | SQLite 迁移、Profile 修订和评分来源；`packages/domain/test/domain.test.ts`；真实工单与配置可重启读取 |
| M2 工单闭环 | HTTP/MCP 持久提交与事件；真实 `minimax-m3` 工单完成权限答复、冻结、验收、评分、集成和显式应用 |
| M3 并发与恢复 | 并发领取及隔离测试、真实并行取消、超时测试、Windows Job 父进程强杀测试、服务独占及强制结束后重启测试 |
| M4 验收与评价 | [评价 ADR](adr-0001-evaluation-attribution.md)、返工与评分修订/聚合测试、真实工单评分 |
| M5 界面与交付 | 浏览器实测真实工单[列表](acceptance-issues.png)与[交付](acceptance-delivery.png)；模拟状态测试覆盖空态、错误重试、排队、待验收、取消中，以及 Profile 连续创建/编辑/复制 |

| 用例 | 主要证据 |
|---|---|
| T01 外部创建 | `packages/mcp/test/adapter.test.ts`；返回持久 ID，调用结束后可查询 |
| T02 幂等提交 | `packages/domain/test/domain.test.ts` 的重复提交断言 |
| T03 点名 Profile | Run 记录 Profile 修订/供应商/模型；ACP 选项核对与真实模型请求 |
| T04 配置不可用 | 禁用 Profile 的创建、重试、返工保护与领域测试 |
| T05 不支持强度 | 真实 `minimax-m3/high` 在 prompt 前拒绝；能力探测与界面默认/选项测试 |
| T06 同 Profile 实例 | 并发领取测试及真实两个 `minimax-m3` ACP 会话 |
| T07 并行隔离 | runtime 工作目录/DSH_HOME 测试、真实并行实例无交叉写入 |
| T08 局部取消 | runtime 取消测试、真实 A 取消而 B 完成、服务端取消竞态测试 |
| T09 提交方退出 | 持久 SQLite 工单、事件游标和独立查询接口；真实闭环跨浏览器读取 |
| T10 重复领取 | `packages/domain/test/concurrency.test.ts` 的并发进程竞争 |
| T11 worker 失联 | 启动/执行/关闭超时及进程范围回收；退出未确认时持久待恢复 |
| T12 迟到交付 | 领域 generation 校验及重启/返工后的拒绝断言 |
| T13 服务重启 | `apps/server/test/recovery.test.ts`：强制结束旧服务、恢复中断、显式重试；独立 Windows Job 崩溃测试 |
| T14 执行结束 | 完成后进入 `awaiting_review`；真实工单冻结后由操作者验收 |
| T15 worker 自评/自验收 | 领域测试拒绝 worker 权限 |
| T16 返工 | 旧 Run/Delivery 保留，workspace 以冻结交付为新尝试起点 |
| T17 一单多 Run | 当前评价按 Issue 聚合，旧 Run 不增加样本 |
| T18 未评分 | Profile 历史无评分时不计 0；领域与界面呈现 |
| T19 修订评分 | 评价历史保留，仅最新有效评价参与汇总 |
| T20 失败评价 | 失败 Run 可被操作者真实评分，无评价时不自动给最低分 |
| T21 行为修订归因 | Run 与评价保留当时 Profile 修订、供应商/模型/强度 |
| T22 展示元数据 | 名称/头像修改不提升行为修订，也不清空评分 |
| T23 头像一致 | 并行 Run 引用同 Profile，界面按其静态头像显示并用 Run ID 区分 |
| T24 敏感信息 | 凭据不入 Profile；事件文本分块不持久化原文，交付整体脱敏；真实 Key 扫描源码/验收数据无原值 |
| T25 真实观测 | 界面只显示已记录状态/事件/时长，没有虚构成本、CPU 或 ETA |
| T26 产品范围 | 只有工单、Profile、实例、验收与设置；未引入游戏机制或技能/persona 表单 |

原先点名的 `step-5-preview` 与 `mimo-v2.6-flash` 在当前 OCG 路由中仍被禁用，未取得成功调用；M0 的两套可用配置由 `minimax-m3` 和 `step-3.7-flash` 完成。未做断电、长期运行、安装包或发布验收。公共 dsh subprocess API 仍不提供跨重启逐个查询旧 Run 范围的身份；恢复依据是 Windows 原生 Job 的父进程终止行为、强杀测试、服务实例独占和不自动重放的领域规则。
