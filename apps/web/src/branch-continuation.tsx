import { useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { WorkBranch } from '../../../packages/contracts/src/work-branches.js';
import type { BranchContinuationPreview } from '../../../packages/contracts/src/work-branch-workspaces.js';
import { request } from '../../../packages/client/src/index.js';
import { isActiveRun } from '../../../packages/domain/src/index.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useApp } from './state.js';
import { NodeRunPanel } from './node-execution.js';

export function SelectedBranchContinue({
  task,
  branch,
}: {
  task: Task;
  branch: WorkBranch | null;
}) {
  const { data } = useApp();
  const [preview, setPreview] = useState<BranchContinuationPreview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const mine = branch?.workspace?.ticket.ownerId === data.user.id;
  const active =
    !branch?.run ||
    isActiveRun(branch.run.state) ||
    branch.run.observation === 'unknown' ||
    !branch.run.node?.terminationConfirmed;
  if (!branch && !preview && !error) return null;
  return (
    <div className="branch-continue-entry">
      {branch && !mine && <p>继续执行需要由此方案节点本人操作。</p>}
      {branch && mine && (
        <>
          <Button
            variant="primary"
            busy={busy}
            disabled={active}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const value = await request<{ branchContinuation: BranchContinuationPreview }>(
                  `/tasks/${task.id}/node-options?workBranchId=${branch.id}&continueSelected=true`,
                );
                setPreview(value.branchContinuation);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            从所选版本继续
          </Button>
          {active && <p>本方案尚未确认结束，请先查看原执行；此入口不会请求停止其他方案。</p>}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <NodeRunPanel
          task={task}
          branch={{
            selection: preview.selection,
            nodeId: preview.nodeId,
            workingCopyId: preview.workingCopyId,
            goal: '',
            continuation: preview,
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
