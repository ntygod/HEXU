import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/src/index.js';
import type { AssistanceReply } from '../../contracts/src/assistance.js';
import { composeDraftAdoption } from '../../contracts/src/ai-drafts.js';
import {
  parseAssistanceAdoption,
  selectedAssistanceSuggestion,
  type AssistanceAdoption,
  type AssistanceAdoptionPage,
  type AssistanceAdoptionPreview,
} from '../../contracts/src/assistance-adoption.js';
import { assertRevision, canonicalJson } from '../../domain/src/index.js';
import {
  taskDescriptionTarget,
  applyTaskDescriptionAdoption,
} from './task-description-adoption.js';
import type { Store } from './store.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

export class AssistanceAdoptionsStore {
  constructor(private readonly store: Store) {}
  private assertAccess(taskId: string, id: string, write = false) {
    if (!this.store.agentAssistance.isAgent(id)) {
      this.store.assistance.adoptionContext(taskId, id, write);
      return;
    }
    this.store.getTask(taskId, write);
    const item = this.store.agentAssistance.get(id).assistance;
    if (item.taskLink?.id !== taskId)
      throw new DomainError('NOT_FOUND', '协助不属于当前任务或不可访问', 404);
  }
  private externalPreview(
    taskId: string,
    id: string,
    responseId: string,
  ): AssistanceAdoptionPreview {
    this.assertAccess(taskId, id, true);
    const item = this.store.agentAssistance.get(id).assistance;
    const agent = item.agent!;
    const response = agent.responses.find((r) => r.id === responseId);
    if (
      !response ||
      response.type !== 'answer' ||
      response.actor.kind !== 'agent' ||
      response.actor.participantId !== agent.recipientParticipantId ||
      !response.body.trim()
    )
      throw new DomainError(
        'ASSISTANCE_NOT_SUGGESTION',
        '仅可采用已认证接收 Agent 保存的回答',
        422,
      );
    const reply: AssistanceReply = {
      id: response.id,
      revision: response.inputRevision,
      actorType: 'agent',
      author: { id: response.actor.ownerUserId, name: item.recipient.name },
      body: response.body,
      createdAt: response.createdAt,
    };
    return {
      source: {
        assistanceId: id,
        assistanceRevision: item.revision,
        snapshotHash: item.snapshotHash,
        snapshot: item.snapshot,
        question: item.question,
        sourceChanged: item.sourceChanged,
        reply,
        replyHash: hash({ reply, response }),
        external: { requestId: agent.requestId, response },
      },
      target: taskDescriptionTarget(this.store, taskId, true),
      canAdopt:
        !item.accessEnded &&
        item.state !== 'cancelled' &&
        item.sourceChanged === false &&
        response.inputRevision === agent.currentInputRevision &&
        response.inputHash === agent.inputHash &&
        response.accessRevision === agent.accessRevision,
    };
  }
  preview(taskId: string, assistanceId: string, replyId: string): AssistanceAdoptionPreview {
    if (this.store.agentAssistance.isAgent(assistanceId))
      return this.externalPreview(taskId, assistanceId, replyId);
    const { item, accessEnded } = this.store.assistance.adoptionContext(taskId, assistanceId, true);
    const row = this.store.db
      .prepare(
        "SELECT body FROM assistance_replies WHERE assistance_id=? AND json_extract(body,'$.id')=?",
      )
      .get(assistanceId, replyId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '协助建议不存在或不可访问', 404);
    const reply = JSON.parse(row.body) as AssistanceReply;
    if (reply.author.id !== item.recipient.id || !reply.body.trim())
      throw new DomainError(
        'ASSISTANCE_NOT_SUGGESTION',
        '只能采用同事或 AI 已保存的建议，不能把自己的追问当作建议',
        422,
      );
    if (item.ai) {
      const run = this.store.run(item.ai.runId);
      if (
        reply.actorType !== 'agent' ||
        reply.runId !== run.id ||
        run.assistanceId !== item.id ||
        run.purpose !== 'assist' ||
        run.state !== 'succeeded' ||
        !run.node?.terminationConfirmed
      )
        throw new DomainError(
          'ASSISTANCE_NOT_SUGGESTION',
          '此 AI 回复没有已确认成功的协助执行，不能采用',
          422,
        );
    } else if (reply.actorType || reply.runId)
      throw new DomainError('ASSISTANCE_NOT_SUGGESTION', '真人建议的来源不一致', 422);
    const current = this.store.assistance.get(assistanceId).assistance;
    return {
      source: {
        assistanceId,
        assistanceRevision: item.revision,
        snapshotHash: item.snapshotHash,
        snapshot: item.snapshot,
        question: item.question,
        sourceChanged: current.sourceChanged,
        reply,
        replyHash: hash(reply),
      },
      target: taskDescriptionTarget(this.store, taskId, true),
      canAdopt: !accessEnded && item.state !== 'cancelled',
    };
  }
  adopt(taskId: string, assistanceId: string, input: unknown, key: string): AssistanceAdoption {
    // Even an old receipt requires current parent-task editing and source-reading authority.
    this.assertAccess(taskId, assistanceId, true);
    const data = parseAssistanceAdoption(input);
    const receipt = this.store.mutate(
      `assistance.adopt:${assistanceId}`,
      key,
      { taskId, ...data },
      () => {
        const current = this.preview(taskId, assistanceId, data.replyId);
        if (!current.canAdopt)
          throw new DomainError(
            'ASSISTANCE_ADOPTION_REVOKED',
            '协助已撤销，不能新采用建议；已保存的采用记录仍保留',
            409,
          );
        const { source, target } = current;
        if (
          source.snapshotHash !== data.expectedSnapshotHash ||
          source.replyHash !== data.expectedReplyHash
        )
          throw new DomainError(
            'ASSISTANCE_SUGGESTION_CHANGED',
            '协助材料或回复已变化，请核对来源后重新选择',
            409,
          );
        assertRevision(source.assistanceRevision, data.expectedAssistanceRevision);
        assertRevision(target.revision, data.expectedTaskRevision);
        const selectedText = selectedAssistanceSuggestion(source.reply.body, data.ranges);
        const afterContent = composeDraftAdoption(target, selectedText, data.mode);
        const at = new Date().toISOString();
        const afterRevision = applyTaskDescriptionAdoption(
          this.store,
          taskId,
          target.revision,
          afterContent,
          at,
        );
        const adoption: AssistanceAdoption = {
          id: randomUUID(),
          taskId,
          source,
          ranges: data.ranges,
          selectedText,
          mode: data.mode,
          target: {
            kind: 'task',
            id: taskId,
            title: target.title,
            beforeRevision: target.revision,
            afterRevision,
            beforeContent: target.content,
            afterContent,
          },
          createdAt: at,
          createdByUserId: this.store.actorId,
          createdByName: this.store.actorName(),
        };
        this.store.db
          .prepare(
            'INSERT INTO assistance_adoptions(id,assistance_id,task_id,body) VALUES(?,?,?,?)',
          )
          .run(adoption.id, assistanceId, taskId, JSON.stringify(adoption));
        // Do not broadcast task content or target revisions on the recipient's limited channel.
        this.store.db
          .prepare(
            "INSERT INTO outbox(task_id,kind,created_at,space_id) VALUES(?,'assistance.adopted',?,?)",
          )
          .run(taskId, at, this.store.spaceId);
        return { id: adoption.id };
      },
    );
    return this.get(taskId, assistanceId, receipt.id);
  }
  get(taskId: string, assistanceId: string, id: string): AssistanceAdoption {
    this.assertAccess(taskId, assistanceId);
    const row = this.store.db
      .prepare('SELECT body FROM assistance_adoptions WHERE id=? AND assistance_id=? AND task_id=?')
      .get(id, assistanceId, taskId) as { body: string } | undefined;
    if (!row) throw new DomainError('NOT_FOUND', '采用记录不存在或不可访问', 404);
    return JSON.parse(row.body) as AssistanceAdoption;
  }
  list(
    taskId: string,
    assistanceId: string,
    query: { cursor: string | null; limit: number },
  ): AssistanceAdoptionPage {
    this.assertAccess(taskId, assistanceId);
    let before = Number.MAX_SAFE_INTEGER;
    if (query.cursor) {
      const row = this.store.db
        .prepare(
          'SELECT rowid AS n FROM assistance_adoptions WHERE id=? AND assistance_id=? AND task_id=?',
        )
        .get(query.cursor, assistanceId, taskId) as { n: number } | undefined;
      if (!row) throw new DomainError('INVALID_CURSOR', '采用记录游标无效，请返回首页', 409);
      before = row.n;
    }
    const rows = (
      this.store.db
        .prepare(
          'SELECT body FROM assistance_adoptions WHERE assistance_id=? AND task_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?',
        )
        .all(assistanceId, taskId, before, query.limit + 1) as { body: string }[]
    ).map((r) => JSON.parse(r.body) as AssistanceAdoption);
    const items = rows.slice(0, query.limit);
    return { items, nextCursor: rows.length > query.limit ? items.at(-1)!.id : null };
  }
}
