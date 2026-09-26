/** Protocol fixture only. NOT Claude Code; never calls a model or external service. */
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('Claude Code protocol fixture (not a real installation)');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(
    '--bare --restricted --tools --permission-mode --max-turns --max-budget-usd --strict-mcp-config --no-session-persistence --session-id --resume',
  );
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const resume = args.includes('--resume');
const retained = resume || args.includes('--session-id');
const sessionId = retained
  ? args[args.indexOf(resume ? '--resume' : '--session-id') + 1]!
  : 'fixture-session';
function emit(value: Record<string, unknown>) {
  console.log(JSON.stringify({ session_id: sessionId, ...value }));
}
// Test-only bounded natural completion; never invokes a model.
// Only current-round markers control this fixture; historical excerpts are data.
const scenario = input.includes('# 本次要求\n') ? input.split('# 本次要求\n').at(-1)! : input;
let memory = 'private-history-must-not-show';
let transcript: string | undefined;
if (retained) {
  if (
    !process.env.CLAUDE_CONFIG_DIR ||
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME !== 'work' ||
    args.includes('--no-session-persistence')
  )
    throw new Error('Fixture expected private retained state');
  const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'work');
  transcript = join(project, `${sessionId}.jsonl`);
  if (resume && (!existsSync(transcript) || scenario.includes('CLAUDE_RESUME_DENIED'))) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true });
    process.exit(1);
  }
  if (resume) memory = JSON.parse(readFileSync(transcript, 'utf8').trim().split('\n')[0]!).memory;
  else mkdirSync(project, { recursive: true, mode: 0o700 });
  appendFileSync(
    join(process.env.HOME!, 'fixture-invocations.txt'),
    (resume ? '--resume' : '--session-id') + '\n',
    { mode: 0o600 },
  );
}
emit({
  type: 'system',
  subtype: 'init',
  session_id: scenario.includes('CLAUDE_WRONG_INIT') ? 'wrong-session' : sessionId,
  cwd: scenario.includes('CLAUDE_WRONG_CWD') ? '/not-the-workspace' : process.cwd(),
  model: scenario.includes('CLAUDE_WRONG_MODEL')
    ? 'unexpected-model'
    : args.includes('--model')
      ? args[args.indexOf('--model') + 1]
      : 'fixture-claude-model',
  permissionMode: 'dontAsk',
  tools: (args[args.indexOf('--tools') + 1] ?? '').split(','),
  mcp_servers: [],
});
if (scenario.includes('FIXTURE_CAPTURE_INPUT'))
  writeFileSync('received-context.txt', input, 'utf8');
if (scenario.includes('FIXTURE_DELAY')) await new Promise((resolve) => setTimeout(resolve, 800));
if (scenario.includes('FIXTURE_HANG')) {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture waiting' }] } });
  setInterval(() => {}, 1000);
} else if (scenario.includes('FIXTURE_INVALID')) console.log('not json');
else if (scenario.includes('FIXTURE_NO_RESULT')) {
  emit({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'not a success signal' }] },
  });
} else if (scenario.includes('FIXTURE_FAILURE')) {
  emit({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'fixture refused' });
  process.exitCode = 1;
} else {
  const tools = args[args.indexOf('--tools') + 1] ?? '';
  if (tools.includes('Write') && scenario.includes('FIXTURE_WRITE'))
    writeFileSync('native-output.txt', 'fixture edit\n', 'utf8');
  emit({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'private thought' },
        { type: 'tool_use', name: 'Read', input: { secret: 'hidden arguments' } },
        { type: 'text', text: 'fixture analysis' },
      ],
    },
  });
  if (transcript && !scenario.includes('CLAUDE_NO_TRANSCRIPT'))
    appendFileSync(transcript, JSON.stringify({ sessionId, memory, prompt: input }) + '\n', {
      mode: 0o600,
    });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: scenario.includes('CLAUDE_WRONG_RESULT') ? 'wrong-session' : sessionId,
    result:
      (resume && scenario.includes('SESSION_RECALL')
        ? 'restored-private-memory=true '
        : 'fixture response ') + (process.env.ANTHROPIC_API_KEY ?? ''),
    total_cost_usd: 0.001,
  });
}
