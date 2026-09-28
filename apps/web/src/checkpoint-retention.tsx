import { CheckpointRestoreResults } from './checkpoint-restore-results.js';
import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { CommitCheckpoint } from '../../../packages/contracts/src/checkpoints.js';
import type {
  RetentionDays,
  RetentionView,
} from '../../../packages/contracts/src/checkpoint-retention.js';
import { Button } from '../../../packages/ui/src/index.js';
import { canEditTask, time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';

const labels: Record<RetentionView['state'], string> = {
  pending: '等待本机核验与保留',
  retained: '本机已保留（上次核验）',
  cancelled: '保留请求已取消',
  invalidated: '原节点授权已失效',
  expired: '已过期',
  missing: '本机对象缺失',
  corrupt: '本机对象核验失败',
  deleted: '本机副本已删除',
};
function Feedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="checkpoint-notice">
          <strong>尚未确认保留请求结果</strong>
          <p>只确认同一提交引用、期限和原请求；不会重新读取或复制代码。</p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次保留操作
          </Button>
        </section>
      )}
    </>
  );
}
export function CheckpointRetention({ record, task }: { record: CommitCheckpoint; task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen((v) => !v)}>{open ? '收起对象保留' : '核验与本机保留'}</Button>
      {open && <RetentionPanel record={record} task={task} />}
    </>
  );
}
function RetentionPanel({ record, task }: { record: CommitCheckpoint; task: Task }) {
  const { data } = useApp();
  const path = `/tasks/${encodeURIComponent(task.id)}/checkpoints/${encodeURIComponent(record.id)}/retentions`;
  const read = useAssistanceRead<{ items: RetentionView[] }>(path, 3000);
  const editable = canEditTask(data, task) && record.request.requestedBy.id === data.user.id;
  const [creating, setCreating] = useState(false);
  const cancel = useAssistanceCommand<RetentionView>(() => read.retry());
  useEffect(() => {
    if (!editable || read.denied || cancel.denied) setCreating(false);
  }, [editable, read.denied, cancel.denied]);
  if (read.denied || cancel.denied) return <p role="alert">保留记录权限已失效，编辑已清除。</p>;
  return (
    <section className="checkpoint-retention" aria-label="本机对象保留">
      <div className="checkpoint-notice">
        <strong>单独保留提交文件对象</strong>
        <p>
          原引用不会自动升级。仅本人在本机确认后，完整核对并复制此提交的 Git
          树和文件；不上传代码，不改变原仓库。
        </p>
        <p>
          祖先历史、未提交内容不包含。LFS
          只保留指针，子模块只保留引用。普通文件的新目录恢复需本机另行确认，不支持跨电脑传输。
        </p>
      </div>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读保留记录</Button>
        </p>
      )}
      {editable && !creating && (
        <Button
          disabled={!!read.error || !read.value || !!cancel.uncertain}
          onClick={() => setCreating(true)}
        >
          保留对象副本
        </Button>
      )}
      {creating && editable && (
        <RetentionEditor
          task={task}
          path={path}
          readBlocked={!!read.error}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            read.retry();
          }}
        />
      )}
      <Feedback command={cancel} />
      {!read.value ? (
        <p role="status">正在读取本机保留记录…</p>
      ) : !read.value.items.length ? (
        <p>尚无对象副本。提交引用仍仅代表原核对时存在。</p>
      ) : (
        read.value.items.map((r) => (
          <section className="retention-card" key={r.request.id} aria-label="对象保留记录">
            <header>
              <strong>{labels[r.state]}</strong>
              <span>{r.request.days} 天</span>
            </header>
            {!r.nodeAuthorized && (
              <p className="form-error">
                原节点授权已失效。以下仅为最后记录，不能据此判断对象现在可用。
              </p>
            )}
            <p>请求时间：{time(r.request.createdAt)}</p>
            {r.manifest ? (
              <>
                <p>
                  本机保留至 {time(r.manifest.expiresAt)}
                  ；到期停止作为有效材料，需在本机明确删除，不会自动续期。
                </p>
                <p aria-label="保留对象范围">
                  {r.manifest.coverage.objects} 个 Git 对象 ·{' '}
                  {r.manifest.coverage.bytes.toLocaleString()} 字节；{r.manifest.coverage.files}{' '}
                  个文件条目，{r.manifest.coverage.trees} 个目录树。
                </p>
                <p aria-label="外部内容排除">
                  LFS 指针 {r.manifest.coverage.lfsPointers} · 子模块引用{' '}
                  {r.manifest.coverage.gitlinks} · 未展开符号链接 {r.manifest.coverage.symlinks}
                  。不包含这些引用指向的外部内容。
                </p>
                <p>
                  最近本机报告：{r.observedAt ? time(r.observedAt) : '未知'}
                  。这不是持续在线检测，也不是远端备份。
                </p>
                <details>
                  <summary>对象清单指纹</summary>
                  <code>{r.manifest.snapshotHash}</code>
                  <p>原始对象只在节点私有数据库中，不公开文件名、路径或作者邮箱。</p>
                </details>
                <CheckpointRestoreResults
                  retentionPath={`${path}/${encodeURIComponent(r.request.id)}`}
                  editable={editable && r.nodeAuthorized}
                />
                {editable && r.state !== 'deleted' && (
                  <details>
                    <summary>重新核验或删除本机副本</summary>
                    <p>重新核验只读保留副本，不依赖原仓库，也不延长期限。</p>
                    <pre aria-label="重新核验命令">{`npm run runner -- verify-checkpoint --request ${r.request.id} --state /path/to/private-state`}</pre>
                    <p>删除需本机再次确认；只清除此副本，原仓库和任务历史不变。</p>
                    <pre aria-label="删除副本命令">{`npm run runner -- forget-checkpoint --request ${r.request.id} --state /path/to/private-state`}</pre>
                  </details>
                )}
              </>
            ) : (
              r.state === 'pending' &&
              editable && (
                <>
                  <p>请在原节点核对目录和提交后执行；请求有效至 {time(r.request.expiresAt)}。</p>
                  <pre aria-label="本机保留命令">{`npm run runner -- retain-checkpoint --request ${r.request.id} --state /path/to/private-state`}</pre>
                  <p>终端需明确输入提交和期限才复制对象，不需要模型账户。</p>
                  <Button
                    busy={cancel.busy}
                    disabled={!!read.error || !!cancel.uncertain}
                    onClick={() => void cancel.send(`${path}/${r.request.id}/cancel`, {})}
                  >
                    取消保留请求
                  </Button>
                </>
              )
            )}
          </section>
        ))
      )}
    </section>
  );
}
function RetentionEditor({
  task,
  path,
  readBlocked,
  onClose,
  onSaved,
}: {
  task: Task;
  path: string;
  readBlocked: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const [days, setDays] = useState<RetentionDays>(7),
    [consent, setConsent] = useState(false),
    [revision, setRevision] = useState(task.revision);
  const command = useAssistanceCommand<RetentionView>(onSaved);
  const locked = command.busy || !!command.uncertain || readBlocked,
    stale = revision !== task.revision;
  if (command.denied) return <p role="alert">保留权限已失效，请关闭后重新核对。</p>;
  return (
    <form
      className="checkpoint-editor"
      aria-label="请求本机对象保留"
      onSubmit={(e) => {
        e.preventDefault();
        if (!locked && !stale && consent)
          void command.send(path, {
            days,
            expectedTaskRevision: revision,
            confirmLocalRetention: true,
          });
      }}
    >
      <h3>选择本机保留期限</h3>
      <fieldset disabled={locked}>
        <label className="field">
          保留期限
          <select
            aria-label="保留期限"
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value) as RetentionDays);
              setConsent(false);
            }}
          >
            <option value={1}>1 天</option>
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
          </select>
        </label>
        <p>
          核验成功后才计算期限；单份最多 10,000 个对象、64 MiB，单个文件对象最多 8
          MiB。缺失或超限不会静默省略。
        </p>
        <label className="checkpoint-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          我确认请求本机保留此提交的文件对象；不含未提交和外部内容，仍需节点本人逐次确认。
        </label>
      </fieldset>
      {stale && (
        <section className="checkpoint-notice">
          <p>任务已变化，期限选择保留；核对后再创建请求。</p>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setRevision(task.revision);
              setConsent(false);
            }}
          >
            已核对保留任务
          </Button>
        </section>
      )}
      <Feedback command={command} />
      <div className="checkpoint-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={locked || stale || !consent}
        >
          创建对象保留请求
        </Button>
        <Button type="button" disabled={command.busy} onClick={onClose}>
          关闭保留编辑
        </Button>
      </div>
    </form>
  );
}
