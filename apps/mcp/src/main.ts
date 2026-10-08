import { once } from 'node:events';
import { bridgeConfiguration, HexuTransport } from './http.js';
import { MAX_FRAME_BYTES, McpSession, parseError } from './protocol.js';

async function main() {
  const configuration = bridgeConfiguration(process.env);
  const session = new McpSession(new HexuTransport(configuration));
  const send = async (message: unknown) => {
    if (!process.stdout.write(`${JSON.stringify(message)}\n`)) await once(process.stdout, 'drain');
  };
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end > MAX_FRAME_BYTES) throw new Error('frame limit');
      const frame = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      let request: unknown;
      try {
        request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame));
      } catch {
        await send(parseError());
        continue;
      }
      const response = await session.handle(request);
      if (response !== undefined) await send(response);
    }
    if (pending.byteLength > MAX_FRAME_BYTES) throw new Error('frame limit');
  }
  // An unterminated line is not a complete stdio protocol message.
  if (pending.length) throw new Error('truncated frame');
}
main().catch(() => {
  // Never log environment, token, raw server responses or material content.
  process.stderr.write('HEXU MCP bridge stopped: invalid configuration, transport, or frame.\n');
  process.exitCode = 1;
});
