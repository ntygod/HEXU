import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CodexSession,
  codexArguments,
  type CodexModel,
  type CodexSummary,
} from '../../../packages/adapters/codex/src/index.js';
import type { NativeRunConfig, NativeEvent } from '../../../packages/contracts/src/native.js';
import { runProcess, type ProcessHandle } from './process-host.js';

export interface CodexHandle extends ProcessHandle {
  summary: CodexSummary;
  models: CodexModel[];
}
/** One app-server per HEXU Run: interruption can never stop another task's connection. */
export async function openCodex(options: {
  executable: string;
  root: string;
  apiKey: string;
  config?: NativeRunConfig;
  retained?: { home: string; threadId?: string; resolvedModel?: string };
  onSpawn?(): void;
  beforeSpawn?(): void;
  onEvent(kind: NativeEvent['kind'], body: string): void;
  onReferences(refs: { sessionId?: string; turnId?: string; resolvedModel?: string }): void;
}): Promise<CodexHandle> {
  const home = await mkdtemp(join(tmpdir(), 'hexu-codex-'));
  await chmod(home, 0o700);
  let protocolError: string | null = null;
  let stoppedByUser = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let models: CodexModel[] = [];
  const finish = () => {
    if (closing) return;
    closing = true;
    clearTimeout(cleanupTimer);
    handle.endInput();
    // App-server is a persistent service. EOF first, then bounded process-group teardown.
    cleanupTimer = setTimeout(() => handle.stop(), 1000);
  };
  const session = new CodexSession(
    (line) => handle.send(line),
    options.onEvent,
    finish,
    options.onReferences,
  );
  let handle: ProcessHandle;
  try {
    options.beforeSpawn?.();
    handle = runProcess({
      executable: options.executable,
      args: codexArguments(options.root),
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: options.retained?.home ?? home,
        LANG: 'C.UTF-8',
      },
      keepInputOpen: true,
      timeoutMs: (options.config?.timeoutSeconds ?? 30) * 1000,
      onSpawn: options.onSpawn,
      onLine: (line) => session.line(line),
    });
  } catch (e) {
    await rm(home, { recursive: true, force: true });
    throw e;
  }
  const bootstrap = (async () => {
    await session.initialize();
    if (stoppedByUser) return;
    await session.checkConfiguration(options.root, !!options.retained);
    await session.authenticate(options.apiKey);
    if (stoppedByUser) return;
    if (options.config) {
      await session.start(
        options.root,
        options.config.mode,
        options.config.contextText,
        options.config.model,
        options.retained,
        () => stoppedByUser || closing,
      );
      if (stoppedByUser) void session.interrupt().catch(() => {});
    } else {
      models = await session.models();
      finish();
    }
  })().catch((e: unknown) => {
    if (!closing && !stoppedByUser)
      protocolError = e instanceof Error ? e.message : 'Codex 初始化失败';
    handle.stop();
  });
  const done = handle.done.then(async (outcome) => {
    closing = true;
    clearTimeout(cleanupTimer);
    session.dispose();
    await bootstrap;
    if (outcome.terminationConfirmed) await rm(home, { recursive: true, force: true });
    return {
      ...outcome,
      stopped: stoppedByUser || session.summary.interrupted,
      error: protocolError ?? outcome.error,
    };
  });
  return {
    summary: session.summary,
    get models() {
      return models;
    },
    done,
    send: handle.send,
    endInput: handle.endInput,
    stop() {
      if (stoppedByUser || closing) return;
      stoppedByUser = true;
      if (session.summary.turnId) {
        void session.interrupt().catch(() => handle.stop());
        cleanupTimer = setTimeout(() => handle.stop(), 1200);
      } else handle.stop();
    },
  };
}
