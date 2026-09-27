import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Store } from '../../packages/db/src/store.js';
import { NodeRegistry } from '../../packages/db/src/nodes.js';
import { NodeExecution, executionHash } from '../../packages/db/src/node-execution.js';
import {
  parseNodeRun,
  type ExecutionPolicy,
  type ExecutionEvent,
} from '../../packages/contracts/src/node-execution.js';
import { parsePair } from '../../packages/contracts/src/nodes.js';
import type { IdentityUser } from '../../packages/contracts/src/identity.js';
const key = () => randomUUID();
export function aiStoreFixture() {
  const store = new Store(':memory:', undefined, { team: true });
  const alice: IdentityUser = {
    id: key(),
    email: 'node-owner@example.invalid',
    name: '节点所有者',
  };
  const bob: IdentityUser = {
    id: key(),
    email: 'project-editor@example.invalid',
    name: '其他项目成员',
  };
  store.collaboration.ensurePerson(alice);
  store.collaboration.ensurePerson(bob);
  const space = store.as({ user: alice, spaceId: `personal-${alice.id}` }, () =>
    store.collaboration.createSpace('执行测试', key()),
  );
  store.db.prepare('INSERT INTO collab_memberships VALUES(?,?,?)').run(space.id, bob.id, 'member');
  const as = <T>(fn: () => T, user = alice) => store.as({ user, spaceId: space.id }, fn);
  const project = as(() =>
    store.createProject({ name: '本机明确授权项目', description: '' }, key()),
  );
  store.db
    .prepare('INSERT INTO collab_project_members VALUES(?,?,?)')
    .run(project.id, bob.id, 'edit');
  const task = as(() =>
    store.createTask({ title: '实际任务', description: '原始说明', projectId: project.id }, key()),
  );
  const nodes = new NodeRegistry(store),
    execution = new NodeExecution(store, nodes);
  const token = randomBytes(32).toString('base64url'),
    workspace = key(),
    connection = key();
  const pairing = as(() => nodes.createPairing(project.id, key()));
  const n = nodes.pair(
    parsePair({
      protocol: 1,
      code: pairing.code,
      nodeToken: token,
      clientId: key(),
      projectId: project.id,
      name: '本人电脑',
      platform: 'linux',
      arch: 'x64',
      workspaces: [{ id: workspace, name: '项目目录' }],
    }),
  );
  nodes.hello(token, connection);
  nodes.sync(token, connection, 1, {
    capturedAt: new Date().toISOString(),
    workspaces: [
      {
        id: workspace,
        state: 'available',
        capturedAt: new Date().toISOString(),
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
    ],
  });
  const policy: ExecutionPolicy = {
    grantId: key(),
    tool: 'claude-code',
    textAssistance: true,
    model: null,
    mode: 'edit',
    workspaceIds: [workspace],
    timeoutSeconds: 30,
    maxTurns: 8,
    maxBudgetUsd: 1,
    toolVersion: 'protocol fixture only',
  };
  const publish = () => execution.publish(token, connection, policy);
  const body = () => ({
    provider: 'node',
    nodeId: n.nodeId,
    workingCopyId: workspace,
    policyHash: executionHash(policy),
    mode: 'edit',
    prompt: '实现范围明确的修改',
    expectedRevision: as(() => store.getTask(task.id).revision),
    confirmExecution: true,
  });
  const create = (idempotency: string = key()) =>
    as(() => execution.create(task.id, parseNodeRun(body()), idempotency));
  const command = () => execution.poll(token, connection).command!;
  const send = (
    c: ReturnType<typeof command>,
    sequence: number,
    kind: ExecutionEvent['kind'],
    result: ExecutionEvent['result'] = null,
    text = '',
  ) =>
    execution.acceptEvent(token, c.id, c.generation, {
      sequence,
      kind,
      result,
      text,
      terminationConfirmed: kind === 'terminal',
    });
  const running = () => {
    publish();
    const run = create(),
      c = command();
    send(c, 1, 'accepted');
    assert.equal(execution.permit(token, connection, c.id, c.generation).allowed, true);
    send(c, 2, 'running');
    return { run, c };
  };
  return {
    store,
    nodes,
    execution,
    alice,
    bob,
    space,
    project,
    task,
    token,
    workspace,
    connection,
    n,
    policy,
    publish,
    body,
    create,
    command,
    send,
    running,
    as,
    close: () => store.close(),
  };
}
