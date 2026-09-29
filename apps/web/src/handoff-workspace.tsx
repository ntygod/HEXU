import { useEffect, useState } from 'react';
import type { Task } from '../../../packages/contracts/src/index.js';
import type { HandoffAcceptance } from '../../../packages/contracts/src/handoff-acceptance.js';
import type { PairingView } from '../../../packages/contracts/src/nodes.js';
import { Button } from '../../../packages/ui/src/index.js';
import { Link, time, useApp } from './state.js';
import { useAssistanceCommand, useAssistanceRead } from './assistance-common.js';
import { NodeRunPanel } from './node-execution.js';

type Pairing = PairingView & { code: string | null };
function PairingFeedback({ command }: { command: ReturnType<typeof useAssistanceCommand> }) {
  return (
    <>
      {command.error && <p role="alert">{command.error}</p>}
      {command.uncertain && (
        <div className="handoff-notice">
          <p>配对请求结果未确认。对账只使用原请求；已生成的配对码不会再次返回。</p>
          <Button busy={command.busy} onClick={() => void command.confirm()}>
            确认上次配对请求
          </Button>
        </div>
      )}
    </>
  );
}
function WorkspacePairing({ projectId }: { projectId: string }) {
  const { notice } = useApp();
  const [pairing, setPairing] = useState<Pairing | null>(null),
    [showCode, setShowCode] = useState(false);
  const read = useAssistanceRead<{ pairings: PairingView[] }>(pairing ? '/nodes' : null, 3000);
  const create = useAssistanceCommand<Pairing>((value) => {
    setPairing(value);
    setShowCode(false);
    read.retry();
  });
  const cancel = useAssistanceCommand(() => {
    setPairing(null);
    setShowCode(false);
  });
  const denied = create.denied || cancel.denied || read.denied;
  const current = read.value?.pairings.find((p) => p.id === pairing?.id) ?? pairing;
  const locked = create.busy || cancel.busy || !!create.uncertain || !!cancel.uncertain;
  const usable = current?.state === 'pending' && !read.error && !locked;
  useEffect(() => {
    if (denied || (current && current.state !== 'pending')) {
      setShowCode(false);
      setPairing((old) => (denied ? null : old?.code ? { ...old, code: null } : old));
    }
  }, [denied, current?.state]);
  if (denied) return <p role="alert">配对权限已失效，配对码已清除；请重新核对项目权限。</p>;
  return (
    <section className="handoff-panel-status" aria-label="接手现场配对">
      <p>生成自己的原项目配对码，在终端使用准备成功后给出的 connect 命令确认目录。</p>
      <PairingFeedback command={create} />
      <PairingFeedback command={cancel} />
      {!pairing ? (
        <Button
          disabled={locked}
          busy={create.busy}
          onClick={() => void create.send('/nodes/pairings', { projectId })}
        >
          生成原项目配对码
        </Button>
      ) : (
        <>
          <p>
            {pairing.ownerName} · {pairing.projectName} · 有效至 {time(pairing.expiresAt)}
          </p>
          {read.error && (
            <p role="alert">
              {read.error}
              <Button onClick={read.retry}>重读配对状态</Button>
            </p>
          )}
          {current?.state === 'pending' ? (
            <>
              {pairing.code ? (
                <>
                  <label className="field">
                    接手现场配对码
                    <input
                      aria-label="接手现场配对码"
                      type={showCode && usable ? 'text' : 'password'}
                      value={pairing.code}
                      readOnly
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <div className="handoff-actions">
                    <Button disabled={!usable} onClick={() => setShowCode((v) => !v)}>
                      {showCode ? '隐藏配对码' : '显示配对码'}
                    </Button>
                    <Button
                      disabled={!usable}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(pairing.code!);
                          notice('配对码已复制，请粘贴到自己的接手节点终端');
                        } catch {
                          notice('复制失败，请显示配对码后手动复制', true);
                        }
                      }}
                    >
                      复制配对码
                    </Button>
                  </div>
                </>
              ) : (
                <p>
                  配对码只返回一次，无法从回执或刷新恢复。请先取消这次配对，再明确生成新的配对码。
                </p>
              )}
              <Button
                busy={cancel.busy}
                disabled={locked}
                onClick={() => {
                  setShowCode(false);
                  void cancel.send(`/nodes/pairings/${pairing.id}/cancel`, {});
                }}
              >
                取消这次配对
              </Button>
            </>
          ) : (
            <p>
              {current?.state === 'used'
                ? '节点已配对。仍需在本机单独启用执行并启动节点。'
                : '这次配对已结束。'}
              <Button disabled={locked} onClick={() => setPairing(null)}>
                准备另一配对
              </Button>
            </p>
          )}
          <p>
            关闭指引会清除这里的配对码，但不会取消配对。可到
            <Link to="/settings#settings-resources">节点与目录</Link>查看或取消。
          </p>
        </>
      )}
    </section>
  );
}

/** Instructions are not a preparation receipt. Local journal and current node
 * execution options remain the respective sources of actual readiness. */
export function HandoffWorkspace({ task, op }: { task: Task; op: HandoffAcceptance }) {
  const [open, setOpen] = useState(false),
    [run, setRun] = useState(false);
  return (
    <section className="handoff-panel-status" aria-label="接手现场研发">
      <Button onClick={() => setOpen((v) => !v)}>
        {open ? '收起研发准备' : '准备接手现场研发'}
      </Button>
      {open && (
        <div className="handoff-workspace-steps">
          <section>
            <h4>1. 在本机准备 Git</h4>
            <p>
              使用原接收节点和已确认的原目录。核验通过并在终端同意后，添加单提交浅 Git 历史与 work
              分支；未准备完整祖先历史。
            </p>
            <pre aria-label="接手Git准备命令">{`npm run runner:handoff-workspace -- --operation ${op.ticket.id} --state /path/to/receiver-state --target /path/to/restored-directory`}</pre>
            <p>
              网页尚未获知本机准备结果。准备中断、文件改动或存在未知写入时，保留现场并查看本机最后记录：
            </p>
            <pre aria-label="接手Git状态命令">{`npm run runner:handoff-workspace-status -- --operation ${op.ticket.id} --state /path/to/receiver-state`}</pre>
            <details>
              <summary>处置未完成的 Git 准备</summary>
              <p>
                仅清理本次完整归属且未被改动的失败元数据。已准备成功的 Git
                和用户代码不会被此命令删除。
              </p>
              <pre>{`npm run runner:handoff-workspace-cleanup -- --operation ${op.ticket.id} --state /path/to/receiver-state`}</pre>
            </details>
          </section>
          <section>
            <h4>2. 配对并授权自己的节点</h4>
            <WorkspacePairing projectId={task.projectId!} />
            <p>
              在生成的独立状态目录单独运行 enable-execution，核对工具、目录和预算，再
              start。使用自己的模型账号；本次配对只共享目录摘要。
            </p>
          </section>
          <section>
            <h4>3. 在此任务开始新 Run</h4>
            <p>
              节点名称为「接手现场 {op.ticket.id.slice(0, 8)}
              」、目录为「接手代码」。执行面板按当前连接和授权显示可用性；请核对后选择本人新会话。
            </p>
            <Button variant="primary" onClick={() => setRun(true)}>
              查看节点并准备新 Run
            </Button>
          </section>
        </div>
      )}
      {run && <NodeRunPanel task={task} onClose={() => setRun(false)} />}
    </section>
  );
}
