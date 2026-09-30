import { createInterface } from 'node:readline';
import { DomainError } from '../../../packages/contracts/src/index.js';
import { preserveBranchWorkspace } from './agent/branch-preservation.js';
async function main() {
  const args = process.argv.slice(2),
    options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!,
      value = args[i + 1];
    if (
      !['--preservation', '--state', '--target'].includes(key) ||
      !value ||
      value.startsWith('--') ||
      options.has(key)
    )
      throw new DomainError(
        'INVALID_INPUT',
        '只接受固定保留请求、原state和全新target；无force/delete参数',
      );
    options.set(key, value);
  }
  if (options.size !== 3)
    throw new DomainError(
      'INVALID_INPUT',
      '需要 --preservation ID --state HOME --target ABSOLUTE_NEW_DIRECTORY',
    );
  const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !!process.stdin.isTTY,
      historySize: 0,
    }),
    iterator = lines[Symbol.asyncIterator]();
  try {
    const p = await preserveBranchWorkspace(
      options.get('--state')!,
      options.get('--preservation')!,
      options.get('--target')!,
      async (prompt) => {
        process.stdout.write(prompt);
        const item = await iterator.next();
        return item.done ? '' : item.value;
      },
    );
    console.log(
      JSON.stringify({
        lastRecorded: {
          id: p.id,
          phase: p.phase,
          outcome: p.outcome,
          originalRoot: p.root,
          preservationTarget: p.destination.path,
          helperOutcome: p.helperOutcome,
          unresolvedIntent: p.intent,
          acknowledged: p.acknowledged,
          publicationPending: !!p.pending,
          claimSettlementRecorded: !!p.releaseReceipt,
          cancelled: p.cancelled,
        },
        directoryPermanentlyDeleted: false,
        moveReplayed: false,
        destinationExecutionAuthorized: false,
      }),
    );
    if (p.phase !== 'settled' || p.outcome !== 'preserved') process.exitCode = 1;
  } finally {
    lines.close();
  }
}
main().catch((cause: unknown) => {
  console.error(
    JSON.stringify(
      cause instanceof DomainError
        ? { code: cause.code, message: cause.message }
        : {
            code: 'BRANCH_PRESERVATION_UNCONFIRMED',
            message:
              '移出保留未获确认；保留原位置、新位置、日志、凭证和占用。重跑仅核对原包，不会重新移动',
          },
    ),
  );
  process.exitCode = 1;
});
