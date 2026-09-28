# 资料、约定、选材与草稿 harness

> 按需读取：修改项目资料、讨论约定、模型材料快照或 AI 草稿采用。这是开发约束；当前交付事实见 [21](../development/21-implementation-status.md)。

## 从哪里下手

- 目标：[05 工作包](../development/05-context-discussion.md)。按对象选择 [资料](../engineering/project-sources.md)、[约定](../engineering/project-agreements.md)、[选材](../engineering/project-materials.md) 或 [草稿](../engineering/ai-drafts.md) 用法。
- 对应契约/事务位于 `packages/contracts/src/`、`packages/db/src/` 的 `project-sources`、`project-agreements`、`project-materials`、`ai-drafts` 文件。
- 共用采用写入：[task-description-adoption.ts](../../packages/db/src/task-description-adoption.ts)；选区：[draft-selection.ts](../../apps/web/src/draft-selection.ts)。

## 文本资料与链接

Project sources support manual text and HTTP/HTTPS references only. Current project viewers can read; edit/manage members can create, edit, soft-delete and restore, including in archived projects. Revalidate current project/space permissions before receipts and inside transactions. Direct IDs, lists, search, immutable history and SSE share this boundary; being a space owner or holding a source URL does not grant access.

Keep stable source IDs and kinds, exact body text, canonical credential-free HTTP(S) links, content hashes and recorded authors. Commit current source, independent revision snapshot, project outbox and receipt together. Migration must not fabricate sources from old descriptions/messages. Delete preserves history; restore keeps the ID and creates a revision. Old receipts cannot reapply a state change, and deleted sources cannot be edited until explicitly restored.

Sources are not automatically model context or project agreements. Saving/editing/deleting them must not alter Project/Task revisions, existing Run/dispatch/Operation material or workspace locks. Explicit project-material selection is a separate command described in this harness. Never fetch a reference URL, access a path, enable a provider or claim delivery from a source edit. File uploads/storage, automatic selection/summaries and global source search remain pending; follow 22 for the next slice.

The feature owns its W1 page/drawers/styles. Render raw text safely and open validated links only on user action. Freeze editor baselines, preserve drafts on transient reads, clear content/editor state on confirmed revocation, and discard drafts on identity/space change or close. Uncertain writes confirm the same body/key. Historical reading refreshes explicitly, not on every SSE. Source deep links do not carry draft content or confer authorization.

## 明确发布项目约定

Publish only from a currently readable human/agent message in a project-visible task of the exact same project. Reject private, foreign and system-message sources; validate the full message hash again inside publication and check source access before old receipt replay. Preserve immutable origin IDs/hash/bounded excerpt and distinguish the human publisher from the discussion/AI author. Existing messages or sources never become agreements automatically.

Project viewers may read; edit/manage members may publish, edit, deactivate/reactivate and explicitly replace active agreements. Replacement creates a new ID and atomically supersedes the selected exact revision, linking both records with their histories, project version, outbox and receipt. Selecting a replacement does nothing until save. Superseded history cannot reactivate; deactivating a successor does not revive a predecessor. Preserve explicit project publication independently of later source/author changes.

Agreement changes do not mutate Project/Task revision, existing Run/dispatch/Operation snapshots or workspace locks. Task update hints are memory-scoped live hints, not persistent notifications, read receipts or provider delivery. Material selection binds actual versions through existing execution rules rather than silently appending changed agreements. Freeze form baselines, confirm uncertain writes with the same request, clear revoked editors, and keep history reading independent of SSE refresh.

## 执行选材与固定快照

Only explicitly selected same-project active sources/agreements become supplemental model material. Validate kind/id/revision/hash/excerpt length and current permissions; private tasks still work with ordinary task context but cannot import project references through this channel. Keep source URLs as references, never fetch them. Show truncation/omitted characters and known-pattern redaction; application character limits are not provider token windows or proof of zero cost.

Context bundles bind atomically with Run/dispatch/notes/idempotency and Operation links. Recheck selected resource states/versions before waiting-stop actions, final creation, native spawn and node one-use permit. Preserve frozen text, old stop signals and unknown writer locks; unselected new resources never silently enter an existing command. Node waiting fixes full input. Preview waiting fixes project supplements while retaining its existing post-stop code/output reconstruction; do not claim those are the same protocol.

Only actual native spawn or node running evidence records material startup. Queue/ACK/permit/Operation success is not provider receipt; old runs have no fabricated bundle. Run material history follows current task/project permissions. Native key-specific redaction stays local; the team host never receives provider keys. Retained sessions may inherit earlier material even when current checkboxes omit it.

Execution panels bind consent to task-context and project-material versions. Uncertain writes confirm a cloned original body and idempotency key, never generate a second paid request; preserve the originally chosen continuation source while the parent Run list updates. Changing filters is not permission to submit a form. Current selection is manual; automatic recommendations, summaries, persistent preferences and remote deployment remain pending.

## AI 草稿与局部采用

Drafts come only from an existing AI reply in the same task, with a source hash and independent revisions. Human edits are explicit; no native transcript import, model call, automatic agreement publication or model-context inclusion. Persisted drafts are task-scoped business records, distinct from unsaved drawer-local edits.

Adoption checks current task/target edit access before receipt replay and again in the transaction, plus exact draft and target revisions. Only the same task description or same-project source body may change; private drafts cannot publish to project sources or other tasks. Compute selected text from bounded non-overlapping ranges of the saved revision, never trust supplied adopted text or target paths. Preserve source title/URL/identity and immutable before/after adoption history. Target update, source revision, adoption, outbox and receipt commit atomically.

Task-description adoption durably pauses pending preview/node Operations in the same transaction, retaining fixed material, stop requests and unknown locks. It does not complete a Task, change its owner, stop a Run, deliver live input, issue permits or dispatch work. Source adoption uses the existing source revision and material-validation rules. Later draft edits never rewrite adopted targets. Archived projects still permit human collaboration.

Keep draft and target baselines fixed in the W1 drawer; conflicts retain local edits/ranges for explicit comparison, not silent rebasing. Unknown replies confirm the identical body/key. Authority or identity/space changes discard unsaved editors. Current targets are task descriptions and project sources; requirements/results, automated drafting and batch adoption remain pending. The next delivery is maintained only in [22](../development/22-next-delivery.md).

## 如何验证与回写

复用同名 [资料测试](../../tests/project-sources.test.ts)、[约定测试](../../tests/project-agreements.test.ts)、[快照测试](../../tests/project-materials.test.ts)、[草稿测试](../../tests/ai-drafts.test.ts)；选择文本时覆盖 [文字簇/换行映射](../../tests/draft-selection.test.ts)。UI 使用已有对应浏览器用例，验证冲突保留和相同请求确认。

只运行改动涉及的检查；平台限制、真实模型未验证和未完成范围要写清楚。能力或契约变化更新 [21](../development/21-implementation-status.md) 与 [19](../development/19-work-items.md) 的原工作项，不把测试数量当作功能完成度。

## 跨边界时再读

Run/Operation 绑定见 [执行](execution.md) / [接续](continuation.md)；协助建议的采用见 [协助](assistance.md)，不要用草稿 API 绕开其来源授权。
