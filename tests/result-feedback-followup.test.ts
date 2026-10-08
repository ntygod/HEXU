import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  feedbackFollowupDraft,
  isFollowupFeedback,
} from '../apps/web/src/result-feedback-followup.js';

const task = Object.freeze({
  id: 'task-a',
  shortId: 'HX-42',
  projectId: 'project-a',
  visibility: 'project' as const,
});
const version = Object.freeze({
  id: 'version-old',
  resultId: 'result-a',
  taskId: task.id,
  revision: 2,
  title: '接口方案',
});
const message = Object.freeze({
  id: 'feedback-a',
  taskId: task.id,
  resultId: version.resultId,
  resultRevisionId: version.id,
  actorName: '陈同学',
  body: '请补上空值处理。\n保留原字段。',
});

test('explicit fixed-version feedback creates a same-project editable draft without changing inputs', () => {
  const before = JSON.stringify([task, version, message]);
  const draft = feedbackFollowupDraft(task, version, message, 'https://hexu.example');
  assert.ok(draft);
  assert.equal(draft.projectId, task.projectId);
  assert.equal(draft.title, '后续：接口方案');
  assert.ok(
    draft.description.includes('https://hexu.example/results/result-a/versions/version-old'),
  );
  assert.ok(draft.description.includes('v2 · 接口方案'));
  assert.ok(draft.description.includes('反馈：陈同学（feedback-a）'));
  assert.ok(draft.description.endsWith(message.body));
  assert.equal(JSON.stringify([task, version, message]), before);
});

test('private and personal Tasks are ineligible even with a project-shaped ID', () => {
  for (const candidate of [
    { ...task, visibility: 'private' as const },
    { ...task, projectId: null },
    { ...task, projectId: '' },
  ]) {
    assert.equal(isFollowupFeedback(candidate, version, message), false);
    assert.equal(feedbackFollowupDraft(candidate, version, message, 'https://hexu.example'), null);
  }
});

test('unversioned, other-version, other-result and other-task messages cannot be adopted', () => {
  for (const candidate of [
    { ...message, resultRevisionId: undefined },
    { ...message, resultRevisionId: 'version-new' },
    { ...message, resultId: 'result-b' },
    { ...message, resultId: null },
    { ...message, taskId: 'task-b' },
  ])
    assert.equal(isFollowupFeedback(task, version, candidate), false);
  assert.equal(isFollowupFeedback(task, { ...version, taskId: 'task-b' }, message), false);
});

test('version changes never reinterpret an old feedback as current-version feedback', () => {
  const newer = { ...version, id: 'version-new', revision: 3 };
  assert.equal(feedbackFollowupDraft(task, newer, message, 'https://hexu.example'), null);
  const currentMessage = { ...message, resultRevisionId: newer.id };
  const draft = feedbackFollowupDraft(task, newer, currentMessage, 'https://hexu.example');
  assert.ok(draft?.description.includes('/versions/version-new'));
  assert.ok(draft?.description.includes('v3'));
});

test('feedback and source text are retained in full for explicit over-limit editing', () => {
  const full = '中'.repeat(12000);
  const draft = feedbackFollowupDraft(
    task,
    version,
    { ...message, body: full },
    'https://hexu.example',
  );
  assert.ok(draft);
  assert.ok(draft.description.length > 12000);
  assert.ok(draft.description.endsWith(full));
});

test('prefilled title respects existing UTF-16 limit without splitting an emoji', () => {
  for (const title of ['中'.repeat(160), 'a'.repeat(156) + '😀', '😀'.repeat(160)]) {
    const draft = feedbackFollowupDraft(
      task,
      { ...version, title },
      message,
      'https://hexu.example',
    );
    assert.ok(draft);
    assert.ok(draft.title.length <= 160);
    assert.equal(/[\uD800-\uDBFF]$/.test(draft.title), false);
    assert.ok(draft.description.includes(title));
  }
});

test('source identifiers are encoded as single route components', () => {
  const escaped = { ...version, id: 'version/?#中文', resultId: 'result/one' };
  const draft = feedbackFollowupDraft(
    task,
    escaped,
    { ...message, resultId: escaped.resultId, resultRevisionId: escaped.id },
    'https://hexu.example',
  );
  assert.ok(
    draft?.description.includes(
      '/results/result%2Fone/versions/version%2F%3F%23%E4%B8%AD%E6%96%87',
    ),
  );
});
