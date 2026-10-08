import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../packages/db/src/store.js';
import { AgentCapabilitiesStore } from '../packages/db/src/agent-capabilities.js';
import { canonicalJson } from '../packages/domain/src/index.js';
import { DomainError } from '../packages/contracts/src/index.js';
import type { AssistanceDetail } from '../packages/contracts/src/assistance.js';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;
function fixture(autoAccept = false, path = ':memory:') {
  const store = new Store(path, undefined, { team: true }),
    db = store.db;
  for (const id of ['alice', 'bob'])
    db.prepare('INSERT INTO collab_people VALUES(?,?,?)').run(id, id, `${id}@example.invalid`);
  db.prepare('INSERT INTO collab_spaces VALUES(?,?,?,?)').run(
    's',
    'Fictional',
    'team',
    new Date().toISOString(),
  );
  for (const id of ['alice', 'bob']) {
    db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run('s', id, 'owner');
  }
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run(
    'p',
    's',
    JSON.stringify({ id: 'p', spaceId: 's', archivedAt: null }),
  );
  for (const id of ['alice', 'bob'])
    db.prepare('INSERT INTO collab_project_members VALUES(?,?,?)').run('p', id, 'manage');
  const task = {
    id: 't',
    title: 'private title',
    shortId: 'T-1',
    spaceId: 's',
    projectId: 'p',
    visibility: 'project',
    ownerUserId: 'alice',
    revision: 1,
  };
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run('t', 's', 'p', JSON.stringify(task));
  const message = {
    id: 'm',
    taskId: 't',
    actorType: 'human',
    actorName: 'alice',
    body: 'selected text\nprivate remainder',
    createdAt: new Date().toISOString(),
  };
  db.prepare('INSERT INTO messages VALUES(?,?,?)').run('m', 't', JSON.stringify(message));
  const as = <T>(id: string, fn: () => T) =>
    store.as({ user: { id, name: id, email: `${id}@example.invalid` }, spaceId: 's' }, fn);
  const resources = new AgentCapabilitiesStore(store);
  const agent = as('bob', () => {
    let a = resources.register(
      { name: 'Fictional recipient', nativeInstanceRef: null },
      randomUUID(),
    );
    a = resources.setEndpoint(
      a.id,
      {
        expectedRevision: 0,
        protocol: 'custom',
        address: 'https://example.invalid',
        implementation: 'fixture',
        implementationVersion: '1',
        receiveMode: 'poll',
      },
      randomUUID(),
    );
    a = resources.setCapability(
      a.id,
      { expectedRevision: 0, title: 'fixture', description: 'text only' },
      randomUUID(),
    );
    return resources.grant(
      a.id,
      {
        projectId: 'p',
        audience: 'selected_members',
        requesterUserIds: ['alice'],
        request: true,
        autoAccept,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxConcurrent: 1,
        costBearer: 'owner',
        expectedCapabilityVersion: 1,
        expectedEndpointRevision: 1,
      },
      randomUUID(),
    );
  });
  const grant = agent.grants[0]!;
  const target = {
    participantId: agent.id,
    capabilityId: agent.capability!.id,
    capabilityVersion: 1,
    endpointRevision: 1,
    grantId: grant.id,
    grantRevision: 1,
  };
  const preview = () =>
    as('alice', () =>
      store.agentAssistance.preview('t', {
        target,
        requesterParticipantId: null,
        input: {
          question: 'explain',
          clarification: null,
          message: {
            sourceMessageId: 'm',
            expectedSourceHash: hash(message),
            range: { start: 0, end: 13 },
          },
          projectTexts: { items: [], expectedHash: '0'.repeat(64) },
        },
      }),
    );
  const body = () => {
    const p = preview();
    return {
      target,
      requesterParticipantId: null,
      input: p.input,
      expectedTaskRevision: 1,
      expectedInputHash: p.inputHash,
      shareConfirmed: true,
    };
  };
  const create = (key: string = randomUUID()) =>
    as('alice', () => store.agentAssistance.create('t', body(), key));
  const response = (d: AssistanceDetail, type: string, extra = {}) => ({
    expectedRevision: d.assistance.revision,
    inputRevision: d.assistance.agent!.currentInputRevision,
    expectedAccessRevision: d.assistance.agent!.accessRevision,
    expectedInputHash: d.assistance.agent!.inputHash,
    type,
    ...extra,
  });
  const respond = (d: AssistanceDetail, type: string, extra = {}, key: string = randomUUID()) =>
    as('bob', () => store.agentAssistance.respond(d.assistance.id, response(d, type, extra), key));
  return {
    store,
    db,
    as,
    resources,
    agent,
    grant,
    target,
    preview,
    body,
    create,
    response,
    respond,
    message,
  };
}
test('original Assistance authority, immutable inputs, atomic accept capacity and ID-only replay', () => {
  const f = fixture();
  try {
    const initialCounts = ['tasks', 'runs', 'messages'].map(
      (t) => (f.db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n,
    );
    const a = f.create('a'),
      b = f.create('b');
    assert.equal(a.assistance.recipientKind, 'agent');
    assert.equal(
      f.as('alice', () => f.store.assistance.get(a.assistance.id)).assistance.id,
      a.assistance.id,
    );
    const accepted = f.respond(a, 'accept', {}, 'accept');
    assert.equal(accepted.assistance.agent!.phase, 'accepted');
    assert.throws(() => f.respond(b, 'accept'), code('CAPACITY_LIMIT'));
    const before = (f.db.prepare('SELECT count(*) n FROM outbox').get() as { n: number }).n;
    const replay = f.respond(a, 'accept', {}, 'accept');
    assert.equal(replay.assistance.revision, accepted.assistance.revision);
    assert.equal((f.db.prepare('SELECT count(*) n FROM outbox').get() as { n: number }).n, before);
    assert.throws(
      () =>
        f.as('bob', () =>
          f.store.agentAssistance.respond(
            a.assistance.id,
            f.response(a, 'decline', { body: 'no' }),
            'accept',
          ),
        ),
      code('IDEMPOTENCY_CONFLICT'),
    );
    const waiting = f.respond(accepted, 'request_input', { body: 'why?' });
    assert.equal(waiting.assistance.state, 'open');
    assert.throws(
      () => f.respond(waiting, 'answer', { body: 'premature' }),
      code('AWAITING_INPUT'),
    );
    const p = f.preview();
    const rev = {
      expectedRevision: waiting.assistance.revision,
      expectedInputRevision: 1,
      expectedAccessRevision: 1,
      expectedTaskRevision: 1,
      causeResponseId: waiting.assistance.agent!.pendingResponseId,
      input: p.input,
      expectedInputHash: p.inputHash,
      shareConfirmed: true,
    };
    const updated = f.as('alice', () =>
      f.store.agentAssistance.revise(a.assistance.id, rev, 'revise'),
    );
    assert.equal(updated.assistance.agent!.currentInputRevision, 2);
    assert.equal(
      (f.db.prepare('SELECT count(*) n FROM assistance_agent_capacity').get() as { n: number }).n,
      0,
    );
    assert.throws(
      () => f.db.prepare('UPDATE assistance_input_revisions SET body=?').run('{}'),
      /immutable/,
    );
    const bAccepted = f.respond(b, 'accept');
    const answer = f.respond(bAccepted, 'answer', { body: 'bounded answer' });
    assert.equal(answer.assistance.state, 'responded');
    assert.equal(answer.assistance.canAdopt, false);
    assert.throws(
      () => f.as('alice', () => f.store.assistance.adoptionContext('t', b.assistance.id, true)),
      code('AGENT_ADOPTION_UNSUPPORTED'),
    );
    assert.throws(
      () =>
        f.as('alice', () =>
          f.store.assistance.reply(
            b.assistance.id,
            { body: 'bypass', expectedRevision: answer.assistance.revision },
            'old',
          ),
        ),
      code('USE_TYPED_RESPONSE'),
    );
    assert.deepEqual(
      ['tasks', 'runs', 'messages'].map(
        (t) => (f.db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n,
      ),
      initialCounts,
    );
    const receipts = f.db
      .prepare("SELECT result FROM idempotency_records WHERE scope LIKE '%agent.assistance:%'")
      .all() as { result: string }[];
    assert.ok(receipts.every((r) => Object.keys(JSON.parse(r.result)).join() === 'id'));
  } finally {
    f.store.close();
  }
});
test('auto acceptance is per grant capacity and source changes block new responses', () => {
  const f = fixture(true);
  try {
    const a = f.create(),
      b = f.create();
    assert.equal(a.assistance.agent!.phase, 'accepted');
    assert.equal(a.assistance.agent!.responses[0]!.actor.kind, 'policy');
    assert.equal(b.assistance.agent!.phase, 'awaiting_acceptance');
    assert.equal(b.assistance.agent!.capacityBlocked, true);
    f.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...f.message, body: 'changed' }), 'm');
    assert.throws(() => f.respond(a, 'answer', { body: 'stale' }), code('INPUT_STALE'));
    assert.equal(
      f.as('bob', () => f.store.agentAssistance.get(a.assistance.id)).assistance.agent!
        .materials[0]!.text,
      'selected text',
    );
  } finally {
    f.store.close();
  }
});
test('revocation cancels original Assistance and releases capacity permanently; old receipts cannot reveal materials', () => {
  const f = fixture(true);
  try {
    const a = f.create();
    const input = f.response(a, 'request_input', { body: 'question' });
    f.as('bob', () => f.store.agentAssistance.respond(a.assistance.id, input, 'response'));
    f.as('bob', () =>
      f.resources.revokeGrant(f.agent.id, f.grant.id, { expectedRevision: 1 }, 'revoke'),
    );
    assert.equal(
      (
        f.db.prepare('SELECT state FROM assistances WHERE id=?').get(a.assistance.id) as {
          state: string;
        }
      ).state,
      'cancelled',
    );
    assert.equal(
      (f.db.prepare('SELECT count(*) n FROM assistance_agent_capacity').get() as { n: number }).n,
      0,
    );
    assert.throws(
      () => f.as('bob', () => f.store.agentAssistance.respond(a.assistance.id, input, 'response')),
      code('NOT_FOUND'),
    );
    assert.equal(
      f.as('alice', () => f.store.agentAssistance.get(a.assistance.id)).assistance.accessEnded,
      true,
    );
  } finally {
    f.store.close();
  }
});
test('transaction rollback covers input, grants, assistance, receipt and outbox', () => {
  const f = fixture();
  try {
    const counts = () =>
      [
        'assistances',
        'assistance_agent_requests',
        'assistance_input_revisions',
        'assistance_input_grants',
        'assistance_events',
        'idempotency_records',
        'outbox',
      ].map((t) => (f.db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n);
    const before = counts();
    f.db.exec(
      "CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox WHEN NEW.assistance_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture injected outbox fault'); END",
    );
    assert.throws(() => f.create('atomic'), /fixture injected/);
    assert.deepEqual(counts(), before);
    f.db.exec('DROP TRIGGER test_fail_outbox');
    const a = f.create('atomic');
    assert.equal(a.assistance.state, 'open');
  } finally {
    f.store.close();
  }
});

test('close retains reads, then explicit cancel revokes and same key confirms without reopening', () => {
  const f = fixture();
  try {
    const a = f.create();
    const closed = f.as('alice', () =>
      f.store.assistance.change(
        a.assistance.id,
        { expectedRevision: a.assistance.revision, action: 'close' },
        'close',
      ),
    );
    assert.equal(
      f.as('bob', () => f.store.assistance.get(a.assistance.id)).assistance.state,
      'closed',
    );
    const command = { expectedRevision: closed.assistance.revision, action: 'cancel' };
    const cancelled = f.as('alice', () =>
      f.store.assistance.change(a.assistance.id, command, 'cancel'),
    );
    assert.equal(cancelled.assistance.agent!.terminalReason, 'cancelled');
    assert.equal(
      f.as('alice', () => f.store.assistance.change(a.assistance.id, command, 'cancel')).assistance
        .revision,
      cancelled.assistance.revision,
    );
    assert.equal(
      (
        f.db
          .prepare(
            'SELECT action FROM assistance_events WHERE assistance_id=? ORDER BY revision DESC LIMIT 1',
          )
          .get(a.assistance.id) as { action: string }
      ).action,
      'cancelled',
    );
  } finally {
    f.store.close();
  }
});

test('fixed message anchor cannot be dropped by scope proposal; private task cannot borrow project grant', () => {
  const f = fixture();
  try {
    const a = f.create();
    assert.throws(
      () =>
        f.respond(a, 'propose_scope', {
          body: 'remove all',
          scope: { question: 'changed', materialIds: [] },
        }),
      code('SCOPE_EXPANSION'),
    );
    const proposed = f.respond(a, 'propose_scope', {
      body: 'narrow',
      scope: { question: 'narrow question', materialIds: [a.assistance.agent!.materials[0]!.id] },
    });
    assert.equal(proposed.assistance.agent!.phase, 'waiting_input');
    assert.equal(proposed.assistance.question, 'explain');
    const task = f.db.prepare('SELECT body FROM tasks WHERE id=?').get('t') as { body: string };
    f.db
      .prepare('UPDATE tasks SET body=? WHERE id=?')
      .run(JSON.stringify({ ...JSON.parse(task.body), visibility: 'private' }), 't');
    assert.throws(() => f.preview(), code('AGENT_ASSISTANCE_SCOPE'));
  } finally {
    f.store.close();
  }
});

test('same owner distinct participants allowed; same participant refused', () => {
  const f = fixture();
  try {
    const own = f.as('bob', () =>
      f.resources.register({ name: 'requester agent', nativeInstanceRef: null }, randomUUID()),
    );
    const recipient = f.as('bob', () =>
      f.resources.grant(
        f.agent.id,
        {
          projectId: 'p',
          audience: 'selected_members',
          requesterUserIds: ['bob'],
          request: true,
          autoAccept: false,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          maxConcurrent: 1,
          costBearer: 'owner',
          expectedCapabilityVersion: 1,
          expectedEndpointRevision: 1,
        },
        randomUUID(),
      ),
    );
    const grant = recipient.grants.find((g) => g.requesterUserIds.includes('bob'))!;
    const original = f.preview();
    const preview = f.as('bob', () =>
      f.store.agentAssistance.preview('t', {
        target: { ...f.target, grantId: grant.id },
        requesterParticipantId: own.id,
        input: original.input,
      }),
    );
    const result = f.as('bob', () =>
      f.store.agentAssistance.create(
        't',
        {
          target: preview.target,
          requesterParticipantId: own.id,
          input: preview.input,
          expectedTaskRevision: preview.expectedTaskRevision,
          expectedInputHash: preview.inputHash,
          shareConfirmed: true,
        },
        'same-owner',
      ),
    );
    assert.equal(result.assistance.requester.id, result.assistance.recipient.id);
    assert.equal(result.assistance.agent!.requesterParticipantId, own.id);
    assert.throws(
      () =>
        f.as('bob', () =>
          f.store.agentAssistance.preview('t', {
            target: preview.target,
            requesterParticipantId: f.agent.id,
            input: preview.input,
          }),
        ),
      code('INVALID_PARTICIPANT'),
    );
  } finally {
    f.store.close();
  }
});

test('input, grant, response, capacity, event, receipt and outbox failures each roll back whole aggregate', () => {
  for (const table of [
    'assistance_input_revisions',
    'assistance_input_grants',
    'assistance_replies',
    'assistance_agent_capacity',
    'assistance_events',
    'idempotency_records',
    'outbox',
  ]) {
    const f = fixture(true);
    try {
      const tables = [
        'assistances',
        'assistance_agent_requests',
        'assistance_input_revisions',
        'assistance_input_grants',
        'assistance_replies',
        'assistance_agent_capacity',
        'assistance_events',
        'idempotency_records',
        'outbox',
      ];
      const counts = () =>
        tables.map((t) => (f.db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n);
      const before = counts();
      f.db.exec(
        `CREATE TRIGGER fixture_fail BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END`,
      );
      assert.throws(() => f.create('fault'), /fixture transaction failure/, table);
      assert.deepEqual(counts(), before, table);
      f.db.exec('DROP TRIGGER fixture_fail');
      assert.equal(f.create('fault').assistance.agent!.phase, 'accepted');
    } finally {
      f.store.close();
    }
  }
});

test('expiry, archival, endpoint/capability changes and membership removal permanently end authority', () => {
  for (const reason of [
    'expiry',
    'archive',
    'endpoint',
    'capability',
    'project_member',
    'space_member',
  ]) {
    const f = fixture(true);
    try {
      const a = f.create();
      if (reason === 'expiry')
        f.db
          .prepare(
            "UPDATE agent_delegation_grants SET body=json_set(body,'$.expiresAt','2000-01-01T00:00:00.000Z') WHERE id=?",
          )
          .run(f.grant.id);
      if (reason === 'archive')
        f.db
          .prepare(
            "UPDATE projects SET body=json_set(body,'$.archivedAt','2026-10-08T00:00:00.000Z') WHERE id='p'",
          )
          .run();
      if (reason === 'endpoint')
        f.db
          .prepare('UPDATE agent_endpoints SET revision=revision+1 WHERE participant_id=?')
          .run(f.agent.id);
      if (reason === 'capability')
        f.db
          .prepare('UPDATE agent_capabilities SET version=version+1 WHERE participant_id=?')
          .run(f.agent.id);
      if (reason === 'project_member')
        f.db
          .prepare("DELETE FROM collab_project_members WHERE project_id='p' AND user_id='bob'")
          .run();
      if (reason === 'space_member')
        f.db.prepare("DELETE FROM collab_memberships WHERE space_id='s' AND user_id='bob'").run();
      assert.throws(() => f.respond(a, 'answer', { body: 'late' }), code('NOT_FOUND'), reason);
      assert.equal(
        (f.db.prepare('SELECT count(*) n FROM assistance_agent_capacity').get() as { n: number }).n,
        0,
        reason,
      );
      assert.equal(
        f.as('alice', () => f.store.agentAssistance.get(a.assistance.id)).assistance.state,
        'cancelled',
        reason,
      );
      if (reason === 'project_member')
        f.db.prepare("INSERT INTO collab_project_members VALUES('p','bob','manage')").run();
      if (reason === 'space_member')
        f.db.prepare("INSERT INTO collab_memberships VALUES('s','bob','member')").run();
      if (reason === 'archive')
        f.db
          .prepare("UPDATE projects SET body=json_set(body,'$.archivedAt',NULL) WHERE id='p'")
          .run();
      if (reason === 'expiry')
        f.db
          .prepare(
            "UPDATE agent_delegation_grants SET body=json_set(body,'$.expiresAt',?) WHERE id=?",
          )
          .run(new Date(Date.now() + 3600000).toISOString(), f.grant.id);
      assert.throws(() => f.respond(a, 'accept'), code('NOT_FOUND'), reason);
    } finally {
      f.store.close();
    }
  }
});

test('two real SQLite connections race for one acceptance reservation atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hexu-negotiation-race-')),
    path = join(dir, 'fixture.sqlite'),
    f = fixture(false, path);
  const workers: Worker[] = [];
  try {
    const first = f.create(),
      second = f.create();
    const start = async (d: AssistanceDetail) => {
      const worker = new Worker(
        `const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {Store}=await import(workerData.module);const store=new Store(workerData.path,undefined,{team:true});store.db.exec('PRAGMA busy_timeout=2000');parentPort.once('message',()=>{try{const result=store.as({user:{id:'bob',name:'bob',email:'bob@example.invalid'},spaceId:'s'},()=>store.agentAssistance.respond(workerData.id,workerData.body,workerData.key));parentPort.postMessage({ok:true,phase:result.assistance.agent.phase});}catch(e){parentPort.postMessage({ok:false,code:e.code,message:e.message});}finally{store.close();parentPort.close();}});parentPort.postMessage({ready:true});})();`,
        {
          eval: true,
          workerData: {
            module: new URL('../packages/db/src/store.js', import.meta.url).href,
            path,
            id: d.assistance.id,
            body: f.response(d, 'accept'),
            key: randomUUID(),
          },
        },
      );
      workers.push(worker);
      await once(worker, 'message');
      return worker;
    };
    const a = await start(first),
      b = await start(second);
    const results = Promise.all([once(a, 'message'), once(b, 'message')]);
    a.postMessage('go');
    b.postMessage('go');
    const outcomes = (await results).map((x) => x[0]);
    assert.equal(outcomes.filter((x) => x.ok).length, 1, JSON.stringify(outcomes));
    assert.equal(
      outcomes.filter((x) => x.code === 'CAPACITY_LIMIT').length,
      1,
      JSON.stringify(outcomes),
    );
    assert.equal(
      (f.db.prepare('SELECT count(*) n FROM assistance_agent_capacity').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (
        f.db.prepare("SELECT count(*) n FROM assistance_events WHERE action='accept'").get() as {
          n: number;
        }
      ).n,
      1,
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stale input prevents accept and answer but permits business decline or clarification without provider retry', () => {
  const f = fixture();
  try {
    const a = f.create(),
      b = f.create();
    const accepted = f.respond(a, 'accept');
    f.db
      .prepare('UPDATE messages SET body=? WHERE id=?')
      .run(JSON.stringify({ ...f.message, body: 'changed content' }), 'm');
    assert.throws(() => f.respond(b, 'accept'), code('INPUT_STALE'));
    assert.throws(() => f.respond(accepted, 'answer', { body: 'stale' }), code('INPUT_STALE'));
    const declined = f.respond(accepted, 'decline', { body: 'Cannot answer old input' });
    assert.equal(declined.assistance.state, 'closed');
    assert.equal(
      (f.db.prepare('SELECT count(*) n FROM assistance_agent_capacity').get() as { n: number }).n,
      0,
    );
    const pending = f.respond(b, 'request_input', { body: 'Please confirm new text' });
    assert.equal(pending.assistance.agent!.phase, 'waiting_input');
    f.as('bob', () =>
      f.resources.revokeGrant(f.agent.id, f.grant.id, { expectedRevision: 1 }, 'revoke-stale'),
    );
    assert.throws(() => f.respond(pending, 'decline', { body: 'late' }), code('NOT_FOUND'));
  } finally {
    f.store.close();
  }
});

test('project source selection is explicit pure text, immutable and version-bound; links never become input', () => {
  const f = fixture();
  try {
    const source = f.as('alice', () =>
      f.store.projectSources.create(
        'p',
        { kind: 'text', title: 'Approved note', content: 'finite shared knowledge', url: null },
        randomUUID(),
      ),
    );
    const p = f.preview();
    const selection = {
      ...p.input,
      projectTexts: {
        items: [
          {
            id: source.id,
            revision: source.revision,
            contentHash: source.contentHash,
            maxChars: 6,
          },
        ],
        expectedHash: '0'.repeat(64),
      },
    };
    const preview = f.as('alice', () =>
      f.store.agentAssistance.preview('t', {
        target: f.target,
        requesterParticipantId: null,
        input: selection,
      }),
    );
    assert.deepEqual(
      preview.materials.map((m) => m.id),
      ['message', `text-${createHash('sha256').update(source.id).digest('hex')}`],
    );
    assert.equal(preview.materials[1]!.text, 'finite');
    const body = {
      target: f.target,
      requesterParticipantId: null,
      input: preview.input,
      expectedTaskRevision: 1,
      expectedInputHash: preview.inputHash,
      shareConfirmed: true,
    };
    const a = f.as('alice', () => f.store.agentAssistance.create('t', body, 'source'));
    f.as('alice', () =>
      f.store.projectSources.edit(
        'p',
        source.id,
        {
          expectedRevision: source.revision,
          title: source.title,
          content: 'changed knowledge',
          url: null,
        },
        randomUUID(),
      ),
    );
    assert.throws(() => f.respond(a, 'accept'), code('INPUT_STALE'));
    assert.equal(
      f.as('bob', () => f.store.agentAssistance.input(a.assistance.id, 1)).materials[1]!.text,
      'finite',
    );
    const link = f.as('alice', () =>
      f.store.projectSources.create(
        'p',
        {
          kind: 'link',
          title: 'Not fetched',
          content: 'description only',
          url: 'https://example.invalid',
        },
        randomUUID(),
      ),
    );
    assert.throws(
      () =>
        f.as('alice', () =>
          f.store.agentAssistance.preview('t', {
            target: f.target,
            requesterParticipantId: null,
            input: {
              ...p.input,
              projectTexts: {
                items: [
                  {
                    id: link.id,
                    revision: link.revision,
                    contentHash: link.contentHash,
                    maxChars: 10,
                  },
                ],
                expectedHash: '0'.repeat(64),
              },
            },
          }),
        ),
      code('INPUT_STALE'),
    );
  } finally {
    f.store.close();
  }
});
