# 方案成果版本与比较选择

当前可在同一 Task 中保存方案的固定文字成果、可选提交引用与节点明确共享的只读文件对比，查看历史版本、讨论指定版本，并比较和明确选择。适用于已有[独立方案现场与首轮 Run](branch-workspaces.md)的真实项目任务；选择不会启动模型、修改代码、停止其他 Run 或完成 Task。

## 保存与讨论

1. 在「方案分支」中等待来源 Run 确认终止，再点击「保存方案成果」。失败或取消的 Run 也可保留有用内容，界面保留原执行结果；活动、停止中或未知现场不能保存。
2. 核对固定共同起点、实际输入、工具/配置模型、执行状态与已收到的共享输出，填写成果标题、说明和可选已知限制。默认只保存文字与来源；需要代码时明确选择[本方案结束后记录的提交引用](result-code.md)。共同起点不是本轮输出代码，引用不是备份，未提交文件不包含。
3. 保存后方案为 ready，表示已有可查看成果。再次保存生成同一 Result 的新 ResultRevision；每个版本不可改写，Task 后续说明、迟到输出及新版本不会修改旧版。
4. 成果页按固定版本显示正文、来源和反馈。反馈带版本标识，切换和刷新保持对应关系；旧数据中未指定版本的反馈单列展示，不猜测应属于哪一版。普通人工分享也保存初始快照，目前只有方案成果支持在原容器内追加版本。

标题上限160字符、说明6000字符、限制2000字符，整份保存请求最多24 KiB，每个方案最多100个版本。共享输出最多6000字符，终态文本优先，有截取时明确显示；这不是完整终端日志。只读取已共享且在结算截止点内的事件，撤权后或结算后到达的输出不加入。升级前已经结束且没有可靠截止点的 Run 不补造输出来源，只允许保存人工说明及已知来源。

## 比较与选择

从方案组点击「比较与选择方案」。每列独立选择已保存版本，展示原目标、正文、已知限制和来源；新版本到达时提示，不自动替换正在查看的版本。没有固定成果的方案保持缺失提示，不显示虚构评分、差异或预览。

「选用这个版本」打开明确选择窗口，可填写说明；保存的选择指向具体 ResultRevision。比如选中 A 的 v1，后来新增 v2，选择仍是 v1。选择、替换和取消都保留操作者、说明与历史，当前每组最多100条选择记录。selected 由当前选择投影产生，原始分支行保留其执行/成果阶段，不维护另一份可漂移的选择标志。

选择后不会自动继续执行。代码引用及有界两侧文件对比见[固定代码](result-code.md)；节点本人可另行打开[方案接续](branch-continuation.md)，核对固定版本并确认新Run。未许可的接续会因选择变化取消，已许可执行保持原材料。完整diff/预览、AI差异建议和实际选择性应用仍缺；现有[整合预检](integration-preflight.md)明确固定源/目标并检查文件冲突。停止动作由各Run单独处理；查看者可以比较历史，编辑者可保存版本和选择。

## 冲突、权限与兼容

成果保存核对方案、Run 和 Result 修订；选择核对组内选择修订与固定版本归属。冲突保留草稿，核对后再使用新基线；未知回复只确认完全相同的原请求体和幂等键，不能以“再保存一次”创建重复版本/选择。重复成功回执指向原版本/选择，不改写成最新状态。

读、直接 ID、反馈、SSE 和旧回执都按父任务当前权限校验。短暂读取失败保留内容；降权清除临时编辑，仍有读取权时保留历史；撤销读取权清除页面。Result/版本/分支修订/历史/outbox/回执原子提交；选择替换同样原子处理，不产生半次选择。

迁移29保留旧方案和现场，只从旧 Result 的已知正文生成一份 legacy 版本，未知作者、更早版本与旧反馈锚点保持未知。全新示例预览仍明确是演示数据。

## API

| 路径（省略 `/api/v1`） | 用途 |
| --- | --- |
| `GET /tasks/:taskId/work-branches/:branchId/result-preview` | 编辑者读取固定来源与保存基线 |
| `POST /tasks/:taskId/work-branches/:branchId/results` | `expectedRevision`、`expectedResultRevision`、`sourceRunId`、`expectedRunRevision`、`title`、`body`、`limitations`；需幂等键 |
| `GET /results/:resultId` | 当前快照、版本列表、当前版本反馈及未指定版本反馈 |
| `GET /results/:resultId/versions/:revisionId` | 明确读取历史版本及其反馈 |
| `POST /tasks/:taskId/messages` | 可带 `resultId` 和 `resultRevisionId`；二者必须属于同一 Task/Result |
| `GET /tasks/:taskId/work-branches/groups/:groupId/comparison` | 同组方案、版本索引、当前选择与选择历史 |
| `POST /tasks/:taskId/work-branches/groups/:groupId/selection` | `expectedSelectionRevision`、`branchId`、`resultRevisionId`、`note`；取消时两个 ID 都为 null，需幂等键 |

当前验证与本地交付位置见 [21](../development/21-implementation-status.md)，唯一下一项见 [22](../development/22-next-delivery.md)。
