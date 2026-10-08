import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../../../packages/db/src/store.js';
import { createRemoteCollaboration } from './remote-collaboration.js';
import { remoteOAuthFromEnvironment } from './remote-oauth.js';
// Separate opt-in executable; never changes preview/team-local listening policy.
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
function privateFile(name: string) {
  const path = resolve(required(name)),
    stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error(`${name} must be a private regular file (0600)`);
  return readFileSync(path);
}
const databasePath = resolve(required('HEXU_COLLABORATION_DATABASE'));
if (!statSync(databasePath).isFile())
  throw new Error('An existing provisioned team database is required');
const key = privateFile('HEXU_EVENT_KEY_FILE');
if (key.length !== 32) throw new Error('HEXU_EVENT_KEY_FILE must contain exactly 32 raw bytes');
const store = new Store(databasePath, undefined, { team: true });
const { app } = await createRemoteCollaboration({
  store,
  publicOrigin: required('HEXU_COLLABORATION_ORIGIN'),
  encryptionKey: key,
  oauth: remoteOAuthFromEnvironment(process.env),
  tls: {
    key: privateFile('HEXU_TLS_KEY_FILE'),
    cert: readFileSync(resolve(required('HEXU_TLS_CERT_FILE'))),
  },
});
const port = Number(process.env.HEXU_COLLABORATION_PORT ?? 8443);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid collaboration port');
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  // Fastify close hooks are LIFO. Close the owner store only after the service has drained
  // deliveries and closed its dedicated OAuth identity handle, not in a later-added hook.
  try {
    await app.close();
  } finally {
    store.close();
  }
};
try {
  await app.listen({ host: process.env.HEXU_COLLABORATION_HOST ?? '127.0.0.1', port });
} catch (error) {
  await close();
  throw error;
}
console.log(
  'HEXU limited collaboration listener started; no host execution or public identity setup.',
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  });
