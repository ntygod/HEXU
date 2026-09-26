import { listNativeSessions } from './agent/execution-commands.js';
import { forgetNativeSession } from './agent/execution-commands.js';
import { ExecutionJournal } from './agent/execution-journal.js';
import { NodeExecutor } from './agent/executor.js';
import { executionCommand } from './agent/execution-commands.js';
import { readExecutionPolicy, writeExecutionPolicy } from './agent/execution-policy.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError, record, text } from '../../../packages/contracts/src/index.js';
import {
  NODE_INTERVAL_MS,
  controlOrigin,
  exact,
  nodeSecret,
  publicName,
  type PairingView,
} from '../../../packages/contracts/src/nodes.js';
import { AgentConnection, nodeRequest, validatePreview } from './agent/connection.js';
import {
  AgentStorage,
  ensurePrivateHome,
  readCredentials,
  writeCredentials,
  forgetCredentials,
  type NodeCredentials,
} from './agent/storage.js';
import { authorizeDirectories } from './agent/workspaces.js';
const safe = (v: string) => v.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const say = (v: string) => console.log(safe(v));

function argumentsFor(args: string[]) {
  const [command, ...rest] = args;
  if (
    !command ||
    ![
      'connect',
      'start',
      'status',
      'disconnect',
      'help',
      'enable-execution',
      'disable-execution',
      'recover-execution',
      'pending-executions',
      'native-sessions',
      'forget-native-session',
    ].includes(command)
  )
    throw new DomainError(
      'USAGE',
      '使用 runner connect/start/status/disconnect/help；密钥不得作为参数',
    );
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (Object.hasOwn(options, flag)) throw new DomainError('USAGE', '参数不能重复');
    if (['--state', '--config', '--dispatch', '--session'].includes(flag)) {
      if (!rest[i + 1] || rest[i + 1]!.startsWith('--'))
        throw new DomainError('USAGE', '参数缺少路径');
      options[flag] = rest[++i]!;
    } else if (['--once', '--local-only'].includes(flag)) options[flag] = true;
    else
      throw new DomainError('USAGE', '不支持此参数；配对码仅从隐藏输入读取，不接收 token/key 参数');
  }
  if (
    (options['--once'] && command !== 'start') ||
    (options['--local-only'] && command !== 'disconnect') ||
    (options['--config'] && !['connect', 'enable-execution'].includes(command)) ||
    (options['--dispatch'] && command !== 'recover-execution') ||
    (options['--session'] && command !== 'forget-native-session')
  )
    throw new DomainError('USAGE', '此命令不支持该选项');
  return {
    command,
    options,
    home: resolve(String(options['--state'] ?? join(homedir(), '.hexu', 'runner'))),
  };
}
async function connect(storage: AgentStorage, configPath: string) {
  if (existsSync(join(storage.home, 'credentials.json')))
    throw new DomainError(
      'ALREADY_PAIRED',
      '状态目录已有凭证，不覆盖原节点；请 start 或显式 disconnect',
    );
  const raw = readFileSync(configPath, 'utf8');
  if (raw.length > 32768) throw new DomainError('INVALID_CONFIG', '配置过大');
  const cfg = exact(JSON.parse(raw), ['controlUrl', 'name', 'workspaces']);
  const origin = controlOrigin(cfg.controlUrl),
    name = publicName(cfg.name);
  if (!Array.isArray(cfg.workspaces))
    throw new DomainError('INVALID_CONFIG', '需要明确的本地目录配置');
  const directories = await authorizeDirectories(
    cfg.workspaces.map((value) => {
      const item = exact(value, ['name', 'path']);
      return { name: publicName(item.name), path: text(item.path, '本地路径', 4096) };
    }),
    storage.home,
  );
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const lines = createInterface({
    input: process.stdin,
    output,
    terminal: !!process.stdin.isTTY,
    historySize: 0,
  });
  const iterator = lines[Symbol.asyncIterator]();
  const ask = async (prompt: string, hidden = false) => {
    muted = hidden;
    process.stdout.write(prompt);
    const next = await iterator.next();
    muted = false;
    process.stdout.write('\n');
    if (next.done) throw new DomainError('CONFIRMATION_REQUIRED', '没有完成本机确认，未配对');
    return next.value;
  };
  try {
    const code = nodeSecret((await ask('粘贴网页生成的配对码（不回显）：', true)).trim());
    const preview = validatePreview(
      await nodeRequest<PairingView>(origin, 'pairing-preview', { code }),
    );
    say(`控制服务：${origin}`);
    say(`所有者：${preview.ownerName} · 空间：${preview.spaceName} · 项目：${preview.projectName}`);
    for (const w of directories)
      say(`本地目录：${w.root} → 对项目公开别名“${w.name}”及 Git 变更数量`);
    say('本次配对只共享摘要，不上传路径、文件名、代码或模型密钥；启用执行须在本机另行确认。');
    if ((await ask('确认上述账号、项目和目录范围，输入 CONNECT：')) !== 'CONNECT')
      throw new DomainError('CONFIRMATION_REQUIRED', '已取消本机配对');
    const credentials: NodeCredentials = {
      version: 1,
      controlUrl: origin,
      name,
      clientId: randomUUID(),
      nodeToken: randomBytes(32).toString('base64url'),
      projectId: preview.projectId,
      spaceId: preview.spaceId,
      nodeId: null,
      directories,
    };
    // Persist before exchange. A lost response is recovered using this same token,
    // never by making another node or repeating any paid operation.
    new ExecutionJournal(storage).assertCanDisconnect();
    storage.resetForPairing();
    writeExecutionPolicy(storage.home, null);
    writeCredentials(storage.home, credentials);
    const result = await nodeRequest<{ nodeId: string }>(origin, 'pair', {
      protocol: 1,
      code,
      nodeToken: credentials.nodeToken,
      clientId: credentials.clientId,
      projectId: credentials.projectId,
      name,
      platform: process.platform,
      arch: process.arch,
      workspaces: directories.map(({ id, name }) => ({ id, name })),
    });
    credentials.nodeId = result.nodeId;
    writeCredentials(storage.home, credentials);
    say('配对完成。运行 runner start 并使用相同 --state 路径，开始独立节点同步。');
  } finally {
    muted = false;
    lines.close();
  }
}
async function main() {
  const { command, options, home } = argumentsFor(process.argv.slice(2));
  if (command === 'help') {
    console.log(
      'HEXU Runner E2c1 · 默认摘要；可选本人授权执行\n\nconnect --config /path/runner.json [--state /path/private-state]\nstart [--state /path/private-state] [--once]\nstatus [--state /path/private-state]\ndisconnect [--state /path/private-state] [--local-only]\n\n配置：{"controlUrl":"http://127.0.0.1:4310","name":"我的电脑","workspaces":[{"name":"工作副本","path":"/absolute/git-root"}]}\n配对码在终端隐藏粘贴，不放入 argv 或环境变量。凭证目录须在代码仓库之外。\n启用执行：enable-execution --config /path/execution.json [--state ...]\n关闭执行：disable-execution [--state ...]\n列出待处理执行：pending-executions [--state ...]\n核对旧进程：recover-execution --dispatch ID [--state ...]\n原生会话状态：native-sessions [--state ...]\n清理原生历史：forget-native-session --session ID [--state ...]\nClaude Code / Codex 可在本机 execution.json 明确设置 retainSessions:true；默认不保留。',
    );
    return;
  }
  if (command === 'status') {
    const path = ensurePrivateHome(home),
      c = readCredentials(path);
    console.log(
      JSON.stringify(
        {
          mode: readExecutionPolicy(path) ? 'owner-execution-enabled' : 'metadata-only',
          name: c.name,
          controlUrl: c.controlUrl,
          nodeId: c.nodeId,
          projectId: c.projectId,
          directoryCount: c.directories.length,
          observation: '本机配置，不代表在线；实时状态见网页',
          executionEnabled: !!readExecutionPolicy(path),
        },
        null,
        2,
      ),
    );
    return;
  }
  const storage = new AgentStorage(home);
  try {
    if (command === 'native-sessions') {
      console.log(JSON.stringify(listNativeSessions(storage), null, 2));
      return;
    }
    if (command === 'forget-native-session') {
      if (!options['--session']) throw new DomainError('USAGE', '需要 --session 节点会话引用');
      await forgetNativeSession(storage, String(options['--session']));
      return;
    }
    if (command === 'pending-executions') {
      console.log(
        JSON.stringify(
          {
            observation: '本机日志，不推断原进程已停止；无权自动解锁或重跑',
            items: new ExecutionJournal(storage).pendingSummaries(),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (['enable-execution', 'disable-execution', 'recover-execution'].includes(command)) {
      await executionCommand(
        storage,
        command,
        options['--config'] as string | undefined,
        options['--dispatch'] as string | undefined,
      );
      return;
    }
    if (command === 'connect') {
      if (!options['--config'])
        throw new DomainError('USAGE', 'connect 需要 --config 本地配置路径');
      await connect(storage, String(options['--config']));
      return;
    }
    if (command === 'disconnect') {
      new ExecutionJournal(storage).assertCanDisconnect();
      const c = readCredentials(storage.home);
      if (!options['--local-only']) {
        try {
          await nodeRequest(c.controlUrl, 'disconnect', {}, c.nodeToken);
        } catch (error) {
          if (
            !(error instanceof DomainError) ||
            !['NODE_REVOKED', 'NODE_AUTH_REQUIRED'].includes(error.code)
          )
            throw error;
        }
      }
      forgetCredentials(storage.home);
      say(
        options['--local-only']
          ? '仅删除本机凭证，未确认服务端撤销。请在网页撤销原节点；日志仍保留。'
          : '节点已撤销并删除本机凭证；摘要日志仍保留。',
      );
      return;
    }
    const agent = new AgentConnection(storage, say),
      abort = new AbortController();
    const executor = new NodeExecutor(agent, say);
    const stop = () => {
      executor.transportLost();
      abort.abort();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let retry = 1000,
      reported = false;
    try {
      while (!abort.signal.aborted) {
        try {
          await agent.cycle(abort.signal);
          await executor.tick(abort.signal);
          retry = 1000;
          reported = false;
          if (options['--once']) {
            say('一次同步已获持久化 ACK。');
            break;
          }
          await delay(executor.enabled ? 1000 : NODE_INTERVAL_MS, undefined, {
            signal: abort.signal,
          });
        } catch (error) {
          executor.transportLost();
          if (abort.signal.aborted) break;
          const transient =
            !(error instanceof DomainError) ||
            ['RECONNECT_REQUIRED', 'NODE_ALREADY_CONNECTED'].includes(error.code) ||
            error.status >= 500;
          if (
            error instanceof DomainError &&
            ['NODE_REVOKED', 'NODE_AUTH_REQUIRED'].includes(error.code)
          )
            agent.connected = false;
          if (!transient || options['--once']) throw error;
          agent.connected = false;
          if (!reported) {
            say(
              '连接中断；未确认摘要已留在本地，重连后按原序号重放。活动执行已请求停止，不会重复启动。',
            );
            reported = true;
          }
          try {
            await delay(retry + Math.floor(Math.random() * 200), undefined, {
              signal: abort.signal,
            });
          } catch {
            break;
          }
          retry = Math.min(retry * 2, 10000);
        }
      }
    } finally {
      await executor.close();
      await agent.goodbye();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    storage.close();
  }
}
void main().catch((error) => {
  say(
    error instanceof DomainError
      ? `${error.code}: ${error.message}`
      : '节点操作失败；未输出凭证或原始错误。请核对配置、服务与本机状态目录。',
  );
  process.exitCode = 1;
});
