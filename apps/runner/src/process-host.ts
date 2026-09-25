import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stopped: boolean;
  terminationConfirmed: boolean;
  error: string | null;
}
export interface ProcessHandle {
  done: Promise<ProcessOutcome>;
  stop(): void;
}
/** Bounded POSIX process group. Never uses a shell or executes text received from the model. */
export function runProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  onLine(line: string): void;
}): ProcessHandle {
  if (process.platform === 'win32')
    throw new Error('本轮原生进程管理暂不支持 Windows；不会降级为只停止父进程');
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stopped = false,
    error: string | null = null,
    closed = false;
  let bytes = 0,
    lineBuffer = '',
    stderr = '';
  const decoder = new StringDecoder('utf8');
  const grace = options.killGraceMs ?? 1500;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const groupAlive = () => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') error ??= '无法确认执行进程组已停止';
    }
  };
  const stop = () => {
    if (stopped || closed) return;
    stopped = true;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), grace);
  };
  const abort = (reason: string) => {
    error ??= reason;
    stop();
  };
  const timer = setTimeout(
    () => abort('执行达到时间上限，已请求停止；已发生的模型费用仍可能计费'),
    options.timeoutMs,
  );
  function emit(line: string) {
    if (!line.trim() || error) return;
    try {
      options.onLine(line);
    } catch {
      abort('工具输出协议不兼容或数据过大，已停止；没有自动切换到不受限模式');
    }
  }
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024))
      return abort('工具输出超过限制，已停止并保留已收到的内容');
    lineBuffer += decoder.write(chunk);
    let boundary: number;
    while ((boundary = lineBuffer.indexOf('\n')) >= 0) {
      emit(lineBuffer.slice(0, boundary));
      lineBuffer = lineBuffer.slice(boundary + 1);
    }
    if (lineBuffer.length > 512 * 1024) abort('单条工具事件超过限制');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    if (bytes > (options.maxOutputBytes ?? 4 * 1024 * 1024)) abort('工具输出超过限制');
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    error = err.code === 'ENOENT' ? '原生工具不可执行或已经移除' : '原生工具无法启动';
  });
  child.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE' && !stopped) abort('无法向原生工具发送本次输入');
  });
  child.stdin.end(options.input ?? '');
  child.on('exit', () => {
    // Close inherited output pipes from lingering descendants before waiting for close.
    if (groupAlive()) {
      signalGroup('SIGTERM');
      clearTimeout(killTimer);
      killTimer = setTimeout(() => signalGroup('SIGKILL'), grace);
    }
  });
  const done = new Promise<ProcessOutcome>((resolve) => {
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      lineBuffer += decoder.end();
      if (lineBuffer) emit(lineBuffer);
      // A native tool must not leave background writers after returning its result.
      if (groupAlive()) signalGroup('SIGKILL');
      const until = Date.now() + grace;
      while (groupAlive() && Date.now() < until) await new Promise((r) => setTimeout(r, 30));
      closed = true;
      const terminationConfirmed = !groupAlive();
      if (code !== 0 && !stopped && !error)
        error = stderr.trim() || `工具以退出码 ${code ?? 'unknown'} 结束`;
      resolve({ code, signal, stopped, terminationConfirmed, error });
    });
  });
  return { done, stop };
}
