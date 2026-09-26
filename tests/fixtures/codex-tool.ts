/** Test-only App Server protocol fixture. Never connects to any model or provider. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex protocol fixture (not a real installation)');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('app-server --listen --config');
  process.exit(0);
}
const rl = createInterface({ input: process.stdin });
let initialized = false,
  ready = false,
  root = '',
  prompt = '',
  key = '';
let hang: ReturnType<typeof setInterval> | undefined;
let threadId = 'fixture-thread',
  turnId = 'fixture-turn';
let retained = false;
const stateFile = join(process.env.CODEX_HOME ?? '', 'fixture-provider-state.json');
let memory = '';
const saveState = () => writeFileSync(stateFile, JSON.stringify({ threadId, root, memory }));
const send = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');
const note = (method: string, params: unknown) => send({ method, params });
function completed(status = 'completed') {
  note('turn/completed', {
    threadId,
    turn: {
      id: turnId,
      status,
      error: status === 'failed' ? { message: 'fixture failure' } : null,
    },
  });
}
rl.on('line', (line) => {
  const request = JSON.parse(line);
  const { id, method, params: p } = request;
  const result = (v: unknown) => send({ id, result: v });
  if (method === 'initialize') {
    if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)
      throw new Error('Fixture forbids inherited provider credentials');
    if (
      !process.env.HOME?.includes('hexu-codex-') ||
      !(
        process.env.CODEX_HOME === process.env.HOME ||
        process.env.CODEX_HOME?.includes('/codex-sessions/')
      )
    )
      throw new Error('Codex must use an isolated home');
    initialized = true;
    result({ userAgent: 'fixture' });
  } else if (method === 'initialized') {
    ready = true;
  } else if (!initialized || !ready) {
    send({ id, error: { code: -32002, message: 'handshake required' } });
  } else if (method === 'config/read')
    result({
      config: {
        features: {
          shell_tool: false,
          unified_exec: false,
          goals: false,
          memories: false,
          proactivity: false,
        },
        approval_policy: 'never',
        web_search: 'disabled',
        cli_auth_credentials_store: 'ephemeral',
        mcp_servers: {},
        hooks: { PreToolUse: [], SessionStart: [], Stop: [] },
        projects: { [p.cwd]: { trust_level: 'untrusted' } },
        plugins: {},
      },
    });
  else if (method === 'account/login/start') {
    key = p.apiKey;
    result({ type: 'apiKey' });
  } else if (method === 'model/list')
    result({
      data: [
        {
          id: 'fixture-model',
          model: 'fixture-model',
          displayName: '测试模型（非真实模型）',
          isDefault: true,
        },
      ],
      nextCursor: null,
    });
  else if (method === 'thread/start') {
    root = p.cwd;
    retained = p.ephemeral === false;
    if (retained) {
      threadId = randomUUID();
      memory = randomUUID();
      saveState();
    }
    result({
      thread: { id: threadId, ephemeral: !retained },
      model: p.model ?? 'fixture-model',
      cwd: root,
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly' },
    });
  } else if (method === 'thread/read' || method === 'thread/resume') {
    if (!existsSync(stateFile)) {
      send({ id, error: { code: -32000, message: 'fixture retained thread missing' } });
      return;
    }
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (saved.threadId !== p.threadId || saved.failResume) {
      send({ id, error: { code: -32000, message: 'fixture thread unavailable' } });
      return;
    }
    threadId = saved.threadId;
    root = saved.root;
    memory = saved.memory;
    retained = true;
    appendFileSync(join(process.env.CODEX_HOME!, 'fixture-resume-methods.txt'), method + '\n');
    result({
      thread: {
        id: saved.wrongId ? 'wrong-session' : threadId,
        cwd: root,
        ephemeral: false,
        status: { type: 'notLoaded' },
        turns: [{ hidden: 'private-history-must-not-show' }],
      },
      model: p.model ?? 'fixture-model',
      cwd: root,
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly' },
    });
  } else if (method === 'turn/start') {
    prompt = p.input[0].text;
    if (retained) {
      turnId = randomUUID();
      saveState();
    }
    if (prompt.includes('CODEX_BAD_JSON')) {
      console.log('bad json');
      return;
    }
    // Deliberately send foreign events and valid events before the turn/start response.
    note('item/completed', {
      threadId: 'wrong-thread',
      turnId,
      item: { id: 'wrong', type: 'agentMessage', text: 'foreign-secret-must-not-show' },
    });
    note('item/completed', {
      threadId,
      turnId,
      item: { id: 'reasoning', type: 'reasoning', text: 'private-chain-must-not-show' },
    });
    result({ turn: { id: turnId, status: 'inProgress', items: [], error: null } });
    if (prompt.includes('CODEX_HANG')) {
      hang = setInterval(() => {}, 1000);
      return;
    }
    if (prompt.includes('CODEX_NO_RESULT')) {
      process.exit(0);
    }
    if (prompt.includes('CODEX_DENIAL')) {
      send({
        id: 701,
        method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, itemId: 'command', command: 'never execute this' },
      });
      return;
    }
    if (p.sandboxPolicy.type === 'workspaceWrite' && prompt.includes('CODEX_WRITE')) {
      const previous = existsSync(join(root, 'native-output.txt'))
        ? readFileSync(join(root, 'native-output.txt'), 'utf8')
        : '';
      writeFileSync(join(root, 'codex-output.txt'), `fixture continued\n${previous}`);
      appendFileSync(join(root, 'codex-count.txt'), 'one invocation\n');
    }
    note('item/completed', {
      threadId,
      turnId,
      item: {
        id: 'answer',
        type: 'agentMessage',
        text: `Codex fixture result ${key}${retained && prompt.split('# 本次要求').at(-1)?.includes('SESSION_RECALL') ? ' restored=' + memory : ''}`,
      },
    });
    note('item/completed', {
      threadId,
      turnId,
      item: { id: 'answer', type: 'agentMessage', text: 'duplicate-item-must-not-show' },
    });
    note('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: { last: { totalTokens: 42 } },
    });
    completed(prompt.includes('CODEX_FAILURE') ? 'failed' : 'completed');
  } else if (method === 'turn/interrupt') {
    result({});
    if (hang) clearInterval(hang);
    completed('interrupted');
  } else if (id === 701 && !method) {
    if (request.result?.decision !== 'decline')
      throw new Error('fixture approval must be declined');
    note('item/completed', {
      threadId,
      turnId,
      item: { id: 'denied', type: 'agentMessage', text: 'fixture permission declined' },
    });
    completed();
  } else send({ id, error: { code: -32601, message: 'unknown fixture method' } });
});
rl.on('close', () => {
  if (hang) clearInterval(hang);
  process.exit(0);
});
