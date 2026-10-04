/** A small real project with disjoint initial work and genuine integration dependencies. */
export const projectSpec = `# Offline reading list
Build a browser reading list in plain HTML/CSS/JavaScript modules, no packages or build step.
Entries: {id,title,url,tags:string[],done:boolean,createdAt:string}. Store locally; never send data to a server.
Users add/edit/delete entries, toggle read state, search title/url/tags, filter unread, and import/export JSON.
All text rendering must use textContent or equivalent escaping; reject javascript: URLs.
Use concise Chinese labels, keyboard-accessible controls, empty/error messages and responsive layout.
Module interfaces fixed by this specification:
model.mjs: createEntry(input), updateEntry(entry, patch), validateEntries(value).
createEntry returns a new Entry with unique string id, ISO createdAt and done=false by default.
updateEntry returns a validated new Entry, preserving id and createdAt and not mutating the original.
validateEntries returns a validated deep copy of the Entry array, or throws; it does not return a boolean.
storage.mjs: loadEntries(storage=localStorage), saveEntries(entries, storage=localStorage).
filters.mjs: filterEntries(entries,{query='',unreadOnly=false}={}).
transfer.mjs: exportEntries(entries), importEntries(text).
JSON import/export uses the Entry array directly, without an envelope object; importEntries returns the validated array.
view.mjs: mountList(root,{onToggle,onDelete,onEdit}), returning {render(entries)}.
main.mjs composes the modules and HTML controls; styles.css supplies presentation.
tests.mjs runs with node tests.mjs, uses node:assert/strict and mocked storage.
Preserve SPEC.md. No network dependencies, no git changes, no credentials.
`

export const liveTickets = [
  { key: 'model', title: '建立条目模型与校验', paths: ['model.mjs'], deps: [],
    request: '实现 SPEC.md 中 model.mjs 的接口。检查标题非空、http/https URL、字符串标签、唯一 ID 和时间；更新时保留 ID/createdAt；validateEntries 拒绝非法数组、重复 ID 和危险 URL。运行 node --check model.mjs。' },
  { key: 'storage', title: '本地保存与损坏数据处理', paths: ['storage.mjs'], deps: ['model'],
    request: '实现 storage.mjs，使用 reading-list-v1 键，调用 model 校验。无数据返回 []；坏 JSON 或格式错误抛出有用错误，不覆盖坏数据。保存失败向调用者抛错。运行语法与 mock storage 检查。' },
  { key: 'filters', title: '搜索与未读筛选', paths: ['filters.mjs'], deps: ['model'],
    request: '实现 filters.mjs：不改变原数组或条目；大小写无关搜索标题/URL/标签；unreadOnly 只返回 done=false。运行实际断言检查。' },
  { key: 'view', title: '安全可访问的列表展示', paths: ['view.mjs'], deps: ['model'],
    request: '实现 view.mjs，使用 DOM API/textContent 安全展示标题/标签/URL，链接 rel=noopener，提供阅读切换、删除、编辑按钮与空列表提示；回调带条目 ID。返回 render(entries)，多次 render 不重复事件回调。运行 node --check view.mjs。' },
  { key: 'styles', title: '响应式阅读清单样式', paths: ['styles.css'], deps: [],
    request: '实现 styles.css，支持 main/header/form/.toolbar/#list/.entry/.tags/.actions/#message 等容器；简洁、可读、手机布局、明显焦点、长 URL 换行、错误提示。只修改 styles.css。' },
  { key: 'transfer', title: 'JSON 导入导出', paths: ['transfer.mjs'], deps: ['model'],
    request: '实现 transfer.mjs。exportEntries 返回可读 JSON，importEntries 解析并调用 validateEntries，拒绝坏数据而不修改原有集合；返回深复制条目。运行实际合法及非法输入检查。' },
  { key: 'shell', title: '组合完整浏览器操作流程', paths: ['index.html', 'main.mjs'], deps: ['storage', 'filters', 'view', 'styles', 'transfer'],
    request: '实现 index.html 与 main.mjs，组合所有现有模块。提供新增/编辑/删除、阅读切换、搜索/未读筛选、JSON 下载和文件导入（明确替换提示）、保存失败/损坏数据提示。原有数据坏时不自动覆盖。无外部依赖；事件可访问；添加失败保留输入；成功后保存并渲染。运行 node --check main.mjs。' },
  { key: 'tests', title: '真实模块回归测试', paths: ['tests.mjs'], deps: ['storage', 'filters', 'transfer'],
    request: '实现 tests.mjs，使用 Node assert，覆盖模型校验/危险 URL/更新字段保护、storage 空/坏/写失败、组合筛选不变异、导入导出及重复 ID。必须运行 node tests.mjs；检查发现产品问题时报告具体失败，不修改其他工单所有的文件。' },
  { key: 'guide', title: '使用说明与启动方式', paths: ['README.md', 'serve.mjs'], deps: ['shell'],
    request: '实现 README.md 中文使用说明和无依赖 serve.mjs：node serve.mjs 在 127.0.0.1:47942 服务当前目录，正确 HTML/CSS/JS MIME，拒绝目录穿越，不绑定公网；说明 node tests.mjs 与浏览器使用、JSON 备份和损坏存储处理。运行 node --check serve.mjs。' },
  { key: 'audit', title: '组合验收与最终检查记录', paths: ['ACCEPTANCE.md'], deps: ['shell', 'tests', 'guide'],
    request: '只阅读现有实现，运行 node tests.mjs 与所有 .mjs 语法检查。将具体命令、结果、发现的问题写入 ACCEPTANCE.md，不宣称未运行的浏览器操作通过。不修改其他文件。' },
]
