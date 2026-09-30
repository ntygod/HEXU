import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closePreservationFixture } from './helpers/branch-preservation-cleanup.js';

test('保留测试清理只删除本夹具claim，SQLite持续占写时仍失败并关闭服务而不挂住整套检查', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hexu-preservation-cleanup-'));
  const path = join(dir, 'registry.sqlite'),
    blocker = new DatabaseSync(path);
  const server = createServer((_req, res) => res.end('fixture'));
  const close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  const fixture = { view: { request: { id: 'own' } }, close };
  try {
    blocker.exec(`CREATE TABLE claims(dispatch_id TEXT PRIMARY KEY);
      INSERT INTO claims VALUES('branch-preserve:own'),('branch-preserve:other');`);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    blocker.exec('BEGIN IMMEDIATE');
    try {
      await assert.rejects(
        closePreservationFixture(fixture, path),
        (error: unknown) =>
          error instanceof Error && (error as Error & { errcode: number }).errcode === 5,
      );
      assert.equal(server.listening, false, 'busy cleanup must not skip the HTTP close');
      assert.equal(blocker.prepare('SELECT COUNT(*) AS n FROM claims').get()!.n, 2);
    } finally {
      blocker.exec('ROLLBACK');
    }
    // A later explicit fixture cleanup only removes the original test's row.
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await closePreservationFixture(fixture, path);
    assert.deepEqual(
      blocker
        .prepare('SELECT dispatch_id FROM claims')
        .all()
        .map((r) => r.dispatch_id),
      ['branch-preserve:other'],
    );
    assert.equal(server.listening, false);
  } finally {
    if (server.listening) await close();
    blocker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
