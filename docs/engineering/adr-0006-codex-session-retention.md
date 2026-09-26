# ADR-0006｜可选私有原生历史，不把新会话称为恢复

日期：2026-09-26（UTC+8）。关联 HX-DEV-09-02/05/06、06-06、10-03 和 11-02。

采用 Codex 官方 App Server 的 thread/read → thread/resume → turn/start，通过本机明确开启的隔离 CODEX_HOME 保存状态。未开启继续 ephemeral；不复用个人订阅/个人会话。只公开不透明引用并检查源执行、模式、工具版本/授权、目录身份及精确 Key 绑定。失败无静默回退；自动等待安排保持新会话语义。

原生历史继承超出当前公开选材，界面须明确提醒；共享任务访问不授予读取私有原生文件。持久化是独立本机授权，不是产品强制审批。7 天是恢复期限，清理是明确本机操作，不伪装自动删除。

依据为官方 App Server 文档及固定发行版本 0.157.0 的 Rust 协议定义。开发者网页可能随版本演进，不把网页示例字段直接套到所有版本；thread sandbox 和 turn sandbox 的序列化由锁定协议核对。源码和无模型检查不等同于有效账户下模型成功恢复。

- 官方文档：https://developers.openai.com/codex/app-server
- 固定协议：https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- 发行版本：https://github.com/openai/codex/releases/tag/rust-v0.157.0

延期范围：Claude resume、实时 steer、失败/中断会话自动对账、跨节点/账户/工具恢复、OS 沙箱与系统凭证存储、真实提供方生成联调。它们保留在原清单，不用新增页面替代。
