import {
  CODE_DIFF_LIMIT,
  parseCodeDifference,
  type CodeFileDifference,
  type CodeFileVersion,
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
  const output: ResultCodeDifference = {
    revisionId,
    referenceHash: reference.hash,
    comparedAt,
    changedFiles: changed.length,
    omittedFiles: changed.length,
    files: [],
  };
  const size = () => Buffer.byteLength(JSON.stringify(output));
  const plain = (buffer: Buffer) => {
    const s = buffer.toString('utf8');
    return (
      Buffer.from(s).equals(buffer) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)
    );
  };
  for (const path of changed) {
    if (output.files.length === 40) break;
    const left = a.get(path) ?? null,
      right = b.get(path) ?? null;
    const x = left ? aObjects.get(left.objectId)! : Buffer.alloc(0),
      y = right ? bObjects.get(right.objectId)! : Buffer.alloc(0);
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
    if (size() > CODE_DIFF_LIMIT && display === 'text') {
      file = { path, before: left, after: right, display: 'budget' };
      output.files[output.files.length - 1] = file;
    }
    if (size() > CODE_DIFF_LIMIT) {
      output.files.pop();
      output.omittedFiles++;
    }
  }
  return parseCodeDifference(output);
}
