/** Optional no-model smoke check against an explicitly supplied official Codex installation.
 * Does NOT authenticate, load user credentials, start a turn, or call a model. */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexSession, codexArguments } from '../dist/packages/adapters/codex/src/index.js';
import { runProcess } from '../dist/apps/runner/src/process-host.js';
const executable = process.argv[2];
if (!executable || !isAbsolute(executable))
  throw new Error(
    'Usage: node scripts/check-codex-protocol.mjs /absolute/path/to/codex (build first)',
  );
const home = await mkdtemp(join(tmpdir(), 'hexu-codex-protocol-'));
const root = join(home, 'repo.with.dot');
await mkdir(root);
execFileSync('git', ['init', '-q', root]);
await mkdir(join(root, '.codex'));
await writeFile(
  join(root, '.codex/config.toml'),
  '[features]\nshell_tool = true\nunified_exec = true\n',
);
let handle;
let timer;
const session = new CodexSession(
  (line) => handle.send(line),
  () => {},
  () => {},
  () => {},
);
handle = runProcess({
  executable,
  args: codexArguments(root),
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, LANG: 'C.UTF-8' },
  keepInputOpen: true,
  timeoutMs: 15000,
  onLine: (line) => session.line(line),
});
try {
  await session.initialize();
  await session.checkConfiguration(root, true);
  const missingId = randomUUID();
  // Only nonexistent-thread metadata methods. Never authenticate or issue turn/start.
  for (const method of ['thread/read', 'thread/resume']) {
    await assert.rejects(
      session.request(method, {
        threadId: missingId,
        ...(method === 'thread/read'
          ? { includeTurns: false }
          : { cwd: root, approvalPolicy: 'never', sandbox: 'read-only' }),
      }),
      (e) =>
        e instanceof Error &&
        /thread|rollout|session/i.test(e.message) &&
        !/not found method|method not found|unknown method|timeout|超时|not authenticated|unauthorized/i.test(
          e.message,
        ),
    );
  }
  console.log(
    'PASS: official initialize + retained config/read + missing-thread read/resume rejection; no turn/start.',
  );
  console.log('No account authentication or model generation was performed.');
} finally {
  session.dispose();
  handle.endInput();
  timer = setTimeout(() => handle.stop(), 500);
  const outcome = await handle.done;
  clearTimeout(timer);
  if (outcome.terminationConfirmed) await rm(home, { recursive: true, force: true });
  if (outcome.error || !outcome.terminationConfirmed)
    throw new Error(outcome.error ?? 'CLI did not stop');
}
