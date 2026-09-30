import {
  CODE_DIFF_LIMIT,
  parseCodeDifference,
  type CodeFileDifference,
  type CodeFileVersion,
  type CodeDifferenceSummary,
  type ResultCodeReference,
  type ResultCodeDifference,
} from '../../../../packages/contracts/src/result-code.js';
import { snapshotEntries } from './checkpoint-restore-plan.js';
import type { verifySnapshot } from './checkpoint-objects.js';
import { DomainError } from '../../../../packages/contracts/src/index.js';

type Snapshot = Awaited<ReturnType<typeof verifySnapshot>>;
/** Both inputs have been verified against fixed Git object IDs. No working files,
 * Git diff drivers, hooks, filters or external diff programs are consulted. */
export function buildCodeDifference(
  revisionId: string,
  reference: ResultCodeReference,
  before: Snapshot,
  after: Snapshot,
  comparedAt: string,
): ResultCodeDifference {
  const files = (snapshot: Snapshot, tree: string) => {
    try {
      return new Map(
        snapshotEntries(reference.base.objectFormat, tree, snapshot, '/fixed-code')
          .entries.filter((e) => e.kind === 'file')
          .map((e) => [
            e.path,
            { objectId: e.objectId, mode: e.gitMode as CodeFileVersion['mode'], bytes: e.bytes },
          ]),
      );
    } catch (cause) {
      if (cause instanceof DomainError)
        throw new DomainError(
          'CODE_DIFF_UNSUPPORTED',
          '所选提交含不支持的文件名、符号链接、子模块、LFS指针或超出展开预算，未共享代码差异',
        );
      throw cause;
    }
  };
  const a = files(before, reference.base.tree),
    b = files(after, reference.checkpoint.manifest.tree);
  const aObjects = new Map(before.objects.map((o) => [o.id, o.data])),
    bObjects = new Map(after.objects.map((o) => [o.id, o.data]));
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) =>
    Buffer.compare(Buffer.from(x), Buffer.from(y)),
  );
  const changed = paths.filter(
    (p) => a.get(p)?.objectId !== b.get(p)?.objectId || a.get(p)?.mode !== b.get(p)?.mode,
  );
  const metadata = { revisionId, referenceHash: reference.hash, comparedAt };
  const difference = buildCodeDifferenceSummary(
    changed.map((path) => ({ path, before: a.get(path) ?? null, after: b.get(path) ?? null })),
    aObjects,
    bObjects,
    (value) => Buffer.byteLength(JSON.stringify({ ...metadata, ...value })) <= CODE_DIFF_LIMIT,
  );
  return parseCodeDifference({ ...metadata, ...difference });
}

export interface CodeDifferenceInput {
  path: string;
  before: CodeFileVersion | null;
  after: CodeFileVersion | null;
}
/** Shared display core. Callers supply fixed, verified blob maps and reserve their
 * complete metadata envelope before adding bodies. A body is whole or omitted. */
export function buildCodeDifferenceSummary(
  changes: readonly CodeDifferenceInput[],
  beforeObjects: ReadonlyMap<string, Buffer>,
  afterObjects: ReadonlyMap<string, Buffer>,
  fits: (summary: CodeDifferenceSummary) => boolean = (value) =>
    Buffer.byteLength(JSON.stringify(value)) <= CODE_DIFF_LIMIT,
): CodeDifferenceSummary {
  const output: CodeDifferenceSummary = {
    changedFiles: changes.length,
    omittedFiles: changes.length,
    files: [],
  };
  if (!fits(output))
    throw new DomainError('CODE_DIFF_LIMIT', '完整选择与固定差异元数据超出共享边界');
  const plain = (buffer: Buffer) => {
    const s = buffer.toString('utf8');
    return (
      Buffer.from(s).equals(buffer) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)
    );
  };
  const bytes = (version: CodeFileVersion | null, objects: ReadonlyMap<string, Buffer>) => {
    if (!version) return Buffer.alloc(0);
    const data = objects.get(version.objectId);
    if (!data || data.length !== version.bytes)
      throw new DomainError('SNAPSHOT_INCOMPLETE', '固定差异对象缺失或大小不一致');
    return data;
  };
  for (const { path, before: left, after: right } of changes) {
    if (output.files.length === 40) break;
    const x = bytes(left, beforeObjects),
      y = bytes(right, afterObjects);
    const display =
      x.length > 8192 || y.length > 8192 ? 'large' : plain(x) && plain(y) ? 'text' : 'binary';
    let file: CodeFileDifference = {
      path,
      before: left,
      after: right,
      display,
      ...(display === 'text'
        ? { beforeText: x.toString('utf8'), afterText: y.toString('utf8') }
        : {}),
    };
    output.files.push(file);
    output.omittedFiles--;
    if (!fits(output) && display === 'text') {
      file = { path, before: left, after: right, display: 'budget' };
      output.files[output.files.length - 1] = file;
    }
    if (!fits(output)) {
      output.files.pop();
      output.omittedFiles++;
    }
  }
  return output;
}
