import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative, isAbsolute, sep, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import {
  parseCodeDifference,
  type ResultCodeEvidence,
  type ResultCodeDifference,
} from '../../../../packages/contracts/src/result-code.js';
import type { ResultRevision } from '../../../../packages/contracts/src/results.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { captureCommitReference } from './checkpoints.js';
import { verifySnapshot } from './checkpoint-objects.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import { buildCodeDifference } from './result-code-diff.js';

const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const inside = (a: string, b: string) => {
  const r = relative(a, b);
  return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
};
export function assertCodeQuiescent(home: string, root: string, rootIdentity: string) {
  const journal = join(home, 'journal.sqlite');
  if (existsSync(journal)) {
    restorePrivatePath(journal, false);
    const db = new DatabaseSync(journal, { readOnly: true });
    try {
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE name='execution_commands'").get() &&
        db.prepare("SELECT 1 FROM execution_commands WHERE phase!='terminal'").get()
      )
        throw new DomainError(
          'RESULT_CODE_WRITER_ACTIVE',
          '本机仍有未确认执行，未读取或共享差异',
          409,
        );
    } finally {
      db.close();
    }
  }
  const registry = join(homedir(), '.hexu', 'workspace-leases', 'registry.sqlite');
  if (existsSync(registry)) {
    restorePrivatePath(registry, false);
    const db = new DatabaseSync(registry, { readOnly: true });
    try {
      const claims = db.prepare('SELECT root,identity FROM claims').all() as {
        root: string;
        identity: string;
      }[];
      if (
        claims.some(
          (c) => c.identity === rootIdentity || inside(c.root, root) || inside(root, c.root),
        )
      )
        throw new DomainError(
          'RESULT_CODE_WRITER_ACTIVE',
          '此目录仍有受管占用或未知进程，未读取或共享差异',
          409,
        );
    } finally {
      db.close();
    }
  }
}
export async function shareResultCode(
  home: string,
  revisionId: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
) {
  nodeId(revisionId);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', '当前代码差异核验仅支持Linux本人节点');
  home = resolve(home);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  if (
    c.directories.flatMap((w) => [w.root, w.gitDir]).some((p) => inside(p, home) || inside(home, p))
  )
    throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '节点状态不能与代码目录重叠');
  const journal = new AgentStorage(join(home, 'result-code'));
  try {
    journal.db.exec(
      'CREATE TABLE IF NOT EXISTS publication(id INTEGER PRIMARY KEY CHECK(id=1),revision_id TEXT NOT NULL,binding TEXT NOT NULL,body TEXT NOT NULL)',
    );
    const pending = journal.db.prepare('SELECT * FROM publication WHERE id=1').get() as
      | { revision_id: string; binding: string; body: string }
      | undefined;
    if (pending && (pending.revision_id !== revisionId || pending.binding !== binding))
      throw new DomainError(
        'RESULT_CODE_PENDING',
        '先用原凭证确认原成果版本的差异回执，不能替换待发包',
        409,
      );
    const stillBound = () => {
      if (
        restorePrivatePath(home, true) !== homeIdentity ||
        restoreBinding(readCredentials(home)) !== binding
      )
        throw new DomainError(
          'RESULT_CODE_SCOPE_CHANGED',
          '节点凭证或目录绑定变化，保留原差异记录',
        );
    };
    const inspect = async () => {
      stillBound();
      const value = await nodeRequest<{ version: ResultRevision; evidence: ResultCodeEvidence }>(
        c.controlUrl,
        'result-code-inspect',
        { revisionId },
        c.nodeToken,
      );
      stillBound();
      const s = value.version?.source;
      if (
        value.version?.id !== revisionId ||
        s?.kind !== 'work_branch' ||
        s.code === 'not_captured' ||
        s.run.nodeId !== c.nodeId ||
        s.code.checkpoint.request.nodeId !== c.nodeId ||
        s.code.checkpoint.request.projectId !== c.projectId ||
        s.code.checkpoint.request.spaceId !== c.spaceId
      )
        throw new DomainError('RESULT_CODE_SCOPE_CHANGED', '成果不属于本机节点或固定代码范围');
      const { hash: referenceHash, ...reference } = s.code;
      if (referenceHash !== hash(reference))
        throw new DomainError('RESULT_CODE_SCOPE_CHANGED', '代码来源指纹不一致');
      const w = c.directories.find((w) => w.id === s.run.workingCopyId);
      if (!w || s.code.checkpoint.request.workspaceId !== w.id)
        throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '目录不在本机授权范围');
      assertCodeQuiescent(home, w.root, w.rootIdentity);
      return { ...value, source: s, code: s.code, w };
    };
    const original = await inspect();
    let packet: ResultCodeDifference;
    if (pending) {
      packet = parseCodeDifference(JSON.parse(pending.body));
      log('只确认上次明确共享的原始差异，不重新读取提交或工作文件。');
    } else if (original.evidence.difference) {
      return { revisionId, hash: hash(original.evidence.difference) };
    } else {
      log(
        `固定输入提交 ${original.code.base.commit}\n固定输出提交 ${original.code.checkpoint.manifest.commit}`,
      );
      log(
        '只读取这两个提交的普通文件对象。未提交、暂存、未跟踪和忽略内容不包含，不修改仓库或启动模型。',
      );
      if ((await ask(`核对本机来源后输入 DIFF ${revisionId}：`)) !== `DIFF ${revisionId}`)
        throw new DomainError('CONFIRMATION_REQUIRED', '已取消差异读取');
      await inspect();
      const read = async (commit: string, tree: string) => {
        let snapshot: Awaited<ReturnType<typeof verifySnapshot>> | undefined;
        const actual = await captureCommitReference(
          original.w,
          commit,
          c.clientId,
          home,
          async (reader, _commit, actualTree) => {
            if (tree !== actualTree)
              throw new DomainError('SNAPSHOT_INCOMPLETE', '固定树与本机对象不一致');
            snapshot = await verifySnapshot(original.code.base.objectFormat, commit, tree, reader);
          },
        );
        if (actual.repositoryIdentity !== original.code.checkpoint.manifest.repositoryIdentity)
          throw new DomainError('RESULT_CODE_SCOPE_CHANGED', '授权仓库的对象存储身份变化');
        return snapshot!;
      };
      const before = await read(original.code.base.commit, original.code.base.tree);
      const after = await read(
        original.code.checkpoint.manifest.commit,
        original.code.checkpoint.manifest.tree,
      );
      packet = buildCodeDifference(
        revisionId,
        original.code,
        before,
        after,
        new Date().toISOString(),
      );
      await inspect();
      log(JSON.stringify(packet, null, 2));
      log(
        '上面列出的文件名和正文将共享给原任务的有权限成员；大文件、二进制和预算省略均已标明。未在差异中的对象不会上传。',
      );
      if (
        (await ask(`确认共享这份固定差异，输入 SHARE_DIFF ${revisionId}：`)) !==
        `SHARE_DIFF ${revisionId}`
      )
        throw new DomainError('CONFIRMATION_REQUIRED', '未共享本机差异');
      await inspect();
      journal.db
        .prepare('INSERT INTO publication VALUES(1,?,?,?)')
        .run(revisionId, binding, JSON.stringify(packet));
    }
    await inspect();
    const receipt = await nodeRequest<{ revisionId: string; hash: string }>(
      c.controlUrl,
      'result-code-publish',
      packet,
      c.nodeToken,
    );
    if (receipt.revisionId !== revisionId || receipt.hash !== hash(packet))
      throw new DomainError('INVALID_RESPONSE', '差异回执不匹配，保留原待发包');
    journal.db.prepare('DELETE FROM publication WHERE id=1').run();
    return receipt;
  } finally {
    journal.close();
  }
}
