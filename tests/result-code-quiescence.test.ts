import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type ReadResult = { code: string | null; sqliteCode?: number; message?: string; elapsedMs: number };

/** A separate reader HOME contains only this fixture's registry. Never change
 * the parent/test suite HOME or read, release, or replace a real workspace claim. */
async function contendedRead(kind: 'registry' | 'journal', overlap = true, release = true) {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-quiescence-')),
    home = join(dir, 'reader-home'),
    state = join(dir, 'node-state'),
    root = join(dir, 'workspace');
  for (const path of [home, state, root]) mkdirSync(path, { mode: 0o700 });
  const s = statSync(root),
    identity = `${s.dev}:${s.ino}`;
  const registry = join(home, '.hexu', 'workspace-leases');
  mkdirSync(registry, { recursive: true, mode: 0o700 });
  const path =
    kind === 'registry' ? join(registry, 'registry.sqlite') : join(state, 'journal.sqlite');
  writeFileSync(path, '', { mode: 0o600 });
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  writer.exec(
    kind === 'registry'
      ? 'CREATE TABLE claims(root TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL,identity TEXT NOT NULL)'
      : 'CREATE TABLE execution_commands(phase TEXT NOT NULL)',
  );
  writer.exec('BEGIN EXCLUSIVE');
  if (kind === 'registry')
    writer
      .prepare('INSERT INTO claims VALUES(?,?,?)')
      .run(
        overlap ? root : join(dir, 'unrelated-workspace'),
        'fixture-held-claim',
        overlap ? identity : '0:0',
      );
  else writer.prepare('INSERT INTO execution_commands VALUES(?)').run('unknown');

  let locked = true,
    timer: ReturnType<typeof setTimeout> | undefined;
  const commit = () => {
    if (locked) {
      writer.exec('COMMIT');
      locked = false;
    }
  };
  const module = new URL('../apps/runner/src/agent/result-code.js', import.meta.url).href;
  const reader = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { assertCodeQuiescent } from ${JSON.stringify(module)};
    process.send({reading:true});
    const started=Date.now();
    let result;
    try { assertCodeQuiescent(${JSON.stringify(state)},${JSON.stringify(root)},${JSON.stringify(identity)}); result={code:null}; }
    catch (e) { result={code:e.code,sqliteCode:e.errcode,message:e.message}; }
    process.send({...result,elapsedMs:Date.now()-started});
    process.disconnect();
  `,
    ],
    { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let result: ReadResult | undefined,
    stderr = '';
  reader.stderr!.on('data', (bytes) => {
    stderr += bytes;
  });
  reader.on('message', (message: ReadResult & { reading?: boolean }) => {
    if (message.reading) {
      // The writer commits independently while DatabaseSync blocks the reader.
      if (release) timer = setTimeout(commit, 200);
    } else result = message;
  });
  const watchdog = setTimeout(() => reader.kill('SIGKILL'), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      reader.once('error', reject);
      reader.once('exit', resolve);
    });
    assert.equal(code, 0, stderr);
    assert(result, 'reader did not return a quiescence result');
    if (release) {
      // Before the fix, the read fails SQLITE_BUSY before this COMMIT.
      assert.equal(locked, false, JSON.stringify(result));
    }
    commit();
    const table = kind === 'registry' ? 'claims' : 'execution_commands';
    const rows = writer.prepare(`SELECT * FROM ${table}`).all();
    assert.equal(rows.length, 1, 'reader must preserve the original claim/evidence');
    if (kind === 'registry') assert.equal(rows[0]!.dispatch_id, 'fixture-held-claim');
    else assert.equal(rows[0]!.phase, 'unknown');
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(watchdog);
    if (reader.exitCode === null && reader.signalCode === null) reader.kill('SIGKILL');
    commit();
    writer.close();
    assert(dir.startsWith(join(tmpdir(), 'hexu-quiescence-')));
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const kind of ['registry', 'journal'] as const)
  test(
    `${kind}短独占事务结束后仍按当前占用拒绝，只读检查保留证据`,
    { skip: process.platform !== 'linux' },
    async () => {
      const result = await contendedRead(kind);
      assert.equal(result.code, 'RESULT_CODE_WRITER_ACTIVE', JSON.stringify(result));
    },
  );

test(
  '无关工作区的短事务不会阻止读取空闲目标，也不会清除原占用',
  { skip: process.platform !== 'linux' },
  async () => {
    const result = await contendedRead('registry', false);
    assert.equal(result.code, null, JSON.stringify(result));
  },
);

test(
  '持续独占锁超过有界等待时仍拒绝检查，不将读取失败当空闲',
  { skip: process.platform !== 'linux' },
  async () => {
    const result = await contendedRead('registry', true, false);
    assert.equal(result.code, 'ERR_SQLITE_ERROR', JSON.stringify(result));
    assert.equal(result.sqliteCode, 5, JSON.stringify(result));
    assert(result.elapsedMs >= 4000, JSON.stringify(result));
  },
);
