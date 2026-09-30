import { branchResultFixture } from './branch-results.js';
import { codeSnapshot, recordResultCode, saveResultCode } from './result-code.js';
import { buildCodeDifference } from '../../apps/runner/src/agent/result-code-diff.js';
import { ResultCodeStore } from '../../packages/db/src/result-code.js';
import type { ResultCodeFeedbackInput } from '../../packages/contracts/src/result-code-feedback.js';
export async function codeFeedbackFixture(
  origin?: string,
  snapshots?: {
    before: Awaited<ReturnType<typeof codeSnapshot>>;
    after: Awaited<ReturnType<typeof codeSnapshot>>;
  },
) {
  const before =
    snapshots?.before ??
    (await codeSnapshot([
      { name: 'README.md', text: 'one\r\ntwo\r\nthree' },
      { name: 'binary.dat', data: Buffer.from([0, 1]) },
      { name: 'empty.txt', text: '' },
      { name: 'removed.txt', text: 'removed\n' },
    ]));
  const after =
    snapshots?.after ??
    (await codeSnapshot([
      { name: 'README.md', text: 'one\r\ntwo edited\r\nthree\n' },
      { name: 'added.txt', text: 'added\n' },
      { name: 'binary.dat', data: Buffer.from([0, 2]) },
      { name: 'empty.txt', text: '', mode: '100755' },
    ]));
  const f = await branchResultFixture(origin, before);
  try {
    const run = f.begin();
    run.start();
    run.finish();
    const save = async (snapshot = after) => {
      const cp = await recordResultCode(f, snapshot),
        saved = await saveResultCode(f, cp.checkpointId);
      const difference = buildCodeDifference(
        saved.revisionId,
        saved.detail.version.source.code,
        before,
        snapshot,
        new Date().toISOString(),
      );
      const receipt = new ResultCodeStore(f.api.store).publish(f.ns[0]!.token, difference);
      return { ...saved, difference, receipt };
    };
    const saved = await save();
    const input: ResultCodeFeedbackInput = {
      body: '请解释这段变更',
      path: 'README.md',
      side: 'after',
      objectId: saved.difference.files.find((f) => f.path === 'README.md')!.after!.objectId,
      range: { start: 2, end: 3 },
    };
    return {
      ...f,
      before,
      after,
      saved,
      save,
      input,
      feedbackPath: `results/${saved.resultId}/versions/${saved.revisionId}/code-feedback`,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
