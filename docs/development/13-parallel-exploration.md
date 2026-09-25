# 13｜并行探索、方案对比与选择性整合

> D1 · M3 · 关联 HX-F05/F07 · 依赖：06、07、10、11 与 14 的基础成果。  
> [计划入口](README.md) · [工作区](06-runner-workspaces.md) · [成果](14-results-feedback.md)

## 1. 用户目标

围绕同一个目标探索不同实现或拆分独立工作。用户看到每条路径的目标、工具、实际产物和差异，可以选择继续，不是同时多开几个终端。

示例：订单大数据量导出，方案 A 分批同步读取，方案 B 后台异步任务。不是默认宣称某工具方案更优；比较维度来自实际方案和用户关心的要求。

## 2. 分支模型

WorkBranch 关联 taskId、共同起点、目标、agentProfileId、workingCopyId、runId、resultId/revision 和 planned/active/ready/selected/discarded。ready 只代表存在可查看结果，不代表质量合格。

共同起点必须明确。存在未提交变更时，先捕获被选择的快照再派生，不能让一条分支包含未提交代码、另一条只有 HEAD 而仍声称相同起点。纯文本探索可没有 Git 目录，但材料版本保持一致。

有代码写入的每条分支拥有独立 WorkingCopy。数据库、端口、缓存和凭证不能盲目共享；创建预览由资源登记分配。并发和预算按节点与任务配置限制，排队不等于运行。

## 3. 创建与调度

`POST /tasks/:taskId/work-branches` 接受共同 checkpoint/materialRevision 与多个 branch specs。事务先写 planned 分支，异步准备各自工作区；部分准备失败保留其他成功结果，不把整组无提示重做。

执行使用 07/适配器，不单独建设第二套调度系统。选择工具和模型引用实际可用配置；高级用户可设置分支专属说明，不默认给所有 Agent 发送全部历史。

## 4. 比较与选择

对比页上方显示共同目标与起点，每列展示摘要、可取得的代码差异、预览和已知限制。AI 可以整理差异表，但标为可编辑建议；不生成没有来源的性能数值、胜率或评分。

选中方案是一次选择记录，可以选择在其 WorkingCopy 继续；不自动合并主分支、不自动停止其他 Run。界面另外提供停止其他执行、保留结果和丢弃目录操作。仍运行的分支即使 discarded 也保留活动提示直至真实停止。

## 5. 选择性整合

明确 target WorkingCopy、source branch/result revision、selected commits/files/patch。整合前保存目标检查点并获取写入权；源仍变化时使用固定结果快照，不读取活动目录拼补丁。

在临时整合目录或独立集成分支试应用，生成差异供用户查看；冲突进入 conflict 状态，不默认自动选择任一方。用户选择应用后在目标版本仍匹配时写入；不匹配重新计算。中途失败保留可恢复起点，不对用户目录盲目强制回滚。

IntegrationOperation 状态 queued/preparing/awaiting_choice/applying/conflict/completed/failed/cancelled。它是代码操作，不是产品验收；completed 表示选定变更已应用，不能替用户判定代码质量。

## 6. 六个工作项

| ID | 工作内容 | 产物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-13-01 | 分支 schema、共同起点和创建接口 | WorkBranch API/迁移 | 06、07、14 基础 |
| HX-DEV-13-02 | 独立现场准备、资源分配、并发排队与执行关联 | branch coordinator | 13-01、06 |
| HX-DEV-13-03 | 分支输出、Result 关联、材料版本和部分失败处理 | branch result binding | 13-02、14 |
| HX-DEV-13-04 | 方案对比页、AI 可编辑差异说明、选择继续 | compare UI/API | 13-03、10/11 |
| HX-DEV-13-05 | 选择性整合、固定源版本、目标锁、冲突与恢复 | IntegrationOperation | 13-03、06 |
| HX-DEV-13-06 | 独立停止/丢弃、活动提示、清理前未保存变更保护 | lifecycle/cleanup UI | 13-02—05、07 |

## 7. 不做什么

不建立模型排行榜；不以两个模型同意触发自动合并；不把工作区独立等同完整环境隔离。没有需要时，用户仍可只使用一个工具、一条工作线。

并行入口清楚但不默认自动启动多次付费执行。质量与方案选择归团队，HEXU 负责把差异和操作后果呈现清楚。
