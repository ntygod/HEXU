import { Fragment, useMemo, useState } from 'react';
import { Button } from '../../../packages/ui/src/index.js';
import {
  compareTextLines,
  type DifferenceLine,
} from '../../../packages/domain/src/line-difference.js';

function Line({ row }: { row: DifferenceLine }) {
  return (
    <tr className={`code-diff-${row.kind}`}>
      <td className="code-diff-number">{row.before ?? '·'}</td>
      <td className="code-diff-number">{row.after ?? '·'}</td>
      <td
        className="code-diff-sign"
        aria-label={
          row.kind === 'addition' ? '新增行' : row.kind === 'deletion' ? '删除行' : '未变行'
        }
      >
        {row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ' '}
      </td>
      <td className="code-diff-content">
        <code>{row.text}</code>
        {row.ending !== 'LF' && (
          <small className="code-diff-ending">
            {row.ending === 'none' ? '末尾无换行' : row.ending}
          </small>
        )}
      </td>
    </tr>
  );
}
function Context({ rows }: { rows: DifferenceLine[] }) {
  const [expanded, setExpanded] = useState(false);
  if (rows.length <= 8) return rows.map((row, i) => <Line row={row} key={i} />);
  return (
    <>
      {rows.slice(0, 3).map((row, i) => (
        <Line row={row} key={'first' + i} />
      ))}
      <tr>
        <td colSpan={4} className="code-diff-fold">
          <Button
            type="button"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起' : '展开'} {rows.length - 6} 行未变内容
          </Button>
        </td>
      </tr>
      {expanded && rows.slice(3, -3).map((row, i) => <Line row={row} key={'middle' + i} />)}
      {rows.slice(-3).map((row, i) => (
        <Line row={row} key={'last' + i} />
      ))}
    </>
  );
}
export function CodeLineDifference({
  before,
  after,
  beforeExists,
  afterExists,
  beforeLabel,
  afterLabel,
}: {
  before: string;
  after: string;
  beforeExists: boolean;
  afterExists: boolean;
  beforeLabel: string;
  afterLabel: string;
}) {
  const [full, setFull] = useState(false);
  const comparison = useMemo(() => compareTextLines(before, after), [before, after]);
  const groups = useMemo(() => {
    if (comparison.kind !== 'diff') return [];
    const result: DifferenceLine[][] = [];
    for (const row of comparison.rows) {
      const previous = result.at(-1);
      if (row.kind === 'context' && previous?.[0]?.kind === 'context') previous.push(row);
      else result.push([row]);
    }
    return result;
  }, [comparison]);
  const showFull = full || comparison.kind === 'fallback';
  return (
    <div className="code-line-difference">
      <div className="code-diff-toolbar" role="group" aria-label="代码阅读方式">
        <Button
          type="button"
          aria-pressed={!showFull}
          disabled={comparison.kind === 'fallback'}
          onClick={() => setFull(false)}
        >
          行级差异
        </Button>
        <Button type="button" aria-pressed={showFull} onClick={() => setFull(true)}>
          两侧全文
        </Button>
        {comparison.kind === 'diff' && (
          <span aria-label="文本变化行数">
            +{comparison.added} / −{comparison.removed} 行
          </span>
        )}
      </div>
      {comparison.kind === 'fallback' && (
        <p className="work-branch-notice">
          {comparison.reason === 'size'
            ? '文本行数或长度超过行级展示上限'
            : '差异较复杂，超过本次行比较计算上限'}
          ，保留两侧完整已共享正文；未生成行级比较。
        </p>
      )}
      {showFull ? (
        <div className="result-code-pair">
          <section>
            <h4>− {beforeLabel}</h4>
            <pre>{beforeExists ? before || '（空文件）' : '（此侧没有文件）'}</pre>
          </section>
          <section>
            <h4>+ {afterLabel}</h4>
            <pre>{afterExists ? after || '（空文件）' : '（此侧没有文件）'}</pre>
          </section>
        </div>
      ) : (
        comparison.kind === 'diff' && (
          <>
            <p className="code-diff-legend">
              原行：{beforeLabel} · 新行：{afterLabel}。+ 新增，−
              删除；保留空白与换行，未标记的换行为 LF。此视图不是可应用补丁。
            </p>
            {!comparison.added && !comparison.removed ? (
              <p>
                {beforeExists && afterExists
                  ? '正文相同；文件模式变化以上方记录为准。'
                  : '空文件没有文本行；文件新增或删除以上方记录为准。'}
              </p>
            ) : (
              <table
                className="code-diff-table"
                aria-label={`${beforeLabel}与${afterLabel}行级差异`}
              >
                <colgroup>
                  <col className="code-diff-gutter" />
                  <col className="code-diff-gutter" />
                  <col className="code-diff-marker" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">原行</th>
                    <th scope="col">新行</th>
                    <th scope="col" aria-label="变更">
                      ±
                    </th>
                    <th scope="col">代码</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((rows, i) => (
                    <Fragment key={i}>
                      {rows[0]!.kind === 'context' ? (
                        <Context rows={rows} />
                      ) : (
                        <Line row={rows[0]!} />
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )
      )}
    </div>
  );
}
