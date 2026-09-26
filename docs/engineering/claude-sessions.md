# E2c2｜Claude Code 节点私有会话与显式恢复

2026-09-26（UTC+8）。范围：同机回环、本人独立节点、API key、受限文件工具。**实验性代码路径；真实账户下生成和成功恢复尚未联调。** 不改变 W1、Task/Run/Operation 或独占工作目录的含义。

## 使用

停止 Runner，在现有本机 execution.json 中为 `tool: "claude-code"` 明确添加 `"retainSessions": true`。重新执行 `enable-execution --config /absolute/execution.json --state /absolute/private-node-state`，阅读历史保留范围并输入 `EXECUTE`，然后 `start`。密钥只由节点本机 `ANTHROPIC_API_KEY` 提供，不写进配置、网页或仓库。没有开启保留的运行显式使用 `--no-session-persistence`；不能把旧运行事后变成可恢复历史。

首次执行由节点生成 UUID 并传给 `--session-id`。只有成功 result、匹配的初始化身份与模型、已确认进程组结束、有效原生历史落盘之后才报告可恢复引用。下一次在原任务最新成功执行的“沿原目录继续”中选择“恢复 Claude Code 原生会话（实验性）”，确认新增材料和模式后开始。默认仍是新会话；每次恢复都创建新的 HEXU Run，不自动完成 Task。

恢复只传节点保存的 UUID 给 `--resume`，不使用 `--continue`、会话名、浏览器传入的路径或 `--fork-session`。旧 wait/request_stop 的 202 Operation 仍只安排新会话，不能自动恢复原生历史。跨工具、跨节点、跨任务、跨模式和跨账号仍不恢复。

## 保留与绑定

每个会话在节点私有状态目录的 `claude-sessions/<opaque-ref>` 下保存，父目录权限 0700，必须位于全部已授权工作目录之外。`HOME` 指向该隔离目录，`CLAUDE_CONFIG_DIR` 指向其 `config`，`CLAUDE_CODE_PROJECT_DIR_NAME=work` 固定原生项目子目录。只传必要环境和本工具 Key，不继承个人订阅、其他工具账户、MCP、Hooks 或自定义环境配置。

绑定包含控制地址、节点/项目/任务/工作目录 ID、目录和 Git 文件身份、原生工具 realpath、完整本机授权策略及版本、模式、精确 API key 的节点 HMAC。Key 和摘要不上传；即使同账号的 Key 轮换也需要新会话。重新 enable-execution 产生新授权版本，旧会话不再匹配。

CLI 原生 JSONL 条目格式属于内部实现，HEXU **不解析和导入其中的对话结构**。在受控目录确认 `config/projects/work/<uuid>.jsonl` 非空，检查整棵私有目录并记录文件内容指纹；成功结束时同步文件后保存 ready。恢复前比对整个目录指纹，历史、索引或配置改变均拒绝，不仅检查文件名存在。此保守策略也可能拒绝用户手工整理过的历史，此时需明确新建。

准备和结束检查最多 4096 项、64 MiB、16 层目录，拒绝链接、特殊文件、非本机用户文件及多硬链接文件；这不是运行中磁盘配额、恶意本机管理员隔离或加密备份。每节点最多保留 32 个未清理 Claude 会话，和 Codex 的 32 个记录分别计数。恢复期限从首次创建起为 7 天，恢复不延长期限，**到期不等于自动删除**。

控制服务只接收不透明引用、created/resumed 动作和截止时间；原生 UUID、模型绑定、历史、指纹和本地路径留在节点。文本预览只有新增材料，原生恢复还会继承旧历史；取消本轮材料勾选不能抹去已有原生上下文。

## 失败、取消与清理

本地绑定、历史缺失/篡改、超限、到期或未知生命周期检查在构造原生进程前完成，拒绝时不调用第二个工具进程。原生执行继续使用 bare/restricted、dontAsk、明确文件工具、空 MCP 和原预算/轮次/时间边界。init 必须返回同一 UUID、目录、模型及允许的工具/权限，assistant/result 也必须归属同一会话；错误身份不会作为有效输出发布。普通非保留执行也检查已出现的会话 ID 一致性。

恢复失败不自动新建、重试、切账号或扩权。**进程启动后的 init/结果检查是输出协议校验，不是“模型请求尚未发送”的证明**；只能保证收到异常后请求停止，不把这一点当成零费用承诺。缺有效完成事件、错 ID/模型/权限、停止或未确认进程结束不能保存为 ready。active 生命周期在 Runner 重启后变为 blocked，unknown 执行仍保留目录占用。

停止 Runner 后：

```bash
npm run runner -- native-sessions --state /absolute/private-node-state
npm run runner -- forget-native-session --session <opaque-ref> --state /absolute/private-node-state
# 核对后输入 FORGET <同一opaque-ref>
```

列表会区分 Claude Code/Codex，不打印原生 ID、正文或 Key；即使当前切换了工具授权，也按原记录清理。只有对应执行已确认终态才可删除本机会话；不删除工作代码、共享消息或任务记录，也不能用清理绕过进程锁。

恢复时原生估算费用仍仅作来源明确的文字，不重复累计为本轮费用。真实账户下恢复统计范围、缓存用量、权限与预算实际效果尚待联调。

## 检查与官方依据

工程和浏览器回归使用明确协议替身、虚构 Key、实际节点/HTTP/Git/子进程，验证首次保留、节点重启、显式 --resume、独立新 Run、历史不上传、拒绝路径、幂等、停止和清理后用户主动新建。替身不是 Claude Code，也不产生真实模型输出。

`npm run check:claude-protocol -- /absolute/path/to/claude` 是可选官方无模型检查：隔离 HOME/配置，无账户密钥，读取版本与帮助，再用随机不存在的 UUID 执行恢复，核对失败 result、零轮次/零 API 时长/零报告费用。官方 2.1.283 接受 `--max-turns` 但不在帮助中显示；探测仅对此精确版本放行这一项文档化参数，缺少 `--restricted` 等参数仍拒绝。此检查不证明已有真实历史成功恢复。

2026-09-26 核对官方文档与 2.1.283 Linux x64 程序：

- [CLI reference](https://code.claude.com/docs/en/cli-reference)：bare/restricted、显式 UUID、resume、no-session-persistence；帮助不列出所有参数。
- [Manage sessions](https://code.claude.com/docs/en/sessions)：原生文件位置、内部条目格式不稳定、私有 project 目录覆盖；恢复 ID 会跨项目搜索，因此不能使用个人默认 HOME。
- [Settings](https://code.claude.com/docs/en/settings)：CLAUDE_CONFIG_DIR 的隔离范围与额外 HOME 配置文件。
- [官方 2.1.283 发布](https://github.com/anthropics/claude-code/releases/tag/v2.1.283)：资产 `claude-linux-x64.tar.gz`，SHA-256 `db404a91bec8baffb53463166fdc8bf579208a527d60afc2d984d7507dc0c2f9`。

实际测试结果与未完成事项见 [21](../development/21-implementation-status.md)，下一交付只在 [22](../development/22-next-delivery.md) 维护。
