import type { AgreementSearchHit } from '../../contracts/src/agreement-search.js';

/** Preserve the project agreement list's literal title-space-content matching rule. */
export function matchesAgreementSearchQuery(
  agreement: Pick<AgreementSearchHit, 'title' | 'content'>,
  normalizedQuery: string,
): boolean {
  return (
    !normalizedQuery ||
    `${agreement.title} ${agreement.content}`.toLocaleLowerCase().includes(normalizedQuery)
  );
}
