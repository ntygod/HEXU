import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import {
  composeDraftAdoption,
  parseDraftRanges,
  selectedDraftText,
  type AiDraft,
  type DraftAdoption,
  type DraftRange,
  type DraftTarget,
} from '../../../packages/contracts/src/ai-drafts.js';
import type { ProjectMaterialCatalog } from '../../../packages/contracts/src/project-materials.js';
import { Button } from '../../../packages/ui/src/index.js';
import { draftPath, DraftFeedback, useDraftCommand, useDraftRead } from './draft-common.js';

export function AdoptDraft({
  task,
  draft,
  onBusy,
  onLock,
  onAdopted,
}: {
  task: Task;
  draft: AiDraft;
  onBusy(v: boolean): void;
  onLock(v: boolean): void;
  onAdopted(): void;
}) {
  const [base, setBase] = useState(draft),
    [ranges, setRanges] = useState<DraftRange[]>([]),
    [selection, setSelection] = useState<DraftRange | null>(null),
    [selectionError, setSelectionError] = useState('');
  const [targetRef, setTargetRef] = useState<Pick<DraftTarget, 'kind' | 'id' | 'title'>>({
    kind: 'task',
    id: task.id,
    title: task.title,
  });
  const [query, setQuery] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [locked, setLocked] = useState(false);
  const catalog = useDraftRead<ProjectMaterialCatalog>(
    task.visibility === 'project' && task.projectId
      ? `/tasks/${task.id}/project-materials?kind=source&q=${encodeURIComponent(query)}${cursor ? `&cursor=${cursor}` : ''}`
      : null,
  );
  const target = useDraftRead<DraftTarget>(
    draftPath(task.id, draft.id) +
      `/target?kind=${targetRef.kind}&id=${encodeURIComponent(targetRef.id)}`,
  );
  const changed = draft.revision !== base.revision;
  let selectedText = '',
    rangeError = '';
  if (ranges.length)
    try {
      selectedText = selectedDraftText(base.content, ranges);
    } catch (e) {
      rangeError = (e as Error).message;
    }
  useEffect(() => {
    onLock(locked);
    return () => onLock(false);
  }, [locked, onLock]);
  return (
    <div className="dialog-body draft-content">
      <p>从已保存的 r{base.revision} 草稿中选取文字，再预览目标变更。未选内容仍保留在草稿中。</p>
      <label className="field">
        选择草稿片段
        <textarea
          aria-label="选择草稿片段"
          value={base.content}
          readOnly
          rows={12}
          disabled={locked}
          onSelect={(event) => {
            const field = event.currentTarget;
            setSelection(
              field.selectionEnd > field.selectionStart
                ? { start: field.selectionStart, end: field.selectionEnd }
                : null,
            );
          }}
        />
      </label>
      <div className="draft-actions">
        <Button
          type="button"
          disabled={locked || !selection || changed}
          onClick={() => {
            if (!selection) return;
            try {
              const next = parseDraftRanges([...ranges, selection]);
              selectedDraftText(base.content, next);
              setRanges(next);
              setSelectionError('');
            } catch (cause) {
              setSelectionError((cause as Error).message);
            }
          }}
        >
          添加所选片段
        </Button>
        <Button
          type="button"
          disabled={locked || changed}
          onClick={() => {
            setRanges([{ start: 0, end: base.content.length }]);
            setSelectionError('');
          }}
        >
          选择整个草稿
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
            清空片段
          </Button>
        )}
      </div>
      {(selectionError || rangeError) && (
        <p className="form-error" role="alert">
          {selectionError || rangeError}
        </p>
      )}
      <section className="draft-selection" aria-label="待采用片段">
        <strong>
          已选 {ranges.length} 个片段 · {selectedText.length} 字符
        </strong>
        {ranges.map((range, index) => (
          <div className="draft-selection-item" key={range.start + ':' + range.end}>
            <pre>{base.content.slice(range.start, range.end)}</pre>
            <Button
              type="button"
              disabled={locked}
              aria-label={`移除片段 ${index + 1}`}
              onClick={() => setRanges((old) => old.filter((_, at) => at !== index))}
            >
              移除
            </Button>
          </div>
        ))}
      </section>
      {changed && (
        <section className="draft-conflict" aria-label="采用来源冲突">
          <strong>草稿已更新为 r{draft.revision}，原片段已保留</strong>
          <pre>{draft.content}</pre>
          <Button
            type="button"
            disabled={locked}
            onClick={() => {
              setBase(draft);
              setRanges([]);
              setSelection(null);
              setSelectionError('');
            }}
          >
            按新草稿重新选择
          </Button>
        </section>
      )}
      {task.projectId && task.visibility === 'project' && (
        <label className="field">
          查找采用目标资料
          <input
            aria-label="查找采用目标资料"
            disabled={locked}
            value={query}
            maxLength={160}
            placeholder="资料标题或摘要…"
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(null);
            }}
          />
        </label>
      )}
      <label className="field">
        采用目标
        <select
          aria-label="采用目标"
          disabled={locked}
          value={`${targetRef.kind}:${targetRef.id}`}
          onChange={(e) => {
            const value = e.target.value;
            if (value === `task:${task.id}`)
              setTargetRef({ kind: 'task', id: task.id, title: task.title });
            else {
              const item = catalog.value?.items.find((item) => `source:${item.id}` === value);
              if (item) setTargetRef({ kind: 'source', id: item.id, title: item.title });
            }
          }}
        >
          <option value={`task:${task.id}`}>当前任务说明</option>
          {targetRef.kind === 'source' &&
            !catalog.value?.items.some((item) => item.id === targetRef.id) && (
              <option value={`source:${targetRef.id}`}>{targetRef.title}（已选择）</option>
            )}
          {catalog.value?.items.map((item) => (
            <option key={item.id} value={`source:${item.id}`}>
              项目资料：{item.title}
            </option>
          ))}
        </select>
      </label>
      {catalog.error && (
        <p className="form-error" role="alert">
          {catalog.error}
          <Button type="button" onClick={catalog.retry}>
            重读目标目录
          </Button>
        </p>
      )}
      <div className="draft-actions">
        {cursor && (
          <Button type="button" disabled={locked} onClick={() => setCursor(null)}>
            目标目录首页
          </Button>
        )}
        {catalog.value?.nextCursor && (
          <Button
            type="button"
            disabled={locked}
            onClick={() => setCursor(catalog.value!.nextCursor)}
          >
            更多目标资料
          </Button>
        )}
      </div>
      {task.visibility === 'private' && (
        <p className="hint">私有草稿只可采用到当前任务说明，此操作不提供项目共享。</p>
      )}
      {target.error && (
        <p className="form-error" role="alert">
          {target.error}；所选片段已保留。
          {!target.denied && (
            <Button type="button" onClick={target.retry}>
              重读采用目标
            </Button>
          )}
        </p>
      )}
      {target.value && !target.denied && (
        <TargetAdoption
          key={`${targetRef.kind}:${targetRef.id}`}
          task={task}
          draft={base}
          ranges={ranges}
          selectedText={selectedText}
          current={target.value}
          blocked={changed || !!target.error || !!rangeError}
          onBusy={onBusy}
          onLock={setLocked}
          onAdopted={onAdopted}
        />
      )}
    </div>
  );
}
function TargetAdoption({
  task,
  draft,
  ranges,
  selectedText,
  current,
  blocked,
  onBusy,
  onLock,
  onAdopted,
}: {
  task: Task;
  draft: AiDraft;
  ranges: DraftRange[];
  selectedText: string;
  current: DraftTarget;
  blocked: boolean;
  onBusy(v: boolean): void;
  onLock(v: boolean): void;
  onAdopted(): void;
}) {
  const [base, setBase] = useState(current),
    [mode, setMode] = useState<'append' | 'replace'>('append');
  const command = useDraftCommand<DraftAdoption>(() => onAdopted(), onBusy);
  const locked = command.busy || !!command.uncertain,
    conflict = current.revision !== base.revision;
  useEffect(() => {
    onLock(locked);
    return () => onLock(false);
  }, [locked, onLock]);
  let next = '',
    limitError = '';
  if (selectedText)
    try {
      next = composeDraftAdoption(base, selectedText, mode);
    } catch (e) {
      limitError = (e as Error).message;
    }
  if (command.denied)
    return (
      <>
        <DraftFeedback command={command} />
        <p>采用权限已变化，请关闭后重新查看目标。</p>
      </>
    );
  return (
    <form
      className="draft-adoption"
      onSubmit={(e) => {
        e.preventDefault();
        if (locked || conflict || blocked || !selectedText || limitError) return;
        void command.send(
          draftPath(task.id, draft.id) + '/adoptions',
          'POST',
          {
            expectedRevision: draft.revision,
            ranges,
            mode,
            target: { kind: base.kind, id: base.id, expectedRevision: base.revision },
          },
          '所选片段已采用；草稿与采用记录均已保留',
        );
      }}
    >
      <label className="field">
        采用方式
        <select
          aria-label="采用方式"
          disabled={locked}
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="append">追加到现有内容之后</option>
          <option value="replace">替换目标正文</option>
        </select>
      </label>
      <section className="draft-comparison" aria-label="采用前后预览">
        <div>
          <h4>当前目标 · r{base.revision}</h4>
          <pre>{base.content || '（空）'}</pre>
        </div>
        <div>
          <h4>
            {mode === 'replace' ? '替换后的正文' : '追加后的正文'} · {next.length}/{base.limit} 字符
          </h4>
          <pre>{next || '选择片段后显示预览'}</pre>
        </div>
      </section>
      <p className="hint">
        {base.kind === 'task'
          ? '仅修改任务说明；等待接续会暂停并保留原材料，活动执行不会自动停止或收到新输入。'
          : '当前项目成员可见。仅修改资料正文，原有执行快照不会被改写；使用旧资料等待的执行会重新核对版本。'}
        任务状态、负责人和工具权限保持原值。
      </p>
      {conflict && (
        <section className="draft-conflict" aria-label="采用目标冲突">
          <strong>目标已更新为 r{current.revision}</strong>
          <p>所选片段已保留，请比较最新正文再继续。</p>
          <pre>{current.content || '（空）'}</pre>
          <Button type="button" disabled={locked} onClick={() => setBase(current)}>
            以最新目标为基线，保留所选片段
          </Button>
        </section>
      )}
      {limitError && (
        <p className="form-error" role="alert">
          {limitError}
        </p>
      )}
      <DraftFeedback command={command} />
      <div className="draft-actions">
        <Button
          type="submit"
          variant="primary"
          busy={command.busy}
          disabled={locked || blocked || conflict || !selectedText || !!limitError}
        >
          采用所选片段
        </Button>
      </div>
    </form>
  );
}
