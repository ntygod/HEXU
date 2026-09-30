import { DomainError } from '../../contracts/src/index.js';
import type {
  ResultCodeFeedbackInput,
  ResultCodeFeedbackAnchor,
} from '../../contracts/src/result-code-feedback.js';
import type { ResultRevision } from '../../contracts/src/results.js';
import { parseCodeDifference } from '../../contracts/src/result-code.js';
import { countTextLines } from '../../domain/src/line-difference.js';
import { codeHash } from './result-code.js';
import type { Store } from './store.js';
export function resolveCodeFeedbackAnchor(
  store: Store,
  version: ResultRevision,
  input: ResultCodeFeedbackInput,
): ResultCodeFeedbackAnchor {
  store.getTask(version.taskId, true);
  if (version.source.kind !== 'work_branch' || version.source.code === 'not_captured')
    throw new DomainError('CODE_FEEDBACK_UNAVAILABLE', '此固定版本没有代码来源', 409);
  const row = store.db
    .prepare('SELECT digest,body FROM result_code_differences WHERE revision_id=? AND task_id=?')
    .get(version.id, version.taskId) as { digest: string; body: string } | undefined;
  if (!row) throw new DomainError('CODE_FEEDBACK_UNAVAILABLE', '此版本尚未共享文件差异', 409);
  const difference = parseCodeDifference(JSON.parse(row.body));
  if (
    difference.revisionId !== version.id ||
    difference.referenceHash !== version.source.code.hash ||
    codeHash(difference) !== row.digest
  )
    throw new DomainError('CODE_FEEDBACK_SOURCE_CHANGED', '固定差异与原版本不匹配', 409);
  const file = difference.files.find((f) => f.path === input.path),
    object = file?.[input.side];
  if (!file || !object || object.objectId !== input.objectId)
    throw new DomainError('CODE_FEEDBACK_SOURCE_CHANGED', '文件或所选侧不属于当前固定版本', 409);
  if (input.range) {
    if (file.display !== 'text')
      throw new DomainError(
        'CODE_FEEDBACK_LINES_UNAVAILABLE',
        '正文未共享，只能定位文件，不能指定行号',
        409,
      );
    const source = input.side === 'before' ? file.beforeText! : file.afterText!;
    if (input.range.end > countTextLines(source))
      throw new DomainError('INVALID_INPUT', '行范围超出此侧完整已共享正文');
  }
  return {
    version: 1,
    kind: 'result_code_file',
    path: file.path,
    side: input.side,
    objectId: object.objectId,
    referenceHash: difference.referenceHash,
    differenceHash: row.digest,
    range: input.range,
  };
}
