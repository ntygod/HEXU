import { DomainError } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash, commitOid, type CommitCheckpoint } from './checkpoints.js';
import {
  retentionDate,
  type RetentionManifest,
  type RetentionView,
} from './checkpoint-retention.js';

export interface ResultCodeReference {
  kind: 'commit_reference';
  checkpoint: CommitCheckpoint;
  base: { objectFormat: 'sha1' | 'sha256'; commit: string; tree: string };
  retention: { id: string; manifest: RetentionManifest } | null;
  hash: string;
}
export interface ResultCodeOption {
  checkpoint: CommitCheckpoint;
  retentions: RetentionView[];
}
export interface CodeFileVersion {
  objectId: string;
  mode: '100644' | '100755';
  bytes: number;
}
export interface CodeFileDifference {
  path: string;
  before: CodeFileVersion | null;
  after: CodeFileVersion | null;
  display: 'text' | 'binary' | 'large' | 'budget';
  beforeText?: string;
  afterText?: string;
}
export const CODE_DIFF_LIMIT = 24 * 1024;
export interface ResultCodeDifference {
  revisionId: string;
  referenceHash: string;
  comparedAt: string;
  changedFiles: number;
  omittedFiles: number;
  files: CodeFileDifference[];
}
export interface ResultCodeEvidence {
  difference: ResultCodeDifference | null;
  retention: {
    state: RetentionView['state'] | 'not_requested' | 'unavailable';
    observedAt: string | null;
    nodeAuthorized: boolean;
  };
  canPublish: boolean;
}
export function parseCodeDifference(input: unknown): ResultCodeDifference {
  const b = exact(input, [
    'revisionId',
    'referenceHash',
    'comparedAt',
    'changedFiles',
    'omittedFiles',
    'files',
  ]);
  const integer = (v: unknown, max: number) => {
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max)
      throw new DomainError('INVALID_INPUT', '代码差异数量或大小无效');
    return v as number;
  };
  const fileVersion = (v: unknown): CodeFileVersion | null => {
    if (v === null) return null;
    const o = exact(v, ['objectId', 'mode', 'bytes']);
    if (o.mode !== '100644' && o.mode !== '100755')
      throw new DomainError('INVALID_INPUT', '当前差异仅支持普通文件');
    return {
      objectId: commitOid(o.objectId),
      mode: o.mode,
      bytes: integer(o.bytes, 8 * 1024 * 1024),
    };
  };
  if (!Array.isArray(b.files) || b.files.length > 40)
    throw new DomainError('INVALID_INPUT', '一次最多共享40个文件差异');
  const paths = new Set<string>();
  const files = b.files.map((item): CodeFileDifference => {
    const f = exact(item, ['path', 'before', 'after', 'display', 'beforeText', 'afterText']);
    if (
      typeof f.path !== 'string' ||
      new TextEncoder().encode(f.path).byteLength > 4096 ||
      /[\p{Cc}\p{Cf}\\]/u.test(f.path) ||
      f.path.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')
    )
      throw new DomainError('INVALID_INPUT', '差异文件名无效');
    const key = f.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new DomainError('INVALID_INPUT', '差异文件名重复或冲突');
    paths.add(key);
    const before = fileVersion(f.before),
      after = fileVersion(f.after);
    if (
      (!before && !after) ||
      (before && after && before.objectId === after.objectId && before.mode === after.mode)
    )
      throw new DomainError('INVALID_INPUT', '差异文件没有变更');
    if (!['text', 'binary', 'large', 'budget'].includes(String(f.display)))
      throw new DomainError('INVALID_INPUT', '差异展示类型无效');
    const display = f.display as CodeFileDifference['display'];
    if (display === 'text') {
      for (const [value, meta] of [
        [f.beforeText, before],
        [f.afterText, after],
      ] as const) {
        if (
          typeof value !== 'string' ||
          new TextEncoder().encode(value).byteLength > 8192 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
          (meta ? new TextEncoder().encode(value).byteLength !== meta.bytes : value !== '')
        )
          throw new DomainError('INVALID_INPUT', '文本差异必须是边界内的完整UTF-8文件内容');
      }
    } else if (f.beforeText !== undefined || f.afterText !== undefined)
      throw new DomainError('INVALID_INPUT', '非文本差异不包含文件正文');
    return {
      path: f.path,
      before,
      after,
      display,
      ...(display === 'text'
        ? { beforeText: f.beforeText as string, afterText: f.afterText as string }
        : {}),
    };
  });
  const result = {
    revisionId: nodeId(b.revisionId),
    referenceHash: checkpointHash(b.referenceHash),
    comparedAt: retentionDate(b.comparedAt),
    changedFiles: integer(b.changedFiles, 100000),
    omittedFiles: integer(b.omittedFiles, 100000),
    files,
  };
  if (
    result.changedFiles !== files.length + result.omittedFiles ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength > CODE_DIFF_LIMIT
  )
    throw new DomainError('INVALID_INPUT', '代码差异数量不一致或超过24 KiB');
  return result;
}
