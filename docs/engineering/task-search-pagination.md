# Task搜索与分页

点击全局搜索或按原快捷键，输入Task标题、说明或编号。选择全部当前可见任务、无项目个人任务或当前项目，先显示最多30项，点击「加载更多任务」继续；状态说明当前已显示数量和是否还有结果，最后显示「已加载全部结果」。追加成功焦点进入第一条新任务，原Task按钮继续进入同一详情。

首次读取失败可「重试搜索」；追加读取失败保留已显示行，点「重试加载更多」重取同一游标。结果内容或顺序变化导致游标失效时，旧批次清空，点「重新搜索」从当前第一批开始。切换关键词、清空、关闭/重开或当前匹配Task投影变化都会取消旧读取并从首批开始，不保存历史搜索快照。

## 查询边界

沿用现有GETsearch和Store.tasks当前可见集合，字段为标题、说明、编号的原拼接文本，范围先取项目/无项目交集，不新增全文索引、其他资源或权限规则。原rowid降序保持，同时间戳不改顺序。q去首尾空白、最多160字符、原locale小写规则；每页30，响应items和nextCursor。

cursor为最多1024字符的v1有界书签，绑定规范化查询和范围、当前有序匹配Task DTO摘要与最后Task ID。非法/跨查询书签为INVALID_CURSOR/400；当前匹配序列或DTO变化为SEARCH_RESULTS_CHANGED/409。它不是访问授权、不可变历史或保留时钟期限的快照。每次读取重新取得原当前集合；没有schema迁移或业务写入。其他范围或不匹配Task变化不使本搜索游标失效。

## 范围与命中依据

全部范围保持原当前可见Task集合，包括无项目Task。显式选择的项目来自当前已加载项目列表，归档项目仍有标识；当前项目选项不可用时提示并清空旧结果，保留选择供用户修正，不自动扩大为全部范围。切范围从首批开始，旧范围的普通迟到响应不混入。范围和关键词只在当前弹窗保留，关闭重开恢复全部范围与空查询。

每行显示当前项目或个人来源、Task编号和当前修订；标题和编号各自均未独立命中时，说明独立命中给出有界纯文本片段。匹配仍由原标题＋说明＋编号拼接规则决定，片段不能改变结果集合。跨字段命中而没有独立说明片段时保持结果，不编造命中或历史修订。

HTTP范围参数为scope=all|personal|project，缺省all；project必须带projectId，另外两种不接受projectId。无效范围明确400；合法无结果项目为空页。跨范围游标400，当前范围内容变化409；旧q-only书签在升级后明确重搜。

## 验证入口

- [契约](../../packages/contracts/src/task-search.ts)、[共享matcher](../../packages/domain/src/task-search.ts)、[纯分页](../../packages/db/src/task-search.ts)
- [命令入口](../../apps/web/src/command-menu.tsx)、[普通分页会话](../../apps/web/src/task-search-pages.ts)
- [临时SQLite/HTTP回归](../../tests/task-search-pagination.test.ts)、[真实浏览器流程](../../tests/e2e/task-search-pagination.spec.ts)
- [本轮证据](../development/history/2026-10-04-task-search-pagination.md)、[当前验收](../development/21-implementation-status.md)

15-04整项仍部分实现；PR68已闭合Task搜索继续分页，本轮范围与来源辨认仍以[当前记录](../development/history/2026-10-04-task-search-scope.md)为准，不宣称需求、消息、约定等多资源统一搜索已完成。
