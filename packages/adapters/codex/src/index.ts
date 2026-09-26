import type { NativeEvent, NativeMode } from '../../../contracts/src/native.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Codex 协议对象无效');
  return value as ObjectValue;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new Error('Codex 原生标识无效');
  return value;
}
export interface CodexModel {
  id: string;
  name: string;
  isDefault: boolean;
}
export interface CodexSummary {
  resultReceived: boolean;
  success: boolean;
  interrupted: boolean;
  text: string;
  sessionId?: string;
  turnId?: string;
  resolvedModel?: string;
  denials: number;
}

/** Host-owned overrides. The temporary HOME does not import personal credentials/configuration. */
export function codexArguments(root: string): string[] {
  const overrides = [
    'cli_auth_credentials_store="ephemeral"',
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="disabled"',
    'features.shell_tool=false',
    'features.unified_exec=false',
    'features.apps=false',
    'features.multi_agent=false',
    'features.goals=false',
    'features.memories=false',
    'features.proactivity=false',
    'features.skill_mcp_dependency_install=false',
    'mcp_servers={}',
    'hooks={}',
    'plugins={}',
    'project_doc_max_bytes=0',
    'show_raw_agent_reasoning=false',
    'check_for_update_on_startup=false',
    `projects={ ${JSON.stringify(root)} = { trust_level="untrusted" } }`,
  ];
  return ['app-server', '--listen', 'stdio://', ...overrides.flatMap((v) => ['-c', v])];
}
export function codexSandbox(root: string, mode: NativeMode) {
  const access = { type: 'restricted', includePlatformDefaults: true, readableRoots: [root] };
  return mode === 'edit'
    ? {
        type: 'workspaceWrite',
        writableRoots: [root],
        readOnlyAccess: access,
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      }
    : { type: 'readOnly', access };
}

/** Bounded JSONL RPC. Secret-bearing requests and raw reasoning are never emitted as UI events. */
export class CodexSession {
  readonly summary: CodexSummary = {
    resultReceived: false,
    success: false,
    interrupted: false,
    text: '',
    denials: 0,
  };
  private pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private counter = 0;
  private disposed = false;
  private events = 0;
  private seenItems = new Set<string>();
  private earlyEvents: ObjectValue[] = [];
  private awaitingTurn = false;
  constructor(
    private send: (line: string) => void,
    private emit: (kind: NativeEvent['kind'], text: string) => void,
    private completed: () => void,
    private references: (refs: {
      sessionId?: string;
      turnId?: string;
      resolvedModel?: string;
    }) => void,
    private requestTimeoutMs = 15000,
  ) {}
  private write(message: unknown) {
    this.send(JSON.stringify(message) + '\n');
  }
  request(method: string, params: ObjectValue): Promise<unknown> {
    if (this.disposed || this.pending.size >= 16)
      return Promise.reject(new Error('Codex 连接已关闭或请求过多'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 请求超时；不会自动重发`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }
  async initialize() {
    object(
      await this.request('initialize', {
        clientInfo: { name: 'hexu', title: 'HEXU', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      }),
    );
    this.write({ method: 'initialized', params: {} });
  }
  async authenticate(apiKey: string) {
    const login = object(await this.request('account/login/start', { type: 'apiKey', apiKey }));
    if (login.type !== 'apiKey') throw new Error('Codex 未确认 API-key 认证方式');
  }
  async checkConfiguration(root: string, retained = false) {
    const response = object(await this.request('config/read', { cwd: root, includeLayers: false }));
    const config = object(response.config),
      features = object(config.features);
    if (
      features.shell_tool !== false ||
      features.unified_exec !== false ||
      config.web_search !== 'disabled' ||
      config.approval_policy !== 'never' ||
      config.cli_auth_credentials_store !== 'ephemeral'
    )
      throw new Error('Codex 未确认本次受限配置；不会回退到默认权限');
    if (
      retained &&
      (features.goals !== false || features.memories !== false || features.proactivity !== false)
    )
      throw new Error('Codex 未确认会话自动行为关闭，拒绝保留或恢复');
    const projects = object(config.projects);
    if (object(projects[root]).trust_level !== 'untrusted')
      throw new Error('Codex 未确认当前目录为不信任项目，已拒绝执行');
    const hooks = config.hooks == null ? {} : object(config.hooks);
    if (Object.values(hooks).some((value) => !Array.isArray(value) || value.length !== 0))
      throw new Error('Codex 包含活动 Hooks，已拒绝执行');
    for (const field of ['mcp_servers', 'plugins']) {
      if (config[field] != null && Object.keys(object(config[field])).length)
        throw new Error('Codex 配置包含本轮未开放的插件或 Hooks，已拒绝执行');
    }
  }
  async models(): Promise<CodexModel[]> {
    const models: CodexModel[] = [],
      cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const result = object(
        await this.request('model/list', {
          limit: 50,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }),
      );
      if (!Array.isArray(result.data)) throw new Error('Codex 模型目录不兼容');
      for (const value of result.data) {
        const entry = object(value);
        if (entry.hidden === true) continue;
        const id = identifier(entry.model ?? entry.id);
        if (!models.some((m) => m.id === id))
          models.push({
            id,
            name: typeof entry.displayName === 'string' ? entry.displayName.slice(0, 160) : id,
            isDefault: entry.isDefault === true,
          });
      }
      if (result.nextCursor == null) return models;
      cursor = identifier(result.nextCursor);
      if (cursors.has(cursor)) throw new Error('Codex 模型目录游标循环');
      cursors.add(cursor);
    }
    throw new Error('Codex 模型目录超过分页限制');
  }
  async start(
    root: string,
    mode: NativeMode,
    prompt: string,
    model: string | null,
    retained?: { threadId?: string; resolvedModel?: string },
    cancelled: () => boolean = () => false,
  ) {
    const checkCancelled = () => {
      if (cancelled()) throw new Error('Codex 启动已取消，没有发送下一轮请求');
    };
    checkCancelled();
    if (retained?.threadId) {
      const read = object(
        await this.request('thread/read', { threadId: retained.threadId, includeTurns: false }),
      );
      const thread = object(read.thread);
      if (
        thread.id !== retained.threadId ||
        thread.ephemeral !== false ||
        thread.cwd !== root ||
        !['notLoaded', 'idle'].includes(String(object(thread.status).type))
      )
        throw new Error('Codex 原会话状态或目录不匹配，没有开始新一轮');
    }
    checkCancelled();
    const response = object(
      await this.request(retained?.threadId ? 'thread/resume' : 'thread/start', {
        ...(retained?.threadId ? { threadId: retained.threadId } : { ephemeral: !retained }),
        cwd: root,
        approvalPolicy: 'never',
        // Loading persistent state must not restore broader historical permissions.
        sandbox: retained ? 'read-only' : mode === 'edit' ? 'workspace-write' : 'read-only',
        ...((retained?.resolvedModel ?? model) ? { model: retained?.resolvedModel ?? model } : {}),
      }),
    );
    const thread = object(response.thread);
    const sessionId = identifier(thread.id);
    if (
      retained &&
      (thread.ephemeral !== false ||
        response.cwd !== root ||
        response.approvalPolicy !== 'never' ||
        object(response.sandbox).type !== 'readOnly' ||
        typeof response.model !== 'string' ||
        !response.model ||
        (retained.threadId && sessionId !== retained.threadId) ||
        (retained.resolvedModel && response.model !== retained.resolvedModel))
    )
      throw new Error('Codex 未确认原生会话或受限恢复配置，不会回退新会话');
    this.summary.sessionId = sessionId;
    if (typeof response.model === 'string')
      this.summary.resolvedModel = response.model.slice(0, 100);
    this.references({
      sessionId: this.summary.sessionId,
      ...(this.summary.resolvedModel ? { resolvedModel: this.summary.resolvedModel } : {}),
    });
    checkCancelled();
    this.awaitingTurn = true;
    const started = object(
      await this.request('turn/start', {
        threadId: this.summary.sessionId,
        input: [{ type: 'text', text: prompt }],
        cwd: root,
        approvalPolicy: 'never',
        sandboxPolicy: codexSandbox(root, mode),
        ...((retained?.resolvedModel ?? model) ? { model: retained?.resolvedModel ?? model } : {}),
      }),
    );
    this.summary.turnId = identifier(object(started.turn).id);
    this.awaitingTurn = false;
    this.references({ turnId: this.summary.turnId });
    for (const message of this.earlyEvents) this.notification(message);
    this.earlyEvents = [];
  }
  async interrupt() {
    if (this.summary.sessionId && this.summary.turnId && !this.summary.resultReceived)
      await this.request('turn/interrupt', {
        threadId: this.summary.sessionId,
        turnId: this.summary.turnId,
      });
  }
  line(line: string) {
    if (this.disposed) return;
    if (++this.events > 10000) throw new Error('Codex 事件数量超过限制');
    const message = object(JSON.parse(line));
    if (typeof message.method === 'string') {
      if ('id' in message) this.serverRequest(message);
      else if (this.awaitingTurn && !this.summary.turnId) {
        if (this.earlyEvents.length >= 500) throw new Error('Codex 早到事件超过限制');
        this.earlyEvents.push(message);
      } else this.notification(message);
      return;
    }
    if (typeof message.id !== 'number') throw new Error('Codex 响应缺少请求标识');
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late/duplicate reply cannot authorize or create another turn.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) {
      const e = object(message.error);
      pending.reject(
        new Error(
          `Codex 请求失败：${typeof e.message === 'string' ? e.message.slice(0, 1000) : '未知错误'}`,
        ),
      );
    } else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('Codex 响应缺少 result/error'));
  }
  private serverRequest(message: ObjectValue) {
    if (!['number', 'string'].includes(typeof message.id)) throw new Error('无效的原生请求标识');
    const params = object(message.params ?? {});
    const scope =
      params.threadId === this.summary.sessionId &&
      (params.turnId === this.summary.turnId || (this.awaitingTurn && !this.summary.turnId));
    if (!scope) {
      this.write({
        id: message.id,
        error: { code: -32600, message: 'Request outside active HEXU turn' },
      });
      return;
    }
    let result: unknown;
    if (
      message.method === 'item/commandExecution/requestApproval' ||
      message.method === 'item/fileChange/requestApproval'
    )
      result = { decision: 'decline' };
    else if (message.method === 'item/permissions/requestApproval')
      result = { permissions: {}, scope: 'turn' };
    else if (message.method === 'item/tool/requestUserInput') result = { answers: {} };
    else if (message.method === 'mcpServer/elicitation/request')
      result = { action: 'decline', content: null };
    else {
      this.write({
        id: message.id,
        error: { code: -32601, message: 'Unsupported by HEXU limited integration' },
      });
      throw new Error('Codex 请求了本轮尚不支持的交互，已停止');
    }
    this.write({ id: message.id, result });
    this.summary.denials++;
    this.emit('warning', 'Codex 的额外授权或交互请求已拒绝；不会自动扩权。');
  }
  private notification(message: ObjectValue) {
    if (this.summary.resultReceived) return;
    const p = object(message.params ?? {});
    if (!this.summary.sessionId || p.threadId !== this.summary.sessionId) return;
    if (message.method === 'turn/completed') {
      const turn = object(p.turn);
      if (turn.id !== this.summary.turnId) return;
      if (!['completed', 'failed', 'interrupted'].includes(String(turn.status)))
        throw new Error('未知 Codex 结束状态');
      this.summary.resultReceived = true;
      this.summary.success = turn.status === 'completed' && turn.error == null;
      this.summary.interrupted = turn.status === 'interrupted';
      if (turn.error) {
        const error = object(turn.error);
        this.emit(
          'warning',
          typeof error.message === 'string' ? error.message.slice(0, 1000) : 'Codex 执行失败',
        );
      }
      this.completed();
      return;
    }
    if (p.turnId !== this.summary.turnId) return;
    if (message.method === 'item/completed') {
      const item = object(p.item),
        id = identifier(item.id);
      if (this.seenItems.has(id)) return;
      this.seenItems.add(id);
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        const text = item.text.slice(0, 12000);
        this.summary.text = (this.summary.text + '\n\n' + text).trim().slice(-20000);
        this.emit('text', text);
      } else if (item.type === 'fileChange')
        this.emit('tool', 'Codex 已返回文件变更活动，请在代码变更页查看实际内容。');
      // reasoning, command bodies, tool arguments, credentials and foreign items are not emitted.
    } else if (message.method === 'thread/tokenUsage/updated') {
      const usage = object(p.tokenUsage),
        last = object(usage.last ?? {});
      const total = last.totalTokens;
      if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0)
        this.emit('usage', `Codex 报告本轮 token：${total}；金额未知，不按美元预算保证。`);
    }
  }
  dispose(reason = 'Codex 连接已结束') {
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.earlyEvents = [];
  }
}
