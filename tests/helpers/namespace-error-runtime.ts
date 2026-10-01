import assert from 'node:assert/strict';
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Each test owns a separate runtime and helper binary. Never replace the shared
 * dist helper or add a production override just to inject a namespace failure. */
export async function namespaceErrorRuntime(
  dir: string,
  helper: 'integration-change' | 'restore-publish',
  after: boolean,
  error: 'EIO' | 'EEXIST' = 'EIO',
) {
  const runtime = join(dir, 'disposable-runtime');
  await mkdir(runtime);
  await cp(resolve('dist/apps'), join(runtime, 'apps'), { recursive: true });
  await cp(resolve('dist/packages'), join(runtime, 'packages'), { recursive: true });
  await writeFile(join(runtime, 'package.json'), '{"type":"module"}\n');
  await symlink(resolve('node_modules'), join(runtime, 'node_modules'), 'dir');
  const build = spawnSync(
    'cc',
    [
      '-Wall',
      '-Wextra',
      '-Werror',
      `-DHEXU_FIXTURE_AFTER=${after ? 1 : 0}`,
      `-DHEXU_FIXTURE_ERRNO=${error}`,
      resolve(`apps/runner/src/native/${helper}.c`),
      resolve('tests/fixtures/namespace-rename-error.c'),
      '-o',
      join(runtime, 'apps/runner/src/native', helper),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(build.status, 0, build.stderr);
  return {
    runtime,
    async run(cli: string, args: string[], input = '') {
      const child = spawn(process.execPath, [join(runtime, 'apps/runner/src', cli), ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (bytes) => {
        stdout += bytes;
      });
      child.stderr.on('data', (bytes) => {
        stderr += bytes;
      });
      const finished = new Promise<{ code: number | null; signal: string | null }>((res, rej) => {
        child.once('error', rej);
        child.once('close', (code, signal) => res({ code, signal }));
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      child.stdin.end(input);
      try {
        return { ...(await finished), stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
