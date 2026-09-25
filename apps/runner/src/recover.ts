import { resolve } from 'node:path';
import { Store } from '../../../packages/db/src/store.js';

// Offline, explicit recovery only. Never guesses whether an old PID still belongs to HEXU.
const [id, acknowledgement] = process.argv.slice(2);
if (!id || acknowledgement !== '--confirm-process-stopped') {
  console.error(
    '请先退出 HEXU，并在系统中确认旧 Claude 及其子进程已经停止。\n然后运行：npm run native:recover -- <runId> --confirm-process-stopped',
  );
  process.exitCode = 1;
} else {
  const store = new Store(resolve(process.env.HEXU_DATA_DIR ?? '.hexu', 'preview.sqlite'));
  try {
    store.confirmNativeStopped(id);
    console.log('已记录人工停止确认，保留执行历史并解除目录占用。');
  } catch (error) {
    console.error(error instanceof Error ? error.message : '恢复失败');
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
