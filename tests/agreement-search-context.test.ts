import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agreementSearchPageScope,
  agreementSearchPath,
  agreementSearchResultContext,
  agreementSearchScopeContext,
} from '../apps/web/src/agreement-search-context.js';
import { TEXT_MATCH_SNIPPET_LIMIT } from '../apps/web/src/text-match-snippet.js';
import type { AgreementSearchHit } from '../packages/contracts/src/agreement-search.js';
import type { Workbench } from '../packages/contracts/src/index.js';
import type { TaskSearchScope } from '../packages/contracts/src/task-search.js';
import { matchesAgreementSearchQuery } from '../packages/domain/src/agreement-search.js';

const project = Object.freeze({ id: 'project-a', name: '交付计划', archivedAt: null });
const otherProject = Object.freeze({ id: 'project-b', name: '其他项目', archivedAt: null });
const projects = Object.freeze([project, otherProject]);
const versions = Object.freeze([
  Object.freeze({ projectId: project.id, version: 7 }),
  Object.freeze({ projectId: otherProject.id, version: 3 }),
]);
const all: TaskSearchScope = Object.freeze({ scope: 'all', projectId: null });
const selected: TaskSearchScope = Object.freeze({ scope: 'project', projectId: project.id });
const personal: TaskSearchScope = Object.freeze({ scope: 'personal', projectId: null });
const agreement: AgreementSearchHit = Object.freeze({
  id: 'agreement-1',
  projectId: project.id,
  title: '当前标题',
  content: '约定正文中的关键字与交付要求。',
  revision: 4,
  state: 'active',
  updatedAt: '2026-10-05T00:00:00.000Z',
  project,
});

test('Agreement scopes preserve project selection and explicitly disable unsupported personal scope', () => {
  const context = agreementSearchScopeContext(all, projects, versions);
  assert.equal(context.available, true);
  assert.equal(context.label, '全部当前可见约定');
  assert.deepEqual(context.projection, [
    [project.id, project.name, false, 7],
    [otherProject.id, otherProject.name, false, 3],
  ]);
  assert.equal(agreementSearchScopeContext(all, [], []).available, true);
  assert.equal(agreementSearchScopeContext(selected, projects, versions).label, project.name);
  assert.deepEqual(agreementSearchScopeContext(personal, projects, versions), {
    available: false,
    label: '无项目个人约定',
    unavailableMessage: '项目约定不支持无项目个人范围，请选择全部或项目。',
    projection: [],
  });
  assert.deepEqual(agreementSearchScopeContext(selected, [otherProject], versions), {
    available: false,
    label: '项目不可用',
    unavailableMessage: '所选项目当前不可用，请选择其他搜索范围。',
    projection: [],
  });
  assert.deepEqual(selected, { scope: 'project', projectId: project.id });
  assert.deepEqual(personal, { scope: 'personal', projectId: null });
  assert.notEqual(
    agreementSearchPageScope('关键字', personal, projects, versions, true),
    agreementSearchPageScope('关键字', all, projects, versions, true),
  );
});

test('Agreement metadata is unavailable when missing, malformed or duplicate; zero must be explicit', () => {
  const malformed: unknown[] = [
    undefined,
    null,
    {},
    [],
    [{ projectId: otherProject.id, version: 3 }],
    [null],
    [{ projectId: project.id }],
    [{ projectId: '', version: 0 }],
    [{ projectId: 123, version: 0 }],
    [{ projectId: project.id, version: '7' }],
    [{ projectId: project.id, version: -1 }],
    [{ projectId: project.id, version: 1.5 }],
    [{ projectId: project.id, version: Number.NaN }],
    [{ projectId: project.id, version: Number.POSITIVE_INFINITY }],
    [{ projectId: project.id, version: Number.MAX_SAFE_INTEGER + 1 }],
    [versions[0], versions[0]],
    [...versions, versions[1]],
  ];
  for (const value of malformed) {
    const context = agreementSearchScopeContext(
      selected,
      projects,
      value as Workbench['projectAgreementVersions'],
    );
    assert.equal(context.available, false);
    assert.equal(context.unavailableMessage, '项目约定版本信息当前不可用，请刷新后重试。');
    assert.deepEqual(context.projection, []);
  }
  assert.equal(agreementSearchScopeContext(all, [], undefined).available, false);
  assert.equal(agreementSearchScopeContext(all, projects, [versions[0]!]).available, false);
  assert.equal(agreementSearchScopeContext(selected, projects, [versions[0]!]).available, true);
  const zero = agreementSearchScopeContext(selected, projects, [
    { projectId: project.id, version: 0 },
  ]);
  assert.equal(zero.available, true);
  assert.deepEqual(zero.projection, [[project.id, project.name, false, 0]]);
  assert.equal(
    agreementSearchScopeContext(selected, [project, project], versions).available,
    false,
  );
  assert.equal(
    agreementSearchScopeContext(selected, [{ ...project, name: '' }], versions).available,
    false,
  );
});

test('Agreement page scope tracks relevant project labels and explicit project versions only', () => {
  const key = agreementSearchPageScope('关键字', selected, projects, versions, true);
  const changedOthers = [
    project,
    { ...otherProject, name: '其他新名称', archivedAt: '2026-10-05' },
  ];
  const changedOtherVersion = [versions[0]!, { projectId: otherProject.id, version: 90 }];
  assert.equal(
    agreementSearchPageScope('关键字', selected, changedOthers, changedOtherVersion, true),
    key,
  );
  assert.equal(
    agreementSearchPageScope(
      '关键字',
      selected,
      [...projects].reverse(),
      [...versions].reverse(),
      true,
    ),
    key,
  );
  const changedSelectedVersion = [{ projectId: project.id, version: 8 }, versions[1]!];
  // A different agreement in this project may also advance its project-wide version.
  assert.notEqual(
    agreementSearchPageScope('关键字', selected, projects, changedSelectedVersion, true),
    key,
  );
  for (const currentProject of [
    { ...project, name: '更新后的当前项目' },
    { ...project, archivedAt: '2026-10-05' },
  ])
    assert.notEqual(
      agreementSearchPageScope('关键字', selected, [currentProject, otherProject], versions, true),
      key,
    );
  for (const selection of [all, personal])
    assert.notEqual(agreementSearchPageScope('关键字', selection, projects, versions, true), key);
  assert.notEqual(agreementSearchPageScope('其他', selected, projects, versions, true), key);
  assert.notEqual(agreementSearchPageScope('关键字', selected, projects, undefined, true), key);
  assert.notEqual(agreementSearchPageScope('关键字', selected, projects, versions, false), key);
  const allKey = agreementSearchPageScope('关键字', all, projects, versions, true);
  assert.notEqual(
    agreementSearchPageScope('关键字', all, projects, changedOtherVersion, true),
    allKey,
  );
  assert.equal(
    agreementSearchPageScope('关键字', all, [...projects].reverse(), [...versions].reverse(), true),
    allKey,
  );
  assert.notEqual(
    agreementSearchPageScope(
      '关键字',
      selected,
      [{ ...project, name: '同名（已归档）' }],
      versions,
      true,
    ),
    agreementSearchPageScope(
      '关键字',
      selected,
      [{ ...project, name: '同名', archivedAt: '2026-10-05' }],
      versions,
      true,
    ),
  );
});

test('Agreement source, lifecycle and revision labels describe the current record truthfully', () => {
  const currentProject = {
    ...project,
    name: '更新后的项目名称'.repeat(20),
    archivedAt: '2026-10-05',
  };
  for (const [state, stateLabel] of [
    ['active', '有效'],
    ['inactive', '已停用'],
    ['superseded', '已替代'],
  ] as const) {
    const context = agreementSearchResultContext(
      { ...agreement, project: currentProject, state, revision: 17 },
      '',
    );
    assert.equal(context.sourceLabel, `${currentProject.name}（已归档）`);
    assert.equal(context.stateLabel, stateLabel);
    assert.equal(context.revisionLabel, '修订 17');
    assert.equal(context.bodyMatch, null);
  }
  assert.equal(
    agreementSearchScopeContext(selected, [currentProject], versions).label,
    `${currentProject.name}（已归档）`,
  );
  assert.equal(agreementSearchResultContext(agreement, '').sourceLabel, project.name);
});

test('Agreement body snippets retain whole Unicode, literal markup and the first repeated match', () => {
  const content = `${'前文'.repeat(100)}👩🏽‍💻 <b>字面文本</b> 关键字 ${'后文'.repeat(100)}`;
  const snippet = agreementSearchResultContext(
    { ...agreement, content },
    ' 👩🏽‍💻 <B>字面文本</B> 关键字 ',
  ).bodyMatch;
  assert.ok(snippet);
  assert.equal(snippet.match, '👩🏽‍💻 <b>字面文本</b> 关键字');
  const rendered = snippet.before + snippet.match + snippet.after;
  assert.ok(Array.from(rendered).length <= TEXT_MATCH_SNIPPET_LIMIT);
  assert.ok(rendered.startsWith('…'));
  assert.ok(rendered.endsWith('…'));
  const repeated = agreementSearchResultContext(
    { ...agreement, content: '首处 KEYWORD 第二处 keyword 末尾' },
    'keyword',
  ).bodyMatch;
  assert.deepEqual(repeated, { before: '首处 ', match: 'KEYWORD', after: ' 第二处 keyword 末尾' });
});

test('Agreement long-query context remains bounded and title matches suppress redundant snippets', () => {
  const longQuery = '长查询'.repeat(80);
  const snippet = agreementSearchResultContext(
    { ...agreement, content: `前文${longQuery}后文` },
    longQuery,
  ).bodyMatch;
  assert.ok(snippet);
  assert.ok(
    Array.from(snippet.before + snippet.match + snippet.after).length <= TEXT_MATCH_SNIPPET_LIMIT,
  );
  assert.ok(snippet.after.endsWith('…'));
  assert.ok(snippet.match.length < longQuery.length);
  const repeatedTitle = { ...agreement, title: 'Title KEYWORD', content: 'Body keyword' };
  assert.equal(agreementSearchResultContext(repeatedTitle, ' KEYWORD ').bodyMatch, null);
  for (const query of ['', ' \u3000 ', '不存在'])
    assert.equal(agreementSearchResultContext(agreement, query).bodyMatch, null);
});

test('Agreement snippets do not change cross-field membership or search discussion origins/history', () => {
  const crossField = {
    ...agreement,
    title: 'Boundary',
    content: 'Content',
    origin: { excerpt: 'origin-only' },
    history: [{ content: 'history-only' }],
  };
  assert.equal(matchesAgreementSearchQuery(crossField, 'boundary content'), true);
  assert.equal(agreementSearchResultContext(crossField, 'boundary content').bodyMatch, null);
  for (const query of ['origin-only', 'history-only']) {
    assert.equal(matchesAgreementSearchQuery(crossField, query), false);
    assert.equal(agreementSearchResultContext(crossField, query).bodyMatch, null);
  }
});

test('Agreement navigation encodes the existing project and current-record deep link', () => {
  const item = { projectId: '项目/space ?&', id: '约定/#?&= next' };
  const path = agreementSearchPath(item);
  assert.equal(
    path,
    `/projects/${encodeURIComponent(item.projectId)}?tab=agreements&agreement=${encodeURIComponent(item.id)}`,
  );
  const target = new URL(path, 'http://localhost');
  assert.equal(target.searchParams.get('tab'), 'agreements');
  assert.equal(target.searchParams.get('agreement'), item.id);
  assert.equal(target.hash, '');
  assert.equal(target.searchParams.has('revision'), false);
});
