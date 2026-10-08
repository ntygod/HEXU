import { time } from './state.js';
import { Button } from '../../../packages/ui/src/index.js';
import { useAssistanceRead } from './assistance-common.js';
import type { AgentResultConsumption } from '../../../packages/contracts/src/agent-consumption.js';

interface ConsumptionItem {
  requestId: string;
  binding: { id: string; provider: string; createdAt: string; cancelledAt: string | null } | null;
  consumption: AgentResultConsumption | null;
}
/** Parent-task-only projection; native session identifiers never enter this view. */
export function AgentConsumptionStatus({
  taskId,
  requestId,
}: {
  taskId: string;
  requestId: string;
}) {
  const read = useAssistanceRead<{ items: ConsumptionItem[] }>(
    `/tasks/${encodeURIComponent(taskId)}/agent-consumptions`,
  );
  const item = read.value?.items.find((v) => v.requestId === requestId);
  const consumed = item?.consumption;
  const ack = consumed?.acknowledgement;
  return (
    <section aria-label="原工作结果回接" className="assistance-snapshot">
      <h3>原工作结果回接</h3>
      {read.error && (
        <p role="alert">
          {read.error}
          <Button onClick={read.retry}>重读回接记录</Button>
        </p>
      )}
      {read.denied && <p>原工作回接记录已隐藏；当前访问权限不允许读取。</p>}
      {!read.denied && (
        <>
          <p>
            {!read.value
              ? read.error
                ? '尚未能核对原工作回接状态。'
                : '正在核对原工作回接状态…'
              : !item?.binding
                ? '尚未绑定原工作；保存回答不代表已继续。'
                : item.binding.cancelledAt
                  ? '未来回接已取消；已启动的外部工作停止情况未知。'
                  : ack
                    ? '发起 Agent 已报告原工作后续输出（外部自报）。'
                    : consumed
                      ? '结果已领取，后续使用尚未确认；恢复时只核对，不重复启动。'
                      : '原工作已绑定，等待回答或发起 Agent 取用。'}
          </p>
          {item?.binding && (
            <p className="hint">
              原工作关联来源：接入端报告（host_reported） · {time(item.binding.createdAt)}
            </p>
          )}
          {consumed && (
            <p className="hint">
              固定输入修订 {consumed.inputRevision} · 领取时间 {time(consumed.claimedAt)}
            </p>
          )}
          {ack && (
            <>
              {(ack.late || ack.cancelled) && (
                <p className="hint">
                  {ack.cancelled
                    ? '取消后的迟到观测，未重新开放回接。'
                    : '请求结束或输入改变后的迟到观测，未启动新工作。'}
                </p>
              )}
              <p className="hint">
                后续输出来源：external_self_report · {time(ack.observedAt)}，未获提供方独立验证。
              </p>
              <pre>{ack.output}</pre>
            </>
          )}
          <p className="hint">
            回接不修改共享说明、不完成任务、不授予工具权限。原 thread
            由接入端报告；真实模型继续需单独实测。
          </p>
        </>
      )}
    </section>
  );
}
