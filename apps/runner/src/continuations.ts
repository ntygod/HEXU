import { DomainError } from '../../../packages/contracts/src/index.js';
import type { ContinuationInput, ContinuationOperation } from '../../../packages/contracts/src/continuation.js';
import { isActiveRun } from '../../../packages/domain/src/index.js';
import { ContinuationStore, humanContextHash } from '../../../packages/db/src/continuations.js';
import type { Store } from '../../../packages/db/src/store.js';
import type { NativeRuntime } from './runtime.js';

/** One local coordinator. This is not a remote Runner, a model retry loop or a workflow engine. */
export class ContinuationCoordinator {
  readonly records: ContinuationStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;
  private closing = false;
  constructor(private store: Store, private native: NativeRuntime, startTimer = true) {
    this.records = new ContinuationStore(store);
    this.records.recover();
    if (startTimer) {
      this.timer = setInterval(() => { void this.tick(); }, 100);
      this.timer.unref();
    }
  }
  create(taskId: string, input: ContinuationInput, key: string) {
    if (this.closing) throw new DomainError('SERVICE_CLOSING', '服务正在关闭，没有接收接续操作', 503);
    return this.records.create(taskId, input, key);
  }
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.draining) return this.draining;
    this.draining = this.drain().finally(() => { this.draining = null; });
    return this.draining;
  }
  private async drain() {
    for (const op of this.records.pending()) {
      if (this.closing) break;
      await this.advance(op);
    }
  }
  private async advance(op: ContinuationOperation) {
    try {
      if (Date.parse(op.expiresAt) <= Date.now())
        throw new DomainError('CONTINUATION_EXPIRED', '等待已超时，没有启动新执行；请核对原执行后重新配置', 409);
      const source = this.records.assertSource(op.taskId, op.input.run);
      if (source.observation === 'unknown' || source.native?.recoveryRequired)
        throw new DomainError('SOURCE_STATE_UNKNOWN', '不能确认原进程状态。目录锁保持不变，请在本机核对并恢复', 409);
      if (humanContextHash(this.store, op.taskId) !== op.humanContextHash)
        throw new DomainError('CONTEXT_CHANGED', '等待期间人工说明或讨论已变化，请重新查看上下文后继续', 409);
      const overview = this.native.overview();
      const capability = op.input.run.requestedTool === 'codex' ? overview.codex : overview.claude;
      if (!overview.enabled || !capability.available)
        throw new DomainError('CAPABILITY_UNAVAILABLE', capability.reason, 422);
      if (!overview.workspaces.some((w) => w.id === op.workingCopyId))
        throw new DomainError('WORKSPACE_UNAVAILABLE', '原目录不在当前授权范围，没有启动新执行', 409);
      const lock = this.store.nativeLock(op.workingCopyId);
      if (lock && lock !== source.id)
        throw new DomainError('WORKING_COPY_BUSY', '目录由其他执行占用，没有停止其他任务', 409);
      if (isActiveRun(source.state)) {
        if (op.input.onActiveRun === 'request_stop') {
          this.store.stopRun(source.id, `continuation-stop:${op.id}`);
          this.native.stop(source.id);
        }
        return; // A stop request is never proof that the writer has stopped.
      }
      if (source.native?.terminationConfirmed !== true || lock)
        throw new DomainError('STOP_UNCONFIRMED', '原执行结束状态与目录锁未确认一致，请核对后继续', 409);
      const current = this.records.transition(op.id, 'preparing');
      if (current.state !== 'preparing' || this.closing) return;
      // Runtime rebuilds bounded context/Git excerpts after the writer has stopped.
      // Store atomically rechecks cancellation, task/context revision and reservation,
      // then commits both the new Run and its operation link before spawning.
      await this.native.create(op.taskId, op.input.run, `continuation-run:${op.id}`, op.id);
    } catch (error) {
      this.records.transition(op.id, error instanceof DomainError ? 'needs_attention' : 'failed', [{
        code: error instanceof DomainError ? error.code : 'CONTINUATION_FAILED',
        message: error instanceof DomainError
          ? this.native.clean(error.message)
          : '接续准备失败，未自动重试；请保留当前现场并重新配置。',
      }]);
    }
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.records.recover(); // Invalidate preparations before awaiting them; never restart paid work.
    if (this.draining) await this.draining;
  }
}
