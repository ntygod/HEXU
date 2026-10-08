import type { TaskAgentCollaboration } from '../../../packages/contracts/src/task-agent-collaborations.js';

/** Labels only: mutations always re-check the underlying service's current authority. */
export function collaborationStatus(item: TaskAgentCollaboration) {
  if (item.state === 'cancelled' || item.accessEnded)
    return {
      label: '分享已撤销',
      detail: '不再发送材料；外部工作是否停止尚未确认。',
      attention: false,
    };
  if (item.terminalReason === 'declined')
    return { label: '对方已拒绝', detail: '这是协作决定，不是提供方故障。', attention: false };
  if (item.state === 'closed')
    return { label: '协助已结束', detail: '保留已获准历史，不再接受新回应。', attention: false };
  if (item.consumption.futureContinuationCancelledAt)
    return {
      label: '未来回接已取消',
      detail: '已启动的外部工作停止情况仍需确认。',
      attention: false,
    };
  if (item.waitingFor === 'clarification' || item.waitingFor === 'scope_decision')
    return {
      label: item.waitingFor === 'clarification' ? '待澄清' : '待确认范围',
      detail: item.canManage ? '打开请求，查看问题并补充固定材料。' : '等待有权发起者补充或确认。',
      attention: item.canManage,
    };
  if (item.consumption.acknowledgement) {
    const ack = item.consumption.acknowledgement;
    return {
      label: ack.late || ack.cancelled ? '收到迟到的继续报告' : '已报告原工作继续',
      detail: '发起 Agent 外部自报，尚非提供方验证的完成。',
      attention: false,
    };
  }
  if (item.consumption.status === 'claimed')
    return {
      label: '成果已领取，使用待确认',
      detail: '恢复时核对原请求，不重复启动原工作。',
      attention: false,
    };
  if (item.phase === 'answered')
    return {
      label:
        item.consumption.status === 'unbound'
          ? '成果已返回，未绑定原工作'
          : '成果已返回，待原工作取用',
      detail: '可查看回答；人工采用到任务说明是另一项明确操作。',
      attention: false,
    };
  if (item.waitingFor === 'capacity')
    return {
      label: '等待接收容量',
      detail: '请求已保存，当前授权接受容量已满。',
      attention: false,
    };
  if (item.phase === 'accepted')
    return {
      label: '已接受，等待回答',
      detail: '接受包含预授权策略确认，不等于 Agent 已执行。',
      attention: false,
    };
  return {
    label: '等待接受',
    detail: '请求已保存；收件和执行情况以独立观测为准。',
    attention: false,
  };
}

export function collaborationDelivery(item: TaskAgentCollaboration) {
  const delivery = item.delivery;
  if (delivery.inputRevision !== item.currentInputRevision)
    return '只有较早输入的通知观测；当前输入送达尚未确认。';
  const labels: Record<typeof delivery.state, string> = {
    not_observed: '暂无通知送达观测；不能据此判断 Agent 在线。',
    pending: '最新协作通知最近记录为等待发送；发送前仍会核对当前授权。',
    inflight: '最新协作通知发送中，回执尚未确认。',
    delivered: '最新协作通知已获回调 2xx；仅确认收件，不确认 Agent 接受或回答。',
    unknown: '最新协作通知送达未知；后台只核对或重试同一事件。',
    failed: '最新协作通知投递失败；已保存的请求与成果仍保留。',
    suppressed: '最新协作通知已停止投递；需核对当前连接与授权。',
    mixed: '最新协作通知有不同的投递结果，尚不能确认全部送达。',
  };
  return labels[delivery.state];
}
export const collaborationConfirmationSource: Record<
  TaskAgentCollaboration['latestConfirmation']['source'],
  string
> = {
  assistance: '协助业务记录',
  consumption_claim: '成果领取记录',
  external_self_report: '发起 Agent 外部自报',
  future_continuation_cancelled: '未来回接取消记录',
};
