# 16｜协作模板、有界自动化与外部集成

> D1 · M4；基础 Git 引用在 M1 已由 03/04 提供 · 关联 HX-F07/F12 · 依赖：05、07、11、13、14。  
> [计划入口](README.md) · [公共 API](18-data-api-catalog.md) · [节点运行](17-remote-deployment.md)

## 1. 用户目标

将常用的“整理材料—实现—汇总”保存下来再次使用，也能将已有 Git、通知和需求来源接进任务。模板是高级能力，用户不必先创建虚拟公司或流程图才能开发。

## 2. 模板数据与编辑

WorkflowTemplate/TemplateRevision 保存名称、说明、输入字段、步骤和连接。步骤类型先支持 agent、human_reply、artifact、bounded_parallel；外部发布动作通过受控连接器执行，不用任意脚本字符串充当配置。

每个 step 保存目标、输入映射、输出 schema、工具配置引用、权限上限、超时、重试和 optional 标记。模板保存时检查节点引用与循环；初期优先列表式步骤编辑，不先建设复杂通用流程绘图器。

WorkflowInstance 锁定 templateRevision，运行期间修改模板不影响已启动实例。用户跳过非必需步骤时检查下游是否有输入替代，不让缺字段被静默编造。所选工具仍依据实际能力。

## 3. 调度复用与边界

每个 AI step 创建普通 Run，串行/并行使用同一 07 调度；输出是 Result/ContextBundle，不建立第二套日志或执行状态。真人步骤进入待回复，而不是普通审批中心。

实例配置最大并行、最大迭代、总时长与费用提示。持续失败、材料不足或无法收敛时暂停派发并解释，用户可调整再继续。自动恢复不能扩大原有 scope，其他 Agent 的消息不能产生新授权。

重试只对明确可安全重复的步骤启用；有外部影响的调用先查询结果。实例取消需要逐个请求停止活跃 Run，直到确认前保留真实状态，不能只把父状态写成 cancelled 后隐藏子进程。

## 4. 连接器体系

Connection 保存 provider/instance、账号引用、授权资源和同步方式。ExternalReference 用 provider+instance+remoteId 唯一识别对象，避免不同 GitLab 实例编号相同。

原生 Git 仓库和提交引用先可用；托管平台 PR/MR、可选 CI、需求导入、通知与发布链接分连接器实现。首个连接器可以选择公司实际使用的平台，其他平台通过同一端口扩展，不能承诺所有厂商 API 等价。

每个对象明确 read_only / import_once / event_sync。外部需求进入 HEXU 时只创建一次映射；后续事件按来源版本与字段归属更新，不能双向无约束覆盖人工修改。

## 5. 外部事件与自动完成

Webhook 校验签名、来源 connection 和目标仓库，先将 deliveryId 与 payload 哈希持久化，再异步处理。重复消息去重；乱序按供应商可用版本/时间与 API 核对处理，不能只取最后到达者。

项目可以显式启用“指定仓库中关联 PR 合并后完成任务”，CompletionEvent 的 actorType=rule，记录 ruleId 与源事件。默认关闭；模型输出中的“merged”不是此规则的可信输入。

通知只发送接收方有权看到的摘要与受保护链接。连接撤销后阻止新读取和外发；已发生外部动作不声称自动撤回。真正部署是受权限约束的执行操作，普通发布链接关联不自动部署。

## 6. 六个工作项

| ID | 工作内容 | 产物 | 依赖 |
| --- | --- | --- | --- |
| HX-DEV-16-01 | 模板、版本、输入/输出契约和步骤列表编辑 | template API/editor | 05、07 |
| HX-DEV-16-02 | 实例调度、普通 Run 复用、并发/迭代边界与人回复 | workflow coordinator | 16-01、11、13 |
| HX-DEV-16-03 | 实例继续/跳过/取消、子执行联动和版本保留 | instance commands/UI | 16-02 |
| HX-DEV-16-04 | Connection/ExternalReference、受控凭证与首个 Git/PR 连接器 | connector port、首个实现 | 03、04、14 |
| HX-DEV-16-05 | Webhook 持久化、验签、去重、乱序处理与可选完成规则 | integration inbox、rule handler | 16-04、07/04 |
| HX-DEV-16-06 | 可选 CI/发布引用、外部通知、断开与同步状态页 | integration UI/handlers | 16-04/05、15 |

## 7. 不做什么

不先建设插件市场、任意代码工作流平台或多厂商账号共享网关。已有项目中的 Hooks/MCP 也需要显示来源和权限；安装某个扩展不是授权它访问所有资料。

工作模板服务于减少重复动作，不将内部团队的质量评估程序固化成每个任务必经的模板。
