import { CodexSessions, type CodexSessionLease } from './codex-sessions.js';
import type { CodexSummary } from '../../../../packages/adapters/codex/src/index.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DomainError, text } from '../../../../packages/contracts/src/index.js';
import { exact, nodeId } from '../../../../packages/contracts/src/nodes.js';
import {
  parsePolicy,
  parseSessionRequest,
  type DispatchCommand,
} from '../../../../packages/contracts/src/node-execution.js';
import type { NativeRunConfig } from '../../../../packages/contracts/src/native.js';
import { canonicalJson } from '../../../../packages/domain/src/index.js';
import {
  ClaudeStream,
  claudeArguments,
  redact,
} from '../../../../packages/adapters/claude-code/src/index.js';
import { runProcess, type ProcessHandle } from '../process-host.js';
import { openCodex } from '../codex-host.js';
import { WorkspaceLease } from '../workspace-lease.js';
import { AgentConnection, nodeRequest } from './connection.js';
import { captureDirectory } from './workspaces.js';
import { ExecutionJournal } from './execution-journal.js';
import {
  keyFor,
  readExecutionPolicy,
  probeExecution,
  type LocalExecution,
} from './execution-policy.js';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** One independently authorized native process at a time. Never resume paid work
 * after a journal/ACK ambiguity, and never use credentials supplied by the server. */
export class NodeExecutor {
  readonly journal: ExecutionJournal;
  readonly sessions: CodexSessions;
  private local: LocalExecution | null;
  private publishedConnection: string | null = null;
  private closed = false;
  private fatal: DomainError | null = null;
  private active: {
    command: DispatchCommand;
    handle: ProcessHandle | null;
    stopRequested: boolean;
    job: Promise<void> | null;
  } | null = null;
  constructor(
    readonly connection: AgentConnection,
    private log: (s: string) => void = () => {},
  ) {
    this.journal = new ExecutionJournal(connection.storage);
    this.journal.recover();
    this.sessions = new CodexSessions(connection.storage);
    this.sessions.recover();
    this.local = readExecutionPolicy(connection.storage.home);
    // A confirmed terminal journal is enough to release its own stale local claim.
    for (const row of this.journal.commands().filter((r) => r.phase === 'terminal')) {
      const command = JSON.parse(row.body) as DispatchCommand;
      const directory = connection.credentials.directories.find(
        (w) => w.id === command.workspaceId,
      );
      if (directory) {
        try {
          new WorkspaceLease(directory.root, command.id, true).release();
        } catch {
          /* a different run owns the directory or it was moved */
        }
      }
    }
  }
  get enabled() {
    return !!this.local;
  }
  private async request<T>(path: string, body: unknown, signal?: AbortSignal) {
    const c = this.connection.credentials;
    return nodeRequest<T>(c.controlUrl, path, body, c.nodeToken, signal);
  }
  private validate(value: unknown): DispatchCommand {
    const b = exact(value, [
      'id',
      'generation',
      'runId',
      'taskId',
      'projectId',
      'workspaceId',
      'policyHash',
      'policy',
      'mode',
      'context',
      'expiresAt',
      'session',
    ]);
    const policy = parsePolicy(b.policy);
    if (
      !this.local ||
      hash(policy) !== hash(this.local.policy) ||
      b.policyHash !== hash(policy) ||
      b.projectId !== this.connection.credentials.projectId ||
      !policy.workspaceIds.includes(String(b.workspaceId)) ||
      (b.mode !== 'read-only' && b.mode !== policy.mode) ||
      !Number.isFinite(Date.parse(String(b.expiresAt)))
    )
      throw new DomainError(
        'EXECUTION_SCOPE_MISMATCH',
        '服务端命令超出本机确认的执行范围，没有启动',
      );
    if (b.session !== undefined && (policy.tool !== 'codex' || !policy.retainSessions))
      throw new DomainError('SESSION_NOT_ENABLED', '本机未授权保留或恢复会话');
    return {
      ...(b.session === undefined ? {} : { session: parseSessionRequest(b.session) }),
      id: nodeId(b.id),
      generation: nodeId(b.generation),
      runId: nodeId(b.runId),
      taskId: nodeId(b.taskId),
      projectId: nodeId(b.projectId),
      workspaceId: nodeId(b.workspaceId),
      policyHash: String(b.policyHash),
      policy,
      mode: b.mode as DispatchCommand['mode'],
      context: text(b.context, '任务材料', 20000),
      expiresAt: String(b.expiresAt),
    };
  }
  async flush(signal?: AbortSignal) {
    for (let i = 0; i < 128; i++) {
      const item = this.journal.pending();
      if (!item) return;
      const ack = await this.request<{ acknowledgedSequence: number }>(
        'execution-event',
        { dispatchId: item.command.id, generation: item.command.generation, event: item.event },
        signal,
      );
      this.journal.acknowledge(item.command.id, ack.acknowledgedSequence);
    }
  }
  async tick(signal?: AbortSignal) {
    try {
      if (this.fatal) throw this.fatal;
      await this.flush(signal);
      if (this.closed || !this.local) return;
      if (this.publishedConnection !== this.connection.connectionId) {
        if (!keyFor(this.local.policy))
          throw new DomainError('API_KEY_REQUIRED', '本机缺少对应 API key，没有发布执行授权');
        const version = await probeExecution(this.local.executable, this.local.policy);
        if (version !== this.local.policy.toolVersion)
          throw new DomainError(
            'TOOL_VERSION_CHANGED',
            '原生工具版本已变化，请在本机重新 enable-execution',
          );
        const response = await this.request<{ policyHash: string }>(
          'execution-policy',
          { connectionId: this.connection.connectionId, policy: this.local.policy },
          signal,
        );
        if (response.policyHash !== hash(this.local.policy))
          throw new DomainError('POLICY_MISMATCH', '服务返回的授权版本不一致');
        this.publishedConnection = this.connection.connectionId;
        this.log('已发布本人执行授权；项目成员可查看已共享输出，不能因此控制本机。');
      }
      const next = await this.request<{ command: unknown | null; stopRequested: boolean }>(
        'execution-poll',
        { connectionId: this.connection.connectionId },
        signal,
      );
      if (typeof next.stopRequested !== 'boolean')
        throw new DomainError('INVALID_RESPONSE', '无效执行响应');
      if (next.stopRequested || (this.active && !next.command)) this.transportLost();
      if (!next.command || next.stopRequested || this.closed) return;
      const command = this.validate(next.command);
      const existing = this.journal.get(command.id);
      if (existing) {
        if (canonicalJson(JSON.parse(existing.body)) !== canonicalJson(command))
          throw new DomainError('COMMAND_CHANGED', '同一派发内容改变');
        return; // accepted/preparing/running/unknown/terminal records ALL prevent another spawn.
      }
      if (this.active) throw new DomainError('LOCAL_EXECUTION_BUSY', '节点已有活动执行');
      this.journal.accept(command);
      await this.flush(signal); // accepted is durable before the control service sees it.
      await this.start(command, signal);
    } catch (error) {
      this.transportLost(); // Communication failure never leaves unattended new work running.
      this.publishedConnection = null;
      throw error;
    }
  }
  transportLost() {
    if (this.active) this.active.stopRequested = true;
    this.active?.handle?.stop();
    this.publishedConnection = null;
  }
  private async start(command: DispatchCommand, signal?: AbortSignal) {
    let lease: WorkspaceLease | null = null;
    const directory = this.connection.credentials.directories.find(
      (w) => w.id === command.workspaceId,
    );
    try {
      if (!directory || (await captureDirectory(directory)).state !== 'available')
        throw new DomainError(
          'WORKSPACE_UNAVAILABLE',
          '目录身份或 Git 状态不满足本机授权，没有启动',
        );
      if (Date.parse(command.expiresAt) <= Date.now() || signal?.aborted || this.closed)
        throw new DomainError('DISPATCH_EXPIRED', '派发已过期或节点正在停止');
      lease = new WorkspaceLease(directory.root, command.id);
      this.journal.phase(command.id, 'preparing'); // Must precede the permit/spawn ambiguity window.
      const permit = await this.request<{ allowed: boolean }>(
        'execution-permit',
        {
          connectionId: this.connection.connectionId,
          dispatchId: command.id,
          generation: command.generation,
        },
        signal,
      );
      if (permit.allowed !== true || signal?.aborted || this.closed) {
        this.journal.settle(command.id, 'cancelled', '启动前已取消，未调用模型。');
        lease.release();
        return;
      }
      // Recheck the local directory after the network round-trip, before any child process.
      if ((await captureDirectory(directory)).state !== 'available')
        throw new DomainError('WORKSPACE_UNAVAILABLE', '启动前目录授权已变化');
      if (signal?.aborted || this.closed) {
        this.journal.settle(command.id, 'cancelled', '节点关闭，未启动模型。');
        lease.release();
        return;
      }
      this.active = { command, handle: null, stopRequested: false, job: null };
      const active = this.active;
      active.job = this.execute(command, directory.root, lease)
        .catch(() => {
          this.fatal = new DomainError(
            'LOCAL_JOURNAL_FAILED',
            '执行日志未能可靠保存，已请求停止；保留目录占用，请在本机核对。',
          );
          this.transportLost();
        })
        .finally(() => {
          if (this.active === active) this.active = null;
        });
    } catch (e) {
      // No process has been constructed in this method's failure path.
      this.journal.settle(
        command.id,
        'failed',
        e instanceof DomainError ? e.message : '准备执行失败，没有启动原生工具。',
      );
      lease?.release();
    }
  }
  private async execute(command: DispatchCommand, root: string, lease: WorkspaceLease) {
    const local = this.local!,
      apiKey = keyFor(local.policy)!;
    let handle: ProcessHandle | null = null,
      home: string | null = null,
      attemptedSpawn = false;
    let retained: CodexSessionLease | undefined;
    let emitted = 0;
    const clean = (value: string) =>
      redact(value, [
        apiKey,
        this.connection.credentials.nodeToken,
        root,
        this.connection.storage.home,
      ]);
    const emit = (_kind: string, value: string) => {
      if (++emitted <= 60) this.journal.append(command.id, 'output', clean(value).slice(0, 5000));
      else if (emitted === 61)
        this.journal.append(command.id, 'output', '后续详细输出已达到共享上限；最终结果仍会保存。');
    };
    const onSpawn = () => {
      this.journal.phase(command.id, 'running');
      this.journal.append(command.id, 'running');
    };
    const config: NativeRunConfig = {
      workingCopyId: command.workspaceId,
      mode: command.mode,
      model: command.policy.model,
      maxTurns: command.policy.maxTurns,
      maxBudgetUsd: command.policy.maxBudgetUsd,
      timeoutSeconds: command.policy.timeoutSeconds,
      toolVersion: command.policy.toolVersion,
      contextText: command.context,
      contextHash: hash(command.context),
    };
    try {
      let summary: { resultReceived: boolean; success: boolean; text: string };
      if (command.policy.tool === 'codex') {
        if (command.policy.retainSessions) {
          const directory = this.connection.credentials.directories.find(
            (d) => d.id === command.workspaceId,
          )!;
          retained = this.sessions.prepare(
            command,
            this.connection.credentials,
            directory,
            local.executable,
            apiKey,
          );
        }
        attemptedSpawn = true;
        const codex = await openCodex({
          executable: local.executable,
          root,
          apiKey,
          config,
          onSpawn,
          onEvent: emit,
          retained,
          onReferences: (refs) => {
            if (retained) this.sessions.references(retained.ref, command.id, refs);
          },
        });
        handle = codex;
        summary = codex.summary;
      } else {
        home = await mkdtemp(join(tmpdir(), 'hexu-node-claude-'));
        const stream = new ClaudeStream(emit);
        attemptedSpawn = true;
        handle = runProcess({
          executable: local.executable,
          args: claudeArguments(config),
          cwd: root,
          env: { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', ANTHROPIC_API_KEY: apiKey },
          input: config.contextText,
          timeoutMs: config.timeoutSeconds * 1000,
          onSpawn,
          onLine: (line) => stream.line(line),
        });
        summary = stream.summary;
      }
      this.active!.handle = handle;
      if (this.closed || this.active!.stopRequested) handle.stop();
      const outcome = await handle.done;
      if (!outcome.terminationConfirmed) {
        this.journal.phase(command.id, 'unknown');
        this.journal.append(command.id, 'unknown');
        return;
      }
      const success =
        !outcome.stopped && !outcome.error && summary.resultReceived && summary.success;
      const state = success
        ? 'succeeded'
        : outcome.stopped && !outcome.error
          ? 'cancelled'
          : 'failed';
      const nativeSession = retained
        ? this.sessions.finish(retained, command, summary as CodexSummary, success)
        : undefined;
      this.journal.settle(
        command.id,
        state,
        clean(
          [
            success
              ? '独立节点确认本次工具执行结束；任务完成由你决定。'
              : state === 'cancelled'
                ? '独立节点已确认原进程停止，文件修改保留。'
                : '工具执行未完成，进程已结束；没有自动重试。',
            summary.text.slice(0, 4800),
            outcome.error
              ? command.session
                ? '原生会话恢复或后续执行失败，没有改用新会话；请核对节点会话状态后明确选择。'
                : '原生进程或协议发生错误。'
              : '',
            !summary.resultReceived && !outcome.stopped
              ? '未收到有效完成事件，未将退出码当作成功。'
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        ),
        nativeSession,
      );
      lease.release();
    } catch (error) {
      handle?.stop();
      const outcome = handle ? await handle.done : null;
      if (outcome?.terminationConfirmed || !attemptedSpawn) {
        this.journal.settle(
          command.id,
          'failed',
          error instanceof DomainError
            ? clean(error.message)
            : '执行未完成，已确认没有遗留受管进程。',
        );
        lease.release();
      } else {
        this.journal.phase(command.id, 'unknown');
        this.journal.append(command.id, 'unknown');
      }
    } finally {
      if (retained) this.sessions.block(retained.ref); // ready is unaffected; interrupted state stays blocked.
      lease.close();
      if (home && this.journal.get(command.id)?.phase === 'terminal')
        await rm(home, { recursive: true, force: true });
    }
  }
  async close() {
    this.closed = true;
    this.active?.handle?.stop();
    await this.active?.job;
    try {
      await this.flush();
    } catch {
      this.log('执行证据尚未获确认，已保存在本机；不会重复启动。');
    }
  }
}
