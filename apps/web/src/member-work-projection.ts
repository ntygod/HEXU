import type { Project, Task, User } from '../../../packages/contracts/src/index.js';

export type MemberWorkProject =
  | { kind: 'personal' }
  | { kind: 'unavailable' }
  | { kind: 'project'; project: Project };

export interface MemberWorkTask {
  task: Task;
  responsible: boolean;
  participant: boolean;
  source: MemberWorkProject;
}

export type MemberWorkView =
  | { kind: 'directory' }
  | { kind: 'unavailable' }
  | { kind: 'member'; member: User; tasks: MemberWorkTask[] };

/** Only the current visible projection supplies members and task relationships. */
export function projectMemberWork(
  data: {
    members: readonly User[];
    tasks: readonly Task[];
    projects: readonly Project[];
  },
  memberId?: string,
): MemberWorkView {
  if (memberId === undefined) return { kind: 'directory' };
  const member = data.members.find((item) => item.id === memberId);
  if (!member) return { kind: 'unavailable' };

  const seen = new Set<string>();
  const tasks: MemberWorkTask[] = [];
  for (const task of data.tasks) {
    const responsible = task.ownerUserId === member.id;
    const participant = task.participantUserIds?.includes(member.id) ?? false;
    if ((!responsible && !participant) || seen.has(task.id)) continue;
    seen.add(task.id);
    const project = data.projects.find((item) => item.id === task.projectId);
    const source: MemberWorkProject =
      task.projectId === null
        ? { kind: 'personal' }
        : project
          ? { kind: 'project', project }
          : { kind: 'unavailable' };
    tasks.push({ task, responsible, participant, source });
  }
  return { kind: 'member', member, tasks };
}
