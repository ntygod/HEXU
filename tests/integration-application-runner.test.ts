import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, mkdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { integrationRunnerFixture } from './helpers/integration-runner.js';
import { preflightIntegration } from '../apps/runner/src/agent/integration-preflight.js';
import { applyIntegration } from '../apps/runner/src/agent/integration-application.js';
import { withSettledIntegrationEvidence } from '../apps/runner/src/agent/integration-application.js';
import { fileURLToPath } from 'node:url';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import { git } from './helpers/checkpoint-retention.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';

const silent = () => {};
const noAsk = async () => {
  throw new Error('never repeat consent or write');
};
async function prepared(
  format: 'sha1' | 'sha256' = 'sha1',
  transfer = false,
  extra: Record<string, string> = {},
) {
  const f = await integrationRunnerFixture(format, transfer, false, extra);
  const id = await f.create();
  await preflightIntegration(f.target.home, id, f.ask(id), silent);
  const view = await f.read(id);
  const apply = await f.api.call(`${f.path}/${id}/apply`, f.alice, {
    expectedRevision: view.operation.revision,
    expectedTaskRevision: view.taskRevision,
    reportHash: view.reportHash,
    paths: ['new.txt', ...Object.keys(extra)].sort(),
    confirmApplication: true,
  });
  assert.equal(apply.statusCode, 200, apply.body);
  const selected = apply.json() as IntegrationView;
  return { ...f, id, selected, consent: async () => `APPLY ${selected.operation.application!.id}` };
}
for (const format of ['sha1', 'sha256'] as const)
  test(
    `${format}本人确认仅新增所选文件，原HEAD/index/既有文件不变，重复执行仅对账`,
    { skip: process.platform !== 'linux' },
    async () => {
      const f = await prepared(format, format === 'sha256');
      try {
        const before = {
          head: await readFile(join(f.target.root, '.git/HEAD')),
          index: await readFile(join(f.target.root, '.git/index')),
          body: await readFile(join(f.target.root, 'README.md')),
        };
        const result = await applyIntegration(f.target.home, f.id, f.consent, silent);
        assert.equal(result.state, 'completed');
        assert.deepEqual(result.appliedPaths, ['new.txt']);
        assert.equal(
          await readFile(join(f.target.root, 'new.txt'), 'utf8'),
          'NEW_COMMITTED_SECRET\n',
        );
        for (const [path, content] of [
          ['.git/HEAD', before.head],
          ['.git/index', before.index],
          ['README.md', before.body],
        ] as const)
          assert.deepEqual(await readFile(join(f.target.root, path)), content);
        assert.equal(git(f.target.root, 'rev-parse', 'HEAD'), f.targetCommit);
        const view = await f.read(f.id);
        assert.equal(view.operation.applied, true);
        assert.equal(view.operation.report!.plan!.applied, false);
        assert.equal(view.operation.application!.reports.length, 2);
        // No recapture on success replay: even a user's later edit is not overwritten.
        await writeFile(join(f.target.root, 'new.txt'), 'USER_EDIT');
        assert.equal(
          (await applyIntegration(f.target.home, f.id, noAsk, silent)).state,
          'completed',
        );
        assert.equal(await readFile(join(f.target.root, 'new.txt'), 'utf8'), 'USER_EDIT');
        const available = new WorkspaceLease(f.target.root, 'after-completion');
        available.release();
      } finally {
        await f.close();
      }
    },
  );

test(
  '本机拒绝确认和确认期间目标变化均不写入，未取得应用启动回执',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared();
    try {
      await assert.rejects(
        applyIntegration(f.target.home, f.id, async () => '', silent),
        /未确认/,
      );
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
      await assert.rejects(
        applyIntegration(
          f.target.home,
          f.id,
          async () => {
            await writeFile(join(f.target.root, 'README.md'), 'USER_EDIT');
            return f.consent();
          },
          silent,
        ),
        /当前目录/,
      );
      assert.equal((await f.read(f.id)).operation.application!.reports.length, 0);
      assert.equal(await readFile(join(f.target.root, 'README.md'), 'utf8'), 'USER_EDIT');
      const available = new WorkspaceLease(f.target.root, 'after-refusal');
      available.release();
    } finally {
      await f.close();
    }
  },
);

test(
  '完成共享ACK丢失只重发固定报告，不重新访问已移动的目录或写入',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    try {
      let lost = true;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (
          lost &&
          String(input).endsWith('/integration-apply-publish') &&
          JSON.parse(String(init?.body)).sequence === 2
        ) {
          lost = false;
          await response.text();
          throw new TypeError('lost terminal ACK');
        }
        return response;
      };
      await assert.rejects(applyIntegration(f.target.home, f.id, f.consent, silent));
      assert.equal((await f.read(f.id)).operation.state, 'completed');
      const moved = join(f.dir, 'moved-after-completion');
      await rename(f.target.root, moved);
      try {
        assert.equal(
          (await applyIntegration(f.target.home, f.id, noAsk, silent)).state,
          'completed',
        );
      } finally {
        await rename(moved, f.target.root);
      }
      assert.equal((await f.read(f.id)).operation.application!.reports.length, 2);
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test(
  '启动ACK丢失保持持久锁；重启仅记录中断，绝不开始写文件',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    try {
      let lost = true;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (lost && String(input).endsWith('/integration-apply-publish')) {
          lost = false;
          await response.text();
          throw new TypeError('lost start ACK');
        }
        return response;
      };
      await assert.rejects(applyIntegration(f.target.home, f.id, f.consent, silent));
      assert.throws(() => new WorkspaceLease(f.target.root, 'second-writer'), /受管执行/);
      assert.equal(
        (await applyIntegration(f.target.home, f.id, noAsk, silent)).state,
        'needs_attention',
      );
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
      assert.equal(
        (await f.read(f.id)).operation.application!.reports.at(-1)!.reason,
        'interrupted',
      );
      assert.throws(() => new WorkspaceLease(f.target.root, 'still-unknown'), /受管执行/);
    } finally {
      globalThis.fetch = fetch;
      new WorkspaceLease(
        f.target.root,
        `integration:${f.selected.operation.application!.id}`,
        true,
      ).release();
      await f.close();
    }
  },
);

test(
  '应用期间额外文件阻止落地，不删除新文件；已启动但零写入可安全释放锁',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    try {
      let changed = false;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!changed && String(input).endsWith('/integration-apply-publish')) {
          changed = true;
          await writeFile(join(f.target.root, 'USER_ADDITION'), 'keep');
        }
        return response;
      };
      assert.equal(
        (await applyIntegration(f.target.home, f.id, f.consent, silent)).state,
        'failed',
      );
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
      assert.equal(await readFile(join(f.target.root, 'USER_ADDITION'), 'utf8'), 'keep');
      const available = new WorkspaceLease(f.target.root, 'after-known-failure');
      available.release();
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test(
  '两个文件之间变化保留已写文件和未知锁，重复调用不续写',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared('sha1', false, { 'z-next.txt': 'NEXT_PRIVATE' }),
      fetch = globalThis.fetch;
    try {
      let changed = false;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!changed && String(input).endsWith('/integration-inspect')) {
          const db = new DatabaseSync(
            join(f.target.home, 'integration-application/journal.sqlite'),
            { readOnly: true },
          );
          try {
            const row = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id) as
              | { body: string }
              | undefined;
            if (row && JSON.parse(row.body).added.length === 1) {
              changed = true;
              await writeFile(join(f.target.root, 'USER_ADDITION'), 'keep');
            }
          } finally {
            db.close();
          }
        }
        return response;
      };
      const result = await applyIntegration(f.target.home, f.id, f.consent, silent);
      assert.equal(result.state, 'needs_attention');
      assert.deepEqual(result.appliedPaths, ['new.txt']);
      assert.equal(
        await readFile(join(f.target.root, 'new.txt'), 'utf8'),
        'NEW_COMMITTED_SECRET\n',
      );
      await assert.rejects(readFile(join(f.target.root, 'z-next.txt')), /ENOENT/);
      assert.throws(() => new WorkspaceLease(f.target.root, 'blocked'), /受管执行/);
      assert.equal(
        (await applyIntegration(f.target.home, f.id, noAsk, silent)).state,
        'needs_attention',
      );
      await assert.rejects(readFile(join(f.target.root, 'z-next.txt')), /ENOENT/);
    } finally {
      globalThis.fetch = fetch;
      new WorkspaceLease(
        f.target.root,
        `integration:${f.selected.operation.application!.id}`,
        true,
      ).release();
      await f.close();
    }
  },
);

test(
  '同一应用并发调用在持久进程守卫前拒绝，不改第一进程阶段或释放写锁',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      arrived = new Promise<void>((resolve) => {
        entered = resolve;
      });
    let first: ReturnType<typeof applyIntegration> | undefined;
    try {
      let held = false;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!held && String(input).endsWith('/integration-apply-publish')) {
          held = true;
          entered();
          await barrier;
        }
        return response;
      };
      first = applyIntegration(f.target.home, f.id, f.consent, silent);
      await arrived;
      await assert.rejects(applyIntegration(f.target.home, f.id, noAsk, silent), /已有进程/);
      assert.equal((await f.read(f.id)).operation.state, 'applying');
      assert.throws(() => new WorkspaceLease(f.target.root, 'other-writer'), /受管执行/);
      release();
      assert.equal((await first).state, 'completed');
      assert.equal(
        await readFile(join(f.target.root, 'new.txt'), 'utf8'),
        'NEW_COMMITTED_SECRET\n',
      );
    } finally {
      release();
      await first?.catch(() => {});
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test(
  '真实独立进程在启动报告后退出，重启不重放任何新增文件且保留未知锁',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared();
    try {
      const module = new URL('../apps/runner/src/agent/integration-application.js', import.meta.url)
        .href;
      const source = `import {applyIntegration} from ${JSON.stringify(module)};
      const real=globalThis.fetch;
      globalThis.fetch=async(input,init)=>{const r=await real(input,init);if(String(input).endsWith('/integration-apply-publish')){await r.clone().text();process.exit(23);}return r;};
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
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (v) => {
        error += v;
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 23, error);
      assert.equal((await f.read(f.id)).operation.state, 'applying');
      assert.throws(() => new WorkspaceLease(f.target.root, 'blocked-after-crash'), /受管执行/);
      assert.equal(
        (await applyIntegration(f.target.home, f.id, noAsk, silent)).state,
        'needs_attention',
      );
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
    } finally {
      new WorkspaceLease(
        f.target.root,
        `integration:${f.selected.operation.application!.id}`,
        true,
      ).release();
      await f.close();
    }
  },
);

test(
  '持久准备后但启动声明前退出可报告零写入失败，释放只属于原尝试的锁',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared();
    try {
      const module = new URL('../apps/runner/src/agent/integration-application.js', import.meta.url)
        .href;
      const source = `import {applyIntegration} from ${JSON.stringify(module)};import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';
      const real=globalThis.fetch;
      globalThis.fetch=async(input,init)=>{const r=await real(input,init);if(String(input).endsWith('/integration-inspect')){const db=new DatabaseSync(join(process.env.FIXTURE_HOME,'integration-application/journal.sqlite'),{readOnly:true});const row=db.prepare('SELECT body FROM applications WHERE id=?').get(process.env.FIXTURE_ID);db.close();if(row&&JSON.parse(row.body).phase==='prepared'){await r.clone().text();process.exit(24);}}return r;};
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
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (v) => {
        error += v;
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 24, error);
      assert.equal((await f.read(f.id)).operation.state, 'queued');
      assert.equal((await applyIntegration(f.target.home, f.id, noAsk, silent)).state, 'failed');
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
      const reports = (await f.read(f.id)).operation.application!.reports;
      assert.equal(reports.length, 1);
      assert.equal(reports[0]!.stage, 'failed');
      assert.equal(reports[0]!.sequence, 1);
      const available = new WorkspaceLease(f.target.root, 'after-proven-no-write');
      available.release();
    } finally {
      await f.close();
    }
  },
);

test(
  '写入中本机取消保留已落地范围；完成报告丢失不会把部分结果当撤销成功',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared('sha1', false, { 'z-next.txt': 'NEXT' }),
      fetch = globalThis.fetch,
      controller = new AbortController();
    try {
      let aborted = false;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (!aborted && String(input).endsWith('/integration-inspect')) {
          const db = new DatabaseSync(
            join(f.target.home, 'integration-application/journal.sqlite'),
            { readOnly: true },
          );
          try {
            const row = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id) as
              | { body: string }
              | undefined;
            if (row && JSON.parse(row.body).added.length === 1) {
              aborted = true;
              controller.abort();
            }
          } finally {
            db.close();
          }
        }
        return response;
      };
      const result = await applyIntegration(
        f.target.home,
        f.id,
        f.consent,
        silent,
        controller.signal,
      );
      assert.equal(result.state, 'needs_attention');
      assert.deepEqual(result.appliedPaths, ['new.txt']);
      assert.equal(
        (await f.read(f.id)).operation.application!.reports.at(-1)!.reason,
        'interrupted',
      );
      await assert.rejects(readFile(join(f.target.root, 'z-next.txt')), /ENOENT/);
      assert.throws(() => new WorkspaceLease(f.target.root, 'still-held'), /受管执行/);
    } finally {
      globalThis.fetch = fetch;
      new WorkspaceLease(
        f.target.root,
        `integration:${f.selected.operation.application!.id}`,
        true,
      ).release();
      await f.close();
    }
  },
);

test(
  '损坏日志不能把未确认写入冒充failed以清除原持久锁',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith('/integration-apply-publish')) {
          await response.text();
          throw new TypeError('lost start');
        }
        return response;
      };
      await assert.rejects(applyIntegration(f.target.home, f.id, f.consent, silent));
      globalThis.fetch = fetch;
      const db = new DatabaseSync(join(f.target.home, 'integration-application/journal.sqlite'));
      try {
        const raw = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id) as {
          body: string;
        };
        const record = JSON.parse(raw.body);
        record.phase = 'failed';
        record.intent = 'new.txt';
        db.prepare('UPDATE applications SET body=? WHERE id=?').run(JSON.stringify(record), f.id);
      } finally {
        db.close();
      }
      await assert.rejects(applyIntegration(f.target.home, f.id, noAsk, silent), /本机应用证据/);
      assert.throws(() => new WorkspaceLease(f.target.root, 'no-false-release'), /受管执行/);
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
    } finally {
      globalThis.fetch = fetch;
      new WorkspaceLease(
        f.target.root,
        `integration:${f.selected.operation.application!.id}`,
        true,
      ).release();
      await f.close();
    }
  },
);

test(
  '服务端回退到cancelled不能覆盖本机部分写入证据或释放原锁',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith('/integration-apply-publish')) {
          await response.text();
          throw new TypeError('lost start');
        }
        return response;
      };
      await assert.rejects(applyIntegration(f.target.home, f.id, f.consent, silent));
      // A durable per-file success immediately before a crash; the server then
      // returns divergent old cancellation history. Never treat it as no writes.
      await writeFile(join(f.target.root, 'new.txt'), 'NEW_COMMITTED_SECRET\n');
      const stat = await lstat(join(f.target.root, 'new.txt')),
        meta = f.selected.operation.report!.plan!.files.find((v) => v.path === 'new.txt')!.source!;
      const db = new DatabaseSync(join(f.target.home, 'integration-application/journal.sqlite'));
      try {
        const row = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id) as {
          body: string;
        };
        const record = JSON.parse(row.body);
        record.phase = 'applying';
        record.acknowledged = 1;
        record.pending = null;
        record.added = [
          {
            path: 'new.txt',
            kind: 'file',
            gitMode: meta.mode,
            objectId: meta.objectId,
            bytes: meta.bytes,
            identity: `${stat.dev}:${stat.ino}`,
          },
        ];
        db.prepare('UPDATE applications SET body=? WHERE id=?').run(JSON.stringify(record), f.id);
      } finally {
        db.close();
      }
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith('/integration-inspect')) {
          const view = (await response.json()) as IntegrationView;
          view.operation.state = 'cancelled';
          view.operation.application!.reports = [];
          return new Response(JSON.stringify(view), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return response;
      };
      await assert.rejects(
        applyIntegration(f.target.home, f.id, noAsk, silent),
        /本机写入证据不一致/,
      );
      assert.equal(
        await readFile(join(f.target.root, 'new.txt'), 'utf8'),
        'NEW_COMMITTED_SECRET\n',
      );
      assert.throws(
        () => new WorkspaceLease(f.target.root, 'cannot-release-from-old-server'),
        /受管执行/,
      );
    } finally {
      globalThis.fetch = fetch;
      new WorkspaceLease(
        f.target.root,
        `integration:${f.selected.operation.application!.id}`,
        true,
      ).release();
      await f.close();
    }
  },
);

test(
  '真实CLI拒绝在应用待决时删除凭证；终态回执对账后允许显式断开',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    const cli = fileURLToPath(new URL('../apps/runner/src/cli.js', import.meta.url));
    const disconnect = () =>
      spawnSync(process.execPath, [cli, 'disconnect', '--local-only', '--state', f.target.home], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      });
    try {
      let lost = true;
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (
          lost &&
          String(input).endsWith('/integration-apply-publish') &&
          JSON.parse(String(init?.body)).sequence === 2
        ) {
          lost = false;
          await response.text();
          throw new TypeError('lost terminal ACK');
        }
        return response;
      };
      await assert.rejects(applyIntegration(f.target.home, f.id, f.consent, silent));
      const before = await readFile(join(f.target.home, 'credentials.json'));
      const denied = disconnect();
      assert.equal(denied.status, 1, denied.stdout);
      assert.match(denied.stdout + denied.stderr, /INTEGRATION_UNSETTLED/);
      assert.deepEqual(await readFile(join(f.target.home, 'credentials.json')), before);
      assert.equal((await applyIntegration(f.target.home, f.id, noAsk, silent)).state, 'completed');
      const allowed = disconnect();
      assert.equal(allowed.status, 0, allowed.stderr);
      await assert.rejects(readFile(join(f.target.home, 'credentials.json')), /ENOENT/);
      assert.equal(
        await readFile(join(f.target.root, 'new.txt'), 'utf8'),
        'NEW_COMMITTED_SECRET\n',
      );
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test(
  '凭证变更的异步等待期间应用不能启动，避免检查后断开竞态',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared();
    let enter!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    const changing = withSettledIntegrationEvidence(f.target.home, async () => {
      enter();
      await barrier;
    });
    try {
      await started;
      await assert.rejects(applyIntegration(f.target.home, f.id, f.consent, silent), /已有进程/);
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
      release();
      await changing;
      assert.equal(
        (await applyIntegration(f.target.home, f.id, f.consent, silent)).state,
        'completed',
      );
    } finally {
      release();
      await changing;
      await f.close();
    }
  },
);

test(
  '正在等待本人确认且尚无应用日志时也不能并发删除凭证',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared();
    let enter!: () => void, release!: () => void;
    const prompted = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
    const attempt = applyIntegration(
      f.target.home,
      f.id,
      async () => {
        enter();
        await barrier;
        return '';
      },
      silent,
    );
    // Attach the rejection handler before releasing the confirmation barrier.
    const refused = assert.rejects(attempt, /未确认/);
    try {
      await prompted;
      const cli = fileURLToPath(new URL('../apps/runner/src/cli.js', import.meta.url));
      const result = spawnSync(
        process.execPath,
        [cli, 'disconnect', '--local-only', '--state', f.target.home],
        { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      );
      assert.equal(result.status, 1);
      assert.match(result.stdout + result.stderr, /RUNNER_ALREADY_STARTED/);
      assert((await readFile(join(f.target.home, 'credentials.json'))).length > 0);
      release();
      await refused;
      await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
    } finally {
      release();
      await refused;
      await f.close();
    }
  },
);

test(
  '损坏的终态文件证据也不能绕过凭证保留守卫',
  { skip: process.platform !== 'linux' },
  async () => {
    const f = await prepared();
    try {
      assert.equal(
        (await applyIntegration(f.target.home, f.id, f.consent, silent)).state,
        'completed',
      );
      const db = new DatabaseSync(join(f.target.home, 'integration-application/journal.sqlite'));
      try {
        const row = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id) as {
          body: string;
        };
        const record = JSON.parse(row.body);
        record.added = [null];
        db.prepare('UPDATE applications SET body=? WHERE id=?').run(JSON.stringify(record), f.id);
      } finally {
        db.close();
      }
      let action = false;
      await assert.rejects(
        withSettledIntegrationEvidence(f.target.home, async () => {
          action = true;
        }),
        /应用日志无效/,
      );
      assert.equal(action, false);
      assert((await readFile(join(f.target.home, 'credentials.json'))).length > 0);
    } finally {
      await f.close();
    }
  },
);
