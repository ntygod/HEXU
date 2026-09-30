import test from 'node:test';
import assert from 'node:assert/strict';
import { branchResultFixture } from './helpers/branch-results.js';

test('来源预览和固定成果共享结算边界，ready阶段可读且不纳入未共享或迟到事件', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin();
    a.start();
    a.send('output', 'VISIBLE_SHARED');
    a.send('output', 'HIDDEN_UNSHARED');
    a.finish();
    const db = f.api.store.db;
    const row = db
      .prepare(
        "SELECT sequence,body FROM node_run_events WHERE dispatch_id=? AND json_extract(body,'$.text')='HIDDEN_UNSHARED'",
      )
      .get(a.command.id) as { sequence: number; body: string };
    db.prepare('UPDATE node_run_events SET body=? WHERE dispatch_id=? AND sequence=?').run(
      JSON.stringify({ ...JSON.parse(row.body), shared: false }),
      a.command.id,
      row.sequence,
    );
    a.send('output', 'LATE_UNSHARED');
    const r = await f.api.call(f.path() + '/result-source', f.alice);
    assert.equal(r.statusCode, 200, r.body);
    const source = r.json();
    assert.equal(source.output.availability, 'captured');
    assert.equal(source.output.text, 'VISIBLE_SHARED');
    assert.equal(source.output.eventCount, 1);
    assert.equal(source.evidence.ignoredAfterTerminal, 1);
    assert(!JSON.stringify(source).includes('HIDDEN_UNSHARED'));
    assert(!JSON.stringify(source).includes('LATE_UNSHARED'));
    const saved = await f.api.call(f.path() + '/results', f.alice, await f.draft());
    assert.equal(saved.statusCode, 201, saved.body);
    const preview = await f.api.call(f.path() + '/result-preview', f.alice);
    assert.equal(preview.statusCode, 200, preview.body);
    assert(preview.json().source.output.text.includes('VISIBLE_SHARED'));
    assert(!preview.json().source.output.text.includes('UNSHARED'));
    const ready = await f.api.call(f.path() + '/result-source', f.alice);
    assert.equal(ready.statusCode, 200, ready.body);
    assert.equal(ready.json().output.digest, source.output.digest);
    assert.equal(f.read().branches[0]!.state, 'ready');
  } finally {
    await f.close();
  }
});

test('缺少旧结算边界时两个接口均保留缺失事实，来源元数据不推断历史输出', async () => {
  const f = await branchResultFixture();
  try {
    const a = f.begin();
    a.start();
    a.send('output', 'LEGACY_NOT_RECAPTURED');
    a.finish();
    f.api.store.db
      .prepare('UPDATE node_dispatches SET terminal_sequence=NULL WHERE id=?')
      .run(a.command.id);
    const preview = await f.api.call(f.path() + '/result-preview', f.alice),
      source = await f.api.call(f.path() + '/result-source', f.alice);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(source.statusCode, 200, source.body);
    for (const v of [preview.json().source, source.json()]) {
      assert.equal(v.output.availability, 'legacy_unavailable');
      assert.equal(v.output.text, '');
    }
    assert.equal(source.json().evidence.toolReportedSuccess, false);
    assert.equal(source.json().evidence.includedThroughSequence, 0);
    assert.equal(source.json().evidence.ignoredAfterTerminal, 0);
    assert(!JSON.stringify(source.json()).includes('LEGACY_NOT_RECAPTURED'));
  } finally {
    await f.close();
  }
});
