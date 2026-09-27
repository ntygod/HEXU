import { useEffect, useState } from 'react';
import type { Message } from '../../../packages/contracts/src/index.js';
import type {
  AgreementContent,
  AgreementPage,
  AgreementPreview,
  ProjectAgreement,
} from '../../../packages/contracts/src/project-agreements.js';
import { Button, Dialog, Empty } from '../../../packages/ui/src/index.js';
import { canEditTask, Link, useApp } from './state.js';
import {
  agreementPath,
  AgreementFeedback,
  AgreementFields,
  useAgreementCommand,
  useAgreementRead,
} from './agreement-common.js';
import './project-agreements.css';

export function PublishAgreement({ message }: { message: Message }) {
  const { data } = useApp();
  const task = data.tasks.find((task) => task.id === message.taskId);
  const allowed =
    !!task &&
    task.visibility === 'project' &&
    !!task.projectId &&
    canEditTask(data, task) &&
    message.actorType !== 'system';
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed || projectId !== task?.projectId) setProjectId(null);
  }, [allowed, task?.projectId, projectId]);
  if (!allowed || !task?.projectId) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="agreement-publish"
        onClick={() => setProjectId(task.projectId)}
      >
        设为项目约定
      </Button>
      {projectId === task.projectId && (
        <PublicationDrawer
          taskId={task.id}
          messageId={message.id}
          projectId={projectId}
          onClose={() => setProjectId(null)}
        />
      )}
    </>
  );
}
function PublicationDrawer({
  taskId,
  messageId,
  projectId,
  onClose,
}: {
  taskId: string;
  messageId: string;
  projectId: string;
  onClose(): void;
}) {
  const loaded = useAgreementRead<AgreementPreview>(
    `/tasks/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}/agreement-preview`,
  );
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="设为项目约定" drawer onClose={() => !busy && onClose()}>
      {loaded.error && (
        <div className="agreement-read-error" role="alert">
          {loaded.error}
          <Button type="button" onClick={loaded.retry}>
            重读讨论来源
          </Button>
        </div>
      )}
      {loaded.value && loaded.value.origin.projectId === projectId ? (
        <PublicationForm
          projectId={projectId}
          preview={loaded.value}
          onBusy={setBusy}
          onClose={onClose}
        />
      ) : (
        <div className="dialog-body">
          <Empty title={loaded.error ? '暂时无法使用此来源' : '正在读取讨论来源'} />
        </div>
      )}
    </Dialog>
  );
}
function PublicationForm({
  projectId,
  preview,
  onBusy,
  onClose,
}: {
  projectId: string;
  preview: AgreementPreview;
  onBusy(value: boolean): void;
  onClose(): void;
}) {
  const { data } = useApp();
  const project = data.projects.find((project) => project.id === projectId);
  const [base, setBase] = useState(preview),
    [value, setValue] = useState<AgreementContent>({ title: '', content: preview.initialContent });
  const [replacing, setReplacing] = useState(false),
    [search, setSearch] = useState(''),
    [replacement, setReplacement] = useState<{
      id: string;
      expectedRevision: number;
      title: string;
    } | null>(null);
  const choices = useAgreementRead<AgreementPage>(
    replacing ? agreementPath(projectId) + '?limit=50&q=' + encodeURIComponent(search) : null,
  );
  const target = useAgreementRead<ProjectAgreement>(
    replacement ? agreementPath(projectId, replacement.id) : null,
  );
  const command = useAgreementCommand(onClose);
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  useEffect(() => {
    if (command.denied) {
      setValue({ title: '', content: '' });
      setReplacement(null);
    }
  }, [command.denied]);
  const conflict = base.origin.hash !== preview.origin.hash;
  const replaceConflict =
    !!replacement &&
    (!target.value ||
      target.value.id !== replacement.id ||
      target.value.revision !== replacement.expectedRevision ||
      target.value.state !== 'active' ||
      !!target.error);
  const valid = !!value.title.trim() && !!value.content.trim() && (!replacing || !!replacement);
  if (command.denied)
    return (
      <div className="dialog-body">
        <AgreementFeedback command={command} />
        <p>权限已变化，编辑内容已关闭。</p>
      </div>
    );
  return (
    <form
      className="drawer-form agreement-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || conflict || replaceConflict || command.busy || command.uncertain) return;
        void command.save({
          path: agreementPath(projectId),
          method: 'POST',
          body: {
            ...value,
            sourceTaskId: base.origin.taskId,
            sourceMessageId: base.origin.messageId,
            expectedSourceHash: base.origin.hash,
            replaces: replacement
              ? { id: replacement.id, expectedRevision: replacement.expectedRevision }
              : null,
          },
          key: crypto.randomUUID(),
        });
      }}
    >
      <div className="dialog-body">
        <p>
          保存到 <strong>{project?.name}</strong>
          ，当前项目成员可见。请编辑需要共同遵守的内容，再明确保存。
        </p>
        <details className="agreement-origin">
          <summary>
            {base.origin.actorType === 'agent' ? 'AI 回复' : '成员讨论'} · {base.origin.actorName} ·{' '}
            {base.origin.taskShortId}
          </summary>
          <pre>{base.origin.excerpt}</pre>
          {base.origin.truncated && <p className="hint">这是来源节选，完整内容保留在原任务。</p>}
          <Link to={`/tasks/${base.origin.taskId}`}>查看原任务</Link>
        </details>
        {base.contentTruncated && (
          <p className="hint">原消息较长，预填前 8000 字符；请整理需要保存的内容。</p>
        )}
        {base.origin.actorType === 'agent' && (
          <p className="hint">这是 AI 的建议，只有你保存的文字才成为项目约定。</p>
        )}
        <AgreementFields
          value={value}
          onChange={setValue}
          disabled={command.busy || !!command.uncertain}
        />
        <label className="agreement-check">
          <input
            type="checkbox"
            checked={replacing}
            disabled={command.busy || !!command.uncertain}
            onChange={(event) => {
              setReplacing(event.target.checked);
              setReplacement(null);
            }}
          />
          替代已有约定
        </label>
        {replacing && (
          <section className="agreement-replacement">
            <label className="field">
              查找被替代约定
              <input
                aria-label="查找被替代约定"
                maxLength={160}
                value={search}
                disabled={command.busy || !!command.uncertain}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="field">
              被替代约定
              <select
                aria-label="被替代约定"
                value={replacement?.id ?? ''}
                disabled={command.busy || !!command.uncertain}
                onChange={(event) => {
                  const item = choices.value?.items.find((item) => item.id === event.target.value);
                  setReplacement(
                    item
                      ? { id: item.id, expectedRevision: item.revision, title: item.title }
                      : null,
                  );
                }}
              >
                <option value="">请选择当前有效约定</option>
                {replacement &&
                  !choices.value?.items.some((item) => item.id === replacement.id) && (
                    <option value={replacement.id}>{replacement.title}（已选择）</option>
                  )}
                {choices.value?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · r{item.revision}
                  </option>
                ))}
              </select>
            </label>
            {choices.error && (
              <p className="form-error" role="alert">
                {choices.error}
                <Button type="button" onClick={choices.retry}>
                  重读可替代约定
                </Button>
              </p>
            )}
            {choices.value?.nextCursor && (
              <p className="hint">仅列出前 50 项，可输入标题缩小范围。</p>
            )}
            {replacement && (
              <>
                <p className="hint">
                  已选：{replacement.title} · r{replacement.expectedRevision}
                  。选择本身不会停用旧约定。
                </p>
                {target.value && (
                  <div className="agreement-compare">
                    <strong>现有约定</strong>
                    <pre>{target.value.content}</pre>
                    <p className="hint">
                      来源：{target.value.origin.actorName} · {target.value.origin.taskShortId}
                    </p>
                  </div>
                )}
                {replaceConflict && (
                  <p role="alert" className="form-error">
                    被替代约定不可用或版本已变化，请重新选择。
                  </p>
                )}
                <Button
                  type="button"
                  disabled={command.busy || !!command.uncertain}
                  onClick={() => setReplacement(null)}
                >
                  取消替代选择
                </Button>
              </>
            )}
          </section>
        )}
        {conflict && (
          <section className="agreement-conflict" aria-label="讨论来源变化">
            <strong>原讨论已变化</strong>
            <pre>{preview.origin.excerpt}</pre>
            <p>约定草稿仍保留，请核对来源后继续。</p>
            <Button
              type="button"
              disabled={command.busy || !!command.uncertain}
              onClick={() => setBase(preview)}
            >
              采用最新来源，保留约定草稿
            </Button>
          </section>
        )}
        <p className="hint">保存不会自动发送给正在运行的模型，也不会改变已有任务或接续材料。</p>
        <AgreementFeedback command={command} />
      </div>
      <div className="dialog-footer">
        <Button type="button" disabled={command.busy} onClick={onClose}>
          取消
        </Button>
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={!valid || conflict || replaceConflict || !!command.uncertain}
        >
          保存项目约定
        </Button>
      </div>
    </form>
  );
}
