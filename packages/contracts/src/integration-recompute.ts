import { DomainError, enumValue, revision } from './index.js';
import { exact, nodeId } from './nodes.js';
import { checkpointHash } from './checkpoints.js';
import type { IntegrationOptions, IntegrationTarget } from './integrations.js';
export interface IntegrationRecomputeCreate {
  expectedRevision: number;
  expectedTaskRevision: number;
  reportHash: string;
  targetCheckpointId: string;
  targetRetentionId: string;
  sourceMaterial: { kind: 'retention' | 'transfer'; id: string };
  confirmPreflight: true;
}
export interface IntegrationRecomputeOptions extends IntegrationOptions {
  originalRevision: number;
  reportHash: string;
  originalTarget: IntegrationTarget;
}
export function parseIntegrationRecomputeCreate(input: unknown): IntegrationRecomputeCreate {
  const b = exact(input, [
    'expectedRevision',
    'expectedTaskRevision',
    'reportHash',
    'targetCheckpointId',
    'targetRetentionId',
    'sourceMaterial',
    'confirmPreflight',
  ]);
  if (b.confirmPreflight !== true)
    throw new DomainError(
      'CONFIRMATION_REQUIRED',
      '需明确固定原来源与原目标目录，仅创建新的只读预检',
    );
  const m = exact(b.sourceMaterial, ['kind', 'id']);
  return {
    expectedRevision: revision(b.expectedRevision),
    expectedTaskRevision: revision(b.expectedTaskRevision),
    reportHash: checkpointHash(b.reportHash),
    targetCheckpointId: nodeId(b.targetCheckpointId),
    targetRetentionId: nodeId(b.targetRetentionId),
    sourceMaterial: {
      kind: enumValue(m.kind, ['retention', 'transfer'] as const, '来源副本'),
      id: nodeId(m.id),
    },
    confirmPreflight: true,
  };
}
