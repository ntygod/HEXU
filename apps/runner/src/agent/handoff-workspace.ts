import { createHash, randomUUID } from 'node:crypto';
import {
  constants as F,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import { commitOid } from '../../../../packages/contracts/src/checkpoints.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { HandoffAcceptance } from '../../../../packages/contracts/src/handoff-acceptance.js';
import { AgentStorage, readCredentials } from './storage.js';
import { nodeRequest } from './connection.js';
import { restoreBinding, restorePrivatePath } from './checkpoint-restore-preflight.js';
import { validateHandoffAcceptanceReply } from './handoff-acceptance.js';
import { withReceivedRestoreSource } from './checkpoint-received-source.js';
import {
  RestoreJournal,
  restoreProgressFromRow,
  type RestorePlan,
} from './checkpoint-restore-journal.js';
import { rebuildPublishedRestorePlan } from './checkpoint-restore-plan.js';
import { verifySnapshot } from './checkpoint-objects.js';
import { verifyRestoreFiles } from './checkpoint-restore.js';
import {
  fdPath,
  identity,
  inode,
  PinnedRestoreParent,
  ownedEntry,
  withOwnedDirectory,
  checkOwnedTree,
  readOwnedFile,
  removeOwnedStage,
  type OwnedRestoreEntry,
} from './checkpoint-restore-files.js';
import { WorkspaceLease } from '../workspace-lease.js';
import { gitWorkspaceMetadata } from './git-workspace-metadata.js';

const digest = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export interface GitWorkspaceProgress {
  id: string;
  operationId: string;
  target: string;
  state: 'preparing' | 'ready' | 'needs_attention' | 'cleaned';
  gitIdentity: string | null;
  metadataHash: string;
  commit: string;
  objectFormat: 'sha1' | 'sha256';
  createdAt: string;
  updatedAt: string;
  configPath: string | null;
  nodeState: string | null;
}
interface Row {
  id: string;
  operation_id: string;
  binding: string;
  body: string;
  plan: string;
}
function decode(row: Row): GitWorkspaceProgress {
  const p = JSON.parse(row.body) as GitWorkspaceProgress;
  nodeId(p.id);
  nodeId(p.operationId);
  if (
    p.id !== row.id ||
    p.operationId !== row.operation_id ||
    !['preparing', 'ready', 'needs_attention', 'cleaned'].includes(p.state) ||
    !['sha1', 'sha256'].includes(p.objectFormat) ||
    !/^[0-9a-f]{64}$/.test(p.metadataHash) ||
    !Number.isFinite(Date.parse(p.createdAt)) ||
    !Number.isFinite(Date.parse(p.updatedAt)) ||
    !isAbsolute(p.target) ||
    resolve(p.target) !== p.target
  )
    throw new DomainError('WORKSPACE_JOURNAL_INVALID', '工作区准备记录身份无效，保留现场');
  commitOid(p.commit, p.objectFormat);
  if (p.state === 'ready' && (!p.gitIdentity || !p.configPath || !p.nodeState))
    throw new DomainError('WORKSPACE_JOURNAL_INVALID', '工作区完成记录不完整，保留现场');
  return p;
}
export function assertGitWorkspaceSettled(home: string) {
  const dir = join(home, 'handoff-workspaces'),
    file = join(dir, 'journal.sqlite');
  if (!existsSync(file)) return;
  restorePrivatePath(dir, true);
  restorePrivatePath(file, false);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='preparations'").get())
      for (const row of db.prepare('SELECT * FROM preparations').all() as unknown as Row[]) {
        if (!['ready', 'cleaned'].includes(decode(row).state))
          throw new DomainError(
            'WORKSPACE_UNSETTLED',
            '本机Git准备尚未处置，请保留原凭证与现场',
            409,
          );
      }
  } finally {
    db.close();
  }
}
export function readGitWorkspaceProgress(home: string, id: string) {
  nodeId(id);
  home = resolve(home);
  restorePrivatePath(home, true);
  const binding = restoreBinding(readCredentials(home)),
    dir = join(home, 'handoff-workspaces'),
    file = join(dir, 'journal.sqlite');
  if (!existsSync(file)) return null;
  restorePrivatePath(dir, true);
  restorePrivatePath(file, false);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare('SELECT * FROM preparations WHERE operation_id=? ORDER BY rowid DESC LIMIT 1')
      .get(id) as unknown as Row | undefined;
    if (!row) return null;
    if (row.binding !== binding)
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '准备记录属于原本机身份');
    return decode(row); // last recorded state; a read-only status query cannot infer process death
  } finally {
    db.close();
  }
}
class WorkspaceJournal {
  readonly storage: AgentStorage;
  constructor(home: string) {
    this.storage = new AgentStorage(join(home, 'handoff-workspaces'));
    try {
      this.storage.db
        .exec(`CREATE TABLE IF NOT EXISTS preparations(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,binding TEXT NOT NULL,body TEXT NOT NULL,plan TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preparation_entries(preparation_id TEXT NOT NULL,path TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(preparation_id,path));`);
      for (const row of this.storage.db
        .prepare('SELECT * FROM preparations')
        .all() as unknown as Row[]) {
        const p = decode(row);
        if (p.state === 'preparing') this.save({ ...p, state: 'needs_attention' });
      }
    } catch (cause) {
      this.storage.close();
      throw cause;
    }
  }
  row(id: string) {
    return this.storage.db
      .prepare('SELECT * FROM preparations WHERE operation_id=? ORDER BY rowid DESC LIMIT 1')
      .get(id) as unknown as Row | undefined;
  }
  save(p: GitWorkspaceProgress) {
    p.updatedAt = new Date().toISOString();
    this.storage.db
      .prepare('UPDATE preparations SET body=? WHERE id=?')
      .run(JSON.stringify(p), p.id);
  }
  track(id: string, e: OwnedRestoreEntry) {
    this.storage.db
      .prepare('INSERT INTO preparation_entries VALUES(?,?,?)')
      .run(id, e.path, JSON.stringify(e));
  }
  entries(id: string) {
    return new Map(
      (
        this.storage.db
          .prepare('SELECT body FROM preparation_entries WHERE preparation_id=?')
          .all(id) as { body: string }[]
      ).map((r) => {
        const e = JSON.parse(r.body) as OwnedRestoreEntry;
        return [e.path, e];
      }),
    );
  }
  close() {
    this.storage.close();
  }
}

function localAcceptance(
  home: string,
  id: string,
  target: string,
  binding: string,
  op: HandoffAcceptance,
) {
  const dir = join(home, 'handoff-acceptances'),
    file = join(dir, 'journal.sqlite');
  restorePrivatePath(dir, true);
  restorePrivatePath(file, false);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM handoff_confirmations WHERE id=?').get(id) as
      | {
          binding: string;
          target: string;
          phase: string;
          packet: string | null;
          request_hash: string;
          workspace_ref: string;
        }
      | undefined;
    if (
      !row ||
      row.phase !== 'settled' ||
      !row.packet ||
      row.binding !== binding ||
      row.target !== target ||
      row.request_hash !== op.ticket.requestHash ||
      row.workspace_ref !== op.proof?.workspaceRef ||
      digest(JSON.parse(row.packet)) !== op.proofHash
    )
      throw new DomainError(
        'WORKSPACE_SOURCE_MISMATCH',
        '需原接收者已确认回执的同一接手目录，不重放接受或导入其他现场',
      );
  } finally {
    db.close();
  }
}
const metaHash = (files: ReadonlyMap<string, Buffer>) =>
  digest(
    [...files]
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([p, v]) => [p, createHash('sha256').update(v).digest('hex')]),
  );
function verifyMetadata(
  fd: number,
  journal: WorkspaceJournal,
  p: GitWorkspaceProgress,
  files: ReadonlyMap<string, Buffer>,
) {
  const owned = journal.entries(p.id);
  checkOwnedTree(fd, owned);
  if ([...owned.values()].filter((e) => e.kind === 'file').length !== files.size)
    throw new DomainError('WORKSPACE_CHANGED', 'Git元数据清单不一致');
  for (const [name, bytes] of files) {
    const e = owned.get(name);
    if (!e || !readOwnedFile(fd, e, owned, bytes.length).equals(bytes))
      throw new DomainError('WORKSPACE_CHANGED', 'Git元数据已变化');
  }
}

/** Adds only new, privately owned .git metadata. User code, old credentials and
 * old node/session bindings stay unchanged. A separate node is paired explicitly. */
export async function prepareHandoffWorkspace(
  home: string,
  id: string,
  target: string,
  ask: (prompt: string) => Promise<string>,
  log: (text: string) => void = console.log,
) {
  nodeId(id);
  home = resolve(home);
  if (process.platform !== 'linux')
    throw new DomainError('PLATFORM_UNSUPPORTED', 'Git现场准备目前只支持Linux');
  if (!isAbsolute(target) || resolve(target) !== target)
    throw new DomainError('INVALID_INPUT', '请使用原本机接手目录的绝对路径');
  const homeIdentity = restorePrivatePath(home, true),
    c = readCredentials(home),
    binding = restoreBinding(c);
  const check = () => {
    if (
      restorePrivatePath(home, true) !== homeIdentity ||
      restoreBinding(readCredentials(home)) !== binding
    )
      throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '原节点身份或状态目录改变');
  };
  const authority = async () => {
    check();
    const op = validateHandoffAcceptanceReply(
      await nodeRequest<HandoffAcceptance>(
        c.controlUrl,
        'handoff-acceptance',
        { action: 'workspace-source', operationId: id },
        c.nodeToken,
      ),
      id,
    );
    if (
      op.state !== 'succeeded' ||
      op.ticket.nodeId !== c.nodeId ||
      op.ticket.projectId !== c.projectId ||
      op.ticket.spaceId !== c.spaceId ||
      !op.proof
    )
      throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '当前身份不是原已接受的接手来源');
    check();
    localAcceptance(home, id, target, binding, op);
    return op;
  };
  const op = await authority(),
    journal = new WorkspaceJournal(home);
  let lease: WorkspaceLease | undefined;
  let progress: GitWorkspaceProgress | undefined;
  try {
    const old = journal.row(id);
    if (old) {
      const p = decode(old);
      if (old.binding !== binding || p.target !== target)
        throw new DomainError('CHECKPOINT_SCOPE_CHANGED', '同一准备记录不能换身份或目录');
      if (p.state === 'ready' || p.state === 'cleaned') {
        try {
          new WorkspaceLease(p.target, `handoff-git:${p.id}`, true).release();
        } catch {
          /* never remove another writer */
        }
      }
      if (p.state !== 'cleaned') return p;
    }
    const count = journal.storage.db.prepare('SELECT COUNT(*) AS n FROM preparations').get()!.n;
    if (Number(count) >= 1000)
      throw new DomainError('WORKSPACE_LIMIT', '本机Git准备记录已达上限，请保留现场与日志');
    const restore = new RestoreJournal(home);
    try {
      const r = restore.row(target);
      if (!r || r.binding !== binding)
        throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '缺少原恢复记录');
      const original = JSON.parse(r.plan) as RestorePlan,
        p = restoreProgressFromRow(r);
      if (
        p.id !== op.proof!.restoreId ||
        p.state !== 'restored' ||
        p.materialState !== 'published' ||
        !p.stageIdentity ||
        original.planHash !== op.proof!.planHash
      )
        throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '接手与原恢复身份不一致');
      return await withReceivedRestoreSource(
        home,
        op.ticket.transferId,
        undefined,
        async (source) => {
          const collect = () =>
            source.snapshot(async (read) => {
              const plan = await rebuildPublishedRestorePlan(
                source.planSource,
                read,
                target,
                source.protectedPaths,
                p.stageIdentity!,
              );
              if (plan.planHash !== original.planHash)
                throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '原文件计划变化，未创建Git现场');
              const snapshot = await verifySnapshot(
                source.manifest.objectFormat,
                source.manifest.commit,
                source.manifest.tree,
                read,
              );
              return {
                plan,
                files: gitWorkspaceMetadata(
                  source.manifest.objectFormat,
                  source.manifest.commit,
                  snapshot,
                  plan.entries,
                ),
              };
            });
          const initial = await collect();
          log(
            JSON.stringify({
              target,
              commit: source.manifest.commit,
              branch: 'work',
              history: 'single_commit_shallow',
              files: op.proof!.files,
              oldNodeUnchanged: true,
              startsModel: false,
            }),
          );
          if ((await ask(`输入 GIT ${id}，仅添加本次单提交浅Git元数据：`)) !== `GIT ${id}`)
            throw new DomainError('CONFIRMATION_REQUIRED', '未确认准备，没有写入Git元数据');
          await authority();
          const latest = await collect();
          if (metaHash(initial.files) !== metaHash(latest.files))
            throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '确认期间原材料变化');
          const preparationId = randomUUID();
          lease = new WorkspaceLease(target, `handoff-git:${preparationId}`);
          const parent = new PinnedRestoreParent(latest.plan.target, source.protectedIdentities);
          let root: number | undefined,
            git: number | undefined,
            metaParent: PinnedRestoreParent | undefined;
          try {
            root = parent.openStage(basename(target), p.stageIdentity!);
            verifyRestoreFiles(root, latest.plan, restore, p);
            const rootStat = fstatSync(root, { bigint: true });
            metaParent = new PinnedRestoreParent({
              path: join(target, '.git'),
              parents: [{ path: target, identity: inode(rootStat) }, ...latest.plan.target.parents],
            });
            metaParent.assertAbsent();
            const at = new Date().toISOString();
            progress = {
              id: preparationId,
              operationId: id,
              target,
              state: 'preparing',
              gitIdentity: null,
              metadataHash: metaHash(latest.files),
              commit: source.manifest.commit,
              objectFormat: source.manifest.objectFormat,
              createdAt: at,
              updatedAt: at,
              configPath: null,
              nodeState: null,
            };
            journal.storage.db
              .prepare('INSERT INTO preparations VALUES(?,?,?,?,?)')
              .run(
                preparationId,
                id,
                binding,
                JSON.stringify(progress),
                JSON.stringify(latest.plan),
              );
            git = metaParent.createStage('.git');
            progress.gitIdentity = identity(fstatSync(git, { bigint: true }));
            journal.save(progress);
            const owned = new Map<string, OwnedRestoreEntry>();
            const dirs = new Set<string>();
            for (const name of latest.files.keys()) {
              let dir = dirname(name);
              while (dir !== '.') {
                dirs.add(dir);
                dir = dirname(dir);
              }
            }
            const saveEntry = (path: string, kind: 'file' | 'directory', fd: number) => {
              const entry = ownedEntry(path, kind, fd);
              journal.track(preparationId, entry);
              owned.set(path, entry);
            };
            for (const path of [...dirs].sort(
              (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
            )) {
              check();
              parent.revalidate();
              metaParent.revalidate();
              withOwnedDirectory(git, dirname(path) === '.' ? '' : dirname(path), owned, (fd) => {
                mkdirSync(fdPath(fd, basename(path)), { mode: 0o700 });
                const child = openSync(
                  fdPath(fd, basename(path)),
                  F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW,
                );
                try {
                  saveEntry(path, 'directory', child);
                  fsyncSync(child);
                  fsyncSync(fd);
                } finally {
                  closeSync(child);
                }
              });
            }
            for (const [path, bytes] of latest.files) {
              check();
              parent.revalidate();
              metaParent.revalidate();
              withOwnedDirectory(git, dirname(path) === '.' ? '' : dirname(path), owned, (fd) => {
                const child = openSync(
                  fdPath(fd, basename(path)),
                  F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW,
                  0o600,
                );
                try {
                  let offset = 0;
                  while (offset < bytes.length) {
                    const n = writeSync(child, bytes, offset, bytes.length - offset);
                    if (!n) throw new Error('Short metadata write');
                    offset += n;
                  }
                  fsyncSync(child);
                  saveEntry(path, 'file', child);
                  fsyncSync(fd);
                } finally {
                  closeSync(child);
                }
              });
            }
            await authority();
            await source.authorized();
            check();
            parent.revalidate();
            metaParent.revalidate();
            verifyRestoreFiles(root, latest.plan, restore, p, {
              name: '.git',
              identity: progress.gitIdentity,
            });
            verifyMetadata(git, journal, progress, latest.files);
            fsyncSync(git);
            fsyncSync(root);
            const output = join(journal.storage.home, preparationId);
            mkdirSync(output, { mode: 0o700 });
            const nodeState = join(output, 'node'),
              configPath = join(output, 'connect.json');
            const config = {
              controlUrl: c.controlUrl,
              name: `接手现场 ${id.slice(0, 8)}`,
              workspaces: [{ name: '接手代码', path: target }],
              expectedScope: {
                ownerId: op.ticket.recipientId,
                projectId: c.projectId,
                spaceId: c.spaceId,
              },
            };
            const out = openSync(configPath, 'wx', 0o600);
            try {
              writeFileSync(out, JSON.stringify(config, null, 2));
              fsyncSync(out);
            } finally {
              closeSync(out);
            }
            const dir = openSync(output, 'r');
            try {
              fsyncSync(dir);
            } finally {
              closeSync(dir);
            }
            progress.state = 'ready';
            progress.nodeState = nodeState;
            progress.configPath = configPath;
            journal.save(progress);
            return progress;
          } finally {
            if (git !== undefined) closeSync(git);
            metaParent?.close();
            if (root !== undefined) closeSync(root);
            parent.close();
          }
        },
      );
    } finally {
      restore.close();
    }
  } catch (cause) {
    if (progress) {
      progress.state = 'needs_attention';
      journal.save(progress);
    }
    throw cause;
  } finally {
    lease?.release();
    journal.close();
  }
}

export async function cleanupHandoffWorkspace(
  home: string,
  id: string,
  ask: (prompt: string) => Promise<string>,
) {
  nodeId(id);
  home = resolve(home);
  restorePrivatePath(home, true);
  const binding = restoreBinding(readCredentials(home)),
    journal = new WorkspaceJournal(home);
  let lease: WorkspaceLease | undefined;
  try {
    const row = journal.row(id);
    if (!row || row.binding !== binding)
      throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '没有此身份的准备记录');
    const p = decode(row);
    if (p.state === 'ready')
      throw new DomainError('WORKSPACE_READY', '已完成的Git现场不由失败清理删除');
    if (p.state === 'cleaned') return p;
    if (!p.gitIdentity)
      throw new DomainError('WORKSPACE_UNKNOWN', 'Git目录创建身份不明确，保留现场');
    if (
      (await ask(`输入 CLEAN_GIT ${p.id}，仅清理本次完整归属的未完成元数据：`)) !==
      `CLEAN_GIT ${p.id}`
    )
      throw new DomainError('CONFIRMATION_REQUIRED', '未确认清理');
    try {
      lease = new WorkspaceLease(p.target, `handoff-git:${p.id}`);
    } catch (cause) {
      if (!(cause instanceof DomainError) || cause.code !== 'LOCAL_WORKSPACE_BUSY') throw cause;
      lease = new WorkspaceLease(p.target, `handoff-git:${p.id}`, true);
    }
    const plan = JSON.parse(row.plan) as RestorePlan;
    const parent = new PinnedRestoreParent(plan.target);
    let root: number | undefined,
      metaParent: PinnedRestoreParent | undefined,
      git: number | undefined;
    try {
      // Original root identity comes from the saved parent chain and existing restore record.
      const restore = new RestoreJournal(home);
      try {
        const saved = restore.row(p.target);
        if (!saved || saved.binding !== binding)
          throw new DomainError('WORKSPACE_SOURCE_MISMATCH', '原恢复记录变化');
        const restored = restoreProgressFromRow(saved);
        if (!restored.stageIdentity) throw new DomainError('WORKSPACE_UNKNOWN', '原目录身份未知');
        root = parent.openStage(basename(p.target), restored.stageIdentity);
      } finally {
        restore.close();
      }
      const s = fstatSync(root, { bigint: true });
      metaParent = new PinnedRestoreParent({
        path: join(p.target, '.git'),
        parents: [{ path: p.target, identity: inode(s) }, ...plan.target.parents],
      });
      git = metaParent.openStage('.git', p.gitIdentity);
      removeOwnedStage(metaParent, '.git', git, p.gitIdentity, journal.entries(p.id), (name) =>
        journal.storage.db
          .prepare('DELETE FROM preparation_entries WHERE preparation_id=? AND path=?')
          .run(p.id, name),
      );
      p.state = 'cleaned';
      journal.save(p);
      return p;
    } finally {
      if (git !== undefined) closeSync(git);
      metaParent?.close();
      if (root !== undefined) closeSync(root);
      parent.close();
    }
  } finally {
    lease?.release();
    journal.close();
  }
}
