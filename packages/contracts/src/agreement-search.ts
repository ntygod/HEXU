import type { Project } from './index.js';
import type { AgreementState } from './project-agreements.js';

/** Only the current published record and current project identity belong in global search. */
export interface AgreementSearchHit {
  id: string;
  projectId: string;
  title: string;
  content: string;
  revision: number;
  state: AgreementState;
  updatedAt: string;
  project: Pick<Project, 'id' | 'name' | 'archivedAt'>;
}

export interface AgreementSearchPage {
  items: AgreementSearchHit[];
  nextCursor: string | null;
}
