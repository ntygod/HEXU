import { BridgeError, type HexuTransport } from './http.js';

/** Bounded current-call polling only. It never consumes an answer or invokes a provider. */
export async function waitForAnswer(transport: HexuTransport, path: string, waitMs: number) {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000)
    throw new BridgeError('INVALID_INPUT', 'waitMs must be between 0 and 30000', 'not_sent');
  const deadline = performance.now() + waitMs;
  let observations = 0;
  for (;;) {
    const remaining = deadline - performance.now();
    const request = await transport.request(
      path,
      undefined,
      undefined,
      waitMs === 0 ? 10_000 : Math.max(1, remaining),
    );
    observations++;
    if (request.phase === 'answered' || request.phase === 'terminal')
      return { status: request.phase, request, observations };
    if (waitMs === 0 || performance.now() + 1000 >= deadline || observations >= 30)
      return { status: 'waiting', request, observations };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
