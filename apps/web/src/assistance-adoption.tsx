import { useEffect, useId, useState } from 'react';
import type { DraftRange } from '../../../packages/contracts/src/ai-drafts.js';
import {
  composeDraftAdoption,
  parseDraftRanges,
} from '../../../packages/contracts/src/ai-drafts.js';
import {
  selectedAssistanceSuggestion,
  type AssistanceAdoption,
  type AssistanceAdoptionPage,
  type AssistanceAdoptionPreview,
} from '../../../packages/contracts/src/assistance-adoption.js';
import { Button } from '../../../packages/ui/src/index.js';
import { time } from './state.js';
import { useAssistanceRead, useAssistanceCommand } from './assistance-common.js';
import { moveDraftSelection, savedDraftRange } from './draft-selection.js';
import './assistance-adoption.css';
const adoptionPath = (taskId: string, id: string) =>
  `/tasks/${encodeURIComponent(taskId)}/assistances/${encodeURIComponent(id)}`;

export function AdoptAssistance({
  taskId,
  id,
  replyId,
  onBusy,
  onClose,
}: {
  taskId: string;
  id: string;
  replyId: string;
  onBusy(v: boolean): void;
  onClose(): void;
}) {
  const read = useAssistanceRead<AssistanceAdoptionPreview>(
    adoptionPath(taskId, id) + '/replies/' + encodeURIComponent(replyId) + '/adoption-preview',
  );
  if (!read.value || read.denied)
    return (
      <section className="assistance-warning" aria-label="协助建议采用">
        <p role={read.error ? 'alert' : 'status'}>{read.error || '正在核对建议来源和任务说明…'}</p>
        {read.denied ? (
          <p>任务或来源权限已变化，采用片段和目标内容已清除。</p>
        ) : (
          <Button type="button" onClick={read.retry}>
            重读采用预览
          </Button>
        )}
        <Button type="button" onClick={onClose}>
          返回协助回复
        </Button>
      </section>
    );
  return (
    <AdoptionEditor
      current={read.value}
      readError={read.error}
      onRetry={read.retry}
      taskId={taskId}
      id={id}
      onBusy={onBusy}
      onClose={onClose}
    />
  );
}
function AdoptionEditor({
  current,
  readError,
  onRetry,
  taskId,
  id,
  onBusy,
  onClose,
}: {
  current: AssistanceAdoptionPreview;
  readError: string;
  onRetry(): void;
  taskId: string;
  id: string;
  onBusy(v: boolean): void;
  onClose(): void;
}) {
  const [base, setBase] = useState(current),
    [ranges, setRanges] = useState<DraftRange[]>([]),
    [selection, setSelection] = useState<DraftRange | null>(null),
    [selectionError, setSelectionError] = useState(''),
    [mode, setMode] = useState<'append' | 'replace'>('append'),
    [saved, setSaved] = useState<AssistanceAdoption | null>(null);
  const command = useAssistanceCommand<AssistanceAdoption>((result) => {
    setSaved(result);
    onRetry();
  });
  const locked = command.busy || !!command.uncertain;
  useEffect(() => {
    onBusy(command.busy);
    return () => onBusy(false);
  }, [command.busy, onBusy]);
  const helpId = useId();
  const replyChanged =
    base.source.replyHash !== current.source.replyHash ||
    base.source.snapshotHash !== current.source.snapshotHash;
  const sourceChanged =
    replyChanged || base.source.assistanceRevision !== current.source.assistanceRevision;
  const targetChanged = base.target.revision !== current.target.revision;
  let selectedText = '',
    next = '',
    contentError = '';
  if (ranges.length)
    try {
      selectedText = selectedAssistanceSuggestion(base.source.reply.body, ranges);
      next = composeDraftAdoption(base.target, selectedText, mode);
    } catch (e) {
      contentError = (e as Error).message;
    }
  const readSelection = (field: HTMLTextAreaElement) =>
    setSelection(savedDraftRange(base.source.reply.body, field.selectionStart, field.selectionEnd));
  if (command.denied)
    return (
      <section className="assistance-warning" role="alert">
        <p>{command.error}；采用编辑已清除，请关闭后重新查看。</p>
        <Button type="button" onClick={onClose}>
          返回协助回复
        </Button>
      </section>
    );
  if (saved)
    return (
      <section className="assistance-adoption" aria-label="建议采用成功">
        <h3>已采用所选建议</h3>
        <AdoptionRecord item={saved} />
        <Button type="button" onClick={onClose}>
          返回协助回复
        </Button>
      </section>
    );
  return (
    <section className="assistance-adoption" aria-label="协助建议采用">
      <header className="assistance-card-meta">
        <h3>采用协助建议</h3>
        <Button type="button" disabled={command.busy} onClick={onClose}>
          返回协助回复
        </Button>
      </header>
      <p className="hint">
        来源：{base.source.reply.author.name} · {time(base.source.reply.createdAt)} · 协助 r
        {base.source.assistanceRevision}。仅写入原任务说明，原建议和未选择的文字保持不变。
      </p>
      <label className="field">
        选择建议片段
        <textarea
          aria-label="选择建议片段"
          aria-describedby={helpId}
          value={base.source.reply.body}
          readOnly
          rows={6}
          onSelect={(e) => readSelection(e.currentTarget)}
          onMouseUp={(e) => readSelection(e.currentTarget)}
          onKeyUp={(e) => readSelection(e.currentTarget)}
          onKeyDown={(e) => {
            if (locked || replyChanged) return;
            const f = e.currentTarget;
            const n = moveDraftSelection(
              f.value,
              { start: f.selectionStart, end: f.selectionEnd, direction: f.selectionDirection },
              {
                key: e.key,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                altKey: e.altKey,
                isComposing: e.nativeEvent.isComposing,
              },
            );
            if (n) {
              e.preventDefault();
              f.setSelectionRange(n.start, n.end, n.direction);
              readSelection(f);
            }
          }}
        />
      </label>
      <p id={helpId} className="hint">
        鼠标拖选，或用左右方向键与 Shift 扩选；Home / End
        定位行首尾。选好后添加片段，默认不采用全文。
      </p>
      <div className="assistance-actions">
        <Button
          type="button"
          disabled={locked || !selection || replyChanged || !current.canAdopt}
          onClick={() => {
            if (!selection) return;
            try {
              const r = parseDraftRanges([...ranges, selection]);
              selectedAssistanceSuggestion(base.source.reply.body, r);
              setRanges(r);
              setSelectionError('');
            } catch (e) {
              setSelectionError((e as Error).message);
            }
          }}
        >
          添加建议片段
        </Button>
        {ranges.length > 0 && (
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setRanges([]);
              setSelectionError('');
            }}
          >
            清空建议片段
          </Button>
        )}
      </div>
      <section className="assistance-snapshot" aria-label="已选建议片段">
        <strong>
          已选 {ranges.length} 个片段 · {selectedText.length} 字符
        </strong>
        {ranges.map((r, i) => (
          <div className="assistance-adoption-fragment" key={r.start + ':' + r.end}>
            <pre>{base.source.reply.body.slice(r.start, r.end)}</pre>
            <Button
              type="button"
              disabled={locked}
              aria-label={`移除建议片段 ${i + 1}`}
              onClick={() => setRanges((old) => old.filter((_, n) => n !== i))}
            >
              移除
            </Button>
          </div>
        ))}
      </section>
      {(selectionError || contentError) && (
        <p className="form-error" role="alert">
          {selectionError || contentError}
        </p>
      )}
      <label className="field">
        建议采用方式
        <select
          aria-label="建议采用方式"
          disabled={locked}
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="append">追加到任务说明之后</option>
          <option value="replace">替换任务说明</option>
        </select>
      </label>
      <section className="assistance-adoption-comparison" aria-label="建议采用前后预览">
        <div>
          <h4>采用前 · 任务 r{base.target.revision}</h4>
          <pre>{base.target.content || '（空）'}</pre>
        </div>
        <div>
          <h4>
            采用后 · {next.length}/{base.target.limit} 字符
          </h4>
          <pre>{next || '选择片段后显示预览'}</pre>
        </div>
      </section>
      {(base.source.sourceChanged || current.source.sourceChanged) && (
        <p className="assistance-warning">
          协助所依据的原消息已变化；采用仍来自这次固定材料下的建议，请确认是否适用于当前任务。
        </p>
      )}
      {(sourceChanged || targetChanged) && !command.uncertain && (
        <section className="assistance-warning" aria-label="建议采用版本冲突">
          <strong>
            {sourceChanged ? '协助回复或状态已更新' : '任务说明已更新'}，所选片段已保留
          </strong>
          <p>请比较最新内容；不会静默覆盖或自动重新采用。</p>
          {replyChanged && <pre>{current.source.reply.body}</pre>}
          <h4>最新任务说明 · r{current.target.revision}</h4>
          <pre>{current.target.content || '（空）'}</pre>
          <Button
            type="button"
            disabled={locked || !!readError || !current.canAdopt}
            onClick={() => {
              setBase(current);
              if (replyChanged) {
                setRanges([]);
                setSelection(null);
                setSelectionError('');
              }
            }}
          >
            {replyChanged ? '按最新建议重新选择' : '已核对更新，保留建议片段'}
          </Button>
        </section>
      )}
      {!current.canAdopt && (
        <p className="assistance-warning">
          协助分享或授权已撤销，不能新采用。此前已保存的采用记录不会被撤回。
        </p>
      )}
      {readError && (
        <p className="form-error" role="alert">
          {readError}；已选片段已保留，读取恢复前不能新采用。
          <Button type="button" onClick={onRetry}>
            重读采用预览
          </Button>
        </p>
      )}
      <p className="hint">
        仅修改任务说明并保留采用记录。等待接续会暂停，原材料保留；不改变任务状态、负责人或活动运行，不发送即时输入、不发布项目约定。
      </p>
      {command.error && (
        <p role="alert" className="form-error">
          {command.error}
        </p>
      )}
      {command.uncertain && (
        <section className="assistance-warning" aria-label="建议采用待确认">
          <strong>尚未确认采用结果</strong>
          <p>
            请求可能已经保存。确认将使用原片段、原目标版本与原请求标识，不重复追加；关闭不会撤回操作。
          </p>
          <Button type="button" busy={command.busy} onClick={() => void command.confirm()}>
            确认上次建议采用
          </Button>
        </section>
      )}
      <Button
        type="button"
        variant="primary"
        busy={command.busy}
        disabled={
          locked ||
          !current.canAdopt ||
          !!readError ||
          sourceChanged ||
          targetChanged ||
          !selectedText ||
          !!contentError
        }
        onClick={() =>
          void command.send(adoptionPath(taskId, id) + '/adoptions', {
            replyId: base.source.reply.id,
            expectedAssistanceRevision: base.source.assistanceRevision,
            expectedSnapshotHash: base.source.snapshotHash,
            expectedReplyHash: base.source.replyHash,
            expectedTaskRevision: base.target.revision,
            ranges,
            mode,
          })
        }
      >
        确认采用建议片段
      </Button>
    </section>
  );
}
function AdoptionRecord({ item }: { item: AssistanceAdoption }) {
  return (
    <article className="assistance-snapshot">
      <strong>
        {item.createdByName} · {item.mode === 'append' ? '追加' : '替换'}任务说明 · r
        {item.target.beforeRevision} → r{item.target.afterRevision}
      </strong>
      <span className="hint">
        {time(item.createdAt)} · 建议来自 {item.source.reply.author.name}
      </span>
      <pre>{item.selectedText}</pre>
      <details>
        <summary>查看采用前后与来源</summary>
        <h4>采用前</h4>
        <pre>{item.target.beforeContent || '（空）'}</pre>
        <h4>采用后</h4>
        <pre>{item.target.afterContent}</pre>
        <h4>原建议 · 回复 r{item.source.reply.revision}</h4>
        <pre>{item.source.reply.body}</pre>
        <h4>协助依据的固定片段</h4>
        <pre>{item.source.snapshot.text}</pre>
        <code>{item.source.replyHash}</code>
      </details>
    </article>
  );
}
export function AssistanceAdoptionHistory({ taskId, id }: { taskId: string; id: string }) {
  const [open, setOpen] = useState(false),
    [cursor, setCursor] = useState<string | null>(null);
  const read = useAssistanceRead<AssistanceAdoptionPage>(
    open
      ? adoptionPath(taskId, id) +
          '/adoptions' +
          (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')
      : null,
    0,
  );
  return (
    <section className="assistance-adoption-history" aria-label="协助建议采用记录">
      <Button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '收起建议采用记录' : '查看建议采用记录'}
      </Button>
      {open && (
        <>
          <p className="hint">记录按原任务权限查看；受邀回复权限不包含任务修改前后的内容。</p>
          {read.error && (
            <p className="form-error" role="alert">
              {read.error}
              <Button type="button" onClick={read.retry}>
                重读建议采用记录
              </Button>
            </p>
          )}
          {read.value?.items.map((item) => (
            <AdoptionRecord key={item.id} item={item} />
          ))}
          {read.value?.items.length === 0 && <p>还没有采用记录。回复不会自动写入任务说明。</p>}
          {!read.value && !read.error && <p role="status">正在读取采用记录…</p>}
          <div className="assistance-actions">
            {cursor && (
              <Button type="button" onClick={() => setCursor(null)}>
                采用记录首页
              </Button>
            )}
            {read.value?.nextCursor && (
              <Button type="button" onClick={() => setCursor(read.value!.nextCursor)}>
                更多采用记录
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
