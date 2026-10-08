# 2026-10-08｜切片7：真实联调准备与认证差距

## 基线与实际交付

从片6远端 `6b9dfb5500dbf0fb8e35c4d28d3b627069c1d66a` / tree `e58070db829b118128a84e5f6e84c826b854ddef` 独立准备。只新增[执行手册](../../engineering/agent-real-integration.md)、[脱敏证据模板](../../engineering/agent-real-integration-evidence.template.json)和相关入口/状态边界；无运行时代码、依赖、迁移、workflow或账号配置变化。

这不是为状态补空提交：官方认证文档与现有实现比较后，确认有限静态Bearer不能直接用于官方所述的ChatGPT/dot插件认证路径。相应最小OAuth桥接拆为可交接的库组合/discovery及有限主体映射/challenge/撤权两步，并列无真实凭据可测验收。Better Auth可作为身份引擎复用候选，但当前loopback handler不能直接外露；1.7.6没有安装所需MCP/OAuth provider包，兼容性待代码阶段验证。

Codex SDK/CLI恢复能力与当前用户已有桌面聊天可达性分别记录。验收必须由真实宿主读exact thread与session，求助前绑定、原工具返回接收回答、同thread后续产物与真实turn终态核对；环境变量、fork共享session、claim和外部ACK不单独构成证明。没有打开原聊天、另建SDK模型会话或调用真实模型。

## 当前阻碍

没有获准HTTPS测试目标/部署、第二真实成员、分享材料、真实dot OAuth连接、持久Events订阅、本机Codex安装/原聊天适配及模型预算。代码准备可以独立继续；这些真实外部动作仍待分别确认。用户本人两个Agent的跨环境测试不能算跨成员。

模板所有真实观测保持null/not_run，代码缺口标blocked；没有合成通过记录。它区分平台订阅、callback收件、dot唤醒、工具回应、回答来源、原线程消费和产物，要求审核实际来源，不将人工填写的boolean当认证证明。私有原始ID/会话、凭据、callback和材料不进入仓库。

## 验证范围

本片是文档准备，检查本地链接/锚点、JSON结构及空观测、102原项状态、差异和引用源码/官方文档。未运行任何业务测试、server/Web构建、模型、浏览器或完整CI；片6的148项/24组件/1桥接等证据仅归属其原版本，不重标为本片真实联调。

原受限state-auth跨身份迟到401/403比较、#52及restore行为未运行；此前Chromium/CUA访问拒绝不重试，不借代理/隧道/别名/提权绕过。无PR、main推送、合并或部署，独立feature不会按原workflow的main push/PR触发器启动全CI。

当前仅准备收口，首个真实异构里程碑未完成。19状态不升；21列出实际准备与未验范围；22仍指向切片7获准联调及最小认证/原线程适配，未跳到下一产品阶段。

独立审阅发现一项P2：接口拒绝不应一概等同验收失败。已改为按断言判断，错误thread/人工搬运/重复执行有反证时fail，负向验证中的预期拒绝为pass，权限缺失为blocked、证据不够为inconclusive。另明确OAuth scope交集不可改写旧principal后送入完整相等复验helper，避免后续实现误用。
