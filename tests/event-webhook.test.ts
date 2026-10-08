import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { test } from 'node:test';
import {
  callbackURL,
  CallbackError,
  postWebhook,
  publicAddress,
  signedHeaders,
  signingKey,
  verifyCallback,
  type WebhookSender,
} from '../apps/control/src/event-webhook.js';

// Synthetic signing material and an injected receiver only. These tests do not
// contact a callback, prove endpoint ownership, or exercise a real dot receiver.
const secret = `whsec_${Buffer.alloc(32, 0x41).toString('base64')}`;
const replacement = `whsec_${Buffer.alloc(32, 0x42).toString('base64')}`;
const url = 'https://receiver.example.test/events';
const now = 1_791_446_400;

// Independent receiver-side fixture: production HEXU sends rather than verifies
// incoming webhooks. The tolerance is this fixture's policy, not an MCP claim.
function accepts(
  body: string,
  headers: Record<string, string>,
  receiverSecret: string,
  currentSeconds = now,
): boolean {
  const timestamp = headers['webhook-timestamp'] ?? '';
  if (!/^\d+$/.test(timestamp) || Math.abs(Number(timestamp) - currentSeconds) > 300) return false;
  const digest = createHmac('sha256', Buffer.from(receiverSecret.slice(6), 'base64'))
    .update(Buffer.from(`${headers['webhook-id']}.${timestamp}.`, 'utf8'))
    .update(Buffer.from(body, 'utf8'))
    .digest();
  return (headers['webhook-signature'] ?? '').split(' ').some((entry) => {
    const [version, encoded] = entry.split(',');
    if (version !== 'v1' || !encoded) return false;
    const supplied = Buffer.from(encoded, 'base64');
    return supplied.length === digest.length && timingSafeEqual(supplied, digest);
  });
}

function invalid(fn: () => unknown) {
  assert.throws(fn, { name: 'Error', message: 'invalid_callback', reason: 'invalid_callback' });
}

test('webhook secrets require canonical base64 encoding of 24–64 bytes', () => {
  for (const size of [24, 25, 32, 63, 64]) {
    const key = Buffer.alloc(size, 0xfb);
    assert.deepEqual(signingKey(`whsec_${key.toString('base64')}`), key);
  }
  for (const value of [
    undefined,
    null,
    42,
    {},
    '',
    'whsec_',
    secret.slice(6),
    ` ${secret}`,
    `${secret}\n`,
    `whsec_${Buffer.alloc(23).toString('base64')}`,
    `whsec_${Buffer.alloc(65).toString('base64')}`,
    secret.replace(/=$/, ''),
    `${secret}=`,
    `whsec_${Buffer.alloc(32, 0xff).toString('base64url')}`,
    `whsec_${Buffer.alloc(32).toString('base64').slice(0, -2)}B=`,
  ])
    invalid(() => signingKey(value));
});

test('webhook signatures cover exact UTF-8 body, event ID, timestamp and decoded key', () => {
  const body = '{ "text": "协助 🌿", "n": 1 }\n';
  const headers = signedHeaders('evt_synthetic', body, [secret], now);
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['webhook-id'], 'evt_synthetic');
  assert.equal(headers['webhook-timestamp'], String(now));
  assert.equal(accepts(body, headers, secret), true);
  assert.equal(accepts(JSON.stringify(JSON.parse(body)), headers, secret), false);
  assert.equal(accepts(`${body} `, headers, secret), false);
  assert.equal(accepts(body, { ...headers, 'webhook-id': 'evt_other' }, secret), false);
  assert.equal(accepts(body, { ...headers, 'webhook-timestamp': String(now + 1) }, secret), false);
  assert.equal(accepts(body, headers, replacement), false);
  assert.equal(accepts(body, { ...headers, 'webhook-signature': 'v1,AA==' }, secret), false);
});

test('rotation emits independently valid space-separated signatures', () => {
  const body = '{"eventId":"evt_rotation"}';
  const headers = signedHeaders('evt_rotation', body, [replacement, secret], now);
  assert.equal(headers['webhook-signature'].split(' ').length, 2);
  assert.equal(accepts(body, headers, secret), true);
  assert.equal(accepts(body, headers, replacement), true);
  const rotated = signedHeaders('evt_rotation', body, [replacement], now);
  assert.equal(accepts(body, rotated, secret), false);
  assert.equal(accepts(body, rotated, replacement), true);
});

test('synthetic receiver rejects stale/future replay timestamps and accepts fresh retry signing', () => {
  const body = '{"eventId":"evt_retry"}';
  const initial = signedHeaders('evt_retry', body, [secret], now);
  assert.equal(accepts(body, initial, secret, now + 300), true);
  assert.equal(accepts(body, initial, secret, now + 301), false);
  assert.equal(accepts(body, initial, secret, now - 301), false);
  const retry = signedHeaders('evt_retry', body, [secret], now + 301);
  assert.equal(retry['webhook-id'], initial['webhook-id']);
  assert.notEqual(retry['webhook-signature'], initial['webhook-signature']);
  assert.equal(accepts(body, retry, secret, now + 301), true);
});

test('callback addresses deny non-public IPv4 and IPv6 ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    '100::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2002:7f00:1::',
    '3fff::1',
    'not-an-address',
    '999.1.1.1',
  ])
    assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(publicAddress(address), true, address);
});

test('callback URLs require HTTPS without credentials, fragments or alternate ports', () => {
  for (const value of [
    null,
    1,
    '',
    'not a URL',
    'http://receiver.example.test/events',
    'https://user:password@receiver.example.test/events',
    'https://receiver.example.test/#token',
    'https://receiver.example.test:8443/events',
    'https://localhost/events',
    'https://receiver.example.test./events',
    'https://127.1/events',
    'https://2130706433/events',
    'https://0x7f000001/events',
    'https://[::1]/events',
    'https://[::ffff:7f00:1]/events',
    `https://receiver.example.test/${'x'.repeat(2048)}`,
  ])
    invalid(() => callbackURL(value));
  assert.equal(callbackURL(url).href, url);
  assert.equal(callbackURL('https://receiver.example.test:443/events').port, '');
  assert.equal(callbackURL('https://[2606:4700:4700::1111]/events').protocol, 'https:');
});

test('invalid URL and oversize UTF-8 payload fail before any DNS or HTTP request', async () => {
  const authorize = () => assert.fail('must not authorize an invalid request');
  await assert.rejects(postWebhook('http://localhost', '{}', {}, authorize), {
    reason: 'invalid_callback',
  });
  await assert.rejects(postWebhook(url, '🌿'.repeat(65537), {}, authorize), {
    reason: 'invalid_callback',
  });
});

test('verification signs a fresh minimal challenge and passes authorization to injected sender', async () => {
  const challenges = new Set<string>();
  const ids = new Set<string>();
  let calls = 0;
  let authorized = 0;
  const sender: WebhookSender = async (target, body, headers, authorize) => {
    calls++;
    assert.equal(target, url);
    assert.equal(headers['X-MCP-Subscription-Id'], 'sub_synthetic');
    const envelope = JSON.parse(body);
    assert.deepEqual(Object.keys(envelope).sort(), ['challenge', 'type']);
    assert.equal(envelope.type, 'verification');
    assert.equal(Buffer.from(envelope.challenge, 'base64url').length, 32);
    assert.equal(accepts(body, headers, secret, Math.floor(Date.now() / 1000)), true);
    challenges.add(envelope.challenge);
    ids.add(headers['webhook-id']!);
    authorize();
    return { status: 200, body: JSON.stringify({ challenge: envelope.challenge }) };
  };
  for (let i = 0; i < 2; i++)
    await verifyCallback(sender, url, secret, 'sub_synthetic', () => {
      authorized++;
    });
  assert.equal(calls, 2);
  assert.equal(authorized, 2);
  assert.equal(challenges.size, 2);
  assert.equal(ids.size, 2);
});

test('verification rejects malformed, wrong and missing echoes without exposing response contents', async () => {
  for (const body of [
    'not-json-private-response',
    'null',
    '{}',
    '{"challenge":1}',
    '{"challenge":"wrong"}',
  ]) {
    const sender: WebhookSender = async () => ({ status: 200, body });
    await assert.rejects(
      verifyCallback(sender, url, secret, 'sub_synthetic', () => {}),
      (error) => {
        assert.ok(error instanceof CallbackError);
        assert.equal(error.reason, 'challenge_failed');
        assert.equal(error.message, 'challenge_failed');
        return true;
      },
    );
  }
  const sameLength: WebhookSender = async (_target, body) => {
    const { challenge } = JSON.parse(body);
    const wrong = `${challenge[0] === 'A' ? 'B' : 'A'}${challenge.slice(1)}`;
    return { status: 200, body: JSON.stringify({ challenge: wrong }) };
  };
  await assert.rejects(
    verifyCallback(sameLength, url, secret, 'sub_synthetic', () => {}),
    { reason: 'challenge_failed' },
  );
});

test('verification rejects redirects and error statuses even with the correct challenge', async () => {
  for (const status of [0, 199, 300, 301, 302, 307, 308, 400, 401, 410, 413, 429, 500, 503]) {
    let calls = 0;
    const sender: WebhookSender = async (_target, body) => {
      calls++;
      return { status, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    };
    await assert.rejects(
      verifyCallback(sender, url, secret, 'sub_synthetic', () => {}),
      { reason: 'challenge_failed' },
    );
    assert.equal(calls, 1, 'verification must not request a redirect or retry itself');
  }
});

test('verification rejects an expired challenge using fake time without a real callback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: now * 1000 });
  const sender: WebhookSender = async (_target, body) => {
    t.mock.timers.tick(10001);
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  };
  await assert.rejects(
    verifyCallback(sender, url, secret, 'sub_synthetic', () => {}),
    { reason: 'challenge_failed' },
  );
});

test('verification refuses invalid configuration before invoking the injected sender', async () => {
  const sender: WebhookSender = async () => assert.fail('invalid configuration reached sender');
  await assert.rejects(
    verifyCallback(sender, 'https://[::1]', secret, 'sub_synthetic', () => {}),
    { reason: 'invalid_callback' },
  );
  await assert.rejects(
    verifyCallback(sender, url, 'whsec_bad', 'sub_synthetic', () => {}),
    { reason: 'invalid_callback' },
  );
});
