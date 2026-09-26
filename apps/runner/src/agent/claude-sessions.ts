import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import type {
  DispatchCommand,
  NativeSessionInfo,
} from '../../../../packages/contracts/src/node-execution.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import {
  claudeSessionId,
  type ClaudeSummary,
  type ClaudeSessionSelection,
} from '../../../../packages/adapters/claude-code/src/index.js';
import { ensurePrivateHome, type AgentStorage, type NodeCredentials } from './storage.js';
import type { LocalDirectory } from './workspaces.js';

const LIFETIME = 7 * 86400_000;
interface SessionRow {
  ref: string;
  binding: string;
  dispatch_id: string;
  session_id: string;
  model: string | null;
  fingerprint: string | null;
  state: 'active' | 'ready' | 'blocked' | 'deleted';
  expires_at: string;
}
export interface ClaudeSessionLease extends ClaudeSessionSelection {
  ref: string;
  home: string;
  resolvedModel?: string;
}
/** Private provider files, not a second task/session API. IDs and file fingerprints
 * stay in the node journal. Never parse Claude's internal transcript entry format. */
export class ClaudeSessions {
  constructor(readonly storage: AgentStorage) {
    storage.db.exec(`CREATE TABLE IF NOT EXISTS native_claude_sessions(
      ref TEXT PRIMARY KEY, binding TEXT NOT NULL, dispatch_id TEXT NOT NULL,
      session_id TEXT NOT NULL, model TEXT, fingerprint TEXT, state TEXT NOT NULL, expires_at TEXT NOT NULL
    );`);
  }
  recover() {
    this.storage.db.exec("UPDATE native_claude_sessions SET state='blocked' WHERE state='active'");
  }
  private row(ref: string) {
    return this.storage.db
      .prepare('SELECT * FROM native_claude_sessions WHERE ref=?')
      .get(nodeId(ref)) as SessionRow | undefined;
  }
  private home(ref: string, create = false) {
    const parent = join(this.storage.home, 'claude-sessions');
    if (create && !existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    if (!existsSync(parent))
      throw new DomainError('SESSION_MISSING', '本机 Claude 历史已移除；没有自动新建会话');
    ensurePrivateHome(parent);
    const path = join(parent, nodeId(ref));
    if (create) {
      mkdirSync(path, { mode: 0o700 });
      mkdirSync(join(path, 'config'), { mode: 0o700 });
    }
    if (!existsSync(path))
      throw new DomainError('SESSION_MISSING', '本机 Claude 会话目录不存在；没有自动新建');
    if (ensurePrivateHome(path) !== path)
      throw new DomainError('SESSION_PATH_CHANGED', '本机会话目录已变化');
    return path;
  }
  private snapshot(home: string, sessionId: string, persist = false) {
    // Official storage location with CLAUDE_CODE_PROJECT_DIR_NAME=work. The internal
    // JSONL schema is deliberately opaque. Hash the whole private tree, not just a
    // single transcript, so a changed config/index/history fails closed on resume.
    const transcript = join('config', 'projects', 'work', `${claudeSessionId(sessionId)}.jsonl`);
    let entries = 0,
      bytes = 0,
      found = false;
    const manifest: [string, string][] = [];
    const walk = (path: string, depth: number) => {
      if (depth > 16) throw new DomainError('SESSION_TOO_LARGE', '原生会话目录过深，拒绝恢复');
      for (const name of readdirSync(path).sort()) {
        if (++entries > 4096)
          throw new DomainError('SESSION_TOO_LARGE', '原生会话文件过多，请在本机清理');
        const item = join(path, name),
          s = lstatSync(item),
          rel = relative(home, item);
        if (
          s.isSymbolicLink() ||
          (!s.isDirectory() && !s.isFile()) ||
          (process.getuid && s.uid !== process.getuid()) ||
          (s.isFile() && s.nlink !== 1)
        )
          throw new DomainError(
            'SESSION_UNSAFE_FILE',
            '原生历史包含链接、非本人或特殊文件，拒绝恢复',
          );
        if (s.isDirectory()) {
          manifest.push([rel, 'directory']);
          walk(item, depth + 1);
          continue;
        }
        if ((bytes += s.size) > 64 * 1024 * 1024)
          throw new DomainError('SESSION_TOO_LARGE', '原生历史超过 64 MiB 本机恢复上限');
        const fd = openSync(item, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(fd);
          if (
            !before.isFile() ||
            before.ino !== s.ino ||
            before.dev !== s.dev ||
            before.nlink !== 1
          )
            throw new DomainError('SESSION_CHANGED', '检查期间原生历史已变化');
          const digest = createHash('sha256'),
            buffer = Buffer.alloc(65536);
          let read = 0,
            n: number;
          while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            read += n;
            if (read > s.size) throw new DomainError('SESSION_CHANGED', '检查期间原生历史已变化');
            digest.update(buffer.subarray(0, n));
          }
          if (read !== s.size || fstatSync(fd).mtimeMs !== before.mtimeMs)
            throw new DomainError('SESSION_CHANGED', '检查期间原生历史已变化');
          if (persist) fsyncSync(fd);
          manifest.push([rel, digest.digest('hex')]);
          if (rel === transcript && read > 0) found = true;
          if (name === `${sessionId}.jsonl` && rel !== transcript)
            throw new DomainError('SESSION_AMBIGUOUS', '发现另一个同名原生会话，拒绝恢复');
        } finally {
          closeSync(fd);
        }
      }
      if (persist) {
        const fd = openSync(path, 'r');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    };
    walk(home, 0);
    if (!found)
      throw new DomainError('SESSION_MISSING', '没有找到完整的本机 Claude 历史；没有自动新建');
    return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  }
  prepare(
    command: DispatchCommand,
    credentials: NodeCredentials,
    directory: LocalDirectory,
    executable: string,
    apiKey: string,
  ): ClaudeSessionLease {
    if (command.policy.tool !== 'claude-code' || !command.policy.retainSessions)
      throw new DomainError('SESSION_NOT_ENABLED', '本机未明确授权保留 Claude 会话');
    for (const root of credentials.directories) {
      const r = relative(root.root, this.storage.home);
      if (!r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)))
        throw new DomainError('SESSION_IN_WORKSPACE', '节点私有历史不能放在任何授权工作目录内');
    }
    const binding = createHash('sha256')
      .update(
        canonicalJson({
          nodeId: credentials.nodeId,
          controlUrl: credentials.controlUrl,
          projectId: command.projectId,
          taskId: command.taskId,
          workspaceId: command.workspaceId,
          root: directory.root,
          rootIdentity: directory.rootIdentity,
          gitIdentity: directory.gitIdentity,
          executable: realpathSync(executable),
          policyHash: command.policyHash,
          mode: command.mode,
          account: createHmac('sha256', credentials.nodeToken).update(apiKey).digest('hex'),
        }),
      )
      .digest('hex');
    let row: SessionRow;
    if (command.session) {
      const saved = this.row(command.session.ref);
      if (!saved || saved.state !== 'ready' || !saved.model || !saved.fingerprint)
        throw new DomainError(
          'SESSION_NOT_RECOVERABLE',
          '本机 Claude 会话未确认安全结束或已移除；没有自动新建',
        );
      if (saved.binding !== binding || saved.dispatch_id !== command.session.sourceDispatchId)
        throw new DomainError(
          'SESSION_SCOPE_CHANGED',
          '原生会话的任务、目录、工具授权或本机账户已变化；请明确新建',
        );
      if (Date.parse(saved.expires_at) <= Date.now())
        throw new DomainError('SESSION_EXPIRED', '原生会话恢复期限已过；历史仍保留，可在本机清理');
      if (this.snapshot(this.home(saved.ref), saved.session_id) !== saved.fingerprint)
        throw new DomainError('SESSION_CHANGED', '本机原生历史或配置已变化；没有自动恢复或新建');
      row = saved;
      this.storage.db
        .prepare("UPDATE native_claude_sessions SET state='active',dispatch_id=? WHERE ref=?")
        .run(command.id, saved.ref);
    } else {
      const count = Number(
        this.storage.db
          .prepare("SELECT COUNT(*) AS n FROM native_claude_sessions WHERE state!='deleted'")
          .get()!.n,
      );
      if (count >= 32)
        throw new DomainError('SESSION_CAPACITY', '节点已保留 32 个 Claude 会话，请先在本机清理');
      row = {
        ref: command.id,
        binding,
        dispatch_id: command.id,
        session_id: randomUUID(),
        model: null,
        fingerprint: null,
        state: 'active',
        expires_at: new Date(Date.now() + LIFETIME).toISOString(),
      };
      this.home(row.ref, true);
      this.storage.db
        .prepare("INSERT INTO native_claude_sessions VALUES(?,?,?,?,NULL,NULL,'active',?)")
        .run(row.ref, binding, command.id, row.session_id, row.expires_at);
    }
    return {
      ref: row.ref,
      home: this.home(row.ref),
      sessionId: row.session_id,
      action: command.session ? 'resumed' : 'created',
      ...(command.session ? { resolvedModel: row.model! } : {}),
    };
  }
  finish(
    lease: ClaudeSessionLease,
    command: DispatchCommand,
    summary: ClaudeSummary,
    success: boolean,
  ): NativeSessionInfo | undefined {
    const row = this.row(lease.ref);
    const ready = !!(
      success &&
      summary.initialized &&
      summary.resultReceived &&
      summary.success &&
      summary.sessionId === lease.sessionId &&
      summary.resolvedModel &&
      row?.state === 'active' &&
      row.dispatch_id === command.id &&
      row.session_id === lease.sessionId &&
      (!lease.resolvedModel || summary.resolvedModel === lease.resolvedModel)
    );
    const fingerprint = ready ? this.snapshot(lease.home, lease.sessionId, true) : null;
    this.storage.db
      .prepare(
        'UPDATE native_claude_sessions SET state=?,model=?,fingerprint=? WHERE ref=? AND dispatch_id=?',
      )
      .run(
        ready ? 'ready' : 'blocked',
        summary.resolvedModel ?? null,
        fingerprint,
        lease.ref,
        command.id,
      );
    return ready ? { ref: lease.ref, action: lease.action, expiresAt: row!.expires_at } : undefined;
  }
  block(ref: string) {
    this.storage.db
      .prepare("UPDATE native_claude_sessions SET state='blocked' WHERE ref=? AND state='active'")
      .run(ref);
  }
  list() {
    return (
      this.storage.db
        .prepare(
          "SELECT ref,dispatch_id,state,expires_at FROM native_claude_sessions WHERE state!='deleted' ORDER BY rowid DESC",
        )
        .all() as Pick<SessionRow, 'ref' | 'dispatch_id' | 'state' | 'expires_at'>[]
    ).map((r) => ({
      ref: r.ref,
      lastDispatchId: r.dispatch_id,
      state: r.state,
      expiresAt: r.expires_at,
      expired: Date.parse(r.expires_at) <= Date.now(),
    }));
  }
  forget(ref: string) {
    const row = this.row(ref);
    if (!row || row.state === 'deleted') throw new DomainError('SESSION_MISSING', '没有此保留会话');
    const execution = this.storage.db
      .prepare('SELECT phase FROM execution_commands WHERE id=?')
      .get(row.dispatch_id);
    if (!execution || execution.phase !== 'terminal')
      throw new DomainError('SESSION_BUSY', '原执行未确认结束；不能用清理历史绕过目录占用');
    const home = this.home(ref);
    // Remove first so a filesystem error remains retryable; never remove outside the private vault.
    rmSync(home, { recursive: true, force: true });
    this.storage.db
      .prepare("UPDATE native_claude_sessions SET state='deleted' WHERE ref=?")
      .run(ref);
  }
}
