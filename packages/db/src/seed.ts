import type { Project, Task, User } from '../../contracts/src/index.js';
export const SPACE_ID = 'space-demo';
export const demoUser: User = { id: 'user-demo-lin', name: '林舟', initial: '林', color: 'violet' };
export const demoMembers: User[] = [demoUser, { id: 'user-demo-chen', name: '陈一', initial: '陈', color: 'teal' }, { id: 'user-demo-zhou', name: '周悦', initial: '周', color: 'amber' }];
export const demoProjects: Project[] = [
  { id: 'project-orders', spaceId: SPACE_ID, name: '订单管理改进', description: '让订单查询、导出与异常处理更顺畅。', color: 'violet', revision: 1 },
  { id: 'project-customers', spaceId: SPACE_ID, name: '客户工作台', description: '在同一个地方了解客户与下一步工作。', color: 'teal', revision: 1 },
  { id: 'project-knowledge', spaceId: SPACE_ID, name: '团队知识整理', description: '让项目资料跟随工作，而不是散落在聊天里。', color: 'amber', revision: 1 },
];
const at = '2026-09-25T06:30:00.000Z';
function task(id: number, title: string, status: Task['status'], projectId = 'project-orders', ownerUserId = demoUser.id, description = '', attention: string | null = null): Task {
  return { id: `task-${id}`, shortId: `HX-${String(id).padStart(3,'0')}`, spaceId: SPACE_ID, projectId, visibility: 'project', title, description, ownerUserId, status, attention, revision: 1, createdAt: at, updatedAt: at };
}
export const demoTasks: Task[] = [
  task(24, '订单按月份导出', 'in_progress', 'project-orders', demoUser.id, '按月份导出订单，沿用当前筛选条件。先完成页面与接口，保持现有权限不变。', '待回复 · 导出字段范围'),
  task(28, '筛选变化时重置分页', 'in_progress', 'project-orders', 'user-demo-chen', '保留筛选条件，重新定位到第一页。'),
  task(26, '订单空状态设计', 'in_progress', 'project-orders', 'user-demo-zhou', '没有匹配结果时提供清楚的提示。', '待反馈'),
  task(32, '增加导出文件命名规则', 'todo', 'project-orders', demoUser.id, '按月份与项目名称生成文件名。'),
  task(33, '补充订单筛选空状态', 'todo', 'project-orders', 'user-demo-zhou'),
  task(34, '整理导出接口使用说明', 'todo', 'project-orders', 'user-demo-chen'),
  task(19, '订单列表基础布局', 'done'), task(21, '订单详情字段整理', 'done', 'project-orders', 'user-demo-chen'),
  task(31, '整理接口调用示例', 'in_progress', 'project-knowledge', demoUser.id, '将常用接口示例整理到项目资料。', '待反馈'),
  task(35, '客户筛选交互', 'todo', 'project-customers'),
];
