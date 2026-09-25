import type { NativeRunConfig, NativeEvent } from '../../../contracts/src/native.js';

export const requiredFlags = [
  '--bare',
  '--restricted',
  '--tools',
  '--permission-mode',
  '--max-turns',
  '--max-budget-usd',
  '--strict-mcp-config',
];
export function claudeArguments(config: NativeRunConfig): string[] {
  const tools = config.mode === 'edit' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  const deniedFiles = [
    '.env',
    '.env.*',
    '**/.env',
    '**/.env.*',
    '**/*.pem',
    '**/*.key',
    '**/credentials*',
    '.hexu/**',
    '.git/**',
    '.ssh/**',
  ];
  const settings = {
    permissions: {
      deny: deniedFiles.flatMap((path) =>
        ['Read', 'Edit', 'Write'].map((tool) => `${tool}(./${path})`),
      ),
    },
  };
  return [
    '--bare',
    '--restricted',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'dontAsk',
    '--tools',
    tools,
    '--allowedTools',
    tools,
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    JSON.stringify(settings),
    '--max-turns',
    String(config.maxTurns),
    '--max-budget-usd',
    String(config.maxBudgetUsd),
    ...(config.model ? ['--model', config.model] : []),
  ];
}
export interface ClaudeSummary {
  resultReceived: boolean;
  success: boolean;
  text: string;
  sessionId?: string;
  denials: number;
}
/** Decode documented JSONL messages, never infer success from prose or a zero exit code alone. */
export class ClaudeStream {
  readonly summary: ClaudeSummary = { resultReceived: false, success: false, text: '', denials: 0 };
  private eventCount = 0;
  constructor(private emit: (kind: NativeEvent['kind'], text: string) => void) {}
  line(line: string) {
    if (++this.eventCount > 2000) throw new Error('event limit');
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== 'object' || !('type' in event)) throw new Error('invalid event');
    const message = event as Record<string, unknown>;
    if (message.type === 'system' && message.subtype === 'init') {
      if (typeof message.session_id === 'string')
        this.summary.sessionId = message.session_id.slice(0, 200);
      this.emit('status', '原生工具已开始本次会话');
    } else if (message.type === 'system' && message.subtype === 'permission_denied') {
      this.summary.denials++;
      this.emit('warning', '原生权限规则拒绝了一项操作；不会在网页自动扩权');
    } else if (message.type === 'assistant') {
      const content = (message.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content))
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'text' && typeof block.text === 'string')
            this.emit('text', block.text.slice(0, 12000));
          if (block.type === 'tool_use')
            this.emit('tool', `工具调用：${String(block.name).slice(0, 80)}`);
          // Never expose raw thinking, tool arguments or full file bodies by default.
        }
    } else if (message.type === 'result') {
      if (this.summary.resultReceived) throw new Error('duplicate result');
      this.summary.resultReceived = true;
      this.summary.success = message.subtype === 'success' && message.is_error !== true;
      this.summary.text = typeof message.result === 'string' ? message.result.slice(0, 20000) : '';
      if (typeof message.session_id === 'string')
        this.summary.sessionId = message.session_id.slice(0, 200);
      if (Array.isArray(message.permission_denials))
        this.summary.denials = Math.max(this.summary.denials, message.permission_denials.length);
      if (typeof message.total_cost_usd === 'number' && Number.isFinite(message.total_cost_usd))
        this.emit('usage', `工具报告的估算费用：USD ${message.total_cost_usd}。不是实际账单。`);
      if (!this.summary.success)
        this.emit(
          'warning',
          `执行未正常完成：${String(message.subtype ?? 'unknown').slice(0, 100)}`,
        );
    }
    // Unknown well-formed events are ignored. The required result is still checked at exit.
  }
}
/** Best-effort known-secret redaction, not a general DLP or filesystem sandbox. */
export function redact(text: string, secrets: string[] = []): string {
  let clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const value of secrets) if (value.length >= 8) clean = clean.split(value).join('[REDACTED]');
  return clean
    .replace(/\b(sk-(?:ant-)?[a-zA-Z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]');
}
