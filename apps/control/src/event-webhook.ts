import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

/** Errors intentionally exclude URLs, response text and signing material. */
export class CallbackError extends Error {
  constructor(
    readonly reason: 'invalid_callback' | 'challenge_failed' | 'timeout' | 'unavailable',
  ) {
    super(reason);
  }
}
export function signingKey(secret: unknown): Buffer {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new CallbackError('invalid_callback');
  const encoded = secret.slice(6),
    key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded)
    throw new CallbackError('invalid_callback');
  return key;
}
/** Conservative public-unicast allowlist; IPv6 transition, documentation and special ranges denied. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99) || (b === 0 && c === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6) return false;
  const first = Number.parseInt(address.split(':')[0]!, 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    first !== 0x2001 &&
    first !== 0x2002 &&
    !address.toLowerCase().startsWith('3fff:') &&
    !address.includes('.')
  );
}
export function callbackURL(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048) throw new CallbackError('invalid_callback');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CallbackError('invalid_callback');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !url.hostname ||
    url.hostname.endsWith('.')
  )
    throw new CallbackError('invalid_callback');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? !publicAddress(host) : !host.includes('.'))
    throw new CallbackError('invalid_callback');
  return url;
}
export function signedHeaders(
  id: string,
  body: string,
  secrets: string[],
  seconds = Math.floor(Date.now() / 1000),
) {
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(seconds),
    'webhook-signature': secrets
      .map(
        (secret) =>
          `v1,${createHmac('sha256', signingKey(secret)).update(`${id}.${seconds}.${body}`).digest('base64')}`,
      )
      .join(' '),
  };
}
export type WebhookSender = (
  url: string,
  body: string,
  headers: Record<string, string>,
  authorize: () => void,
) => Promise<{ status: number; body: string }>;
/** Resolve at EACH connection; pin IP while retaining hostname for certificate/SNI. No redirect support. */
export const postWebhook: WebhookSender = async (value, body, headers, authorize) => {
  const url = callbackURL(value);
  if (Buffer.byteLength(body) > 262144) throw new CallbackError('invalid_callback');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  const started = Date.now();
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(() => reject(new CallbackError('timeout')), 10000);
      }),
    ]);
  } catch (error) {
    throw error instanceof CallbackError ? error : new CallbackError('unavailable');
  } finally {
    if (dnsTimer) clearTimeout(dnsTimer);
  }
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new CallbackError('invalid_callback');
  authorize(); // Current authorization after asynchronous DNS, immediately before network transmission.
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'POST',
        agent: false,
        family: selected.family,
        lookup: (_host, _options, cb) => cb(null, selected.address, selected.family),
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      },
      (res) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16384) {
            req.destroy();
            reject(new CallbackError('unavailable'));
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', () => reject(new CallbackError('unavailable')));
      },
    );
    const timer = setTimeout(
      () => {
        req.destroy();
        reject(new CallbackError('timeout'));
      },
      Math.max(1, 10000 - (Date.now() - started)),
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new CallbackError('unavailable')));
    req.end(body);
  });
};
export async function verifyCallback(
  sender: WebhookSender,
  url: string,
  secret: string,
  subscriptionId: string,
  authorize: () => void,
) {
  callbackURL(url);
  signingKey(secret);
  const challenge = randomBytes(32).toString('base64url'),
    id = `verify_${randomBytes(24).toString('hex')}`;
  const body = JSON.stringify({ type: 'verification', challenge }),
    started = Date.now();
  const result = await sender(
    url,
    body,
    { ...signedHeaders(id, body, [secret]), 'X-MCP-Subscription-Id': subscriptionId },
    authorize,
  );
  let echoed: unknown;
  try {
    echoed = JSON.parse(result.body).challenge;
  } catch {
    echoed = null;
  }
  if (
    result.status < 200 ||
    result.status >= 300 ||
    Date.now() - started > 10000 ||
    typeof echoed !== 'string' ||
    Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) ||
    !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))
  )
    throw new CallbackError('challenge_failed');
}
