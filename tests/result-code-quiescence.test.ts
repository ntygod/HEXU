import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { assertCodeQuiescent } from '../apps/runner/src/agent/result-code.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';

/** A real second process holds the transaction before this synchronous reader
 * runs, then releases it independently of the blocked parent's event loop. */
async function duringShortTransaction(path: string, check: () => void) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA busy_timeout=5000; BEGIN EXCLUSIVE');
       console.log('LOCKED');
       process.stdin.once('data', () => setTimeout(() => {
         db.exec('COMMIT'); db.close(); process.stdin.destroy();
       }, 250));`,
      path,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exit = once(child, 'exit');
  try {
    const [signal] = await once(child.stdout, 'data');
    assert.equal(String(signal).trim(), 'LOCKED');
    child.stdin.write('release shortly\n');
    check();
    assert.deepEqual(await exit, [0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exit;
  }
}

for (const kind of ['registry', 'execution'] as const) {
  for (const active of [false, true]) {
    test(
      `${kind} occupancy read waits for a short real transaction and ${active ? 'still rejects the original writer' : 'does not invent a writer'}`,
      { skip: process.platform !== 'linux' },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), 'hexu-occupancy-transaction-')),
          home = join(directory, 'home'),
          state = join(home, 'node-state'),
          root = join(directory, 'root'),
          originalHome = process.env.HOME;
        await mkdir(home, { mode: 0o700 });
        await mkdir(state, { mode: 0o700 });
        await mkdir(root, { mode: 0o700 });
        process.env.HOME = home;
        let lease: WorkspaceLease | undefined;
        try {
          let path: string;
          if (kind === 'registry') {
            lease = new WorkspaceLease(root, 'owned-test-writer');
            if (!active) lease.release();
            path = join(home, '.hexu', 'workspace-leases', 'registry.sqlite');
          } else {
            path = join(state, 'journal.sqlite');
            const db = new DatabaseSync(path);
            db.exec('CREATE TABLE execution_commands(phase TEXT NOT NULL)');
            db.prepare('INSERT INTO execution_commands VALUES(?)').run(
              active ? 'running' : 'terminal',
            );
            db.close();
            await chmod(path, 0o600);
          }
          const s = statSync(root),
            inspect = () => assertCodeQuiescent(state, root, `${s.dev}:${s.ino}`);
          await duringShortTransaction(path, () => {
            if (active) assert.throws(inspect, { code: 'RESULT_CODE_WRITER_ACTIVE' });
            else assert.doesNotThrow(inspect);
          });
          if (active) assert.throws(inspect, { code: 'RESULT_CODE_WRITER_ACTIVE' });
        } finally {
          lease?.release();
          if (originalHome === undefined) delete process.env.HOME;
          else process.env.HOME = originalHome;
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  }
}
