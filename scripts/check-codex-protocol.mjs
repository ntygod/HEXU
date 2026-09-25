/** Optional no-model smoke check against an explicitly supplied official Codex installation.
 * Does NOT authenticate, load user credentials, start a turn, or call a model. */
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  await session.checkConfiguration(root);
  console.log(
    'PASS: official initialize + config/read; empty hooks; exact untrusted dotted directory; project overrides ignored.',
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
