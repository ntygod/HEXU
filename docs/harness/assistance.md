# 真人/AI 协助与建议采用 harness

> 按需读取：修改固定摘录分享、有限授权、协助回复/取消、AI 文本执行或建议采用。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[11 工作包](../development/11-continuation-assistance.md)；按路径选择 [真人用法](../engineering/human-assistance.md)、[AI 文本用法](../engineering/ai-text-assistance.md)、[采用用法](../engineering/assistance-adoption.md)。
- 代码：[协助事务](../../packages/db/src/assistance.ts)、[采用事务](../../packages/db/src/assistance-adoption.ts)、[共享采用写入](../../packages/db/src/task-description-adoption.ts)、[HTTP](../../apps/control/src/assistance.ts)、[纯文本宿主](../../apps/runner/src/text-claude.ts)。

## 真人有限协助

Assistance shares one explicitly selected existing human/agent message excerpt with a different current space member. Persist only the selected source text, provenance and question in the immutable snapshot; no private transcript import, URL fetching, implicit task sharing or model call. Scope is snapshot_reply, not Task/Project/Run or workspace access. A recipient without Task access must not receive task titles/IDs, project/message IDs or later source changes. Parent-task viewers may read the thread; only the named parties may reply and only the current authorized requester manages it.

Keep independent revisions, replies, snapshot-bound grants, events and ID-only receipts atomic. Source/space/project access is checked before old receipt replay and inside writes. Membership revocation permanently cancels grants in the same transaction; rejoining cannot revive them. Close keeps recipient reading but prevents new replies; cancel revokes recipient access and retains parent-task history. Never rewrite Task/Run/Operation/materials, owners, directory locks or paid work from human assistance actions. SSE exposes only permitted assistance IDs, never parent metadata; polling also clears revoked readers. Preserve unsent input on transient reads and require explicit conflict comparison; uncertain writes confirm the same frozen body/key.

Human-assistance browser workflows use their own process, database and fictional identity on port 4313. Keep normal authentication limits; do not exhaust the node fixture's sign-in bucket or reuse the team fixture's first-run setup. The separately authorized AI text path is covered in the next section. Files/diff/results material, adoption into additional targets, cross-space/remote transmission and notifications remain pending; explicit adoption into the original task is implemented below. Follow the same 19/21/22/24 documents.

## 另行授权的 AI 文本协助

The additional local textAssistance:true opt-in is Claude-only and never inferred from directory execution or human snapshot consent. Preserve the two explicit web material/cost confirmations. Run purpose=assist and assistanceId link to the same Assistance; fixed input/grant/dispatch/Run/receipt/outbox are atomic. Keep the primary codingRun/latest/active path separate while retaining assist history. No task revision/status/owner changes, workspace lease, inherited session, source directory, or implicit human-thread forwarding.

Each text launch uses an empty private temporary cwd/HOME, --tools empty, all tools denied, no Hooks/MCP/session persistence and strict initialization/result checks. Tool calls and permission-denial events/results fail closed without publishing an answer. This trusts the configured CLI and is not an OS sandbox. Capability checks and fixtures are not live model proof. Recheck node owner, local policy and current task authority; accepted and one-use permit are not spawn/provider receipt. Cancellation/revocation stops only the linked assist and discards output; never re-run ambiguous launches. Text offline STOPPED recovery must not release another code lease. Key/output redaction is best effort, not a DLP guarantee.

Project tasks and same-project owner nodes only in this slice, still loopback/POSIX and serialized node execution. Codex equivalence, private AI task binding, retained AI sessions, follow-up turns, remote deployment and real model interoperability remain pending. Explicit suggestion adoption into the original task is implemented below. AI E2E uses a separate disposable 4314 identity process, with the explicit text-tool fixture and fake credentials. Preserve original test limits and work-item IDs. Commit references and local object retention belong to the [checkpoint harness](checkpoints.md); the next delivery is maintained only in [22](../development/22-next-delivery.md).

## 建议明确采用

Use `AssistanceAdoptionsStore` for saved recipient suggestions only, including AI replies tied to a successful termination-confirmed assist Run. Check current task edit and source-read authority before replay; recheck grants, assistance revision, snapshot/reply hashes and target revision in the transaction. Never accept caller-provided suggestion text, author, target paths or foreign task IDs. Cancelled/revoked assistance cannot create a new adoption; authorized parent editors may confirm a previously committed receipt without reapplying it. A limited snapshot_reply grant never exposes task descriptions/adoption history or authorizes writes. Removed recipients cannot regain old source access by rejoining.

`task-description-adoption.ts` is shared with AI drafts: task revision, both waiting-plan pauses, immutable adoption, outbox and receipt commit atomically. Preserve snapshots, already requested stops, active Runs and unknown directory locks. Do not start models, complete tasks, publish agreements or change files. History is immutable and parent-task/source scoped, not emitted on the limited-recipient assistance channel. Migration 19 must not invent adoption history for older replies.

The W1 adoption editor keeps explicit multi-ranges and baseline on conflicts/transient reads, requires comparison before rebasing, and freezes the exact request for uncertain receipts. Clear editors on revoked task editing or identity/space changes; reauthorization does not revive selections. Use existing grapheme keyboard movement and browser-LF to original-CRLF offsets. Browser adoption tests have a separate disposable identity process on 4315, not relaxed auth limits. Keep original tests and numbering.

## 如何验证与回写

复用 [真人](../../tests/assistance.test.ts)、[AI 授权](../../tests/ai-assistance.test.ts)、[节点文本执行](../../tests/ai-node.test.ts)、[建议采用](../../tests/assistance-adoption.test.ts) 的相关测试。浏览器真人/AI/采用分别使用 4313/4314/4315 的独立可丢弃认证进程，不能通过放宽限流让用例通过。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

分享不是完整任务访问，相关读取策略见 [身份](identity.md)；AI 派发涉及 [节点](nodes.md) 与 [Claude](claude.md)；多片段/CRLF 选择对照 [上下文](context.md)。

## 有限接收连接与 Events

receiver连接明确绑定当前project/participant/endpoint/capability/delegation grant，接收以后新建请求无需人工逐条搬token；各业务事务仍核请求专属材料scope和当前权限。旧capability_read不扩权。原outbox同事务生成ID-only事件；2xx仅收件，未知只能重试相同eventId，不能重复启动原工作。Events签名材料和callback必须加密保存，不输出到payload/日志；每连接前校验公共HTTPS地址并pin DNS，撤权后停止投递。协议/测试入口见[有限远端说明](../engineering/agent-remote-events.md)。
