# 全局搜索与分页

点击全局搜索或按原快捷键。默认任务类型，输入Task标题、说明或编号；也可明确选择成果或约定（当前记录）类型。选择全部当前可见任务、无项目个人任务或当前项目，先显示最多30项，点击「加载更多任务」继续；状态说明当前已显示数量和是否还有结果，最后显示「已加载全部结果」。追加成功焦点进入第一条新任务，原Task按钮继续进入同一详情。

首次读取失败可「重试搜索」；追加读取失败保留已显示行，点「重试加载更多」重取同一游标。结果内容或顺序变化导致游标失效时，旧批次清空，点「重新搜索」从当前第一批开始。切换关键词、清空、关闭/重开或当前匹配Task投影变化都会取消旧读取并从首批开始，不保存历史搜索快照。

## 查询边界

沿用现有GETsearch和Store.tasks当前可见集合，字段为标题、说明、编号的原拼接文本，范围先取项目/无项目交集，此Task路径不新增全文索引或权限规则。原rowid降序保持，同时间戳不改顺序。q去首尾空白、最多160字符、原locale小写规则；每页30，响应items和nextCursor。

cursor为最多1024字符的v1有界书签，绑定规范化查询和范围、当前有序匹配Task DTO摘要与最后Task ID。非法/跨查询书签为INVALID_CURSOR/400；当前匹配序列或DTO变化为SEARCH_RESULTS_CHANGED/409。它不是访问授权、不可变历史或保留时钟期限的快照。每次读取重新取得原当前集合；没有schema迁移或业务写入。其他范围或不匹配Task变化不使本搜索游标失效。

## 范围与命中依据

全部范围保持原当前可见Task集合，包括无项目Task。显式选择的项目来自当前已加载项目列表，归档项目仍有标识；当前项目选项不可用时提示并清空旧结果，保留选择供用户修正，不自动扩大为全部范围。切范围从首批开始，旧范围的普通迟到响应不混入。范围和关键词只在当前弹窗保留，关闭重开恢复全部范围与空查询。

每行显示当前项目或个人来源、Task编号和当前修订；标题和编号各自均未独立命中时，说明独立命中给出有界纯文本片段。匹配仍由原标题＋说明＋编号拼接规则决定，片段不能改变结果集合。跨字段命中而没有独立说明片段时保持结果，不编造命中或历史修订。

HTTP范围参数为scope=all|personal|project，缺省all；project必须带projectId，另外两种不接受projectId。无效范围明确400；合法无结果项目为空页。跨范围游标400，当前范围内容变化409；旧q-only书签在升级后明确重搜。

## 当前成果类型

选择「成果（当前版本）」后，关键词匹配当前成果标题、说明或关联Task当前标题/编号。沿同一项目/无项目范围分页，保留Result原顺序；缺少当前父Task时不归入个人成果。切类型保留关键词/范围，取消旧读取并清除旧页；关闭重开仍回到默认任务与空查询。

行中显示成果当前版本数字、Task标题/编号和项目/个人来源。只有标题或关联Task字段没有独立命中时才展示有界正文片段；高亮纯文本，不检索历史。示例预览成果标明示例；点击进入原成果详情，现有详情可使用真实版本ID的固定链接，搜索不拼造该ID。

同一端点使用可选type=task|result|agreement，缺省task保持旧响应/书签；Result响应items是当前Result加最小task上下文。Result游标另绑定type=result及相关父Task来源字段；当前来源变化也会使页失效，未参与展示/匹配的其他内容不影响当前序列。

## 验证入口

- [契约](../../packages/contracts/src/task-search.ts)、[共享matcher](../../packages/domain/src/task-search.ts)、[纯分页](../../packages/db/src/task-search.ts)
- [命令入口](../../apps/web/src/command-menu.tsx)、[普通分页会话](../../apps/web/src/search-pages.ts)、[Task投影](../../apps/web/src/task-search-pages.ts)、[Result投影](../../apps/web/src/result-search-pages.ts)
- [Task SQLite/HTTP回归](../../tests/task-search-pagination.test.ts)、[Task浏览器流程](../../tests/e2e/task-search-pagination.spec.ts)、[当前Result回归](../../tests/current-result-search.test.ts)、[Result浏览器流程](../../tests/e2e/current-result-search.spec.ts)
- [Task分页证据](../development/history/2026-10-04-task-search-pagination.md)、[Task范围证据](../development/history/2026-10-04-task-search-scope.md)、[当前Result记录](../development/history/2026-10-04-current-result-search.md)、[当前验收](../development/21-implementation-status.md)

15-04整项仍部分实现；PR68/69已闭合Task搜索分页、范围与来源辨认，本轮当前Result入口以[记录](../development/history/2026-10-04-current-result-search.md)为准，不宣称需求、消息、约定等多资源统一搜索已完成。


## 约定当前记录

选择「约定（当前记录）」后，可在全部当前可见项目或一个当前项目中检索现有约定标题/正文，按原标题加空格加正文的文字规则匹配。结果包含当前有效、已停用和已替代记录，逐行标明状态、真实修订和项目来源；「当前记录」不等于规则当前有效。正文首处独立命中给出有界纯文本上下文，标题已独立命中时不重复显示正文片段；不检索来源讨论节选或旧修订文字。

每页最多30项，支持原「加载更多约定」、错误重试、变化后重新搜索和焦点行为。点击沿原项目约定地址打开当前详情，停用/替代记录也可定位；这不是固定历史修订链接，不会发布、采用或加入模型材料。

无项目个人范围没有项目约定。切换类型仍保留该选择并明确提示先选全部或项目，UI不发约定请求，直接API也明确拒绝；不能把个人选择偷偷扩大为全部。当前项目不可用时继续说明不可用，不选别的项目代替。

读取依赖已有Workbench响应中的可选项目约定版本数字；没有元数据时说明当前不可用，请刷新后再试，不编造版本0。普通刷新传来相关项目约定版本/来源标签变化时取消旧页并重读首批，其他Task或选定范围外项目变化保留当前页。同项目的其他约定变化也可能重读，这是项目粒度信号，不能当作查询专属或永远实时的保证。实际检查见[约定查找记录](../development/history/2026-10-05-current-agreement-search.md)。
