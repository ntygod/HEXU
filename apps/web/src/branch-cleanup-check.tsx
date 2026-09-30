import { useEffect, useState } from 'react';
import type { WorkBranch } from '../../../packages/contracts/src/work-branches.js';
import type { BranchCleanupOptions } from '../../../packages/contracts/src/branch-cleanup-check.js';
import { Button, Dialog } from '../../../packages/ui/src/index.js';
import { useAssistanceRead } from './assistance-common.js';
import { time, useApp } from './state.js';
import { branchCleanupCommand } from './branch-cleanup-command.js';

function Inspector({
  branch,
  close,
  denied,
}: {
  branch: WorkBranch;
  close(): void;
  denied(): void;
}) {
  const { data } = useApp(),
    read = useAssistanceRead<BranchCleanupOptions>(
      `/tasks/${branch.taskId}/work-branches/${branch.id}/cleanup-options`,
    );
  const [baseline, setBaseline] = useState<BranchCleanupOptions | null>(null),
    [selected, setSelected] = useState(''),
    [showCommand, setShowCommand] = useState(false);
  useEffect(() => {
    if (!baseline && read.value) setBaseline(structuredClone(read.value));
  }, [baseline, read.value]);
  useEffect(() => {
    if (read.denied) denied();
  }, [read.denied]);
  const material = baseline?.materials.find((m) => m.retention.request.id === selected),
    current = read.value?.materials.find((m) => m.retention.request.id === selected),
    task = data.tasks.find((t) => t.id === branch.taskId),
    stale =
      !!baseline &&
      ((!!task && task.revision > baseline.taskRevision) ||
        (!!read.value &&
          (baseline.branch.revision !== read.value.branch.revision ||
            baseline.taskRevision !== read.value.taskRevision ||
            baseline.originHash !== read.value.originHash ||
            baseline.canInspect !== read.value.canInspect ||
            (!!material && JSON.stringify(material) !== JSON.stringify(current))))),
    available =
      !!baseline?.canInspect &&
      !!read.value?.canInspect &&
      !!material &&
      !!current &&
      !stale &&
      !read.error;
  if (read.denied) return null;
  return (
    <Dialog title="清理前核对现场保护" drawer onClose={close}>
      <div className="dialog-body work-branch-lifecycle work-branch-workspace">
        <strong>{branch.name}</strong>
        <p>
          当前只提供保护条件核对，没有目录删除或解绑动作。检查不会停止执行、清除占用、回滚修改或自动创建检查点。
        </p>
        <dl>
          <dt>固定方案</dt>
          <dd>
            <code>{branch.id}</code> · 修订 {baseline?.branch.revision ?? branch.revision}
          </dd>
          <dt>原登记目录</dt>
          <dd>
            <code>{branch.workingCopyId}</code>
          </dd>
          <dt>保留范围</dt>
          <dd>所选提交的完整普通文件快照；不包含未提交/未跟踪/忽略文件、Git祖先历史或其他引用。</dd>
        </dl>
        {!baseline && !read.error && <p role="status">正在核对原现场与本人可用副本…</p>}
        {baseline && !baseline.canInspect && (
          <p className="work-branch-notice" role="status">
            {baseline.unavailableReason}
          </p>
        )}
        <p className="work-branch-notice">
          先单独停止原执行并等待终止确认，再退出原节点的同步进程；不要杀死未核对的旧PID。清理前有任何用户修改、活动或未知占用、待发执行/登记回执都应先保留现场。一次检查通过也不是未来删除许可。
        </p>
        <label className="field">
          同一现场的固定提交与保留副本
          <select
            aria-label="现场保护副本"
            value={selected}
            disabled={!baseline?.canInspect}
            onChange={(e) => {
              setSelected(e.target.value);
              setShowCommand(false);
            }}
          >
            <option value="">明确选择已保留的提交，不默认用共同起点</option>
            {baseline?.materials.map((m) => (
              <option key={m.retention.request.id} value={m.retention.request.id}>
                {m.checkpoint.request.label} · {m.checkpoint.manifest.commit.slice(0, 12)} ·{' '}
                {m.retention.request.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {baseline && !baseline.materials.length && (
          <p>
            同一现场没有当前有效的完整对象副本。返回 Task
            的“代码检查点”，由原本人记录当前已有提交并明确保留；不要自动提交或丢弃未保存修改。
          </p>
        )}
        {material && (
          <section aria-label="固定保护起点">
            <p>
              提交 <code>{material.checkpoint.manifest.commit}</code>
            </p>
            <p>
              副本 <code>{selected}</code> · 有效至 {time(material.retention.manifest!.expiresAt)}
            </p>
            <p>服务仅列出原记录；当前HEAD、索引、全部文件和私有副本仍须在本机重新核对。</p>
          </section>
        )}
        {read.error && <p role="alert">{read.error}。原选择保留，暂不生成新命令。</p>}
        {stale && (
          <p className="work-branch-notice">
            方案、任务或所选副本已变化，原选择未被替换；请明确重新核对范围。
          </p>
        )}
        <div className="work-branch-actions">
          <Button onClick={read.retry}>重读保护条件</Button>
          <Button
            disabled={!read.value || !!read.error}
            onClick={() => {
              if (!read.value) return;
              if (!read.value.materials.some((m) => m.retention.request.id === selected))
                setSelected('');
              setBaseline(structuredClone(read.value));
              setShowCommand(false);
            }}
          >
            重新核对保护范围
          </Button>
        </div>
        <Button variant="primary" disabled={!available} onClick={() => setShowCommand(true)}>
          生成本机核对命令
        </Button>
        {showCommand && available && baseline && (
          <section aria-label="清理前本机核对命令">
            <pre>
              {branchCleanupCommand({
                branchId: branch.id,
                expectedRevision: baseline.branch.revision,
                expectedTaskRevision: baseline.taskRevision,
                retentionId: selected,
              })}
            </pre>
            <p>
              把引号内的状态目录占位符替换为原方案节点私有目录。本机输入 CHECK_BRANCH
              和固定方案标识后才检查；代码、路径与检查结果不自动分享。
            </p>
            <p>
              成功只输出本次观察，deletionAuthorized始终为false。未知或失败时按提示保留原文件、日志和凭证；不提供force、删除或清锁参数。
            </p>
          </section>
        )}
      </div>
      <div className="dialog-footer">
        <Button onClick={close}>返回保留的方案</Button>
      </div>
    </Dialog>
  );
}
export function BranchCleanupEntry({ branch }: { branch: WorkBranch }) {
  const { data } = useApp();
  const [open, setOpen] = useState(false),
    [revoked, setRevoked] = useState(false);
  if (
    branch.state !== 'discarded' ||
    branch.preservation?.executionRegistrationClosed ||
    !branch.workingCopyId ||
    branch.workspace?.ticket.ownerId !== data.user.id
  )
    return null;
  return (
    <>
      <Button disabled={revoked} onClick={() => setOpen(true)}>
        清理前核对
      </Button>
      {revoked && <p role="alert">现场核对权限已失效，选择已清除。</p>}
      {open && (
        <Inspector
          branch={branch}
          close={() => setOpen(false)}
          denied={() => {
            setOpen(false);
            setRevoked(true);
          }}
        />
      )}
    </>
  );
}
