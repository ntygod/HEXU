import type { AgreementSearchPage } from '../../contracts/src/agreement-search.js';
import type { TaskSearchQuery } from '../../contracts/src/task-search.js';
import { matchesAgreementSearchQuery } from '../../domain/src/agreement-search.js';
import { canonicalJson } from '../../domain/src/index.js';
import { pageSearchItems, searchHash } from './search-cursor.js';
import type { Store } from './store.js';

/** Collect the full current project-scoped feed before matching and bounded pagination. */
export function pageAgreementSearch(store: Store, query: TaskSearchQuery): AgreementSearchPage {
  const matches = store.projectAgreements
    .currentSearchItems(query)
    .filter((agreement) => matchesAgreementSearchQuery(agreement, query.q));
  const queryHash = searchHash(
    canonicalJson({
      type: 'agreement',
      q: query.q,
      scope: query.scope,
      projectId: query.projectId,
    }),
  );
  return pageSearchItems(matches, queryHash, query.cursor, 'afterAgreementId');
}
