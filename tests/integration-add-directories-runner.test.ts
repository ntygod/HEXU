import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { readFile, writeFile, readdir, lstat, rename, mkdir } from 'node:fs/promises';
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
import { readIntegrationApplicationStatus } from '../apps/runner/src/agent/integration-application-status.js';
import { recoverIntegration } from '../apps/runner/src/agent/integration-recovery.js';
import { PinnedRestoreParent } from '../apps/runner/src/agent/checkpoint-restore-files.js';
import { WorkspaceLease } from '../apps/runner/src/workspace-lease.js';
import type { IntegrationView } from '../packages/contracts/src/integrations.js';
import { parseLocalApplicationRecord } from '../apps/runner/src/agent/integration-application-record.js';

const silent = () => {};
const never = async () => {
  throw new Error('must not replay a write or request consent again');
};
const extra = {
  'new-module/deeper/a.txt': 'A\n',
  'new-module/deeper/b.txt': 'B\n',
  'new-module/other/c.txt': 'C\n',
};
const linux = { skip: process.platform !== 'linux' };
async function prepared(
  format: 'sha1' | 'sha256' = 'sha1',
  files: Record<string, string> = extra,
  baseFiles: Record<string, string> = {},
) {
  const f = await integrationRunnerFixture(format, format === 'sha256', false, files, {
    baseFiles,
  });
  try {
    const id = await f.create();
    await preflightIntegration(f.target.home, id, f.ask(id), silent);
    const v = await f.read(id);
    const response = await f.api.call(`${f.path}/${id}/apply`, f.alice, {
      expectedRevision: v.operation.revision,
      expectedTaskRevision: v.taskRevision,
      reportHash: v.reportHash,
      paths: Object.keys(files).sort(),
      confirmApplication: true,
    });
    assert.equal(response.statusCode, 200, response.body);
    const selected = response.json() as IntegrationView;
    const applicationId = selected.operation.application!.id;
    return {
      ...f,
      id,
      applicationId,
      consent: async () => `APPLY ${applicationId}`,
      close: async () => {
        // Only this disposable fixture's own claim, never a production or foreign claim.
        try {
          new WorkspaceLease(f.target.root, `integration:${applicationId}`, true).release();
        } catch {}
        await f.close();
      },
    };
  } catch (cause) {
    await f.close();
    throw cause;
  }
}
type Fixture = Awaited<ReturnType<typeof prepared>>;
function record(f: Fixture): LocalApplication | undefined {
  const db = new DatabaseSync(join(f.target.home, 'integration-application/journal.sqlite'), {
    readOnly: true,
  });
  try {
    const row = db.prepare('SELECT body FROM applications WHERE id=?').get(f.id);
    return row && (JSON.parse(row.body as string) as LocalApplication);
  } finally {
    db.close();
  }
}
for (const format of ['sha1', 'sha256'] as const)
  test(
    `${format} selected files create exclusive shared/nested parents while preserving original files and Git state`,
    linux,
    async () => {
      const f = await prepared(format);
      try {
        const originals = new Map(
          await Promise.all(
            ['README.md', '.git/HEAD', '.git/index'].map(
              async (path) => [path, await readFile(join(f.target.root, path))] as const,
            ),
          ),
        );
        const result = await applyIntegration(f.target.home, f.id, f.consent, silent);
        assert.equal(result.state, 'completed', JSON.stringify(result));
        assert.deepEqual(result.appliedPaths, Object.keys(extra).sort());
        for (const [path, expected] of originals)
          assert.deepEqual(await readFile(join(f.target.root, path)), expected);
        for (const [path, expected] of Object.entries(extra))
          assert.equal(await readFile(join(f.target.root, path), 'utf8'), expected);
        await assert.rejects(readFile(join(f.target.root, 'new.txt')), /ENOENT/);
        const status = readIntegrationApplicationStatus(f.target.home, f.id);
        assert.deepEqual(
          status.confirmedCreatedDirectories.map((d) => d.path),
          ['new-module', 'new-module/deeper', 'new-module/other'],
        );
        assert.equal(status.intendedDirectory, null);
        for (const d of status.confirmedCreatedDirectories)
          assert.equal((await lstat(join(f.target.root, d.path))).mode & 0o777, 0o700);
        assert(!(await readdir(f.target.root)).some((name) => name.startsWith('.hexu-restore-')));
        const journal = record(f)!;
        await writeFile(join(f.target.root, 'new-module/deeper/a.txt'), 'USER_EDIT');
        assert.equal(
          (await applyIntegration(f.target.home, f.id, never, silent)).state,
          'completed',
        );
        assert.equal(
          await readFile(join(f.target.root, 'new-module/deeper/a.txt'), 'utf8'),
          'USER_EDIT',
        );
        assert.deepEqual(record(f)!.directories, journal.directories);
        await withSettledIntegrationEvidence(f.target.home, async () => {});
        const lease = new WorkspaceLease(f.target.root, 'after-parent-success');
        lease.release();
      } finally {
        await f.close();
      }
    },
  );

test(
  'directory-only interruption retains claim/evidence, never resumes, and explicit preserve settlement keeps user files',
  linux,
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch,
      stop = new AbortController();
    try {
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input).endsWith('/integration-inspect') && record(f)?.directories?.length === 1)
          stop.abort();
        return response;
      };
      const result = await applyIntegration(f.target.home, f.id, f.consent, silent, stop.signal);
      assert.equal(result.state, 'needs_attention', JSON.stringify(result));
      assert.deepEqual(result.appliedPaths, []);
      globalThis.fetch = fetch;
      const before = record(f)!;
      assert.deepEqual(
        before.directories!.map((d) => d.path),
        ['new-module'],
      );
      assert.throws(() => new WorkspaceLease(f.target.root, 'must-remain-blocked'), /占用|进程/);
      await assert.rejects(
        withSettledIntegrationEvidence(f.target.home, async () => {}),
        /未知|未确认/,
      );
      assert.equal(
        (await applyIntegration(f.target.home, f.id, never, silent)).state,
        'needs_attention',
      );
      assert.deepEqual(record(f), before);
      await writeFile(join(f.target.root, 'new-module/user.txt'), 'KEEP_USER_FILE');
      const settled = await recoverIntegration(
        f.target.home,
        f.id,
        async () => `STOPPED ${f.applicationId}`,
        silent,
      );
      assert.equal(settled.state, 'released');
      assert.equal(
        await readFile(join(f.target.root, 'new-module/user.txt'), 'utf8'),
        'KEEP_USER_FILE',
      );
      assert.deepEqual(record(f), before);
      assert.equal((await f.read(f.id)).operation.applied, false);
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test(
  'failure after creating directory stage preserves exact intent and never infers publication or retries',
  linux,
  async (t) => {
    const f = await prepared();
    try {
      const create = PinnedRestoreParent.prototype.createStage;
      t.mock.method(
        PinnedRestoreParent.prototype,
        'createStage',
        function (this: PinnedRestoreParent, name: string) {
          const fd = create.call(this, name);
          closeSync(fd);
          throw new Error('fixture stopped before recording stage identity');
        },
      );
      const result = await applyIntegration(f.target.home, f.id, f.consent, silent);
      assert.equal(result.state, 'needs_attention');
      t.mock.restoreAll();
      const before = record(f)!;
      assert.equal(before.directories!.length, 0);
      assert.equal(before.directoryIntent!.path, 'new-module');
      assert.equal(before.directoryIntent!.stageIdentity, null);
      assert.equal(before.intent, 'new-module/deeper/a.txt');
      const stage = join(f.target.root, before.directoryIntent!.stageName);
      assert((await lstat(stage)).isDirectory());
      await assert.rejects(lstat(join(f.target.root, 'new-module')), /ENOENT/);
      assert.equal(
        (await applyIntegration(f.target.home, f.id, never, silent)).state,
        'needs_attention',
      );
      assert.deepEqual(record(f), before);
      assert.deepEqual(await readdir(stage), []);
      assert.throws(() => new WorkspaceLease(f.target.root, 'cannot-ignore-stage'), /占用|进程/);
    } finally {
      t.mock.restoreAll();
      await f.close();
    }
  },
);

test(
  'replacing an already-created parent stops subsequent writes and preserves both original and user replacement',
  linux,
  async () => {
    const f = await prepared(),
      fetch = globalThis.fetch;
    let changed = false;
    try {
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (
          !changed &&
          String(input).endsWith('/integration-inspect') &&
          record(f)?.directories?.length === 1
        ) {
          changed = true;
          await rename(join(f.target.root, 'new-module'), join(f.dir, 'preserved-original-parent'));
          await mkdir(join(f.target.root, 'new-module'));
          await writeFile(join(f.target.root, 'new-module/user.txt'), 'REPLACEMENT');
        }
        return response;
      };
      assert.equal(
        (await applyIntegration(f.target.home, f.id, f.consent, silent)).state,
        'needs_attention',
      );
      assert.equal(record(f)!.added.length, 0);
      assert((await lstat(join(f.dir, 'preserved-original-parent'))).isDirectory());
      assert.equal(
        await readFile(join(f.target.root, 'new-module/user.txt'), 'utf8'),
        'REPLACEMENT',
      );
      await assert.rejects(lstat(join(f.target.root, 'new-module/deeper')), /ENOENT/);
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test(
  'a directory appearing during confirmation is not adopted and starts no filesystem application',
  linux,
  async () => {
    const f = await prepared();
    try {
      await assert.rejects(
        applyIntegration(
          f.target.home,
          f.id,
          async () => {
            await mkdir(join(f.target.root, 'new-module'));
            await writeFile(join(f.target.root, 'new-module/user.txt'), 'USER_CREATED');
            return f.consent();
          },
          silent,
        ),
      );
      assert.equal(
        await readFile(join(f.target.root, 'new-module/user.txt'), 'utf8'),
        'USER_CREATED',
      );
      assert.equal((await f.read(f.id)).operation.application!.reports.length, 0);
      assert(!(await readdir(f.target.root)).some((n) => n.startsWith('.hexu-restore-')));
      assert.equal(record(f), undefined);
      const available = new WorkspaceLease(f.target.root, 'no-write-started');
      available.release();
    } finally {
      await f.close();
    }
  },
);

test(
  'a user directory winning after staging remains untouched together with owned stage and persistent intent',
  linux,
  async (t) => {
    const f = await prepared();
    try {
      const absent = PinnedRestoreParent.prototype.assertAbsent;
      let appeared = false;
      t.mock.method(
        PinnedRestoreParent.prototype,
        'assertAbsent',
        function (this: PinnedRestoreParent) {
          if (
            !appeared &&
            this.observation.path === join(f.target.root, 'new-module') &&
            readdirSync(f.target.root).some((n) => n.startsWith('.hexu-restore-'))
          ) {
            appeared = true;
            mkdirSync(this.observation.path);
            writeFileSync(join(this.observation.path, 'user.txt'), 'DO_NOT_ADOPT');
          }
          return absent.call(this);
        },
      );
      const result = await applyIntegration(f.target.home, f.id, f.consent, silent);
      assert.equal(result.state, 'needs_attention');
      t.mock.restoreAll();
      const evidence = record(f)!;
      assert.equal(evidence.directories!.length, 0);
      assert(evidence.directoryIntent!.stageIdentity);
      assert.equal(
        await readFile(join(f.target.root, 'new-module/user.txt'), 'utf8'),
        'DO_NOT_ADOPT',
      );
      assert((await lstat(join(f.target.root, evidence.directoryIntent!.stageName))).isDirectory());
      assert.deepEqual(result.appliedPaths, []);
    } finally {
      t.mock.restoreAll();
      await f.close();
    }
  },
);

test(
  'same-content replacement of a pre-existing ancestor does not replace frozen parent authority',
  linux,
  async () => {
    const f = await prepared(
        'sha1',
        { 'existing/new/deep/file': 'NEW' },
        { 'existing/keep': 'KEEP' },
      ),
      fetch = globalThis.fetch;
    let changed = false;
    try {
      globalThis.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (
          !changed &&
          String(input).endsWith('/integration-inspect') &&
          record(f)?.phase === 'applying'
        ) {
          changed = true;
          await rename(join(f.target.root, 'existing'), join(f.dir, 'original-existing'));
          await mkdir(join(f.target.root, 'existing'));
          await writeFile(join(f.target.root, 'existing/keep'), 'KEEP');
        }
        return response;
      };
      assert.equal(
        (await applyIntegration(f.target.home, f.id, f.consent, silent)).state,
        'failed',
      );
      assert(changed);
      assert.equal(record(f)!.directories!.length, 0);
      assert.equal(await readFile(join(f.target.root, 'existing/keep'), 'utf8'), 'KEEP');
      assert.equal(await readFile(join(f.dir, 'original-existing/keep'), 'utf8'), 'KEEP');
      await assert.rejects(lstat(join(f.target.root, 'existing/new')), /ENOENT/);
    } finally {
      globalThis.fetch = fetch;
      await f.close();
    }
  },
);

test(
  'directory evidence is bounded, exact, selected-file-scoped and cannot turn partial material into a settled failure',
  linux,
  async () => {
    const f = await prepared();
    try {
      assert.equal(
        (await applyIntegration(f.target.home, f.id, f.consent, silent)).state,
        'completed',
      );
      const original = record(f)!;
      assert.equal(
        parseLocalApplicationRecord(JSON.stringify(original), f.id).directories!.length,
        3,
      );
      const variants: ((r: LocalApplication) => void)[] = [
        (r) => {
          r.directories![0]!.path = 'not-selected';
        },
        (r) => {
          r.directories!.push({ ...r.directories![0]! });
        },
        (r) => {
          r.directories![0]!.identity = '1:2';
        },
        (r) => {
          delete r.directoryIntent;
        },
        (r) => {
          delete r.recoveryContext;
        },
        (r) => {
          r.phase = 'failed';
          r.added = [];
        },
        (r) => {
          (r.directories![0] as unknown as Record<string, unknown>).unrequestedPath = '/outside';
        },
        (r) => {
          r.directoryIntent = { path: 'new-module', stageName: '../other', stageIdentity: null };
        },
      ];
      for (const alter of variants) {
        const damaged = structuredClone(original);
        alter(damaged);
        assert.throws(() => parseLocalApplicationRecord(JSON.stringify(damaged), f.id), {
          code: 'INTEGRATION_JOURNAL_INVALID',
        });
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'actual process exit after the first directory keeps durable ownership and restart only reconciles',
  linux,
  async () => {
    const f = await prepared();
    try {
      const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { join } from 'node:path';
      import { applyIntegration } from './dist/apps/runner/src/agent/integration-application.js';
      const home=process.env.FIXTURE_NODE_HOME,id=process.env.FIXTURE_INTEGRATION;
      const original=globalThis.fetch;
      globalThis.fetch=async(input,init)=>{
        const response=await original(input,init);
        if(String(input).endsWith('/integration-inspect')){
          const db=new DatabaseSync(join(home,'integration-application/journal.sqlite'),{readOnly:true});
          const row=db.prepare('SELECT body FROM applications WHERE id=?').get(id);db.close();
          const record=row&&JSON.parse(row.body);
          if(record?.phase==='applying'&&record.directories?.length===1)process.exit(17);
        }
        return response;
      };
      await applyIntegration(home,id,async()=>process.env.FIXTURE_CONSENT,()=>{});
    `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          FIXTURE_NODE_HOME: f.target.home,
          FIXTURE_INTEGRATION: f.id,
          FIXTURE_CONSENT: await f.consent(),
        },
      });
      let stderr = '';
      child.stderr.on('data', (value) => {
        stderr += String(value);
      });
      assert.deepEqual(await once(child, 'exit'), [17, null], stderr);
      const before = record(f)!;
      assert.equal(before.phase, 'applying');
      assert.deepEqual(
        before.directories!.map((d) => d.path),
        ['new-module'],
      );
      assert.equal(before.added.length, 0);
      assert.throws(
        () => new WorkspaceLease(f.target.root, 'cannot-assume-exit-settled'),
        /占用|进程/,
      );
      const result = await applyIntegration(f.target.home, f.id, never, silent);
      assert.equal(result.state, 'needs_attention');
      assert.deepEqual(result.appliedPaths, []);
      assert.deepEqual(record(f)!.directories, before.directories);
      assert.deepEqual(await readdir(join(f.target.root, 'new-module')), []);
      assert.equal(
        readIntegrationApplicationStatus(f.target.home, f.id).processStoppedConfirmed,
        false,
      );
    } finally {
      await f.close();
    }
  },
);
