import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  taskSearchProjectLabel,
  taskSearchResultContext,
  taskSearchScopeContext,
} from '../apps/web/src/task-search-context.js';
import { TEXT_MATCH_SNIPPET_LIMIT } from '../apps/web/src/text-match-snippet.js';
import { matchesTaskSearchQuery } from '../packages/domain/src/task-search.js';

const project = Object.freeze({ id: 'project-a', name: '交付计划', archivedAt: null });
const task = Object.freeze({
  title: '排查首页',
  shortId: 'HX-123',
  description: '确认详情页面中的关键字与交付内容。',
  projectId: project.id,
});

test('scope context keeps all, no-project and unavailable-project choices distinct', () => {
  assert.deepEqual(taskSearchScopeContext({ scope: 'all', projectId: null }, []), {
    available: true,
    label: '全部当前可见任务',
  });
  assert.deepEqual(taskSearchScopeContext({ scope: 'personal', projectId: null }, [project]), {
    available: true,
    label: '无项目个人任务',
  });
  const selection = { scope: 'project' as const, projectId: project.id };
  assert.deepEqual(taskSearchScopeContext(selection, [project]), {
    available: true,
    label: project.name,
  });
  assert.deepEqual(taskSearchScopeContext(selection, []), {
    available: false,
    label: '项目不可用',
  });
  assert.deepEqual(selection, { scope: 'project', projectId: project.id });
});

test('source labels use only current names and preserve long archived names without shortening', () => {
  const current = { ...project, name: '当前项目名称'.repeat(40), archivedAt: '2026-10-04' };
  const label = `${current.name}（已归档）`;
  assert.equal(taskSearchProjectLabel(current), label);
  assert.equal(taskSearchResultContext(task, [current], '关键字').sourceLabel, label);
  assert.equal(taskSearchResultContext(task, [], '关键字').sourceLabel, '项目不可用');
  assert.equal(
    taskSearchResultContext({ ...task, projectId: null }, [current], '关键字').sourceLabel,
    '个人任务',
  );
});

test('ordinary body snippets retain Chinese, whole Unicode text and literal markup', () => {
  const description = `${'前文'.repeat(100)}👩🏽‍💻 <b>字面文本</b> 关键字 ${'后文'.repeat(100)}`;
  const { descriptionMatch } = taskSearchResultContext(
    { ...task, description },
    [project],
    ' 👩🏽‍💻 <B>字面文本</B> 关键字 ',
  );
  assert.ok(descriptionMatch);
  assert.equal(descriptionMatch.match, '👩🏽‍💻 <b>字面文本</b> 关键字');
  const text = descriptionMatch.before + descriptionMatch.match + descriptionMatch.after;
  assert.ok(Array.from(text).length <= TEXT_MATCH_SNIPPET_LIMIT);
  assert.ok(text.startsWith('…'));
  assert.ok(text.endsWith('…'));
});

test('cross-field ordinary matches retain a row context without inventing a body match', () => {
  const crossField = { ...task, title: 'Boundary', description: 'description' };
  for (const query of ['boundary description', 'description hx-123']) {
    assert.equal(matchesTaskSearchQuery(crossField, query), true);
    assert.deepEqual(taskSearchResultContext(crossField, [project], query), {
      sourceLabel: project.name,
      descriptionMatch: null,
    });
  }
  const bodyMatch = { ...crossField, description: 'Detail says Boundary HX-123 here.' };
  assert.equal(matchesTaskSearchQuery(bodyMatch, 'boundary hx-123'), true);
  assert.equal(
    taskSearchResultContext(bodyMatch, [project], 'boundary hx-123').descriptionMatch?.match,
    'Boundary HX-123',
  );
  assert.equal(taskSearchResultContext(bodyMatch, [project], ' BOUNDARY ').descriptionMatch, null);
  assert.equal(taskSearchResultContext(bodyMatch, [project], ' hx-123 ').descriptionMatch, null);
  for (const query of ['', ' \u3000 ', 'boundary', 'hx-123', 'missing'])
    assert.equal(taskSearchResultContext(crossField, [project], query).descriptionMatch, null);
});
