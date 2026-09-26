import { rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Only this fixed, disposable fixture directory is cleared; never the user's preview data.
const path = resolve('.hexu/e2e');
rmSync(path, { recursive: true, force: true });
const repo = join(path, 'repo');
mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', repo]);
writeFileSync(join(repo, 'README.md'), 'Browser protocol fixture, not a real project.\n');
execFileSync('git', ['-C', repo, 'add', 'README.md']);
execFileSync('git', [
  '-C',
  repo,
  '-c',
  'user.name=Fixture',
  '-c',
  'user.email=fixture@example.invalid',
  'commit',
  '-qm',
  'fixture',
]);
const executable = join(path, 'claude-fixture');
writeFileSync(
  executable,
  `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/native-tool.js')).href)});\n`,
);
chmodSync(executable, 0o700);
const codexExecutable = join(path, 'codex-fixture');
writeFileSync(
  codexExecutable,
  `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/codex-tool.js')).href)});\n`,
);
chmodSync(codexExecutable, 0o700);
process.env.HEXU_CODEX_BIN = codexExecutable;
process.env.OPENAI_API_KEY = 'sk-openai-browser-protocol-fixture-not-a-real-key';
process.env.HEXU_DATA_DIR = path;
process.env.HEXU_HOST = '127.0.0.1';
process.env.HEXU_PORT = '4310';
// Always override inherited native settings: browser tests MUST NOT call real tools or accounts.
process.env.HEXU_NATIVE_ENABLED = '1';
process.env.HEXU_NATIVE_ROOTS = JSON.stringify([repo]);
process.env.HEXU_CLAUDE_BIN = executable;
process.env.ANTHROPIC_API_KEY = 'sk-ant-browser-protocol-fixture-not-a-real-key';
// Independent real-auth browser fixture, no model/provider settings inherited.
const { createApp } = await import('../dist/apps/control/src/app.js');
const teamApp = await createApp({
  port: 4311,
  databasePath: join(path, 'team-workspace.sqlite'),
  identity: {
    databasePath: join(path, 'team-identity.sqlite'),
    secret: 'fictional-browser-auth-secret-not-real-0123456789',
    setupCode: 'fictional-browser-setup-code-not-real-0123456789',
    baseURL: 'http://127.0.0.1:4311',
    trustedOrigins: ['http://127.0.0.1:4311'],
  },
});
await teamApp.listen({ host: '127.0.0.1', port: 4311 });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void teamApp.close();
  });
process.env.HEXU_MODE = 'preview';
await import('../dist/apps/control/src/main.js');
