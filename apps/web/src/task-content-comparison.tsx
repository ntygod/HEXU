import { Fragment, useMemo, useState } from 'react';
import type { TaskContentRevision } from '../../../packages/contracts/src/task-content-history.js';
import {
  compareTaskContent,
  type TaskContentComparison as Comparison,
} from '../../../packages/domain/src/task-content-comparison.js';
import type { DifferenceLine } from '../../../packages/domain/src/line-difference.js';
import { Button } from '../../../packages/ui/src/index.js';
import { time } from './state.js';
import './task-content-comparison.css';

const source = {
  created: '创建任务',
  edited: '手工编辑',
  adopted: '明确采用内容',
  status: '状态操作清除关注',
  legacy: '已有内容快照',
};

/** Mounted only with two or more currently readable history records. No new data reads or writes. */
export function TaskContentComparison({
  taskId,
  items,
}: {
  taskId: string;
  items: TaskContentRevision[];
}) {
  const [open, setOpen] = useState(false);
  const [before, setBefore] = useState(items[1]!);
  const [after, setAfter] = useState(items[0]!);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState('');
  // Keep selected old records available even if an explicit first-page reload no
  // longer includes them. Current permission/identity loss unmounts this component.
  const options = [
    ...new Map(
      [...items, before, after]
        .filter((item) => item.taskId === taskId)
        .map((item) => [item.revision, item]),
    ).values(),
  ].sort((a, b) => b.revision - a.revision);
  const valid =
    before.taskId === taskId && after.taskId === taskId && before.revision < after.revision;
  const pending =
    comparison &&
    (comparison.before.revision !== before.revision ||
      comparison.after.revision !== after.revision);
  return (
    <section className="task-comparison-picker" aria-label="工作说明版本对照">
      <button className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        对照两个版本
      </button>
      {open && (
        <>
          <p>从已加载的历史中选择。双方固定在所选修订；新保存或刷新历史不会自动替换对照。</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              try {
                setComparison(compareTaskContent(taskId, before, after));
                setError('');
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : '无法对照所选版本');
              }
            }}
          >
            <label>
              较早版本
              <select
                aria-label="较早版本"
                value={before.revision}
                onChange={(event) => {
                  const item = options.find((item) => item.revision === Number(event.target.value));
                  if (item) setBefore(item);
                }}
              >
                {options.map((item) => (
                  <option key={item.revision} value={item.revision}>
                    任务修订 {item.revision} · {source[item.source]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              较新版本
              <select
                aria-label="较新版本"
                value={after.revision}
                onChange={(event) => {
                  const item = options.find((item) => item.revision === Number(event.target.value));
                  if (item) setAfter(item);
                }}
              >
                {options.map((item) => (
                  <option key={item.revision} value={item.revision}>
                    任务修订 {item.revision} · {source[item.source]}
                  </option>
                ))}
              </select>
            </label>
            {!valid && <p role="status">请选择两个不同版本，并将较早版本放在前面。</p>}
            {pending && <p role="status">选择已改变，点击查看后再切换对照。</p>}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <Button type="submit" disabled={!valid}>
              查看两版对照
            </Button>
          </form>
          {comparison && (
            <Compared
              key={`${comparison.before.revision}:${comparison.after.revision}`}
              value={comparison}
            />
          )}
        </>
      )}
    </section>
  );
}

function Version({ item, label }: { item: TaskContentRevision; label: string }) {
  return (
    <section className="task-compared-version" aria-label={label}>
      <h4>
        {label} · 任务修订 {item.revision}
      </h4>
      <p>
        {source[item.source]} · {item.actorName ?? '操作者未记录'} ·{' '}
        {item.savedAt ? (
          <time dateTime={item.savedAt} title={item.savedAt}>
            {time(item.savedAt)}
          </time>
        ) : (
          '保存时间未记录'
        )}
      </p>
      {item.source === 'legacy' && <p>这是迁移时已有的内容，更早的修改过程未记录。</p>}
    </section>
  );
}
function Compared({ value }: { value: Comparison }) {
  const { before, after, description } = value;
  const [full, setFull] = useState(false);
  const groups = useMemo(() => {
    if (description.kind !== 'diff') return [];
    const result: DifferenceLine[][] = [];
    for (const row of description.rows) {
      const previous = result.at(-1);
      if (row.kind === 'context' && previous?.[0]?.kind === 'context') previous.push(row);
      else result.push([row]);
    }
    return result;
  }, [description]);
  const showFull = full || description.kind === 'fallback';
  return (
    <section className="task-content-comparison" aria-label="固定工作说明对照">
      <h3>
        任务修订 {before.revision} → {after.revision}
      </h3>
      <p>对照已保存的两版内容，仅供阅读。</p>
      <Version item={before} label="较早一版" />
      <Version item={after} label="较新一版" />
      <Field label="标题" before={before.title} after={after.title} changed={value.titleChanged} />
      <Field
        label="关注内容"
        before={before.attention ?? ''}
        after={after.attention ?? ''}
        changed={value.attentionChanged}
      />
      <section aria-label="说明文字对照">
        <h4>说明</h4>
        <div className="task-comparison-actions" role="group" aria-label="说明阅读方式">
          <Button
            aria-pressed={!showFull}
            disabled={description.kind === 'fallback'}
            onClick={() => setFull(false)}
          >
            行级变化
          </Button>
          <Button aria-pressed={showFull} onClick={() => setFull(true)}>
            两版全文
          </Button>
          {description.kind === 'diff' && (
            <span>
              新增 {description.added} 行 · 删除 {description.removed} 行
            </span>
          )}
        </div>
        {description.kind === 'fallback' && (
          <p role="status">
            {description.reason === 'size'
              ? '说明行数或长度超过行级展示上限'
              : '差异较复杂，超过行比较计算上限'}
            ，改为查看两版完整说明。
          </p>
        )}
        {showFull ? (
          <div className="task-comparison-pair">
            <section aria-label="较早说明全文">
              <h5>任务修订 {before.revision}</h5>
              <pre tabIndex={0}>{before.description || '（空）'}</pre>
            </section>
            <section aria-label="较新说明全文">
              <h5>任务修订 {after.revision}</h5>
              <pre tabIndex={0}>{after.description || '（空）'}</pre>
            </section>
          </div>
        ) : (
          description.kind === 'diff' && (
            <>
              {!description.added && !description.removed ? (
                <p>两版说明文字一致。</p>
              ) : (
                <>
                  <p>+ 新增，− 删除；原行与新行分别对应两版说明，保留空白和换行。</p>
                  <table className="task-comparison-table" aria-label="说明行级变化">
                    <colgroup>
                      <col className="task-comparison-gutter" />
                      <col className="task-comparison-gutter" />
                      <col className="task-comparison-marker" />
                      <col />
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">原行</th>
                        <th scope="col">新行</th>
                        <th scope="col" aria-label="变化">
                          ±
                        </th>
                        <th scope="col">说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((rows, index) => (
                        <Fragment key={index}>
                          {rows[0]!.kind === 'context' ? (
                            <Context rows={rows} />
                          ) : (
                            <Line row={rows[0]!} />
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )
        )}
      </section>
    </section>
  );
}
function Field({
  label,
  before,
  after,
  changed,
}: {
  label: string;
  before: string;
  after: string;
  changed: boolean;
}) {
  return (
    <section aria-label={`${label}对照`}>
      <h4>
        {label} · {changed ? '已变化' : '未变化'}
      </h4>
      {changed ? (
        <dl>
          <dt>较早一版</dt>
          <dd>{before || '（无）'}</dd>
          <dt>较新一版</dt>
          <dd>{after || '（无）'}</dd>
        </dl>
      ) : (
        <p className="task-comparison-text">{after || '（无）'}</p>
      )}
    </section>
  );
}
function Line({ row }: { row: DifferenceLine }) {
  return (
    <tr className={`task-comparison-${row.kind}`}>
      <td>{row.before ?? '·'}</td>
      <td>{row.after ?? '·'}</td>
      <td
        aria-label={
          row.kind === 'addition' ? '新增行' : row.kind === 'deletion' ? '删除行' : '未变行'
        }
      >
        {row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ' '}
      </td>
      <td>
        <span>{row.text}</span>
        {row.ending !== 'LF' && <small>{row.ending === 'none' ? '末尾无换行' : row.ending}</small>}
      </td>
    </tr>
  );
}
function Context({ rows }: { rows: DifferenceLine[] }) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length <= 8) return rows.map((row, index) => <Line key={index} row={row} />);
  return (
    <>
      {rows.slice(0, 3).map((row, index) => (
        <Line key={'start' + index} row={row} />
      ))}
      <tr>
        <td colSpan={4}>
          <Button
            aria-expanded={expanded}
            aria-label={`${expanded ? '收起' : '展开'}原第${rows[3]!.before}–${rows[rows.length - 4]!.before}行未变说明`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起' : '展开'} {rows.length - 6} 行未变内容
          </Button>
        </td>
      </tr>
      {expanded && rows.slice(3, -3).map((row, index) => <Line key={'middle' + index} row={row} />)}
      {rows.slice(-3).map((row, index) => (
        <Line key={'end' + index} row={row} />
      ))}
    </>
  );
}
