import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  AgentStorage,
  writeCredentials,
  type NodeCredentials,
} from '../apps/runner/src/agent/storage.js';
import { restoreBinding } from '../apps/runner/src/agent/checkpoint-restore-preflight.js';
import { type LocalApplication } from '../apps/runner/src/agent/integration-application.js';
import { readIntegrationApplicationStatus } from '../apps/runner/src/agent/integration-application-status.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { type IntegrationApplicationReport } from '../packages/contracts/src/integrations.js';

const cli = fileURLToPath(
  new URL('../apps/runner/src/integration-application-status.js', import.meta.url),
);
const observedAt = '2026-09-29T12:00:00.000Z';
const added = {
  path: 'added.txt',
  kind: 'file' as const,
  objectId: 'a'.repeat(40),
  gitMode: '100644' as const,
  bytes: 17,
  identity: '123:456',
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-integration-status-')),
    home = join(dir, 'node'),
    root = join(dir, 'target'),
    journalHome = join(home, 'integration-application'),
    database = join(journalHome, 'journal.sqlite');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(root);
  const credentials: NodeCredentials = {
    version: 1,
    controlUrl: 'http://127.0.0.1:1',
    clientId: 'fixture-client',
    nodeToken: 'S'.repeat(43),
    name: 'PRIVATE_CREDENTIAL_LABEL\n\u001b[31m',
    projectId: 'fixture-project',
    spaceId: 'fixture-space',
    nodeId: 'fixture-node',
    directories: [
      {
        id: 'fixture-workspace',
        name: 'LOCAL_ONLY_NAME',
        root,
        rootIdentity: `${lstatSync(root).dev}:${lstatSync(root).ino}`,
        gitDir: join(root, '.git'),
        gitIdentity: '1:2',
      },
    ],
  };
  writeCredentials(home, credentials);
  const storage = new AgentStorage(journalHome);
  storage.db.exec('CREATE TABLE applications(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const base: LocalApplication = {
    binding: restoreBinding(credentials),
    integrationId: 'fixture-integration',
    applicationId: 'fixture-application',
    inputHash: 'b'.repeat(64),
    root,
    phase: 'prepared',
    added: [],
    intent: null,
    pending: null,
    acknowledged: 0,
  };
  const save = (value: unknown) =>
    storage.db
      .prepare(
        'INSERT INTO applications VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      )
      .run(base.integrationId, typeof value === 'string' ? value : JSON.stringify(value));
  save(base);
  return {
    dir,
    home,
    root,
    database,
    journalHome,
    credentials,
    storage,
    base,
    save,
    read: () => readIntegrationApplicationStatus(home, base.integrationId),
    close: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function packet(
  record: LocalApplication,
  stage: IntegrationApplicationReport['stage'],
  sequence: 1 | 2,
): IntegrationApplicationReport {
  return {
    integrationId: record.integrationId,
    applicationId: record.applicationId,
    inputHash: record.inputHash,
    stage,
    sequence,
    observedAt,
    appliedPaths: record.added.map((entry) => entry.path),
    reason: stage === 'applying' || stage === 'completed' ? null : 'interrupted',
    confirmPublication: true,
  };
}

function snapshot(path: string): unknown {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path, { bigint: true });
  return {
    mode: `${stat.mode}`,
    identity: `${stat.dev}:${stat.ino}`,
    mtime: `${stat.mtimeNs}`,
    content: stat.isDirectory()
      ? Object.fromEntries(
          readdirSync(path)
            .sort()
            .map((name) => [name, snapshot(join(path, name))]),
        )
      : readFileSync(path).toString('base64'),
  };
}

const code = (expected: string) => (cause: unknown) =>
  !!cause && typeof cause === 'object' && 'code' in cause && cause.code === expected;

test(
  '只读状态保留所有合法历史阶段和ACK窗口，不修改日志、进程守卫或工作区锁',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture(),
      lease = new WorkspaceLease(f.root, `integration:${f.base.applicationId}`);
    try {
      const records: LocalApplication[] = [
        f.base,
        { ...f.base, pending: packet(f.base, 'applying', 1) },
        { ...f.base, acknowledged: 1 },
        { ...f.base, phase: 'applying', acknowledged: 1, intent: 'unconfirmed.txt' },
        { ...f.base, phase: 'applying', acknowledged: 1, added: [added], intent: 'next.txt' },
        { ...f.base, phase: 'failed' },
        { ...f.base, phase: 'failed', pending: packet(f.base, 'failed', 1) },
        { ...f.base, phase: 'failed', acknowledged: 1 },
        { ...f.base, phase: 'failed', acknowledged: 1, pending: packet(f.base, 'failed', 2) },
        { ...f.base, phase: 'failed', acknowledged: 2 },
        { ...f.base, phase: 'completed', added: [added], acknowledged: 2 },
        { ...f.base, phase: 'needs_attention', acknowledged: 2 },
        {
          ...f.base,
          phase: 'needs_attention',
          acknowledged: 2,
          added: [added],
          intent: 'next.txt',
        },
      ];
      for (const phase of ['completed', 'needs_attention'] as const) {
        const record = { ...f.base, phase, acknowledged: 1, added: [added] };
        records.push({ ...record, pending: packet(record, phase, 2) });
      }
      for (const record of records) {
        f.save(record);
        const before = snapshot(f.dir),
          leaseBefore = snapshot(join(homedir(), '.hexu', 'workspace-leases'));
        const status = f.read();
        assert.equal(status.localPhase, record.phase);
        assert.equal(status.evidence, 'historical_local_journal');
        assert.equal(status.acknowledgedReportSequence, record.acknowledged);
        assert.equal(status.pendingReportSequence, record.pending?.sequence ?? null);
        assert.equal(status.pendingReport?.observedAt ?? null, record.pending?.observedAt ?? null);
        assert.equal(status.intendedUnconfirmedPath, record.intent);
        assert.deepEqual(
          status.confirmedAdded,
          record.added.map(({ kind: _kind, ...entry }) => entry),
        );
        for (const flag of [
          'directoryChecked',
          'currentServerAuthorityChecked',
          'processStoppedConfirmed',
          'writeAuthorized',
        ] as const)
          assert.equal(status[flag], false);
        assert(!('observedAt' in status));
        assert.deepEqual(snapshot(f.dir), before);
        assert.deepEqual(snapshot(join(homedir(), '.hexu', 'workspace-leases')), leaseBefore);
      }
      lease.assertHeld();
      assert.throws(() => new AgentStorage(f.journalHome), code('RUNNER_ALREADY_STARTED'));
    } finally {
      lease.release();
      f.close();
    }
  },
);

test(
  '活动写入事务只返回上次提交快照，不读取未提交阶段或改写守卫',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      f.storage.db.exec('BEGIN IMMEDIATE');
      f.save({ ...f.base, phase: 'applying', acknowledged: 1 });
      const before = snapshot(f.dir);
      assert.equal(f.read().localPhase, 'prepared');
      assert.deepEqual(snapshot(f.dir), before);
      f.storage.db.exec('COMMIT');
      assert.equal(f.read().localPhase, 'applying');
    } finally {
      f.close();
    }
  },
);

test(
  '实际CLI在目录移动、服务离线后只输出安全JSON历史证据，不运行Git或创建锁',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const record: LocalApplication = {
        ...f.base,
        phase: 'needs_attention',
        acknowledged: 1,
        added: [added],
        intent: 'next.txt',
      };
      record.pending = packet(record, 'needs_attention', 2);
      f.save(record);
      renameSync(f.root, `${f.root}-moved`);
      writeFileSync(join(`${f.root}-moved`, 'added.txt'), 'PRIVATE_BODY_BYTES');
      const emptyHome = join(f.dir, 'unused-os-home'),
        before = snapshot(f.dir);
      const result = spawnSync(
        process.execPath,
        [cli, '--operation', f.base.integrationId, '--state', f.home],
        {
          encoding: 'utf8',
          env: { PATH: '', HOME: emptyHome, NODE_NO_WARNINGS: '1' },
          timeout: 5000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split('\n').length, 1);
      const status = JSON.parse(result.stdout);
      assert.equal(status.root, f.root);
      assert.equal(status.localPhase, 'needs_attention');
      assert.equal(status.pendingReport.observedAt, observedAt);
      assert.equal(status.currentServerAuthorityChecked, false);
      for (const secret of [
        f.credentials.nodeToken,
        f.credentials.name,
        record.binding,
        record.inputHash,
        'LOCAL_ONLY_NAME',
        'PRIVATE_BODY_BYTES',
      ])
        assert(!result.stdout.includes(secret));
      assert(!/[\u0000-\u0008\u000b-\u001f]/.test(result.stdout));
      assert.deepEqual(snapshot(f.dir), before);
      assert(!existsSync(emptyHome));
      f.save({ ...record, pending: null, acknowledged: 2 });
      assert.equal(f.read().pendingReport, null); // No mtime-derived observation date after ACK.
    } finally {
      f.close();
    }
  },
);

test(
  '缺少状态、日志、表或应用记录不会初始化任何文件',
  { skip: process.platform === 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'hexu-status-missing-'));
    try {
      const missing = join(dir, 'missing'),
        before = snapshot(dir);
      assert.throws(
        () => readIntegrationApplicationStatus(missing, 'operation'),
        code('INTEGRATION_JOURNAL_NOT_FOUND'),
      );
      assert.deepEqual(snapshot(dir), before);
      const result = spawnSync(
        process.execPath,
        [cli, '--operation', 'operation', '--state', missing],
        { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
      );
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).code, 'INTEGRATION_JOURNAL_NOT_FOUND');
      assert.deepEqual(snapshot(dir), before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const f = fixture();
    try {
      const before = snapshot(f.dir);
      assert.throws(
        () => readIntegrationApplicationStatus(f.home, 'absent'),
        code('INTEGRATION_RECORD_NOT_FOUND'),
      );
      assert.deepEqual(snapshot(f.dir), before);
      for (const path of [f.database, join(f.home, 'credentials.json'), f.journalHome]) {
        renameSync(path, `${path}-missing`);
        const missing = snapshot(f.dir);
        assert.throws(f.read, code('INTEGRATION_JOURNAL_NOT_FOUND'));
        assert.deepEqual(snapshot(f.dir), missing);
        renameSync(`${path}-missing`, path);
      }
      f.storage.db.exec('DROP TABLE applications');
      const noTable = snapshot(f.dir);
      assert.throws(f.read, code('INTEGRATION_JOURNAL_NOT_FOUND'));
      assert.deepEqual(snapshot(f.dir), noTable);
    } finally {
      f.close();
    }
  },
);

test(
  '损坏JSON、未知字段及阶段/ACK/意图/文件/待发报告矛盾均拒绝',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      const malformed: unknown[] = [
        '{broken',
        'null',
        '[]',
        'x'.repeat(524289),
        { ...f.base, extra: 'PRIVATE_BODY' },
        { ...f.base, integrationId: 'other' },
        { ...f.base, phase: 'completed', acknowledged: 2 },
        { ...f.base, phase: 'completed', acknowledged: 1, added: [added] },
        { ...f.base, phase: 'applying' },
        { ...f.base, acknowledged: 2 },
        { ...f.base, added: [added] },
        { ...f.base, intent: 'new.txt' },
        { ...f.base, phase: 'failed', added: [added] },
        { ...f.base, phase: 'needs_attention' },
        { ...f.base, phase: 'applying', acknowledged: 1, added: [added], intent: added.path },
        { ...f.base, phase: 'applying', acknowledged: 1, added: [added, added] },
        {
          ...f.base,
          phase: 'applying',
          acknowledged: 1,
          added: [{ ...added, body: 'PRIVATE_BODY' }],
        },
        { ...f.base, phase: 'applying', acknowledged: 1, added: [{ ...added, path: '../escape' }] },
        {
          ...f.base,
          phase: 'applying',
          acknowledged: 1,
          added: [{ ...added, path: 'control\u001b.txt' }],
        },
        { ...f.base, phase: 'applying', acknowledged: 1, added: [{ ...added, identity: 'guess' }] },
        { ...f.base, pending: { ...packet(f.base, 'applying', 1), integrationId: 'other' } },
        { ...f.base, pending: { ...packet(f.base, 'applying', 1), applicationId: 'other' } },
        { ...f.base, pending: { ...packet(f.base, 'applying', 1), inputHash: 'c'.repeat(64) } },
        { ...f.base, acknowledged: 1, pending: packet(f.base, 'applying', 1) },
        {
          ...f.base,
          phase: 'needs_attention',
          acknowledged: 1,
          added: [added],
          pending: packet(f.base, 'needs_attention', 2),
        },
      ];
      for (const record of malformed) {
        f.save(record);
        const before = snapshot(f.dir);
        assert.throws(
          f.read,
          code('INTEGRATION_JOURNAL_INVALID'),
          JSON.stringify(record).slice(0, 300),
        );
        assert.deepEqual(snapshot(f.dir), before);
      }
    } finally {
      f.close();
    }
  },
);

test(
  '原凭证绑定与目录登记不可替换，拒绝链接或公开状态',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      for (const change of [
        { nodeToken: 'T'.repeat(43) },
        { nodeId: 'other-node' },
        { clientId: 'other-client' },
        { controlUrl: 'http://127.0.0.1:2' },
        { projectId: 'other-project' },
        { directories: [{ ...f.credentials.directories[0]!, root: `${f.root}-other` }] },
      ]) {
        writeCredentials(f.home, { ...f.credentials, ...change });
        assert.throws(f.read, code('INTEGRATION_SCOPE_CHANGED'));
      }
      writeCredentials(f.home, f.credentials);
      f.save({ ...f.base, root: join(f.dir, 'unregistered') });
      assert.throws(f.read, code('INTEGRATION_SCOPE_CHANGED'));
      f.save(f.base);
      const alias = join(f.dir, 'state-alias');
      symlinkSync(f.home, alias);
      assert.throws(
        () => readIntegrationApplicationStatus(alias, f.base.integrationId),
        code('INSECURE_STATE_DIRECTORY'),
      );
      chmodSync(f.database, 0o644);
      assert.throws(f.read, code('INSECURE_STATE_DIRECTORY'));
      chmodSync(f.database, 0o600);
      assert.equal(f.read().localPhase, 'prepared');
    } finally {
      f.close();
    }
  },
);

test(
  '读取后的状态路径/日志/凭证交换必须在输出前失败',
  { skip: process.platform === 'win32' },
  (t) => {
    for (const target of ['home', 'journal', 'credentials', 'binding'] as const) {
      const f = fixture();
      try {
        const prepare = DatabaseSync.prototype.prepare;
        let swapped = false;
        t.mock.method(
          DatabaseSync.prototype,
          'prepare',
          function (this: DatabaseSync, sql: string) {
            const statement = prepare.call(this, sql);
            if (!sql.startsWith('SELECT id, CASE')) return statement;
            const get = statement.get.bind(statement);
            statement.get = ((...args: Parameters<typeof get>) => {
              const result = get(...args);
              if (!swapped) {
                swapped = true;
                if (target === 'home') {
                  renameSync(f.home, `${f.home}-old`);
                  cpSync(`${f.home}-old`, f.home, { recursive: true });
                } else if (target === 'journal') {
                  renameSync(f.database, `${f.database}-old`);
                  copyFileSync(`${f.database}-old`, f.database);
                } else if (target === 'credentials') {
                  writeCredentials(f.home, f.credentials); // Same bytes, different inode.
                } else {
                  writeFileSync(
                    join(f.home, 'credentials.json'),
                    JSON.stringify({ ...f.credentials, nodeToken: 'T'.repeat(43) }),
                  ); // Same inode, changed binding.
                }
              }
              return result;
            }) as typeof statement.get;
            return statement;
          },
        );
        assert.throws(f.read, code('INTEGRATION_SCOPE_CHANGED'), target);
        assert(swapped);
      } finally {
        t.mock.restoreAll();
        f.close();
      }
    }
  },
);

test(
  '非标准表、虚拟表与WAL日志不作只读恢复或创建sidecar',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      for (const create of [
        'CREATE VIEW applications AS SELECT 1 AS id, 2 AS body',
        'CREATE TABLE applications(id TEXT PRIMARY KEY,body TEXT NOT NULL,extra TEXT)',
        'CREATE TABLE applications(id TEXT PRIMARY KEY,body TEXT GENERATED ALWAYS AS (id) VIRTUAL)',
        'CREATE VIRTUAL TABLE applications USING fts5(id,body)',
      ]) {
        f.storage.db.exec('DROP TABLE applications');
        f.storage.db.exec(create);
        const before = snapshot(f.dir);
        assert.throws(f.read, code('INTEGRATION_JOURNAL_INVALID'));
        assert.deepEqual(snapshot(f.dir), before);
        f.storage.db.exec(
          create.includes('CREATE VIEW') ? 'DROP VIEW applications' : 'DROP TABLE applications',
        );
        f.storage.db.exec('CREATE TABLE applications(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
      }
      f.save(f.base);
      f.storage.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)');
      const before = snapshot(f.dir);
      assert.throws(f.read, code('INTEGRATION_JOURNAL_INVALID'));
      assert.deepEqual(snapshot(f.dir), before);
    } finally {
      f.close();
    }
  },
);

test('CLI只接受操作ID与状态路径，错误输出不插入调用者控制字符', () => {
  for (const args of [
    [],
    ['--operation', 'id'],
    ['--operation', 'id', '--state', '/tmp', '--unlock', 'yes'],
    ['--operation', 'id', '--operation', 'again'],
    ['--operation', 'bad\n\u001bID', '--state', '/tmp'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.equal(JSON.parse(result.stderr).code, 'INVALID_INPUT');
    assert(!result.stderr.includes('\u001b'));
  }
});

test(
  '崩溃留下的热回滚日志只读失败，绝不恢复或删除现场',
  { skip: process.platform === 'win32' },
  () => {
    const f = fixture();
    try {
      f.storage.db.exec('CREATE TABLE spill(id INTEGER PRIMARY KEY,body BLOB);');
      const fill = f.storage.db.prepare('INSERT INTO spill VALUES(?,zeroblob(16384))');
      f.storage.db.exec('BEGIN');
      for (let index = 0; index < 200; index++) fill.run(index);
      f.storage.db.exec('COMMIT');
      const crashed = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE spill SET body=randomblob(16384)');
      process.exit(23);
    `,
          f.database,
        ],
        { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
      );
      assert.equal(crashed.status, 23, crashed.stderr);
      const journal = readFileSync(`${f.database}-journal`);
      assert(journal.length > 512);
      assert(journal.subarray(0, 8).some((byte) => byte !== 0));
      const before = snapshot(f.dir);
      assert.throws(f.read, code('INTEGRATION_JOURNAL_UNREADABLE'));
      assert.deepEqual(snapshot(f.dir), before);
    } finally {
      f.close();
    }
  },
);
