/** Official CLI no-model check: isolated version/help + nonexistent UUID rejection.
 * No authentication, provider key, personal HOME or generated transcript is used. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess } from '../dist/apps/runner/src/process-host.js';
import {
  claudeArguments,
  claudeCapabilities,
} from '../dist/packages/adapters/claude-code/src/index.js';
const executable = process.argv[2];
if (!executable || !isAbsolute(executable))
  throw new Error('Usage: npm run check:claude-protocol -- /absolute/path/to/claude');
const home = await mkdtemp(join(tmpdir(), 'hexu-claude-protocol-'));
let safeToRemove = true;
const invoke = async (args, input = '') => {
  let output = '';
  const handle = runProcess({
    executable,
    args,
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, 'config'),
      CLAUDE_CODE_PROJECT_DIR_NAME: 'work',
      LANG: 'C.UTF-8',
    },
    input,
    timeoutMs: 15000,
    maxOutputBytes: 262144,
    onLine: (line) => {
      output += line + '\n';
    },
  });
  const outcome = await handle.done;
  safeToRemove &&= outcome.terminationConfirmed;
  assert.equal(outcome.terminationConfirmed, true, 'CLI must terminate');
  return { outcome, output };
};
try {
  const version = await invoke(['--version']),
    help = await invoke(['--help']);
  assert.equal(version.outcome.code, 0);
  assert.equal(help.outcome.code, 0);
  assert.ok(
    claudeCapabilities(version.output.trim(), help.output, true),
    'Required restricted/session capabilities not recognized',
  );
  const sessionId = randomUUID();
  const config = { mode: 'read-only', model: null, maxTurns: 1, maxBudgetUsd: 0.01 };
  const missing = await invoke(
    claudeArguments(config, { sessionId, action: 'resumed' }),
    'No-model missing-session compatibility check.',
  );
  assert.equal(missing.outcome.code, 1);
  const events = missing.output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1, 'No init, assistant or model turn may be emitted');
  const result = events[0];
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, true);
  assert.equal(result.session_id, sessionId);
  assert.equal(result.num_turns, 0);
  assert.equal(result.duration_api_ms, 0);
  assert.equal(result.total_cost_usd, 0);
  assert.ok(result.errors?.some((text) => text.includes('No conversation found with session ID:')));
  console.log(
    'PASS:',
    version.output.trim(),
    'isolated version/help + missing-session rejection; zero turns/API duration/cost reported.',
  );
  console.log(
    'No provider key, account authentication or real model generation. Successful history restoration remains a separate check.',
  );
} finally {
  if (safeToRemove) await rm(home, { recursive: true, force: true });
}
