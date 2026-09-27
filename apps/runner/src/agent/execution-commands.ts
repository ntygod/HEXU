import { ClaudeSessions } from './claude-sessions.js';
import { CodexSessions } from './codex-sessions.js';
import { createInterface } from 'node:readline/promises';
import { DomainError } from '../../../../packages/contracts/src/index.js';
import type { DispatchCommand } from '../../../../packages/contracts/src/node-execution.js';
import { WorkspaceLease } from '../workspace-lease.js';
import { type AgentStorage, readCredentials } from './storage.js';
import { configureExecution, writeExecutionPolicy } from './execution-policy.js';
import { ExecutionJournal } from './execution-journal.js';
async function confirm(prompt: string, expected: string) {
  // Read one explicit local answer. No password, node token or API key is accepted here.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    process.stdout.write(prompt + '\n');
    const answer = await lines[Symbol.asyncIterator]().next();
    if (answer.done || answer.value !== expected)
      throw new DomainError('CONFIRMATION_REQUIRED', '本机未确认，未更改执行授权');
  } finally {
    lines.close();
  }
}
export async function executionCommand(
  storage: AgentStorage,
  command: string,
  config?: string,
  dispatchId?: string,
) {
  const credentials = readCredentials(storage.home);
  if (command === 'enable-execution') {
    if (!config) throw new DomainError('USAGE', 'enable-execution 需要 --config 本机配置路径');
    const local = await configureExecution(config, credentials);
    console.log(`节点 ${credentials.name} · 项目 ${credentials.projectId}`);
    console.log(
      `只允许当前节点所有者发起 ${local.policy.tool}；模式 ${local.policy.mode}；超时 ${local.policy.timeoutSeconds} 秒。`,
    );
    console.log(
      `目录：${credentials.directories
        .filter((w) => local.policy.workspaceIds.includes(w.id))
        .map((w) => w.name)
        .join('、')}`,
    );
    console.log(
      '将使用节点本机的 API 账户；模型可能读取授权目录内代码，输出将共享到项目任务。文件工具策略不是操作系统沙箱。',
    );
    console.log(
      local.policy.maxBudgetUsd === null
        ? 'Codex 不支持美元硬预算。'
        : `Claude 每次预算参数：USD ${local.policy.maxBudgetUsd}（不等于已验证账单）。`,
    );
    if (local.policy.retainSessions)
      console.log(
        `另外保留 ${local.policy.tool === 'codex' ? 'Codex' : 'Claude Code'} 原生历史到节点私有目录（可能含代码及敏感材料），恢复有效期 7 天；到期不自动删除，请用 forget-native-session 清理。不会上传原生历史到控制服务。`,
      );
    if (local.policy.textAssistance)
      console.log(
        '另外允许本人发起 Claude 纯文本协助：每次使用空临时目录、独立 HOME、禁用全部工具且不保留会话；不访问上述项目目录。仍使用本机账户并可能计费，这不是操作系统沙箱。',
      );
    await confirm('确认以上范围，输入 EXECUTE：', 'EXECUTE');
    writeExecutionPolicy(storage.home, local);
    console.log('本机执行授权已保存；下次 start 将核对工具版本并发布。');
  } else if (command === 'disable-execution') {
    writeExecutionPolicy(storage.home, null);
    console.log('已关闭本机执行；旧连接过期后不可派发。需要立即阻止服务请求时，请在网页撤销节点。');
  } else {
    const journal = new ExecutionJournal(storage);
    if (!dispatchId)
      throw new DomainError(
        'USAGE',
        'recover-execution 需要 --dispatch 执行派发 ID；可在任务执行信息查看',
      );
    const row = journal.get(dispatchId);
    if (!row || row.phase === 'terminal')
      throw new DomainError('RECOVERY_NOT_REQUIRED', '没有此待核对执行');
    const record = JSON.parse(row.body) as DispatchCommand;
    const directory = credentials.directories.find((w) => w.id === record.workspaceId);
    if (!directory && record.purpose !== 'assist')
      throw new DomainError('WORKSPACE_SCOPE_MISMATCH', '原执行目录授权记录不存在');
    await confirm(
      `请先在本机核实原执行及其子进程已全部停止，保留文件修改；此命令不会杀旧 PID。输入 STOPPED ${dispatchId}：`,
      `STOPPED ${dispatchId}`,
    );
    journal.settle(
      dispatchId,
      'cancelled',
      '节点操作者在本机明确确认旧进程已全部停止；文件修改保留。',
    );
    if (record.purpose !== 'assist' && directory)
      new WorkspaceLease(directory.root, dispatchId, true).release();
    if (record.purpose === 'assist')
      console.log(
        '纯文本协助没有项目目录占用；未触碰其他运行的目录锁，也不会自动清理未定位的临时目录。',
      );
    console.log('停止证据已保存；下次 start 上报，不会恢复或重跑旧执行。');
  }
}

export async function forgetNativeSession(storage: AgentStorage, ref: string) {
  await confirm(
    `仅清理此节点保留的原生历史，不删除代码或 HEXU 任务。输入 FORGET ${ref}：`,
    `FORGET ${ref}`,
  );
  const claude = new ClaudeSessions(storage);
  if (claude.list().some((s) => s.ref === ref)) claude.forget(ref);
  else new CodexSessions(storage).forget(ref);
  console.log('本机原生历史已清理；旧会话引用不能恢复，任务公开历史不受影响。');
}

export function listNativeSessions(storage: AgentStorage) {
  return [
    ...new CodexSessions(storage).list().map((s) => ({ tool: 'codex' as const, ...s })),
    ...new ClaudeSessions(storage).list().map((s) => ({ tool: 'claude-code' as const, ...s })),
  ];
}
