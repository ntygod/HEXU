# 11｜跨工具继续与临时协助

> D1 · M2 · 关联 HX-F05/F06/F08 · 依赖：05、07、08、09、10。  
> [计划入口](README.md) · [跨人接手](12-handoff-sharing.md) · [并行](13-parallel-exploration.md)

## 1. 两个动作，不能混淆

**继续：**替换接下来推进当前主工作的人/工具，保留 Task 与必要代码现场。  
**协助：**针对一个问题增加参与者，不改变负责人或主执行者，不默认获得活动代码写入权。

默认常见切换尽量一步完成。检查在后台做，只有缺条件时打开针对性处理面板；不每次让用户填写一份正式交接文档。

## 2. 同机继续流程

用户选择目标工具和可用模型，服务取得当前 Task revision、workingCopy、previousRun 和必要 ContextBundle。检查原写入是否结束、目标配置是否可用以及数据范围是否改变。

条件满足：复用同一 WorkingCopy，记录当前改动快照，创建 previousRunId 关联的新 Run。无需推送提交、强制创建 Handoff 或把整个目录上传云端。同工具可恢复有效 NativeSession；跨工具总是使用自身原生会话和公共上下文。

仍有活动执行：展示“停止当前执行后继续”，用户选择后进入 waiting_for_stop；收到真实终态后再次检查配置与目录再启动。原写入状态未知就停留在需要处理，不自行释放锁。

跨节点/成员则转到 12；只改模型也记录新的配置边界。自动默认只限用户授权范围，不因额度不足或配置失效静默切换到其他付费主体。

## 3. 服务命令

`POST /tasks/:taskId/continuations` 接收目标配置、源 Run、工作区、上下文选择及 onActiveRun=wait/request_stop。返回 operationId、状态、blockers 与可用下一步。准备与开始解耦，GET operation 可以恢复刷新前的过程。

operation 用幂等键，并在真正开始前重新核对 Task revision、工作区版本和权限。仅标题等无关改变可更新展示；会影响继续材料的变化需要重建上下文，不能把过期计划直接执行。

## 4. 临时协助流程

用户从消息、报错、文件、diff 或成果选择“请协助”，填写简短问题，选择同事或 AI，预览将分享的材料。默认分享引用的固定版本和必要摘录，不附整段私有历史。

Assistance 保存 requester、recipient、task、selectedSnapshot、targetRevision 和 open/responded/closed/cancelled。对真人可发送可见范围内的线程链接；对 AI 创建 purpose=assist 的 Run，输出只回到该协助线程。

接收者本来没有项目权限时，使用只对协助快照和回复有效的 AccessGrant，不因被提及获得完整 Task/Project API 访问。完整任务页面显示无权，协助入口仍可在有效授权内查看所选材料；撤销后停止后续访问。

AI 协助默认文本材料、真正只读环境或隔离副本。不支持可靠只读边界时禁用本机活动目录模式并解释；prompt 中的“请不要修改”不是隔离。需要改代码时引导用户转为并行分支或接手。

## 5. 回应和采纳

回应可为讨论或 Result 引用。用户能继续追问、复制、局部采用、忽略；“采纳”只是把建议放入当前工作说明或生成用户可确认的改动，不自动修改主分支或设为团队约定。

材料版本变化只标注建议基于哪个旧版本，不自动退回任务、不触发验收。取消协助如有活跃 Run，应发停止请求并继续显示真实运行情况；撤销分享不宣称能删除别人已经看过的内容。

## 6. 六个工作项

| ID | 工作内容 | 产物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-11-01 | 继续命令、目标配置、预检 blockers、幂等操作状态 | continuation service/API | 05、07、08、09 |
| HX-DEV-11-02 | 同机复用现场、原生恢复/新会话、停止后接续与重新打开 | continuation runner integration | 11-01、06、10 |
| HX-DEV-11-03 | Assistance、选中快照、受邀范围与有限 AccessGrant | assistance API、schema | 05、03 权限 |
| HX-DEV-11-04 | 真人回复与 AI assist Run、只读/隔离限制和结果回写 | assistance execution/thread | 11-03、07 |
| HX-DEV-11-05 | 继续/协助面板、模型配置、材料预览和就地回复 | 两类 ActionDrawer | 02、10、11-01/03 |
| HX-DEV-11-06 | 采纳/追问/取消、过期快照提示、失败后保留材料 | assistance actions、恢复 UI | 11-02—05 |

## 7. 场景走读

“订单导出”用 Claude 完成页面后，用户选 Codex 继续异步逻辑：仍是同任务、同目录、新 Run；不创建新需求和验收流程。用户选中一个报错请同事看：只新增协助线程，原负责人和运行不变。

本包是核心产品能力，不是资源设置页里两个 Logo 的切换。费用信息可获得时展示来源，不在开始前伪造精确报价。

## E1c 当前实现子集

`POST /tasks/:taskId/continuations` 现返回 **202 + 持久化 Operation**；必须显式选择 `onActiveRun=wait/request_stop`。`GET /operations/:id`、`GET /tasks/:taskId/continuations` 与带 expectedRevision/幂等键的 `POST /operations/:id/cancel` 已接入。E1b 返回 201+Run 的旧接续契约已经迁移；普通 `/runs` 创建仍返回 201，且同样受接续预约保护。

同机双向跨工具继续支持等待/停止、刷新、取消、启动前重查和事务关联。原进程未知不释放目录锁；重启将待接续操作转为需要处理，保留要求但不自动启动。任务修订或人工上下文变化采取保守阻止，标题变化也需要重新配置；这不是最终的细粒度影响判定。

11-01/02/05 仍为部分实现：没有完整共享上下文选择、团队权限、同工具原生 resume 或协助面板。11-03/04/06 尚未实现，本轮接续取消不计作协助取消。真实模型生成仍未联调。工程结果见 [21](21-implementation-status.md)，逐项状态见 [19](19-work-items.md)。
