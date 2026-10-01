import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskContentRevision } from '../packages/contracts/src/task-content-history.js';
import { compareTaskContent } from '../packages/domain/src/task-content-comparison.js';

function version(
  revision: number,
  overrides: Partial<TaskContentRevision> = {},
): TaskContentRevision {
  return {
    taskId: 'task-a',
    revision,
    title: '固定标题',
    description: '原说明',
    attention: null,
    actorId: null,
    actorName: null,
    savedAt: null,
    source: 'legacy',
    changedFields: [],
    ...overrides,
  };
}

test('只对照同一Task两个有效且按修订顺序排列的版本', () => {
  const before = version(3),
    after = version(7);
  for (const [taskId, a, b] of [
    ['', before, after],
    ['task-b', before, after],
    ['task-a', before, version(7, { taskId: 'task-b' })],
    ['task-a', before, before],
    ['task-a', after, before],
    ['task-a', version(0), after],
    ['task-a', version(1.5), after],
    ['task-a', before, version(Number.MAX_SAFE_INTEGER + 1)],
  ] as const)
    assert.throws(() => compareTaskContent(taskId, a, b), { code: 'INVALID_INPUT' });
  assert.equal(compareTaskContent('task-a', before, after).after.revision, 7);
});

test('两侧内容与来源独立固定，后来的列表/调用者修改不能漂移已展示对照或补造旧作者', () => {
  const before = version(17),
    after = version(19, {
      source: 'edited',
      actorId: 'person-a',
      actorName: '保存的人',
      savedAt: '2026-10-01T00:00:00.000Z',
      description: '新说明',
      changedFields: ['description'],
    });
  const result = compareTaskContent('task-a', before, after);
  before.title = '后来改动';
  before.actorName = '不能补造';
  after.description = '另一轮新文字';
  after.changedFields.push('title');
  assert.equal(result.before.revision, 17);
  assert.equal(result.before.title, '固定标题');
  assert.equal(result.before.actorName, null);
  assert.equal(result.before.savedAt, null);
  assert.equal(result.before.source, 'legacy');
  assert.equal(result.after.description, '新说明');
  assert.deepEqual(result.after.changedFields, ['description']);
  assert.equal(result.after.actorName, '保存的人');
});

test('分别显示标题/关注与说明变化，准确保留空内容、Unicode和原换行', () => {
  const before = version(1, {
    title: '原题',
    attention: '等待字段',
    description: '中文🙂\r\n原行\n',
  });
  const after = version(2, { title: '新题', attention: null, description: '中文🙂\r\n新行\n' });
  const result = compareTaskContent('task-a', before, after);
  assert.equal(result.titleChanged, true);
  assert.equal(result.attentionChanged, true);
  assert.equal(result.description.kind, 'diff');
  if (result.description.kind !== 'diff') throw new Error('expected bounded text diff');
  const endings = { LF: '\n', CRLF: '\r\n', CR: '\r', none: '' };
  for (const [side, text] of [
    ['before', before.description],
    ['after', after.description],
  ] as const)
    assert.equal(
      result.description.rows
        .filter((row) => row[side] !== null)
        .map((row) => row.text + endings[row.ending])
        .join(''),
      text,
    );
  const empty = compareTaskContent(
    'task-a',
    version(1, { description: '' }),
    version(2, { description: '', attention: '' }),
  );
  assert.equal(empty.titleChanged, false);
  assert.equal(empty.attentionChanged, false);
  assert.deepEqual(empty.description, { kind: 'diff', rows: [], added: 0, removed: 0 });
});

test('合法Task说明超出行数或计算预算时保留两侧全文，不把截断当成功差异', () => {
  for (const [a, b, reason] of [
    ['原说明', '行\n'.repeat(2001) + '结尾', 'size'],
    ['旧\n'.repeat(600), '新\n'.repeat(600), 'complexity'],
  ] as const) {
    assert.ok(a.length <= 12000 && b.length <= 12000);
    const result = compareTaskContent(
      'task-a',
      version(1, { description: a }),
      version(2, { description: b }),
    );
    assert.deepEqual(result.description, { kind: 'fallback', reason });
    assert.equal(result.before.description, a);
    assert.equal(result.after.description, b);
  }
});
