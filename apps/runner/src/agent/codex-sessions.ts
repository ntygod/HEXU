import { createHash, createHmac } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import { nodeId } from '../../../../packages/contracts/src/nodes.js';
import type {
  DispatchCommand,
  NativeSessionInfo,
} from '../../../../packages/contracts/src/node-execution.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import type { CodexSummary } from '../../../../packages/adapters/codex/src/index.js';
import { ensurePrivateHome, type AgentStorage, type NodeCredentials } from './storage.js';
import type { LocalDirectory } from './workspaces.js';

const LIFETIME = 7 * 86400_000;
interface SessionRow {
  ref: string;
  binding: string;
  dispatch_id: string;
  thread_id: string | null;
  turn_id: string | null;
  model: string | null;
  state: 'active' | 'ready' | 'blocked' | 'deleted';
  expires_at: string;
}
export interface CodexSessionLease {
  ref: string;
  home: string;
  threadId?: string;
  resolvedModel?: string;
  action: 'created' | 'resumed';
}
/** Only HEXU-created, explicitly retained provider state. No import of personal HOME,
 * browser-supplied provider IDs, transcript paths or credentials. AgentStorage's
 * exclusive process guard and workspace claims serialize all access to this vault. */
export class CodexSessions {
  constructor(readonly storage: AgentStorage) {
    storage.db.exec(`CREATE TABLE IF NOT EXISTS native_codex_sessions(
      ref TEXT PRIMARY KEY, binding TEXT NOT NULL, dispatch_id TEXT NOT NULL,
      thread_id TEXT, turn_id TEXT, model TEXT, state TEXT NOT NULL, expires_at TEXT NOT NULL
    );`);
  }
  recover() {
    // Interrupted lifecycle never becomes resumable just because the OS guard unlocked.
    this.storage.db.exec("UPDATE native_codex_sessions SET state='blocked' WHERE state='active'");
  }
  private row(ref: string) {
    return this.storage.db
      .prepare('SELECT * FROM native_codex_sessions WHERE ref=?')
      .get(nodeId(ref)) as SessionRow | undefined;
  }
  private home(ref: string, create: boolean) {
    const parent = join(this.storage.home, 'codex-sessions');
    if (create && !existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    if (!existsSync(parent))
      throw new DomainError('SESSION_MISSING', '节点原生会话文件已移除；没有自动新建会话');
    ensurePrivateHome(parent);
    const path = join(parent, nodeId(ref));
    if (create) mkdirSync(path, { mode: 0o700 });
    if (!existsSync(path))
      throw new DomainError('SESSION_MISSING', '节点原生会话文件已移除；请明确使用新会话');
    const real = ensurePrivateHome(path);
    if (real !== path) throw new DomainError('SESSION_PATH_CHANGED', '原生会话目录已改变');
    return real;
  }
  private inspect(home: string) {
    // Limit traversal and refuse indirection. Never read or publish native transcript bodies.
    let entries = 0,
      bytes = 0;
    const walk = (path: string) => {
      for (const entry of readdirSync(path)) {
        if (++entries > 4096)
          throw new DomainError('SESSION_TOO_LARGE', '原生会话文件过多，请清理或明确新建会话');
        const item = join(path, entry),
          s = lstatSync(item);
        if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
          throw new DomainError('SESSION_UNSAFE_FILE', '原生会话含链接或特殊文件，拒绝恢复');
        if (s.isDirectory()) walk(item);
        else if ((bytes += s.size) > 64 * 1024 * 1024)
          throw new DomainError('SESSION_TOO_LARGE', '原生会话超过本机恢复上限，未自动重试');
      }
    };
    walk(home);
  }
  prepare(
    command: DispatchCommand,
    credentials: NodeCredentials,
    directory: LocalDirectory,
    executable: string,
    apiKey: string,
  ): CodexSessionLease {
    if (command.policy.tool !== 'codex' || !command.policy.retainSessions)
      throw new DomainError('SESSION_NOT_ENABLED', '本机未授权保留 Codex 会话');
    for (const root of credentials.directories) {
      const r = relative(root.root, this.storage.home);
      if (!r || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)))
        throw new DomainError('SESSION_IN_WORKSPACE', '节点私有会话目录不能位于授权工作目录中');
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
          // Exact-key binding is conservative: rotation requires a new session. Never leaves the node.
          account: createHmac('sha256', credentials.nodeToken).update(apiKey).digest('hex'),
        }),
      )
      .digest('hex');
    let row: SessionRow, action: CodexSessionLease['action'];
    if (command.session) {
      const saved = this.row(command.session.ref);
      if (!saved || saved.state !== 'ready' || !saved.thread_id || !saved.turn_id || !saved.model)
        throw new DomainError(
          'SESSION_NOT_RECOVERABLE',
          '原生会话不存在、已删除或未确认安全结束；没有自动新建',
        );
      if (saved.binding !== binding || saved.dispatch_id !== command.session.sourceDispatchId)
        throw new DomainError(
          'SESSION_SCOPE_CHANGED',
          '原生会话的任务、目录、工具授权或本机账户已变化；请明确新建会话',
        );
      if (Date.parse(saved.expires_at) <= Date.now())
        throw new DomainError(
          'SESSION_EXPIRED',
          '原生会话恢复期限已过；历史文件仍保留，请明确新建或在本机清理',
        );
      this.inspect(this.home(saved.ref, false));
      row = saved;
      action = 'resumed';
      this.storage.db
        .prepare("UPDATE native_codex_sessions SET state='active',dispatch_id=? WHERE ref=?")
        .run(command.id, saved.ref);
    } else {
      const count = Number(
        this.storage.db
          .prepare("SELECT COUNT(*) AS n FROM native_codex_sessions WHERE state!='deleted'")
          .get()!.n,
      );
      if (count >= 32)
        throw new DomainError('SESSION_CAPACITY', '节点已保留 32 个原生会话，请先在本机清理');
      const ref = command.id;
      this.home(ref, true);
      row = {
        ref,
        binding,
        dispatch_id: command.id,
        thread_id: null,
        turn_id: null,
        model: null,
        state: 'active',
        expires_at: new Date(Date.now() + LIFETIME).toISOString(),
      };
      this.storage.db
        .prepare("INSERT INTO native_codex_sessions VALUES(?,?,?,NULL,NULL,NULL,'active',?)")
        .run(ref, binding, command.id, row.expires_at);
      action = 'created';
    }
    return {
      ref: row.ref,
      home: this.home(row.ref, false),
      action,
      ...(action === 'resumed' ? { threadId: row.thread_id!, resolvedModel: row.model! } : {}),
    };
  }
  references(
    ref: string,
    dispatchId: string,
    refs: { sessionId?: string; turnId?: string; resolvedModel?: string },
  ) {
    const row = this.row(ref);
    if (!row || row.state !== 'active' || row.dispatch_id !== dispatchId)
      throw new DomainError('SESSION_BINDING_LOST', '原生会话关联已变化，已停止');
    if (refs.sessionId && row.thread_id && refs.sessionId !== row.thread_id)
      throw new DomainError('SESSION_ID_CHANGED', '提供方返回了另一会话，拒绝继续');
    this.storage.db
      .prepare('UPDATE native_codex_sessions SET thread_id=?,turn_id=?,model=? WHERE ref=?')
      .run(
        refs.sessionId ?? row.thread_id,
        refs.turnId ?? row.turn_id,
        refs.resolvedModel ?? row.model,
        ref,
      );
  }
  finish(
    lease: CodexSessionLease,
    command: DispatchCommand,
    summary: CodexSummary,
    success: boolean,
  ): NativeSessionInfo | undefined {
    const row = this.row(lease.ref);
    const ready = !!(
      success &&
      summary.resultReceived &&
      summary.success &&
      summary.sessionId &&
      summary.turnId &&
      row?.state === 'active' &&
      row.dispatch_id === command.id &&
      row.thread_id === summary.sessionId &&
      row.turn_id === summary.turnId &&
      row.model
    );
    if (ready) this.inspect(lease.home);
    this.storage.db
      .prepare('UPDATE native_codex_sessions SET state=? WHERE ref=? AND dispatch_id=?')
      .run(ready ? 'ready' : 'blocked', lease.ref, command.id);
    return ready ? { ref: lease.ref, action: lease.action, expiresAt: row!.expires_at } : undefined;
  }
  block(ref: string) {
    this.storage.db
      .prepare("UPDATE native_codex_sessions SET state='blocked' WHERE ref=? AND state='active'")
      .run(ref);
  }
  list() {
    return (
      this.storage.db
        .prepare(
          "SELECT ref,dispatch_id,state,expires_at FROM native_codex_sessions WHERE state!='deleted' ORDER BY rowid DESC",
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
    // Even an active-looking session cannot be deleted while its execution is uncertain.
    const execution = this.storage.db
      .prepare('SELECT phase FROM execution_commands WHERE id=?')
      .get(row.dispatch_id);
    if (!execution || execution.phase !== 'terminal')
      throw new DomainError('SESSION_BUSY', '原执行未确认结束；先核对进程，不能清理会话绕过占用');
    const home = this.home(ref, false);
    this.storage.db
      .prepare("UPDATE native_codex_sessions SET state='deleted' WHERE ref=?")
      .run(ref);
    rmSync(home, { recursive: true, force: true });
  }
}
