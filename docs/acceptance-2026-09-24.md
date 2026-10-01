# 2026-09-24 施工验收记录

依据：`Lachesis_施工包_2026-09-23.zip` 的 M0–M5、T01–T26。工作区为 Windows、Node 24.16.0、pnpm 10.29.2；Lachesis 使用固定的 dsh `0.1.7-alpha.2` 与 ACP SDK `1.4.0`。本记录区分确定性测试、真实模型请求和界面截图。

## 已运行

| 验证 | 结果 |
|---|---|
| `pnpm check` | 7 个包类型检查通过 |
| `pnpm build` | 7 个包构建通过，Web 产物生成 |
| `pnpm test` | 最终 83/83 通过：MCP 6、runtime 18、domain 18、workspace 25、server 16 |
| Windows runtime 崩溃测试 | 观察到原生 Job runner；强杀父进程后 runner、ACP worker 和持续写入心跳的子进程退出 |
| 数据目录独占 | 第二个实例在业务库恢复前被拒绝；第一实例状态不变，退出后可重新取得租约 |
| 完整启动重复实例 | 两个 `scripts/start.mjs` 使用同一数据目录、不同端口；第二个非零退出并关闭监听，第一实例健康接口继续返回 200 |
| 同端口旧健康接口 | 预先放置返回旧 `product` 值的本机服务；新启动因本次 `launchId` 不匹配非零退出，不误报已就绪 |
| 取消期间状态变化 | 在关闭 worker 期间注入权限问题，使工单版本递增；取消仍终结工单，终止后的待答问题不再展示，也不能被提交 |
| 交付与事件脱敏 | 合成凭据拆分在两条 ACP 文本事件中；事件仅保存文本更新元数据，完整回复与摘要均将凭据替换为 `[redacted]` |
| Profile 能力查询 | 真实 `minimax-m3` 与 `step-3.7-flash` 经无 prompt ACP 会话探测，均返回无可选强度；供应商默认保留，隔离进程范围退出 |
| Profile 能力 HTTP | 本机 HTTP 入口以浏览器 Cookie 和 CSRF 返回 200、真实 `minimax-m3` 无可选强度；相同入口用外部令牌返回 403 |
| 探测退出未确认 | 首次探测报告 `range_unconfirmed` 后同一实例第二次请求直接拒绝，没有再启动 worker；停机保留数据目录独占 |
| 强制结束服务后重启 | 旧进程的目录独占被 OS 释放；新服务将原 Run 标为中断、工单标为失败，不自动重放；显式重试才生成第 2 次 Run。此项与独立 Windows Job 子进程强杀测试共同覆盖服务与 worker 的恢复边界 |
| 本机 Gateway Key 残留检查 | 用实际 Key 值在内存中扫描 191 个源码/文档类文本文件及真实验收数据目录的 85 个文件（含 SQLite）；均未发现原值，未打印 Key |

## 真实 OCG 模型调用

本机开发 OCG 当时监听 `127.0.0.1:19042`。使用只在子进程环境中提供的 Gateway Key、隔离 `DSH_HOME` 与 `local-ocg` 的 OpenAI Chat Completions 路由；密钥未写入 Profile、工单或本文。

| 模型 | OCG 路由检查 | ACP 结果 |
|---|---|---|
| `minimax-m3` | 目录可见，有可用候选 | 回复成功，`end_turn`，事件可读，范围退出确认 |
| `step-3.7-flash` | 目录可见 | 回复成功，`end_turn`，事件可读，范围退出确认 |
| `step-5-preview` | 目录不可见，候选均报告 `mapping_protocol_incompatible` | 会话建立，prompt 报连接错误，未产生交付 |
| `mimo-v2.6-flash` | 目录不可见，候选均报告 `mapping_protocol_incompatible` | 会话建立，prompt 报连接错误，未产生交付 |

继续施工时重新读取 OCG `/v1/models`（HTTP 200）：`minimax-m3` 与 `step-3.7-flash` 可见，`step-5-preview` 与 `mimo-v2.6-flash` 仍不可见。`step-3.7-flash` 使用独立 ACP 会话完成短请求；给 `minimax-m3` 显式指定不支持的 `high` 强度，dsh 在 prompt 前明确拒绝。两套成功配置均使用供应商默认强度。未改动正在运行的 OCG 配置。

`minimax-m3` 完整工单在隔离普通目录项目中运行：工单被领取，模型请求的两次工具权限由操作者答复，执行结束后冻结 `proof.txt`。验收脚本先读取冻结文件，确认恰好 23 字节、原有两个文件未改动；随后才验收并评 5 分。集成和显式应用均通过项目自带的 `node verify.mjs`，目标目录最终只新增 `proof.txt`，内容为 `Lachesis OCG run passed`。第一次探索性运行虽也走通状态链，但文件缺少该次要求的换行且脚本过早验收，因此不计作内容验收；上述第二次验证修正了这个错误，命令退出码为 0。

另启动两个同 Profile、同 `minimax-m3` 的真实 ACP 实例，分别使用独立工作目录和 `DSH_HOME`。A 在流式回复中被局部取消，B 同时完成短回复并以 `end_turn` 结束；A 的 prompt 被关闭、B 未受影响，两个进程范围都确认退出，两个工作目录均无交叉文件。此项证明的是实际并发与局部取消，不替代第二个不同模型配置的验收。

浏览器在测试数据上完成本机配对，列表、交付、评分和应用状态均可读取。截图：[真实工单列表](acceptance-issues.png)、[冻结交付与文件](acceptance-delivery.png)。截图只证明界面展示；模型调用、字节核对和测试结果以上述独立记录为准。

另在同一构建产物上使用浏览器局部 API 模拟逐项验收 M5 状态：无工单、列表错误及重试、排队、待验收、取消请求中到已取消，均通过。Profile 表单连续创建、连续编辑和连续复制通过；能力探测无选项时禁用强度并显示供应商默认，有选项时可保存所选强度。模拟状态截图：[排队](acceptance-m5-queued-mock.png)、[待验收](acceptance-m5-review-mock.png)、[取消中](acceptance-m5-cancelling-mock.png)。这些截图仅证明前端状态交互，真实模型和后端闭环以上述单独记录为准。

## 边界与未完成项

- M0 要求的两套用户可用模型配置已由 `minimax-m3` 与 `step-3.7-flash` 成功执行；原先点名的 `step-5-preview` 与 `mimo-v2.6-flash` 仍需 OCG 管理者启用可用协议后才能单独重测。OCG 配置是独立持久设置，Lachesis 未擅自修改。
- M3 已通过实例独占、超时回收、迟到结果保护和本机 Windows Job 崩溃测试。运行前强制探测原生 Job；若某次退出仍无法确认，工单持久进入「待恢复」且同一实例不能重试。服务重启会把旧活动 Run 标为中断，保留记录，不自动续跑。当前公共 subprocess API 不暴露每个旧 Run 可跨重启查询的范围身份，因而重启标记不能当作逐一核实退出的证明。
- Profile 表单通过无 prompt ACP 能力查询提供可用强度；未查询或模型不支持时显示供应商默认，既有非默认设置须重新核对或显式改回默认。ACP 在发出模型 prompt 前仍会再次核对，不支持时明确失败并写入工单事件。
- 未进行断电、长期运行、安装包或正式发布验收。没有创建 Git 仓库、提交、推送或部署。
