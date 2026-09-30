import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import {
  applyIntegration,
  withSettledIntegrationEvidence,
  type LocalApplication,
} from '../apps/runner/src/agent/integration-application.js';
import { recoverIntegration } from '../apps/runner/src/agent/integration-recovery.js';
import { originalApplicationEvidenceHash } from '../apps/runner/src/agent/integration-recovery-context.js';
import { readIntegrationApplicationStatus } from '../apps/runner/src/agent/integration-application-status.js';
import { type LocalIntegrationRecovery } from '../apps/runner/src/agent/integration-recovery-journal.js';
import { WorkspaceLease, workspaceReleaseReceipt } from '../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';

const silent = () => {};
const noAsk = async () => {
  throw new Error('must not request a second confirmation');
};
const linux = { skip: process.platform !== 'linux' };
async function prepared(transfer = false) {
  const f = await integrationRunnerFixture('sha1', transfer, false, { 'z-next.txt': 'NEXT\n' });
  const id = await f.create();
  await preflightIntegration(f.target.home, id, f.ask(id), silent);
  const view = await f.read(id);
  const response = await f.api.call(`${f.path}/${id}/apply`, f.alice, {
    expectedRevision: view.operation.revision,
    expectedTaskRevision: view.taskRevision,
    reportHash: view.reportHash,
    paths: ['new.txt', 'z-next.txt'],
    confirmApplication: true,
  });
  assert.equal(response.statusCode, 200, response.body);
  const selected = response.json() as IntegrationView;
  const applicationId = selected.operation.application!.id;
  return {
    ...f,
    id,
    selected,
    applicationId,
    consent: async () => `APPLY ${applicationId}`,
    stopped: async () => `STOPPED ${applicationId}`,
  };
}
type Fixture = Awaited<ReturnType<typeof prepared>>;
function database(f: Fixture) {
  return new DatabaseSync(join(f.target.home, 'integration-application/journal.sqlite'));
}
function applicationBody(f: Fixture) {
  const db = database(f);
  try {
    return db.prepare('SELECT body FROM applications WHERE id=?').get(f.id)!.body as string;
  } finally {
    db.close();
  }
}
function application(f: Fixture) {
  return JSON.parse(applicationBody(f)) as LocalApplication;
}
function editApplication(f: Fixture, change: (record: LocalApplication) => void) {
  const record = application(f);
  change(record);
  const db = database(f);
  try {
    db.prepare('UPDATE applications SET body=? WHERE id=?').run(JSON.stringify(record), f.id);
  } finally {
    db.close();
  }
}
function recovery(f: Fixture) {
  const db = database(f);
  try {
    return JSON.parse(
      db
        .prepare('SELECT body FROM integration_recoveries WHERE application_id=?')
        .get(f.applicationId)!.body as string,
    ) as LocalIntegrationRecovery;
  } finally {
    db.close();
  }
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (path: string) => {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await visit(name);
      else result[name] = (await readFile(join(root, name))).toString('base64');
    }
  };
  await visit('');
  return result;
}
async function stranded(f: Fixture, partial = false) {
  const fetch = globalThis.fetch,
    controller = new AbortController();
  try {
    globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!partial && String(input).endsWith('/integration-apply-publish')) {
        await response.text();
        throw new TypeError('fixture dropped start ACK');
      }
      if (partial && String(input).endsWith('/integration-inspect')) {
        const db = database(f);
        try {
          const row = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id);
          if (row && JSON.parse(row.body as string).added.length === 1) controller.abort();
        } finally {
          db.close();
        }
      }
      return response;
    };
    if (partial) {
      const result = await applyIntegration(
        f.target.home,
        f.id,
        f.consent,
        silent,
        controller.signal,
      );
      assert.equal(
        result.state,
        'needs_attention',
        JSON.stringify({ result, reports: (await f.read(f.id)).operation.application?.reports }),
      );
      assert.deepEqual(result.appliedPaths, ['new.txt']);
    } else
      await assert.rejects(
        applyIntegration(f.target.home, f.id, f.consent, silent),
        /dropped start ACK/,
      );
  } finally {
    globalThis.fetch = fetch;
  }
  assert(application(f).recoveryContext);
}
function cleanupClaim(f: Fixture) {
  try {
    new WorkspaceLease(f.target.root, `integration:${f.applicationId}`, true).release();
  } catch {}
}

test(
  '停止确认必须同时覆盖原应用与 integration-add 子进程，拒绝时原证据和锁不变',
  linux,
  async () => {
    const f = await prepared();
    try {
      await stranded(f);
      const before = applicationBody(f),
        files = await snapshot(f.target.root);
      await assert.rejects(
        recoverIntegration(
          f.target.home,
          f.id,
          async (prompt) => {
            assert.match(prompt, /integration-add/);
            assert.match(prompt, /孤儿进程/);
            assert.match(prompt, new RegExp(f.applicationId));
            return '';
          },
          silent,
        ),
        /未明确确认/,
      );
      assert.equal(applicationBody(f), before);
      assert.deepEqual(await snapshot(f.target.root), files);
      assert.throws(() => new WorkspaceLease(f.target.root, 'refused-confirmation'), /受管执行/);
    } finally {
      cleanupClaim(f);
      await f.close();
    }
  },
);

test(
  '真实部分写入结算保留编辑、额外和缺失文件，HEAD/index与旧报告不变，只记录有界观察',
  linux,
  async () => {
    const f = await prepared();
    try {
      await stranded(f, true);
      await writeFile(join(f.target.root, 'new.txt'), 'USER_EDIT');
      await writeFile(join(f.target.root, 'EXTRA'), 'PRESERVE');
      await rm(join(f.target.root, 'target.txt'));
      const before = applicationBody(f),
        files = await snapshot(f.target.root),
        original = (await f.read(f.id)).operation;
      const outcome = await recoverIntegration(f.target.home, f.id, f.stopped, silent);
      assert.equal(outcome.state, 'released');
      assert.equal(outcome.publication, 'acknowledged');
      assert.equal(outcome.filesVerified, false);
      assert.equal(applicationBody(f), before);
      assert.deepEqual(await snapshot(f.target.root), files);
      const after = await f.read(f.id);
      assert.deepEqual(after.operation, original);
      assert.equal(after.recovery!.report.recordedAddedCount, 1);
      assert.equal(after.recovery!.report.filesVerified, false);
      assert.equal(after.recovery!.report.unresolvedWriteIntent, false);
      const packet = JSON.stringify(after.recovery!.report);
      for (const secret of [f.target.root, f.target.credentials.nodeToken, 'new.txt', 'USER_EDIT'])
        assert(!packet.includes(secret));
      const writer = new WorkspaceLease(f.target.root, 'new-writer-after-preserve');
      try {
        assert.equal(
          (await recoverIntegration(f.target.home, f.id, noAsk, silent)).recoveryId,
          outcome.recoveryId,
        );
        await applyIntegration(f.target.home, f.id, noAsk, silent);
        writer.assertHeld();
        let allowed = false;
        await withSettledIntegrationEvidence(f.target.home, async () => {
          allowed = true;
        });
        assert(allowed);
      } finally {
        writer.release();
      }
    } finally {
      cleanupClaim(f);
      await f.close();
    }
  },
);

test('原应用待发ACK原样保留，后来仅原包对账不会改冻结观察或释放后续写锁', linux, async () => {
  const f = await prepared();
  try {
    await stranded(f);
    const original = applicationBody(f),
      originalHash = originalApplicationEvidenceHash(application(f));
    await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    assert.equal(applicationBody(f), original);
    const frozen = recovery(f);
    assert.equal(frozen.originalApplicationEvidenceHash, originalHash);
    assert.deepEqual(frozen.originalApplication.pending, application(f).pending);
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => {}),
      /未确认回执/,
    );
    const writer = new WorkspaceLease(f.target.root, 'after-original-pending');
    try {
      await applyIntegration(f.target.home, f.id, noAsk, silent);
      assert.equal(application(f).pending, null);
      assert.equal(application(f).acknowledged, 1);
      assert.equal(application(f).phase, 'prepared');
      assert.equal(
        (await recoverIntegration(f.target.home, f.id, noAsk, silent)).publication,
        'acknowledged',
      );
      assert.deepEqual(recovery(f), frozen);
      writer.assertHeld();
      const status = readIntegrationApplicationStatus(f.target.home, f.id);
      assert.equal(status.localPhase, 'prepared');
      assert.equal(status.pendingReportSequence, null);
      assert.equal(status.directoryChecked, false);
      assert(!JSON.stringify(status).includes(f.target.credentials.nodeToken));
      await withSettledIntegrationEvidence(f.target.home, async () => {});
    } finally {
      writer.release();
    }
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

test('离线且固定材料过期时仍只在本机保留释放，原结算包待确认后原样重发', linux, async () => {
  const f = await prepared(),
    fetch = globalThis.fetch;
  try {
    await stranded(f, true);
    for (const id of [f.sr, f.tr])
      f.api.store.db
        .prepare(
          "UPDATE checkpoint_retentions SET manifest=json_set(manifest,'$.expiresAt','2020-01-01T00:00:00.000Z') WHERE id=?",
        )
        .run(id);
    const body = applicationBody(f),
      files = await snapshot(f.target.root),
      requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      throw new TypeError('fixture offline');
    };
    const result = await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    assert.equal(result.state, 'released');
    assert.equal(result.publication, 'pending');
    assert.equal(requests.length, 1);
    assert(requests[0]!.endsWith('/integration-recovery-publish'));
    assert.equal(applicationBody(f), body);
    assert.deepEqual(await snapshot(f.target.root), files);
    const pending = recovery(f).recoveryPending;
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => {}),
      /未确认回执/,
    );
    globalThis.fetch = fetch;
    assert.equal(
      (await recoverIntegration(f.target.home, f.id, noAsk, silent)).publication,
      'acknowledged',
    );
    assert.deepEqual(recovery(f).report, pending);
  } finally {
    globalThis.fetch = fetch;
    cleanupClaim(f);
    await f.close();
  }
});

test('来源节点撤权仍可本机释放并向原目标Task发布有界观察，不使用来源特权', linux, async () => {
  const f = await prepared(true);
  try {
    await stranded(f, true);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    const before = applicationBody(f);
    const result = await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    assert.equal(result.publication, 'acknowledged');
    assert.equal(applicationBody(f), before);
    assert.equal((await f.read(f.id)).operation.applied, false);
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

test('目标节点撤权不阻止本机释放，但观察保持待发且凭证守卫不放行', linux, async () => {
  const f = await prepared();
  try {
    await stranded(f, true);
    f.as(() => f.nodes.revoke(f.ns[0]!.nodeId, 1, randomUUID()));
    const before = applicationBody(f);
    const result = await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    assert.equal(result.state, 'released');
    assert.equal(result.publication, 'pending');
    assert.equal(result.publicationError, 'NODE_REVOKED');
    assert.equal(applicationBody(f), before);
    assert(recovery(f).recoveryPending);
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => {}),
      /未确认回执/,
    );
    const writer = new WorkspaceLease(f.target.root, 'after-revoked-target');
    writer.release();
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

test('结算ACK丢失原包重放，新写入者及原应用证据保持不变', linux, async () => {
  const f = await prepared(),
    fetch = globalThis.fetch;
  try {
    await stranded(f, true);
    let packets: string[] = [];
    globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/integration-recovery-publish')) {
        packets.push(String(init?.body));
        await response.text();
        throw new TypeError('lost recovery ACK');
      }
      return response;
    };
    assert.equal(
      (await recoverIntegration(f.target.home, f.id, f.stopped, silent)).publication,
      'pending',
    );
    const writer = new WorkspaceLease(f.target.root, 'writer-between-recovery-retries');
    try {
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/integration-recovery-publish'))
          packets.push(String(init?.body));
        return fetch(input, init);
      };
      assert.equal(
        (await recoverIntegration(f.target.home, f.id, noAsk, silent)).publication,
        'acknowledged',
      );
      assert.equal(packets.length, 2);
      assert.equal(packets[0], packets[1]);
      writer.assertHeld();
    } finally {
      writer.release();
    }
  } finally {
    globalThis.fetch = fetch;
    cleanupClaim(f);
    await f.close();
  }
});

test(
  '真实恢复进程在原锁释放事务后退出，凭持久收据重放不读已移动目录或触碰新写入者',
  linux,
  async () => {
    const f = await prepared();
    try {
      await stranded(f, true);
      const module = new URL('../apps/runner/src/agent/integration-recovery.js', import.meta.url)
        .href;
      const source = `import {recoverIntegration} from ${JSON.stringify(module)};import {DatabaseSync} from 'node:sqlite';
const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql){const s=prepare.call(this,sql);if(sql.includes('INSERT INTO integration_recoveries VALUES')){const run=s.run.bind(s);s.run=(...args)=>{if(JSON.parse(args[1]).phase==='released')process.exit(37);return run(...args);};}return s;};
await recoverIntegration(process.env.FIXTURE_HOME,process.env.FIXTURE_ID,async()=>process.env.FIXTURE_STOPPED,()=>{});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          FIXTURE_HOME: f.target.home,
          FIXTURE_ID: f.id,
          FIXTURE_STOPPED: await f.stopped(),
        },
      });
      let error = '';
      child.stderr.on('data', (value) => {
        error += value;
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 37, error);
      const preparedRecovery = recovery(f);
      assert.equal(preparedRecovery.phase, 'release_prepared');
      assert(workspaceReleaseReceipt(preparedRecovery.releaseRequest));
      const writer = new WorkspaceLease(f.target.root, 'after-registry-before-local-save');
      try {
        await rename(f.target.root, f.target.root + '-moved');
        assert.equal(
          (await recoverIntegration(f.target.home, f.id, noAsk, silent)).publication,
          'acknowledged',
        );
        assert.equal(recovery(f).recoveryId, preparedRecovery.recoveryId);
        await rename(f.target.root + '-moved', f.target.root);
        writer.assertHeld();
      } finally {
        try {
          await rename(f.target.root + '-moved', f.target.root);
        } catch {}
        writer.release();
      }
    } finally {
      cleanupClaim(f);
      await f.close();
    }
  },
);

for (const changed of ['root', 'git', 'foreign', 'missing'] as const)
  test(`${changed} 原目录/元数据身份或claim变化时没有匹配收据绝不释放`, linux, async () => {
    const f = await prepared();
    let foreign: WorkspaceLease | undefined;
    try {
      await stranded(f);
      if (changed === 'root') {
        await rename(f.target.root, f.target.root + '-old');
        await mkdir(f.target.root);
        await mkdir(join(f.target.root, '.git'));
      }
      if (changed === 'git') {
        await rename(join(f.target.root, '.git'), join(f.target.root, '.git-old'));
        await mkdir(join(f.target.root, '.git'));
      }
      if (changed === 'foreign' || changed === 'missing') {
        cleanupClaim(f);
        if (changed === 'foreign') foreign = new WorkspaceLease(f.target.root, 'foreign-writer');
      }
      const before = applicationBody(f);
      await assert.rejects(recoverIntegration(f.target.home, f.id, f.stopped, silent));
      assert.equal(applicationBody(f), before);
      assert.equal(recovery(f).phase, 'release_prepared');
      assert.equal(workspaceReleaseReceipt(recovery(f).releaseRequest), null);
      foreign?.assertHeld();
    } finally {
      foreign?.release();
      if (changed === 'root') {
        await rm(f.target.root, { recursive: true, force: true });
        await rename(f.target.root + '-old', f.target.root);
      }
      if (changed === 'git') {
        await rm(join(f.target.root, '.git'), { recursive: true, force: true });
        await rename(join(f.target.root, '.git-old'), join(f.target.root, '.git'));
      }
      cleanupClaim(f);
      await f.close();
    }
  });

test('旧日志只从当前精确授权回复补全上下文，离线失败关闭且不会猜测', linux, async () => {
  const f = await prepared(),
    fetch = globalThis.fetch;
  try {
    await stranded(f);
    editApplication(f, (r) => {
      delete r.recoveryContext;
      // The legacy file-only format predates directory ownership fields too.
      delete r.directories;
      delete r.directoryIntent;
    });
    const before = applicationBody(f),
      hash = originalApplicationEvidenceHash(application(f));
    globalThis.fetch = async () => {
      throw new TypeError('offline legacy');
    };
    await assert.rejects(recoverIntegration(f.target.home, f.id, noAsk, silent), /offline legacy/);
    assert.equal(applicationBody(f), before);
    globalThis.fetch = fetch;
    await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    assert(application(f).recoveryContext);
    assert.equal(originalApplicationEvidenceHash(application(f)), hash);
    assert.deepEqual(recovery(f).originalApplication.pending, JSON.parse(before).pending);
  } finally {
    globalThis.fetch = fetch;
    cleanupClaim(f);
    await f.close();
  }
});

test('错误的冻结上下文不能恢复或伪装只读状态，原凭证守卫保持关闭', linux, async () => {
  const f = await prepared();
  try {
    await stranded(f);
    editApplication(f, (r) => {
      r.recoveryContext!.workspaceId = 'wrong-workspace';
    });
    await assert.rejects(recoverIntegration(f.target.home, f.id, noAsk, silent), /本机应用证据/);
    assert.throws(() => readIntegrationApplicationStatus(f.target.home, f.id), /本机应用证据/);
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => {}),
      /应用日志无效/,
    );
    assert.throws(() => new WorkspaceLease(f.target.root, 'malformed-context'), /受管执行/);
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

test('恢复等待停止确认时持有同一进程守卫，不能并发应用或删除凭证', linux, async () => {
  const f = await prepared();
  let release!: () => void, entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
  let attempt: ReturnType<typeof recoverIntegration> | undefined;
  try {
    await stranded(f);
    attempt = recoverIntegration(
      f.target.home,
      f.id,
      async () => {
        entered();
        await barrier;
        return f.stopped();
      },
      silent,
    );
    await arrived;
    await assert.rejects(applyIntegration(f.target.home, f.id, noAsk, silent), /已有进程/);
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => {}),
      /已有进程/,
    );
    release();
    await attempt;
  } finally {
    release();
    await attempt?.catch(() => {});
    cleanupClaim(f);
    await f.close();
  }
});

test('未确认写入意图与其可能已出现的文件保持原状，不升级为已应用路径', linux, async () => {
  const f = await prepared();
  try {
    await stranded(f, true);
    editApplication(f, (record) => {
      record.phase = 'applying';
      record.acknowledged = 1;
      record.pending = null;
      record.intent = 'z-next.txt';
    });
    await writeFile(join(f.target.root, 'z-next.txt'), 'UNKNOWN_OR_USER_BYTES');
    const before = applicationBody(f),
      files = await snapshot(f.target.root);
    await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    assert.equal(applicationBody(f), before);
    assert.deepEqual(await snapshot(f.target.root), files);
    assert.equal(recovery(f).report!.recordedAddedCount, 1);
    assert.equal(recovery(f).report!.unresolvedWriteIntent, true);
    assert.deepEqual(
      application(f).added.map((entry) => entry.path),
      ['new.txt'],
    );
    await withSettledIntegrationEvidence(f.target.home, async () => {});
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

for (const kind of ['completed', 'recovered'] as const)
  test(`${kind} 已结算历史在明确删除凭证后仍允许重新配对守卫`, linux, async () => {
    const f = await prepared();
    try {
      if (kind === 'completed') await applyIntegration(f.target.home, f.id, f.consent, silent);
      else {
        await stranded(f, true);
        await recoverIntegration(f.target.home, f.id, f.stopped, silent);
      }
      await withSettledIntegrationEvidence(f.target.home, async () => {
        await rm(join(f.target.home, 'credentials.json'));
      });
      let called = false;
      await withSettledIntegrationEvidence(f.target.home, async () => {
        called = true;
      });
      assert(called);
    } finally {
      cleanupClaim(f);
      await f.close();
    }
  });

test('实际应用进程在启动ACK窗口退出后可以保留结算，但原启动包仍冻结待发', linux, async () => {
  const f = await prepared();
  try {
    const module = new URL('../apps/runner/src/agent/integration-application.js', import.meta.url)
      .href;
    const source = `import {applyIntegration} from ${JSON.stringify(module)};
const fetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const r=await fetch(input,init);if(String(input).endsWith('/integration-apply-publish')){await r.clone().text();process.exit(23);}return r;};
await applyIntegration(process.env.FIXTURE_HOME,process.env.FIXTURE_ID,async()=>process.env.FIXTURE_CONSENT,()=>{});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        FIXTURE_HOME: f.target.home,
        FIXTURE_ID: f.id,
        FIXTURE_CONSENT: await f.consent(),
      },
    });
    let error = '';
    child.stderr.on('data', (value) => {
      error += value;
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 23, error);
    const before = applicationBody(f);
    assert.equal(application(f).pending!.sequence, 1);
    await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    assert.equal(applicationBody(f), before);
    await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

test('确认期间原应用证据变化时拒绝释放，不能把新现场绑定旧停止确认', linux, async () => {
  const f = await prepared();
  try {
    await stranded(f);
    await assert.rejects(
      recoverIntegration(
        f.target.home,
        f.id,
        async () => {
          editApplication(f, (record) => {
            record.pending!.observedAt = new Date(Date.now() + 1000).toISOString();
          });
          return f.stopped();
        },
        silent,
      ),
      /原应用证据在结算期间变化/,
    );
    assert.throws(
      () => new WorkspaceLease(f.target.root, 'changed-during-confirmation'),
      /受管执行/,
    );
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

test('缺少原应用表的结算记录仍阻止凭证删除，不把损坏历史当空日志', linux, async () => {
  const f = await prepared();
  try {
    await stranded(f, true);
    await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    const db = database(f);
    try {
      db.exec('DROP TABLE applications');
    } finally {
      db.close();
    }
    let called = false;
    await assert.rejects(
      withSettledIntegrationEvidence(f.target.home, async () => {
        called = true;
      }),
      /缺少原应用证据/,
    );
    assert.equal(called, false);
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});

test('新版含冻结上下文日志的状态读取仍不改文件或输出私有上下文', linux, async () => {
  const f = await prepared();
  try {
    await stranded(f, true);
    await recoverIntegration(f.target.home, f.id, f.stopped, silent);
    const before = await snapshot(f.target.home);
    const status = readIntegrationApplicationStatus(f.target.home, f.id);
    assert.deepEqual(await snapshot(f.target.home), before);
    assert.equal(status.directoryChecked, false);
    const output = JSON.stringify(status);
    assert(!output.includes('recoveryContext'));
    assert(!output.includes(f.target.credentials.nodeToken));
    assert(!output.includes(application(f).binding));
  } finally {
    cleanupClaim(f);
    await f.close();
  }
});
