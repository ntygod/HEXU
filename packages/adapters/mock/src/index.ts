import type { Store } from '../../../db/src/store.js';
import { isActiveRun } from '../../../domain/src/index.js';

/** Deterministic UI exercise only: no shell, model credentials or filesystem editing. */
export class MockAdapter {
  private timers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  constructor(
    private store: Store,
    private stepMs = 900,
  ) {}
  private later(id: string, steps: number, callback: () => void) {
    const set = this.timers.get(id) ?? new Set();
    this.timers.set(id, set);
    const timer = setTimeout(() => {
      set.delete(timer);
      try {
        callback();
      } catch (error) {
        console.error('Mock adapter error:', error instanceof Error ? error.message : 'unknown');
      }
    }, this.stepMs * steps);
    timer.unref();
    set.add(timer);
  }
  start(id: string) {
    if (this.timers.has(id) || this.store.run(id).state !== 'queued') return;
    this.later(id, 0.3, () => this.store.stepRun(id, 'preparing'));
    this.later(id, 1, () =>
      this.store.stepRun(id, 'running', '模拟：已读取本任务的说明，正在演示执行过程。'),
    );
    this.later(id, 3, () => {
      const run = this.store.run(id);
      if (run.state !== 'running') return;
      if (run.scenario === 'waiting_input')
        this.store.stepRun(
          id,
          'waiting_input',
          '模拟提问：接下来优先处理交互还是接口？可在上方等待面板回复。',
        );
      else if (run.scenario === 'waiting_approval')
        this.store.stepRun(
          id,
          'waiting_approval',
          '模拟授权：演示一次需要人决定的操作。此操作不会执行命令或访问外部资源。',
        );
      else if (run.scenario === 'failure')
        this.store.stepRun(id, 'failed', '模拟失败：用于检查错误反馈。已有任务和讨论均已保留。');
      else this.finish(id);
    });
  }
  private finish(id: string) {
    if (this.store.run(id).state !== 'running') return;
    this.store.stepRun(
      id,
      'succeeded',
      '本次模拟执行已结束。未调用真实模型，也未修改代码。你可以继续、写成果说明或按团队方式标记任务完成。',
    );
  }
  resume(id: string) {
    if (this.store.run(id).state === 'running') this.later(id, 1, () => this.finish(id));
  }
  settleStops(taskId: string) {
    for (const run of this.store.runs(taskId))
      if (run.state === 'stopping' || run.state === 'cancelled') this.stop(run.id);
  }
  stop(id: string) {
    for (const timer of this.timers.get(id) ?? []) clearTimeout(timer);
    this.timers.delete(id);
    if (this.store.run(id).state === 'stopping')
      this.later(id, 0.25, () => this.store.stepRun(id, 'cancelled', '模拟执行已停止。'));
  }
  close() {
    for (const [id, timers] of this.timers) {
      for (const timer of timers) clearTimeout(timer);
      const run = this.store.run(id);
      if (isActiveRun(run.state)) {
        this.store.stopRun(id, `shutdown-${id}`);
        if (this.store.run(id).state === 'stopping') this.store.stepRun(id, 'cancelled');
      }
    }
    this.timers.clear();
  }
}
