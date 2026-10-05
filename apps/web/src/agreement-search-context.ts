import type { Project, Workbench } from '../../../packages/contracts/src/index.js';
import type { AgreementSearchHit } from '../../../packages/contracts/src/agreement-search.js';
import type { TaskSearchScope } from '../../../packages/contracts/src/task-search.js';
import { taskSearchProjectLabel } from './task-search-context.js';
import { textMatchSnippet } from './text-match-snippet.js';

type SearchProject = Pick<Project, 'id' | 'name' | 'archivedAt'>;
type AgreementVersion = NonNullable<Workbench['projectAgreementVersions']>[number];
type ProjectProjection = [id: string, name: string, archived: boolean, version: number];

const unavailableVersions = '项目约定版本信息当前不可用，请刷新后重试。';

/** Current project labels and an explicit version entry are required for every searched project. */
export function agreementSearchScopeContext(
  selection: TaskSearchScope,
  projects: readonly SearchProject[],
  versions: readonly AgreementVersion[] | undefined,
) {
  const unavailable = (label: string, unavailableMessage: string) => ({
    available: false,
    label,
    unavailableMessage,
    projection: [] as ProjectProjection[],
  });
  if (selection.scope === 'personal')
    return unavailable('无项目个人约定', '项目约定不支持无项目个人范围，请选择全部或项目。');

  const projectIds = new Set<string>();
  for (const item of projects) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      projectIds.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name ||
      (item.archivedAt != null && typeof item.archivedAt !== 'string')
    )
      return unavailable(
        selection.scope === 'all' ? '全部当前可见约定' : '项目不可用',
        unavailableVersions,
      );
    projectIds.add(item.id);
  }
  const project =
    selection.scope === 'project'
      ? projects.find((item) => item.id === selection.projectId)
      : undefined;
  if (selection.scope === 'project' && !project)
    return unavailable('项目不可用', '所选项目当前不可用，请选择其他搜索范围。');
  const label = project ? taskSearchProjectLabel(project) : '全部当前可见约定';
  if (!Array.isArray(versions)) return unavailable(label, unavailableVersions);
  const byProject = new Map<string, number>();
  for (const entry of versions) {
    if (
      !entry ||
      typeof entry.projectId !== 'string' ||
      !entry.projectId ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 0 ||
      byProject.has(entry.projectId)
    )
      return unavailable(label, unavailableVersions);
    byProject.set(entry.projectId, entry.version);
  }
  const projection: ProjectProjection[] = [];
  for (const item of project ? [project] : projects) {
    const version = byProject.get(item.id);
    if (version === undefined) return unavailable(label, unavailableVersions);
    projection.push([item.id, item.name, !!item.archivedAt, version]);
  }
  projection.sort(([left], [right]) => left.localeCompare(right));
  return { available: true, label, unavailableMessage: '', projection };
}

/** Project-granularity invalidation from the existing Workbench refresh only. */
export function agreementSearchPageScope(
  query: string,
  selection: TaskSearchScope,
  projects: readonly SearchProject[],
  versions: readonly AgreementVersion[] | undefined,
  enabled: boolean,
) {
  const context = agreementSearchScopeContext(selection, projects, versions);
  const available = enabled && context.available;
  return JSON.stringify([
    'agreement',
    query,
    selection,
    available,
    available ? context.projection : [],
  ]);
}

/** Presentation only: a cross-field title/content match need not have a body snippet. */
export function agreementSearchResultContext(agreement: AgreementSearchHit, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  const titleMatch = !!needle && agreement.title.toLocaleLowerCase().includes(needle);
  return {
    sourceLabel: taskSearchProjectLabel(agreement.project),
    stateLabel: { active: '有效', inactive: '已停用', superseded: '已替代' }[agreement.state],
    revisionLabel: `修订 ${agreement.revision}`,
    bodyMatch: titleMatch ? null : textMatchSnippet(agreement.content, query),
  };
}

export function agreementSearchPath(agreement: Pick<AgreementSearchHit, 'id' | 'projectId'>) {
  return `/projects/${encodeURIComponent(agreement.projectId)}?tab=agreements&agreement=${encodeURIComponent(agreement.id)}`;
}
