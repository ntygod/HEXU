import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fstatSync,
} from 'node:fs';
import { basename, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError, revision } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  parseRetentionManifest,
  retentionDate,
} from '../../../../packages/contracts/src/checkpoint-retention.js';
import { checkpointHash } from '../../../../packages/contracts/src/checkpoints.js';
import type {
  BranchExecutionBinding,
  BranchWorkspaceOperation,
} from '../../../../packages/contracts/src/work-branch-workspaces.js';
import { parseBranchWorkspaceProof } from '../../../../packages/contracts/src/work-branch-workspaces.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import {
  localRestoreCheckpoint,
  verifyRestoreFiles,
  cleanupRestoreCheckpoint,
} from './checkpoint-restore.js';
import {
  RestoreJournal,
  restoreProgressFromRow,
  readRestoreProgress,
  type RestorePlan,
} from './checkpoint-restore-journal.js';
import { PinnedRestoreParent, inode } from './checkpoint-restore-files.js';
import {
  prepareRestoredGitWorkspace,
  readGitWorkspaceProgress,
  cleanupRestoredGitWorkspace,
  type GitWorkspaceProgress,
} from './restored-git-workspace.js';
import {
  branchOriginHash,
  readBranchOrigin,
  verifyBranchOrigin,
  type BranchOrigin,
} from './branch-origin.js';
import { WorkspaceLease } from '../workspace-lease.js';

interface LocalPreparation {
  id: string;
  target: string;
  binding: string;
  phase: 'preparing' | 'needs_attention' | 'pending' | 'settled';
  packet: unknown | null;
  result: BranchWorkspaceOperation | null;
  git: GitWorkspaceProgress | null;
}
function validateReply(value: BranchWorkspaceOperation, id: string) {
  if (
    !value ||
    value.ticket?.id !== id ||
    !['waiting_local', 'prepared', 'bound', 'cancelled', 'needs_attention'].includes(value.state)
  )
    throw new DomainError('INVALID_RESPONSE', '方案现场响应无效');
  const t = value.ticket;
  for (const v of [
    t.id,
    t.taskId,
    t.branchId,
    t.groupId,
    t.ownerId,
    t.projectId,
    t.spaceId,
    t.sourceNodeId,
    t.retentionId,
    t.checkpointId,
  ])
    nodeId(v);
  checkpointHash(t.startHash);
  checkpointHash(t.requestHash);
  parseRetentionManifest(t.manifest);
  revision(t.branchRevision);
  revision(value.revision);
  retentionDate(t.createdAt);
  retentionDate(t.expiresAt);
  retentionDate(value.updatedAt);
  if (t.createdAt >= t.expiresAt || t.expiresAt > t.manifest.expiresAt)
    throw new DomainError('INVALID_RESPONSE', '现场请求期限无效');
  if (value.proof !== null) {
    parseBranchWorkspaceProof(value.proof);
    if (branchOriginHash(value.proof) !== value.proofHash)
      throw new DomainError('INVALID_RESPONSE', '现场核验回执指纹不一致');
  }
  if (['prepared', 'bound'].includes(value.state) && !value.proof)
    throw new DomainError('INVALID_RESPONSE', '缺少现场核验证据');
  if (value.state === 'bound') {
    nodeId(value.nodeId);
    nodeId(value.workingCopyId);
  }
  if (branchOriginHash({ ...t, requestHash: '' }) !== t.requestHash)
    throw new DomainError('INVALID_RESPONSE', '方案请求指纹无效');
  return value;
}
class BranchJournal {
  readonly storage: AgentStorage;
  constructor(home: string) {
    this.storage = new AgentStorage(join(home, 'branch-preparations'));
    try {
      this.storage.db.exec(
        'CREATE TABLE IF NOT EXISTS preparations(id TEXT PRIMARY KEY,body TEXT NOT NULL)',
      );
      for (const row of this.storage.db.prepare('SELECT body FROM preparations').all() as {
        body: string;
      }[]) {
        const p = JSON.parse(row.body) as LocalPreparation;
        if (p.phase === 'preparing') this.save({ ...p, phase: 'needs_attention' });
      }
    } catch (error) {
      this.storage.close();
      throw error;
    }
  }
  get(id: string): LocalPreparation | null {
    const row = this.storage.db.prepare('SELECT body FROM preparations WHERE id=?').get(id) as
      | { body: string }
      | undefined;
    if (!row) return null;
    const p = JSON.parse(row.body) as LocalPreparation;
    if (p.id !== id || !['preparing', 'needs_attention', 'pending', 'settled'].includes(p.phase))
      throw new DomainError('WORK_BRANCH_JOURNAL_INVALID', '方案本机记录身份不一致');
    return p;
  }
  save(p: LocalPreparation) {
    this.storage.db
      .prepare(
        'INSERT INTO preparations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(p.id, JSON.stringify(p));
  }
  close() {
    this.storage.close();
  }
}
export function assertBranchEvidenceSettled(home: string) {
  for (const [file, table] of [
    [join(home, 'branch-preparations/journal.sqlite'), 'preparations'],
    [join(home, 'journal.sqlite'), 'branch_binding'],
  ] as const) {
    if (!existsSync(file)) continue;
    restorePrivatePath(file, false);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
        for (const row of db.prepare(`SELECT body FROM ${table}`).all() as { body: string }[]) {
          const p = JSON.parse(row.body);
          if (p.phase !== 'settled')
            throw new DomainError(
              'WORK_BRANCH_UNSETTLED',
              '方案现场证据尚未处置，请保留原凭证和记录',
              409,
            );
        }
    } finally {
      db.close();
    }
  }
}
export async function prepareBranchWorkspace(
  home: string,
  id: string,
  target: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
) {
  home = resolve(home);
  nodeId(id);
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  const inside = (a: string, b: string) => {
    const r = relative(a, b);
    return !r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep));
  };
  if (
    c.directories
      .flatMap((w) => [w.root, w.gitDir])
      .some((path) => inside(path, home) || inside(home, path))
  )
    throw new DomainError('RESTORE_TARGET_OVERLAP', '原状态目录与授权代码重叠，未创建准备日志');
  const inspect = async () => {
    if (
      restorePrivatePath(home, true) !== homeIdentity ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原节点凭证或状态目录已变化');
    const op = validateReply(
      await nodeRequest<BranchWorkspaceOperation>(
        c.controlUrl,
        'work-branch-workspace',
        { action: 'inspect', operationId: id },
        c.nodeToken,
      ),
      id,
    );
    if (
      op.ticket.sourceNodeId !== c.nodeId ||
      op.ticket.projectId !== c.projectId ||
      op.ticket.spaceId !== c.spaceId
    )
      throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '不是原本人节点的方案现场请求');
    return op;
  };
  const journal = new BranchJournal(home);
  let p = journal.get(id);
  try {
    const op = await inspect(),
      t = op.ticket;
    if (p && (p.target !== target || p.binding !== binding))
      throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '原准备不能更换目录或身份');
    if (p && ['pending', 'settled'].includes(p.phase)) {
      try {
        new WorkspaceLease(target, `branch-origin:${id}`, true).release();
      } catch {
        /* never release another writer */
      }
    }
    const deliver = async () => {
      const result = validateReply(
        await nodeRequest<BranchWorkspaceOperation>(
          c.controlUrl,
          'work-branch-workspace',
          p!.packet,
          c.nodeToken,
        ),
        id,
      );
      if (!['prepared', 'bound', 'cancelled', 'needs_attention'].includes(result.state))
        throw new DomainError('INVALID_RESPONSE', '尚未确认现场报告');
      p!.result = result;
      p!.phase = 'settled';
      journal.save(p!);
      return p!;
    };
    if (p?.phase === 'pending') return await deliver();
    if (p) return p;
    if (op.state !== 'waiting_local')
      throw new DomainError('WORK_BRANCH_PREPARATION_CHANGED', '此请求不再等待本机准备');
    log(
      JSON.stringify({
        branchId: t.branchId,
        startHash: t.startHash,
        commit: t.manifest.commit,
        target,
        startsModel: false,
      }),
    );
    if ((await ask(`输入 BRANCH ${id}，为此方案明确准备独立新目录：`)) !== `BRANCH ${id}`)
      throw new DomainError('CONFIRMATION_REQUIRED', '未同意方案现场准备');
    if ((await inspect()).state !== 'waiting_local')
      throw new DomainError('WORK_BRANCH_PREPARATION_CHANGED', '方案准备已取消');
    p = { id, target, binding, phase: 'preparing', packet: null, result: null, git: null };
    journal.save(p);
    const restored = await localRestoreCheckpoint(
      home,
      t.retentionId,
      target,
      async (prompt) => {
        const answer = await ask(prompt);
        if ((await inspect()).state !== 'waiting_local')
          throw new DomainError('WORK_BRANCH_PREPARATION_CHANGED', '方案准备已取消，保留本机现场');
        return answer;
      },
      { log },
    );
    if (restored.state !== 'restored')
      throw new DomainError('WORK_BRANCH_RESTORE_INCOMPLETE', '代码恢复未完成，保留原记录和现场');
    const git = await prepareRestoredGitWorkspace(
      home,
      id,
      target,
      ask,
      async () => {
        if ((await inspect()).state !== 'waiting_local')
          throw new DomainError('WORK_BRANCH_PREPARATION_CHANGED', '方案准备已取消，未登记现场');
        return {
          sourceKind: 'retention',
          sourceId: t.retentionId,
          ownerId: t.ownerId,
          commit: t.manifest.commit,
          snapshotHash: t.manifest.snapshotHash,
          restoreId: restored.id,
          nodeName: `方案现场 ${t.branchId.slice(0, 8)}`,
          workspaceName: '方案代码',
        };
      },
      'branch-workspaces',
      log,
    );
    p.git = git;
    if (git.state !== 'ready' || !git.nodeState || !git.gitIdentity)
      throw new DomainError('WORK_BRANCH_GIT_INCOMPLETE', 'Git准备未完成，保留现场');
    if ((await inspect()).state !== 'waiting_local')
      throw new DomainError('WORK_BRANCH_PREPARATION_CHANGED', '现场准备已取消，保留本机目录');
    const lease = new WorkspaceLease(target, `branch-origin:${id}`),
      restore = new RestoreJournal(home);
    try {
      const row = restore.row(target)!;
      const progress = restoreProgressFromRow(row),
        plan = JSON.parse(row.plan) as RestorePlan;
      if (row.binding !== binding || progress.id !== restored.id || !progress.stageIdentity)
        throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '原恢复记录改变');
      const parent = new PinnedRestoreParent(plan.target);
      let root: number | undefined;
      try {
        root = parent.openStage(basename(target), progress.stageIdentity);
        verifyRestoreFiles(root, plan, restore, progress, {
          name: '.git',
          identity: git.gitIdentity,
        });
        const origin: BranchOrigin = {
          version: 1,
          ticket: t,
          plan,
          restoreId: progress.id,
          rootIdentity: progress.stageIdentity,
          gitIdentity: git.gitIdentity,
          entries: [...restore.entries(progress.id).values()],
        };
        const bytes = JSON.stringify(origin);
        if (Buffer.byteLength(bytes) > 32 * 1024 * 1024)
          throw new DomainError('WORK_BRANCH_ORIGIN_LIMIT', '本机起点记录超过32 MiB，未登记');
        mkdirSync(git.nodeState, { mode: 0o700 });
        const fd = openSync(join(git.nodeState, 'branch-origin.json'), 'wx', 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        const dir = openSync(git.nodeState, 'r');
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
        if ((await inspect()).state !== 'waiting_local')
          throw new DomainError('WORK_BRANCH_PREPARATION_CHANGED', '准备已经取消');
        parent.revalidate();
        verifyRestoreFiles(root, plan, restore, progress, {
          name: '.git',
          identity: git.gitIdentity,
        });
        p.packet = {
          action: 'prepare',
          operationId: id,
          requestHash: t.requestHash,
          proof: {
            originHash: branchOriginHash(origin),
            workspaceRef: branchOriginHash([
              'branch-copy',
              c.nodeId,
              progress.stageIdentity,
              inode(fstatSync(root)),
            ]),
            restoreId: progress.id,
            planHash: plan.planHash,
            snapshotHash: t.manifest.snapshotHash,
            verifiedAt: new Date().toISOString(),
          },
        };
        p.phase = 'pending';
        journal.save(p);
      } finally {
        if (root !== undefined) closeSync(root);
        parent.close();
      }
    } finally {
      restore.close();
      lease.release();
    }
    return await deliver();
  } catch (error) {
    if (p && p.phase === 'preparing') {
      p.phase = 'needs_attention';
      journal.save(p);
    }
    throw error;
  } finally {
    journal.close();
  }
}
export async function bindBranchWorkspace(home: string, ask: (prompt: string) => Promise<string>) {
  const storage = new AgentStorage(home);
  let lease: WorkspaceLease | undefined;
  try {
    const c = readCredentials(storage.home),
      origin = readBranchOrigin(storage.home),
      t = origin.ticket;
    const directory = c.directories.find((w) => w.root === origin.plan.target.path);
    if (!directory || !c.nodeId || c.nodeId === t.sourceNodeId)
      throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '需要此方案独立目录的新配对节点');
    const binding: BranchExecutionBinding = {
      branchId: t.branchId,
      groupId: t.groupId,
      operationId: t.id,
      startHash: t.startHash,
      originHash: branchOriginHash(origin),
      commit: t.manifest.commit,
    };
    storage.db.exec(
      'CREATE TABLE IF NOT EXISTS branch_binding(id TEXT PRIMARY KEY, body TEXT NOT NULL)',
    );
    const row = storage.db.prepare('SELECT body FROM branch_binding WHERE id=?').get(t.id) as
      | { body: string }
      | undefined;
    let p = row ? JSON.parse(row.body) : null;
    const credentialBinding = restoreBinding(c);
    if (p && p.binding !== credentialBinding)
      throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '原登记不能换节点凭证');
    if (p) {
      try {
        new WorkspaceLease(directory.root, `branch-bind:${t.id}`, true).release();
      } catch {
        /* never release a model claim */
      }
    }
    if (p?.phase === 'settled') return p.result as BranchWorkspaceOperation;
    if (!p) {
      if (
        (await ask(`输入 BIND ${t.branchId}，将此本人新节点登记到原方案：`)) !==
        `BIND ${t.branchId}`
      )
        throw new DomainError('CONFIRMATION_REQUIRED', '未同意现场登记');
      lease = new WorkspaceLease(directory.root, `branch-bind:${t.id}`);
      await verifyBranchOrigin(storage.home, c, directory, binding);
      p = {
        phase: 'pending',
        binding: credentialBinding,
        packet: {
          action: 'bind',
          operationId: t.id,
          requestHash: t.requestHash,
          originHash: binding.originHash,
          workspaceId: directory.id,
        },
        result: null,
      };
      storage.db.prepare('INSERT INTO branch_binding VALUES(?,?)').run(t.id, JSON.stringify(p));
    }
    const result = validateReply(
      await nodeRequest<BranchWorkspaceOperation>(
        c.controlUrl,
        'work-branch-workspace',
        p.packet,
        c.nodeToken,
      ),
      t.id,
    );
    if (!['bound', 'cancelled', 'needs_attention'].includes(result.state))
      throw new DomainError('INVALID_RESPONSE', '现场登记尚未确认');
    p.phase = 'settled';
    p.result = result;
    storage.db.prepare('UPDATE branch_binding SET body=? WHERE id=?').run(JSON.stringify(p), t.id);
    return result;
  } finally {
    lease?.release();
    storage.close();
  }
}
export function readBranchWorkspaceStatus(home: string, id: string) {
  const dir = join(resolve(home), 'branch-preparations'),
    file = join(dir, 'journal.sqlite');
  nodeId(id);
  if (!existsSync(file)) return null;
  restorePrivatePath(dir, true);
  restorePrivatePath(file, false);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT body FROM preparations WHERE id=?').get(id) as
      | { body: string }
      | undefined;
    const p = row ? (JSON.parse(row.body) as LocalPreparation) : null;
    if (p && (p.id !== id || p.binding !== restoreBinding(readCredentials(home))))
      throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '原准备记录属于其他本机身份');
    return p;
  } finally {
    db.close();
  }
}
export async function cleanupBranchPreparation(
  home: string,
  id: string,
  ask: (prompt: string) => Promise<string>,
) {
  const journal = new BranchJournal(home);
  try {
    const p = journal.get(id),
      c = readCredentials(home);
    if (!p || p.binding !== restoreBinding(c))
      throw new DomainError('WORK_BRANCH_SCOPE_CHANGED', '缺少此身份的原准备记录');
    if (p.phase === 'settled' && p.result?.state === 'bound')
      throw new DomainError('WORK_BRANCH_BOUND', '已登记现场不能由准备清理解除');
    if (p.packet) {
      const op = validateReply(
        await nodeRequest<BranchWorkspaceOperation>(
          c.controlUrl,
          'work-branch-workspace',
          { action: 'inspect', operationId: id },
          c.nodeToken,
        ),
        id,
      );
      if (op.state !== 'cancelled')
        throw new DomainError('WORK_BRANCH_PENDING', '先在网页取消原准备请求，再处置本机证据');
      p.result = op;
    }
    if (
      (await ask(`输入 CLOSE_BRANCH ${id}，处置本次未完成准备；已发布目录保留：`)) !==
      `CLOSE_BRANCH ${id}`
    )
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认处置准备');
    const git = readGitWorkspaceProgress(home, id, 'branch-workspaces');
    if (git && !['ready', 'cleaned'].includes(git.state))
      await cleanupRestoredGitWorkspace(home, id, ask, 'branch-workspaces');
    const restored = readRestoreProgress(home, p.target);
    if (restored && restored.state !== 'restored')
      await cleanupRestoreCheckpoint(home, p.target, ask);
    try {
      new WorkspaceLease(p.target, `branch-origin:${id}`, true).release();
    } catch {
      /* never clear another writer */
    }
    p.phase = 'settled';
    journal.save(p);
    return p;
  } finally {
    journal.close();
  }
}
