import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { teamFixture } from './team.js';
import { NodeRegistry } from '../../packages/db/src/nodes.js';
import { CheckpointStore } from '../../packages/db/src/checkpoints.js';
import { NodeExecution, executionHash } from '../../packages/db/src/node-execution.js';
import { WorkBranchStore } from '../../packages/db/src/work-branches.js';
import {
  parseNodeRun,
  type ExecutionEvent,
  type ExecutionPolicy,
} from '../../packages/contracts/src/node-execution.js';
import type { BranchWorkspaceOperation } from '../../packages/contracts/src/work-branch-workspaces.js';
import type { BranchResultPreview } from '../../packages/contracts/src/results.js';

/** Control/API-only protocol fixture. The prepared binding is seeded, not a real
 * directory or model run. Real filesystem/executor coverage stays in branch-workspaces. */
export async function branchResultFixture(
  origin?: string,
  inputCode = {
    objectFormat: 'sha1' as 'sha1' | 'sha256',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  },
) {
  const api = await teamFixture(origin);
  try {
    const { alice, bob } = await api.pair();
    const project = await api.project(alice),
      task = await api.task(alice, project.id, '比较订单导出的两个方案');
    const as = <T>(f: () => T) => api.store.as({ user: alice.user, spaceId: alice.spaceId }, f);
    const nodes = new NodeRegistry(api.store),
      execution = new NodeExecution(api.store, nodes),
      checkpoints = new CheckpointStore(api.store);
    const branches = new WorkBranchStore(api.store);
    const makeNode = () => {
      const token = randomBytes(32).toString('base64url'),
        workspace = randomUUID(),
        connection = randomUUID();
      const pairing = as(() => nodes.createPairing(project.id, randomUUID()));
      const node = nodes.pair({
        code: pairing.code!,
        nodeToken: token,
        clientId: randomUUID(),
        projectId: project.id,
        name: '成果协议测试节点',
        platform: 'linux',
        arch: 'x64',
        workspaces: [{ id: workspace, name: '方案协议目录' }],
      });
      nodes.hello(token, connection);
      const summary = {
        id: workspace,
        state: 'available' as const,
        capturedAt: new Date().toISOString(),
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      };
      nodes.sync(token, connection, 1, { capturedAt: summary.capturedAt, workspaces: [summary] });
      return { ...node, token, workspace, connection, summary };
    };
    const ns = [makeNode(), makeNode()];
    const request = as(() =>
      checkpoints.create(
        task.id,
        {
          nodeId: ns[0]!.nodeId,
          workspaceId: ns[0]!.workspace,
          commit: inputCode.commit,
          label: '协议夹具共同起点',
          expectedTaskRevision: task.revision,
          confirmReference: true,
        },
        randomUUID(),
      ),
    );
    const at = new Date().toISOString();
    const cp = checkpoints.publish(ns[0]!.token, {
      requestId: request.id,
      requestHash: request.requestHash,
      confirmPublication: true,
      manifest: {
        version: 1,
        kind: 'git_commit_reference',
        objectFormat: inputCode.objectFormat,
        commit: request.commit,
        tree: inputCode.tree,
        repositoryIdentity: 'c'.repeat(64),
        verifiedAt: at,
        verifiedObjects: 'commit_and_root_tree',
        availability: 'local_reference',
        workingCopy: { ...ns[0]!.summary, capturedAt: at },
      },
    });
    const view = as(() =>
      branches.create(
        task.id,
        {
          expectedTaskRevision: task.revision,
          checkpointId: cp.checkpointId,
          branches: [
            { name: '方案 A', goal: '分页读取并导出' },
            { name: '方案 B', goal: '后台异步导出' },
          ],
        },
        randomUUID(),
      ),
    );
    for (const [i, node] of ns.entries()) {
      const b = view.branches[i]!;
      const op: BranchWorkspaceOperation = {
        ticket: {
          id: randomUUID(),
          taskId: task.id,
          branchId: b.id,
          branchRevision: b.revision,
          groupId: view.group.id,
          startHash: view.group.startHash,
          ownerId: alice.user.id,
          projectId: project.id,
          spaceId: alice.spaceId,
          sourceNodeId: ns[0]!.nodeId,
          retentionId: randomUUID(),
          checkpointId: cp.checkpointId,
          manifest: {
            version: 1,
            kind: 'git_snapshot_objects',
            objectFormat: inputCode.objectFormat,
            commit: request.commit,
            tree: inputCode.tree,
            repositoryIdentity: 'c'.repeat(64),
            snapshotHash: 'd'.repeat(64),
            coverage: {
              objects: 3,
              bytes: 200,
              files: 1,
              trees: 1,
              symlinks: 0,
              gitlinks: 0,
              lfsPointers: 0,
            },
            scope: 'commit_snapshot_without_ancestors_or_external_content',
            retainedAt: at,
            expiresAt: new Date(Date.now() + 86400000).toISOString(),
          },
          createdAt: at,
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
          requestHash: 'e'.repeat(64),
        },
        state: 'bound',
        revision: 3,
        proof: {
          originHash: 'f'.repeat(64),
          workspaceRef: '1'.repeat(64),
          restoreId: randomUUID(),
          planHash: '2'.repeat(64),
          snapshotHash: 'd'.repeat(64),
          verifiedAt: at,
        },
        proofHash: '3'.repeat(64),
        nodeId: node.nodeId,
        workingCopyId: node.workspace,
        updatedAt: at,
        reason: null,
      };
      as(() =>
        api.store.atomic(() => {
          api.store.db
            .prepare('INSERT INTO work_branch_workspaces VALUES(?,?,?,?,?,?,?)')
            .run(
              op.ticket.id,
              b.id,
              task.id,
              'bound',
              node.nodeId,
              node.workspace,
              JSON.stringify(op),
            );
          branches.change(
            api.store.getTask(task.id),
            { ...b, workingCopyId: node.workspace },
            'workspace_bound',
          );
        }),
      );
    }
    const read = () => as(() => branches.get(task.id, view.group.id));
    const path = (index = 0) => `tasks/${task.id}/work-branches/${view.branches[index]!.id}`;
    const begin = (index = 0, tool: 'claude-code' | 'codex' = 'claude-code') => {
      const n = ns[index]!,
        b = read().branches[index]!;
      const policy: ExecutionPolicy = {
        grantId: randomUUID(),
        tool,
        model: 'protocol-test-model',
        mode: 'edit',
        workspaceIds: [n.workspace],
        timeoutSeconds: 30,
        maxTurns: 8,
        maxBudgetUsd: tool === 'codex' ? null : 1,
        toolVersion: 'protocol fixture',
      };
      execution.publish(n.token, n.connection, policy);
      const run = as(() =>
        execution.create(
          task.id,
          parseNodeRun({
            provider: 'node',
            nodeId: n.nodeId,
            workingCopyId: n.workspace,
            policyHash: executionHash(policy),
            mode: 'edit',
            prompt: `RESULT_INPUT_${index}`,
            expectedRevision: api.store.getTask(task.id).revision,
            confirmExecution: true,
            workBranch: {
              branchId: b.id,
              expectedRevision: b.revision,
              startHash: view.group.startHash,
            },
          }),
          randomUUID(),
        ),
      );
      const command = execution.poll(n.token, n.connection).command!;
      let sequence = 0;
      const send = (
        kind: ExecutionEvent['kind'],
        text = '',
        result: ExecutionEvent['result'] = null,
      ) =>
        execution.acceptEvent(n.token, command.id, command.generation, {
          sequence: ++sequence,
          kind,
          text,
          result,
          terminationConfirmed: kind === 'terminal',
        });
      const start = () => {
        send('accepted');
        assert(execution.permit(n.token, n.connection, command.id, command.generation).allowed);
        send('running');
      };
      return {
        run,
        command,
        send,
        start,
        finish: (
          state: 'succeeded' | 'failed' | 'cancelled' = 'succeeded',
          output = '协议夹具最终输出',
        ) => send('terminal', output, state),
      };
    };
    const draft = async (index = 0) => {
      const reply = await api.call(path(index) + '/result-preview', alice);
      assert.equal(reply.statusCode, 200, reply.body);
      const v = reply.json() as BranchResultPreview;
      return {
        expectedRevision: v.branchRevision,
        expectedResultRevision: v.resultRevision,
        sourceRunId: v.source.run.id,
        expectedRunRevision: v.source.run.revision,
        title: `方案 ${index === 0 ? 'A' : 'B'} 成果`,
        body: '已完成分批读取的实现说明。',
        limitations: '暂未固定代码文件。',
      };
    };
    return {
      api,
      alice,
      bob,
      project,
      task,
      as,
      nodes,
      execution,
      ns,
      view,
      read,
      path,
      begin,
      draft,
      close: api.close,
    };
  } catch (e) {
    await api.close();
    throw e;
  }
}
