import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { RestoreEntry } from './checkpoint-restore-plan.js';
import { PinnedRestoreParent } from './checkpoint-restore-files.js';

const helper = fileURLToPath(new URL('../native/integration-add', import.meta.url));
export function checkIntegrationAddHelper() {
  const r = spawnSync(helper, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    env: { LC_ALL: 'C' },
  });
  if (r.error || r.status !== 0 || r.stdout.trim() !== 'hexu-integration-add-v1')
    throw new DomainError(
      'INTEGRATION_HELPER_UNAVAILABLE',
      '缺少Linux排他新增组件，请先构建；不降级为覆盖写入',
    );
}
export function publishIntegrationAddition(
  parent: PinnedRestoreParent,
  entry: RestoreEntry,
  bytes: Buffer,
) {
  if (entry.kind !== 'file' || bytes.length !== entry.bytes || entry.gitMode === '40000')
    throw new DomainError('INTEGRATION_UNSUPPORTED', '只能发布已核验的普通文件');
  if (basename(parent.observation.path) !== basename(entry.path))
    throw new DomainError('INTEGRATION_UNSUPPORTED', '固定目标与文件名不一致');
  parent.revalidate();
  parent.assertAbsent();
  const r = spawnSync(helper, [basename(entry.path), entry.gitMode, String(bytes.length)], {
    stdio: ['pipe', 'pipe', 'pipe', parent.fd],
    input: bytes,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
    env: { LC_ALL: 'C' },
  });
  if (!r.error && r.status === 20 && r.stdout.trim() === 'not_published') return null;
  const match = !r.error && r.status === 0 && /^published (\d+:\d+)\n$/.exec(r.stdout);
  if (!match)
    throw new DomainError(
      'INTEGRATION_WRITE_UNKNOWN',
      '新增文件结果未确认；保留现场与写锁，不重写或回滚',
    );
  parent.revalidate();
  return match[1]!;
}
