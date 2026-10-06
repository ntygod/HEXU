import type { Project, Workbench } from '../../../packages/contracts/src/index.js';
import type { AgreementSearchHit } from '../../../packages/contracts/src/agreement-search.js';
import type { TaskSearchScope } from '../../../packages/contracts/src/task-search.js';
import {
  agreementSearchPageScope,
  agreementSearchScopeContext,
} from './agreement-search-context.js';
import { useSearchPages } from './search-pages.js';

/** Reuse ordinary page cancellation, retry, busy guards and focus for current agreements. */
export function useAgreementSearchPages(
  query: string,
  projects: readonly Project[],
  versions: Workbench['projectAgreementVersions'],
  selection: TaskSearchScope,
  enabled: boolean,
) {
  const context = agreementSearchScopeContext(selection, projects, versions);
  const available = enabled && context.available;
  const scope = agreementSearchPageScope(query, selection, projects, versions, enabled);
  return useSearchPages<AgreementSearchHit>('agreement', query, scope, selection, available);
}
