/** Explicit protocol fixture only: no provider/network calls and no project file access. */
import assert from 'node:assert/strict';
import { appendFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { requiredFlags } from '../../packages/adapters/claude-code/src/index.js';
export async function textFixture(capture: string) {
  if (process.argv.includes('--version')) {
    console.log('hexu-text-protocol-fixture 1');
    return;
  }
  if (process.argv.includes('--help')) {
    console.log([...requiredFlags, '--disallowedTools', '--system-prompt', '--settings'].join(' '));
    return;
  }
  const args = process.argv.slice(2),
    option = (flag: string) => args[args.indexOf(flag) + 1]!;
  for (const flag of requiredFlags) assert.ok(args.includes(flag), flag);
  assert.equal(option('--tools'), '');
  assert.equal(option('--disallowedTools'), '*');
  assert.equal(option('--permission-mode'), 'dontAsk');
  assert.deepEqual(JSON.parse(option('--mcp-config')), { mcpServers: {} });
  assert.deepEqual(JSON.parse(option('--settings')), {
    permissions: { deny: ['*'] },
    disableAllHooks: true,
  });
  for (const flag of ['--resume', '--session-id', '--continue', '--add-dir', '--allowedTools'])
    assert.ok(!args.includes(flag));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  appendFileSync(
    capture,
    JSON.stringify({
      input,
      args,
      cwd: process.cwd(),
      home: process.env.HOME,
      files: readdirSync(process.cwd()),
      envNames: Object.keys(process.env),
    }) + '\n',
  );
  const session_id = randomUUID(),
    model = 'explicit-text-fixture-not-a-model';
  const emit = (m: unknown) => console.log(JSON.stringify(m));
  emit({
    type: 'system',
    subtype: 'init',
    session_id,
    model,
    cwd: process.cwd(),
    permissionMode: 'dontAsk',
    tools: input.includes('TOOLS_ENABLED') ? ['Read'] : [],
    mcp_servers: [],
  });
  if (input.includes('TOOL_USE')) {
    emit({
      type: 'assistant',
      session_id,
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'never executed' } }],
      },
    });
    return;
  }
  if (input.includes('PERMISSION_DENIED'))
    emit({ type: 'system', subtype: 'permission_denied', session_id });
  if (input.includes('NO_RESULT')) return;
  if (input.includes('WRONG_SESSION')) {
    emit({ type: 'result', session_id: 'foreign', subtype: 'success', result: 'wrong' });
    return;
  }
  if (input.includes('HANG_TEXT')) {
    await new Promise(() => setInterval(() => {}, 1000));
    return;
  }
  if (input.includes('SLOW_TEXT')) await new Promise((r) => setTimeout(r, 300));
  emit({
    type: 'assistant',
    session_id,
    message: { content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING_NOT_SHARED' }] },
  });
  const result = input.includes('LEAK_KEY')
    ? `建议 ${process.env.ANTHROPIC_API_KEY} ${process.cwd()}`
    : '协议替身建议：核对超时条件；没有读取代码或执行命令。';
  emit({
    type: 'result',
    session_id,
    subtype: input.includes('FAIL_TEXT') ? 'error_during_execution' : 'success',
    result,
    ...(input.includes('RESULT_DENIAL') ? { permission_denials: [{ tool_name: 'Read' }] } : {}),
  });
}
