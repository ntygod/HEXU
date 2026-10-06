import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resultSearchResultContext,
  resultSearchScopeContext,
} from '../apps/web/src/result-search-context.js';

const project = Object.freeze({ id: 'project-a', name: '交付计划', archivedAt: null });
const task = Object.freeze({ title: '排查首页', shortId: 'HX-123', projectId: project.id });
const result = Object.freeze({ title: '当前说明', body: '正文关键字', kind: 'text' as const });

test('Result scope labels preserve all, personal and unavailable project selections', () => {
  assert.deepEqual(resultSearchScopeContext({ scope: 'all', projectId: null }, []), {
    available: true,
    label: '全部当前可见成果',
  });
  assert.deepEqual(resultSearchScopeContext({ scope: 'personal', projectId: null }, [project]), {
    available: true,
    label: '无项目个人成果',
  });
  const selection = { scope: 'project' as const, projectId: project.id };
  assert.deepEqual(resultSearchScopeContext(selection, [project]), {
    available: true,
    label: project.name,
  });
  assert.deepEqual(resultSearchScopeContext(selection, []), {
    available: false,
    label: '项目不可用',
  });
  assert.deepEqual(selection, { scope: 'project', projectId: project.id });
});

test('Result source uses current project labels and never treats missing context as personal', () => {
  const current = { ...project, name: '更新后的项目名称'.repeat(20), archivedAt: '2026-10-04' };
  assert.equal(
    resultSearchResultContext(result, task, [current], '').sourceLabel,
    `${current.name}（已归档）`,
  );
  assert.equal(resultSearchResultContext(result, task, [], '').sourceLabel, '项目不可用');
  assert.equal(
    resultSearchResultContext(result, undefined, [current], '').sourceLabel,
    '任务不可用',
  );
  assert.equal(
    resultSearchResultContext(result, { ...task, projectId: null }, [current], '').sourceLabel,
    '个人任务',
  );
});

test('Result context keeps demo labels truthful and suppresses redundant current-body context', () => {
  assert.equal(resultSearchResultContext(result, task, [], '').kindLabel, '成果说明');
  assert.equal(
    resultSearchResultContext({ ...result, kind: 'demo-preview' }, task, [], '').kindLabel,
    '示例预览',
  );
  assert.equal(resultSearchResultContext(result, task, [], '关键字').bodyMatch?.match, '关键字');
  for (const query of [result.title, task.title, task.shortId, '']) {
    assert.equal(
      resultSearchResultContext({ ...result, body: `${query} 正文` }, task, [], query).bodyMatch,
      null,
    );
  }
});
