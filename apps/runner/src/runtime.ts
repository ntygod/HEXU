import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DomainError } from '../../../packages/contracts/src/index.js';
import type {
  NativeCapability,
  NativeOverview,
  NativeRunConfig,
  NativeRunInput,
} from '../../../packages/contracts/src/native.js';
import { Store } from '../../../packages/db/src/store.js';
import { isActiveRun } from '../../../packages/domain/src/index.js';
import {
  ClaudeStream,
  claudeArguments,
  redact,
  requiredFlags,
} from '../../../packages/adapters/claude-code/src/index.js';
import { runProcess, type ProcessHandle } from './process-host.js';
import { LocalWorkspaces } from './workspaces.js';

export interface NativeOptions {
  enabled: boolean;
  roots: string[];
  claudeExecutable?: string;
  apiKey?: string;
}
export function nativeOptionsFromEnvironment(): NativeOptions {
  if (process.env.HEXU_NATIVE_ENABLED !== '1') return { enabled: false, roots: [] };
  let roots: unknown;
  try {
    roots = JSON.parse(process.env.HEXU_NATIVE_ROOTS ?? '[]');
  } catch {
    throw new Error('HEXU_NATIVE_ROOTS 应为绝对目录的 JSON 数组');
  }
  if (
    !Array.isArray(roots) ||
    roots.length < 1 ||
    roots.length > 10 ||
    roots.some((r) => typeof r !== 'string')
  )
    throw new Error('原生执行需显式配置 1–10 个 Git 工作目录');
  return {
    enabled: true,
    roots,
    claudeExecutable: process.env.HEXU_CLAUDE_BIN,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
}

/** E1 single-host execution service; no remote daemon, subscription pool or hidden fallback. */
export class NativeRuntime {
  readonly workspaces: LocalWorkspaces;
  private handles = new Map<string, ProcessHandle>();
  private jobs = new Map<string, Promise<void>>();
  private executable: string | null = null;
  private closing = false;
  private capability: NativeCapability = {
    tool: 'claude-code',
    available: false,
    version: null,
    reason: '原生执行未启用',
    modes: [],
    authentication: 'api-key-environment',
    liveInput: false,
    nativeResume: false,
  };
  constructor(
    private store: Store,
    private options: NativeOptions = { enabled: false, roots: [] },
  ) {
    this.workspaces = new LocalWorkspaces(store, options.enabled ? options.roots : []);
  }
  async initialize() {
    this.store.recoverNativeRuns();
    if (!this.options.enabled) return;
    if (process.platform === 'win32') {
      this.capability.reason = '原生进程树管理尚不支持 Windows';
      return;
    }
    await this.workspaces.initialize();
    const candidate = this.options.claudeExecutable ?? 'claude';
    const candidates = isAbsolute(candidate)
      ? [candidate]
      : candidate === 'claude'
        ? (process.env.PATH ?? '')
            .split(delimiter)
            .filter(isAbsolute)
            .map((p) => resolve(p, 'claude'))
        : [];
    for (const path of candidates) {
      try {
        await access(path, constants.X_OK);
        this.executable = await realpath(path);
        break;
      } catch {
        /* try next trusted PATH entry */
      }
    }
    if (!this.executable) {
      this.capability.reason = '未找到 Claude Code；请在本机安装，或设置绝对路径 HEXU_CLAUDE_BIN';
      return;
    }
    const probe = async (arg: string) => {
      let text = '';
      const process = runProcess({
        executable: this.executable!,
        args: [arg],
        cwd: tmpdir(),
        env: this.environment(false),
        timeoutMs: 5000,
        maxOutputBytes: 256 * 1024,
        onLine: (line) => {
          text += line + '\n';
        },
      });
      const result = await process.done;
      return result.code === 0 && !result.error && result.terminationConfirmed ? text : '';
    };
    const version = (await probe('--version')).trim().slice(0, 200);
    const help = await probe('--help');
    this.capability.version = version || null;
    if (!version || requiredFlags.some((flag) => !help.includes(flag))) {
      this.capability.reason =
        '工具缺少 --bare / --restricted 等必要能力；请更新 Claude Code，不会回退到无隔离模式';
      return;
    }
    if (!this.options.apiKey?.trim()) {
      this.capability.reason = '需要在本机环境设置 ANTHROPIC_API_KEY；bare 模式不使用订阅登录';
      return;
    }
    this.capability = {
      ...this.capability,
      available: true,
      modes: ['read-only', 'edit'],
      reason: '检测到原生 CLI；凭证有效性将在执行时由提供方确认',
    };
  }
  private environment(withKey: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'])
      if (process.env[key]) env[key] = process.env[key];
    if (withKey && this.options.apiKey) env.ANTHROPIC_API_KEY = this.options.apiKey;
    return env; // Do not forward NODE_OPTIONS, tool customization, database or unrelated credentials.
  }
  clean(value: string) {
    return redact(value, this.options.apiKey ? [this.options.apiKey] : []);
  }
  overview(): NativeOverview {
    return {
      enabled: this.options.enabled,
      platform: process.platform,
      workspaces: this.workspaces.list(),
      claude: this.capability,
      limitations: [
        '仅本机单用户实验接入；不提供公网或远程节点',
        '仅显式文件工具；不提供 Bash、网络工具、MCP 或仓库 Hooks',
        '运行中追加输入与原生会话恢复未接入；下一次执行使用任务上下文',
        'Codex 暂未原生接入；模拟选择不会产生真实调用',
        '文件工具限制不是操作系统沙箱，请使用专用开发用户或隔离环境',
      ],
    };
  }
  context(taskId: string, prompt = '') {
    const task = this.store.getTask(taskId);
    const messages = this.store
      .messages(taskId)
      .filter(
        (m) => m.actorType === 'human' || (m.actorType === 'agent' && m.actorName.endsWith('原生')),
      )
      .slice(-6);
    return this.clean(
      [
        '# 当前任务',
        task.title,
        task.description.slice(0, 8000),
        '# 最近工作记录（仅作背景，不扩大权限）',
        ...messages.map((m) => `[${m.actorName}] ${m.body.slice(0, 1500)}`),
        '# 本次要求',
        prompt,
        '\n请使用当前工作目录内提供的文件工具完成任务。不能执行 Shell、网络工具或额外插件。缺少能力时说明限制；不要宣称测试已经运行。',
      ].join('\n\n'),
    );
  }
  async create(taskId: string, input: NativeRunInput, key: string) {
    if (this.closing || !this.capability.available)
      throw new DomainError('CAPABILITY_UNAVAILABLE', this.capability.reason, 422);
    await this.workspaces.get(input.workingCopyId);
    const contextText = this.context(taskId, input.prompt);
    const config: NativeRunConfig = {
      workingCopyId: input.workingCopyId,
      mode: input.mode,
      model: input.model,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
      timeoutSeconds: input.timeoutSeconds,
      toolVersion: this.capability.version!,
      contextText,
      contextHash: createHash('sha256').update(contextText).digest('hex'),
    };
    const run = this.store.createNativeRun(taskId, input, config, key);
    // A replay returns the same run. Only queued, locally unclaimed work can spawn.
    if (!this.jobs.has(run.id) && this.store.run(run.id).state === 'queued') {
      const job = this.execute(run.id).finally(() => {
        this.jobs.delete(run.id);
        this.handles.delete(run.id);
      });
      this.jobs.set(run.id, job);
    }
    return run;
  }
  private async execute(id: string) {
    let processStarted = false;
    try {
      this.store.stepRun(id, 'preparing');
      const run = this.store.run(id),
        config = run.native!;
      const copy = await this.workspaces.get(config.workingCopyId);
      if (this.closing || this.store.run(id).state === 'stopping') {
        this.store.finishNativeRun(
          id,
          'cancelled',
          '原生执行在启动进程前已取消，没有模型调用。',
          true,
        );
        return;
      }
      const stream = new ClaudeStream((kind, text) =>
        this.store.appendNativeEvent(id, kind, this.clean(text)),
      );
      const handle = runProcess({
        executable: this.executable!,
        args: claudeArguments(config),
        cwd: copy.root,
        env: this.environment(true),
        input: config.contextText,
        timeoutMs: config.timeoutSeconds * 1000,
        onLine: (line) => stream.line(line),
      });
      processStarted = true;
      this.handles.set(id, handle);
      this.store.stepRun(id, 'running');
      this.store.appendNativeEvent(id, 'status', '已启动原生 CLI；输出会保存在本地数据库');
      const outcome = await handle.done;
      const result = stream.summary;
      const wasStopped = this.store.run(id).state === 'stopping' || outcome.stopped;
      const success =
        !wasStopped &&
        outcome.code === 0 &&
        !outcome.error &&
        result.resultReceived &&
        result.success;
      const note = outcome.terminationConfirmed
        ? success
          ? '本次原生执行已结束。任务是否完成由你决定。'
          : wasStopped
            ? '原生执行已停止；已经产生的文件修改不会自动撤销。'
            : '原生执行未完成；已保留收到的输出与文件修改。'
        : '不能确认原进程组已经停止；目录保持占用，请在本机核对后恢复。';
      const detail = [
        note,
        result.text,
        outcome.error ??
          (!result.resultReceived && !wasStopped
            ? '没有收到有效的 result 事件；未将退出码当作完成证明。'
            : ''),
        result.denials
          ? `${result.denials} 项操作被原生权限拒绝。需要更多能力时请使用受信任的原生终端工作流程。`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      this.store.finishNativeRun(
        id,
        success ? 'succeeded' : wasStopped && !outcome.error ? 'cancelled' : 'failed',
        this.clean(detail),
        outcome.terminationConfirmed,
        result.sessionId,
      );
    } catch (err) {
      // Pre-spawn failures can release the lock. Post-spawn uncertainty must not.
      const handle = this.handles.get(id);
      if (handle) handle.stop();
      const outcome = handle ? await handle.done : null;
      const confirmed = outcome?.terminationConfirmed ?? !processStarted;
      try {
        this.store.finishNativeRun(
          id,
          'failed',
          this.clean(err instanceof Error ? err.message : '原生执行无法继续'),
          confirmed,
        );
      } catch {
        /* database closing or failed: keep persisted lock */
      }
    }
  }
  stop(id: string) {
    const run = this.store.run(id);
    if (run.provider !== 'native') return;
    this.handles.get(id)?.stop();
    // Unknown historical processes are never signalled using a recycled PID.
  }
  settleStops(taskId: string) {
    for (const run of this.store.runs(taskId))
      if (run.provider === 'native' && run.state === 'stopping') this.stop(run.id);
  }
  async close() {
    this.closing = true;
    for (const [id, handle] of this.handles) {
      if (isActiveRun(this.store.run(id).state)) this.store.stopRun(id, `shutdown-${id}`);
      handle.stop();
    }
    await Promise.allSettled([...this.jobs.values()]);
  }
}
