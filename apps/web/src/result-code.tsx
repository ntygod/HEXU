import type {
  ResultCodeReference,
  ResultCodeEvidence,
  CodeDifferenceSummary,
  CodeFileDifference,
} from '../../../packages/contracts/src/result-code.js';
import { useEffect, useRef, type ReactNode } from 'react';
import type { ResultCodeFeedbackAnchor } from '../../../packages/contracts/src/result-code-feedback.js';
import { Button } from '../../../packages/ui/src/index.js';
import { time } from './state.js';
import './result-code.css';
import { CodeLineDifference } from './code-line-difference.js';

/** Text-only presentation shared by result commits and immutable trial candidates. */
export function CodeDifferencePanel({
  difference,
  title = '查看固定代码差异',
  beforeLabel = '起点文件',
  afterLabel = '所选文件',
  emptyLabel = '所选提交相对共同起点没有普通文件变化。',
  children,
  onFeedback,
  focusAnchor,
}: {
  difference: CodeDifferenceSummary;
  title?: string;
  beforeLabel?: string;
  afterLabel?: string;
  emptyLabel?: string;
  children?: ReactNode;
  onFeedback?: (file: CodeFileDifference) => void;
  focusAnchor?: ResultCodeFeedbackAnchor;
}) {
  const root = useRef<HTMLDetailsElement>(null),
    focused = useRef<HTMLDetailsElement>(null);
  const focusKey = focusAnchor
    ? [
        focusAnchor.path,
        focusAnchor.side,
        focusAnchor.objectId,
        focusAnchor.range?.start,
        focusAnchor.range?.end,
        focusAnchor.referenceHash,
        focusAnchor.differenceHash,
      ].join('\0')
    : '';
  useEffect(() => {
    if (!focusAnchor || !root.current || !focused.current) return;
    root.current.open = true;
    focused.current.open = true;
    const frame = requestAnimationFrame(() => {
      const target =
        focused.current?.querySelector<HTMLElement>('[data-code-feedback-focus]') ??
        focused.current?.querySelector<HTMLElement>('summary');
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusKey]);
  return (
    <details className="result-code-diff" ref={root}>
      <summary>
        {title}（{difference.changedFiles}个文件）
      </summary>
      {children}
      {difference.omittedFiles > 0 && (
        <p className="work-branch-notice">
          受共享预算限制，另有 {difference.omittedFiles} 个变化文件未列出；当前展示不是完整补丁。
        </p>
      )}
      {!difference.changedFiles && <p>{emptyLabel}</p>}
      {difference.files.map((file) => {
        const feedback =
          focusAnchor?.path === file.path &&
          file[focusAnchor.side]?.objectId === focusAnchor.objectId
            ? focusAnchor
            : undefined;
        return (
          <details
            key={`${file.path}:${file.before?.objectId}:${file.after?.objectId}:${file.before?.mode}:${file.after?.mode}`}
            className="result-code-file"
            ref={feedback ? focused : undefined}
          >
            <summary>
              <span>
                {!file.before
                  ? '+ 新增'
                  : !file.after
                    ? '− 删除'
                    : file.before.objectId === file.after.objectId
                      ? '模式变化'
                      : '修改'}
              </span>{' '}
              <code>{file.path}</code>
            </summary>
            <p>
              {file.before ? `${file.before.bytes} 字节 / ${file.before.mode}` : '原来不存在'} →{' '}
              {file.after ? `${file.after.bytes} 字节 / ${file.after.mode}` : '已删除'}
            </p>
            {feedback && (
              <p className="work-branch-notice" aria-label="固定反馈位置">
                反馈定位：{feedback.side === 'before' ? '起点文件' : '所选文件'}
                {feedback.range
                  ? `第${feedback.range.start}–${feedback.range.end}行`
                  : '整个文件'}{' '}
                · 固定对象 {feedback.objectId.slice(0, 12)}
              </p>
            )}
            {onFeedback && (
              <Button type="button" onClick={() => onFeedback(file)}>
                对这个文件提出反馈
              </Button>
            )}
            {file.display === 'text' ? (
              <CodeLineDifference
                before={file.beforeText ?? ''}
                after={file.afterText ?? ''}
                beforeExists={!!file.before}
                afterExists={!!file.after}
                beforeLabel={beforeLabel}
                afterLabel={afterLabel}
                feedback={feedback}
              />
            ) : (
              <p>
                {
                  {
                    binary: '二进制或非UTF-8文件，仅展示固定对象与大小。',
                    large: '文件超过单侧8 KiB正文范围，正文未共享。',
                    budget: '受本次24 KiB共享预算限制，正文未共享。',
                  }[file.display]
                }
              </p>
            )}
          </details>
        );
      })}
    </details>
  );
}
export function ResultCodePanel({
  code,
  evidence,
  revisionId,
  onFeedback,
  focusAnchor,
}: {
  code: ResultCodeReference;
  evidence?: ResultCodeEvidence;
  revisionId?: string;
  onFeedback?: (file: CodeFileDifference) => void;
  focusAnchor?: ResultCodeFeedbackAnchor;
}) {
  const difference = evidence?.difference;
  const state = evidence?.retention;
  return (
    <section className="result-code" aria-label="固定代码与差异">
      <strong>固定提交引用</strong>
      <dl>
        <dt>共同起点</dt>
        <dd>
          <code>{code.base.commit}</code>
        </dd>
        <dt>所选代码</dt>
        <dd>
          <code>{code.checkpoint.manifest.commit}</code>
        </dd>
      </dl>
      <p>
        此引用在 {time(code.checkpoint.manifest.verifiedAt)}{' '}
        核对。可能包含Run结束后的人工修改；未提交、暂存、未跟踪和忽略内容不包含。
      </p>
      {code.base.commit === code.checkpoint.manifest.commit && (
        <p className="work-branch-notice">所选提交与共同起点相同，不代表生成了新的提交内容。</p>
      )}
      {code.retention ? (
        <p>
          对象副本：
          {state?.state === 'retained' && state.nodeAuthorized
            ? '最后报告已保留'
            : state?.state === 'expired'
              ? '已过期'
              : state?.state === 'deleted'
                ? '已删除'
                : '当前不可用或授权已变化'}
          ；原保留期限 {time(code.retention.manifest.expiresAt)}。这不是实时文件检测。
        </p>
      ) : (
        <p>尚未关联对象副本，提交引用不等于备份或可恢复现场。</p>
      )}
      {difference ? (
        <CodeDifferencePanel
          difference={difference}
          onFeedback={onFeedback}
          focusAnchor={
            focusAnchor?.referenceHash === difference.referenceHash ? focusAnchor : undefined
          }
        >
          <p>
            {time(difference.comparedAt)}{' '}
            由原节点核验并明确共享；比较两个提交中的文件，不含活动目录或完整Git历史。
          </p>
        </CodeDifferencePanel>
      ) : (
        <>
          <p>此版本尚未共享可读差异，不能仅凭提交引用推断文件内容。</p>
          {evidence?.canPublish && revisionId && (
            <details>
              <summary>在本人节点核验并共享差异</summary>
              <p>在原方案节点执行，先核对两个提交，再明确确认共享文件名与差异正文。</p>
              <pre>
                npm run runner:result-code -- --revision {revisionId} --state /path/to/node-state
              </pre>
            </details>
          )}
        </>
      )}
    </section>
  );
}
