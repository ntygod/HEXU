/** Protocol fixture only. NOT Claude Code; never calls a model or external service. */
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('Claude Code protocol fixture (not a real installation)');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(
    '--bare --restricted --tools --permission-mode --max-turns --max-budget-usd --strict-mcp-config',
  );
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
function emit(value: unknown) {
  console.log(JSON.stringify(value));
}
emit({ type: 'system', subtype: 'init', session_id: 'fixture-session' });
// Test-only bounded natural completion; never invokes a model.
if (input.includes('FIXTURE_DELAY')) await new Promise((resolve) => setTimeout(resolve, 800));
if (input.includes('FIXTURE_HANG')) {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'fixture waiting' }] } });
  setInterval(() => {}, 1000);
} else if (input.includes('FIXTURE_INVALID')) console.log('not json');
else if (input.includes('FIXTURE_NO_RESULT')) {
  emit({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'not a success signal' }] },
  });
} else if (input.includes('FIXTURE_FAILURE')) {
  emit({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'fixture refused' });
  process.exitCode = 1;
} else {
  const tools = args[args.indexOf('--tools') + 1] ?? '';
  if (tools.includes('Write') && input.includes('FIXTURE_WRITE'))
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
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'fixture-session',
    result: 'fixture response ' + (process.env.ANTHROPIC_API_KEY ?? ''),
    total_cost_usd: 0.001,
  });
}
